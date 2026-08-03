const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { PhoneService } = require('./src/phoneService');
const kickBrowser = require('./src/kickBrowser');

// Prefer an explicit system ffmpeg (set via Dockerfile on Render) over the
// bundled @ffmpeg-installer/ffmpeg binary - see Dockerfile for why.
const FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegInstaller.path;

const service = new PhoneService({
    streamerName: process.env.STREAMER_NAME || 'Destiny',
    storageFile: process.env.PHONE_SERVICE_STATE_FILE || undefined
});

const KICK_CHANNEL = process.env.KICK_CHANNEL || null;
const KICK_POLL_INTERVAL_MS = Number(process.env.KICK_POLL_INTERVAL_MS || 90000);
const KICK_VIDEOS_POLL_INTERVAL_MS = Number(process.env.KICK_VIDEOS_POLL_INTERVAL_MS || 900000);
const KICK_VOD_URL_TTL_MS = 45 * 60 * 1000;
const KICK_VOD_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

let liveRelayUrl = process.env.LIVE_HLS_URL || null;

// Twilio's <Play> fetches a URL expecting a finite, completable download - an
// endlessly open stream eventually hits Twilio's own fetch timeout (confirmed
// via Twilio error 11200 / "AsyncContext timeout" at ~30s). So /live.mp3 never
// hands Twilio an unbounded response - each request auto-closes after
// LIVE_CHUNK_SECONDS, and the TwiML loops back for the next one. What it does
// NOT do is re-establish the connection to Kick per chunk: that reconnect
// (DNS + TLS + manifest + first segment) was the dominant cause of an audible
// ~10s gap between chunks. Instead one transcode process stays connected in
// the background for as long as the stream is live, feeding a catch-up buffer
// that runs comfortably ahead of LIVE_CHUNK_SECONDS. That means every chunk -
// not just the first - gets served from audio that was already fully
// transcoded before it was ever requested, so the fetch itself is always
// near-instant instead of occasionally waiting on live data to trickle in.
// The 30s Twilio fetch-timeout above is about how long Twilio will wait to
// download the file, not how long the resulting audio is allowed to play for -
// since the download is already fast (pre-buffered), a longer chunk here just
// means the one unavoidable Twilio-side pause between chunks (the Gather
// timeout after <Play> finishes) happens less often, at the cost of running
// this far behind the true live edge.
const LIVE_CHUNK_SECONDS = 60;
const LIVE_AUDIO_BYTES_PER_SECOND = (96 * 1000) / 8; // matches -b:a 96k below
const LIVE_CHUNK_BYTES = LIVE_AUDIO_BYTES_PER_SECOND * LIVE_CHUNK_SECONDS;
// Kept comfortably above LIVE_CHUNK_SECONDS worth of audio: as long as the
// transcoder has been running for a while, a fresh request can be satisfied
// entirely out of this buffer and close (and thus become playable to Twilio)
// in well under a second, instead of waiting out a fixed real-time delay.
const LIVE_CATCHUP_BUFFER_MS = (LIVE_CHUNK_SECONDS + 15) * 1000;
const activeLiveRequests = new Set();
let liveTranscodeProcess = null;
let liveTranscodeBuffer = [];
// True while reconnectLiveTranscode() is re-validating against Kick after an
// unexpected death - blocks startLiveTranscode from being called elsewhere
// (e.g. the /live.mp3 route) with the stale URL that just failed.
let liveReconnecting = false;

function startLiveTranscode(hlsUrl) {
    if (!hlsUrl || liveTranscodeProcess || liveReconnecting) {
        return;
    }

    // No -re: Twilio's <Play> appears to fully download a chunk before
    // playing any of it, rather than streaming progressively as bytes
    // arrive. Pacing our output to real-time therefore just makes the
    // silent "download" phase as long as the chunk itself (measured as an
    // alternating ~20s-silent/~20s-audio pattern) - deliver as fast as
    // possible instead and let Twilio pace the actual playback. Live input
    // still can't outrun the broadcast itself (new segments only exist once
    // Kick's encoder produces them), so this doesn't risk racing ahead in
    // steady state - only removes an artificial slowdown.
    const proc = spawn(FFMPEG_PATH, [
        '-i', hlsUrl,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '96k',
        '-ar', '44100',
        '-f', 'mp3',
        '-'
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    liveTranscodeProcess = proc;

    proc.on('error', (error) => {
        console.error('live transcode error:', error);
    });

    // Guarded with `liveTranscodeProcess === proc` because kill() is async: if
    // this process was already replaced by stopLiveTranscode()+startLiveTranscode(),
    // its delayed exit must not null out the newer process.
    proc.on('exit', (code, signal) => {
        console.error(`live transcode exited with code=${code} signal=${signal}`);
        if (liveTranscodeProcess === proc) {
            liveTranscodeProcess = null;
            liveTranscodeBuffer = [];
            for (const res of activeLiveRequests) {
                if (!res.writableEnded) {
                    res.end();
                }
            }
            activeLiveRequests.clear();
            // An unexpected death mid-call is usually Kick's signed playback
            // URL expiring (~20-30 min lifetime), not the broadcast ending -
            // pollKickChannel can't catch this because it's deliberately
            // paused for the whole time someone's listening. Re-validate
            // against Kick directly instead of waiting for the next 90s poll.
            reconnectLiveTranscode();
        }
    });

    proc.stdout.on('data', (chunk) => {
        if (liveTranscodeProcess !== proc) {
            return;
        }
        const now = Date.now();
        liveTranscodeBuffer.push({ chunk, at: now });
        while (liveTranscodeBuffer.length && now - liveTranscodeBuffer[0].at > LIVE_CATCHUP_BUFFER_MS) {
            liveTranscodeBuffer.shift();
        }
        for (const res of activeLiveRequests) {
            if (res.writableEnded) {
                activeLiveRequests.delete(res);
                continue;
            }
            res.write(chunk);
            res.__liveBytesSent = (res.__liveBytesSent || 0) + chunk.length;
            // Close as soon as this response has a full chunk's worth of
            // audio, rather than waiting out a fixed wall-clock timer - that
            // was the actual cause of the alternating silent/audio pattern:
            // even once all the bytes had arrived, the response stayed open
            // (so Twilio kept "downloading") for the rest of the fixed delay.
            if (res.__liveBytesSent >= LIVE_CHUNK_BYTES) {
                activeLiveRequests.delete(res);
                if (res.__liveCloseTimer) {
                    clearTimeout(res.__liveCloseTimer);
                }
                if (!res.writableEnded) {
                    res.end();
                }
            }
        }
    });
}

function stopLiveTranscode() {
    if (liveTranscodeProcess) {
        liveTranscodeProcess.kill('SIGKILL');
        liveTranscodeProcess = null;
    }
    liveTranscodeBuffer = [];
    for (const res of activeLiveRequests) {
        if (!res.writableEnded) {
            res.end();
        }
    }
    activeLiveRequests.clear();
}

async function reconnectLiveTranscode() {
    if (!KICK_CHANNEL || liveReconnecting) {
        return;
    }
    liveReconnecting = true;
    try {
        const { isLive, hlsUrl } = await kickBrowser.checkLiveStatus(KICK_CHANNEL);
        if (isLive && hlsUrl) {
            liveRelayUrl = hlsUrl;
            liveReconnecting = false;
            startLiveTranscode(liveRelayUrl);
        } else {
            liveRelayUrl = null;
            if (service.state.isLive) {
                service.endStream();
            }
            liveReconnecting = false;
        }
    } catch (error) {
        console.error(`Live reconnect failed: ${error.message}`);
        liveReconnecting = false;
    }
}

// Same reasoning applies to archived recordings: without a bound, ffmpeg
// would try to stream from the seek position all the way to the end of a
// potentially multi-hour VOD in one response, which Twilio can't wait out
// any better than an infinite live stream. Unlike live, there's no single
// shared stream to keep warm (each caller can be at a different position) -
// but each CALLER still gets a persistent, per-session ffmpeg process that
// keeps transcoding forward in the background between chunk requests, so
// repeat/continuing requests don't pay a fresh reconnect+reseek cost every
// ~18s the way a stateless per-request spawn would.
const ARCHIVE_CHUNK_SECONDS = 60;
const ARCHIVE_AUDIO_BYTES_PER_SECOND = (96 * 1000) / 8; // matches -b:a 96k below
const ARCHIVE_CHUNK_BYTES = ARCHIVE_AUDIO_BYTES_PER_SECOND * ARCHIVE_CHUNK_SECONDS;
// How much drift to tolerate between the position handlePlaybackControl
// expects (tracked via wall-clock elapsed time) and where the persistent
// transcode has actually gotten to, before treating a request as a real seek
// (which requires killing and respawning at the new position) rather than a
// natural continuation of the same session.
const ARCHIVE_POSITION_TOLERANCE_SECONDS = 5;
// A session nobody has reattached to for this long is assumed abandoned
// (caller hung up, went to the menu, or switched recordings) and is torn
// down so its ffmpeg process and Kick CDN connection don't leak forever.
const ARCHIVE_SESSION_IDLE_MS = 90 * 1000;
const archiveSessions = new Map(); // caller phone number -> session

function stopArchiveSession(phoneNumber) {
    const session = archiveSessions.get(phoneNumber);
    if (!session) {
        return;
    }
    archiveSessions.delete(phoneNumber);
    if (session.process && !session.process.killed) {
        session.process.kill('SIGKILL');
    }
    if (session.currentRes && !session.currentRes.writableEnded) {
        session.currentRes.end();
    }
}

function startArchiveSession(phoneNumber, recordingId, audioUrl, startSeconds) {
    stopArchiveSession(phoneNumber);

    const proc = spawn(FFMPEG_PATH, [
        '-ss', String(startSeconds),
        '-i', audioUrl,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '96k',
        '-ar', '44100',
        '-f', 'mp3',
        '-'
    ], { stdio: ['ignore', 'pipe', 'inherit'] });

    const session = {
        recordingId,
        process: proc,
        currentRes: null,
        bytesSentForCurrentRes: 0,
        startSeconds,
        bytesProducedTotal: 0,
        lastAttachedAt: Date.now(),
        pending: []
    };
    archiveSessions.set(phoneNumber, session);

    proc.on('error', (error) => {
        console.error(`archive transcode error for ${phoneNumber}: ${error.message}`);
    });

    proc.on('exit', (code, signal) => {
        console.error(`archive transcode for ${phoneNumber} exited with code=${code} signal=${signal}`);
        if (archiveSessions.get(phoneNumber) === session) {
            archiveSessions.delete(phoneNumber);
            if (session.currentRes && !session.currentRes.writableEnded) {
                session.currentRes.end();
            }
        }
    });

    proc.stdout.on('data', (chunk) => {
        session.bytesProducedTotal += chunk.length;
        if (session.currentRes && !session.currentRes.writableEnded) {
            session.currentRes.write(chunk);
            session.bytesSentForCurrentRes += chunk.length;
            if (session.bytesSentForCurrentRes >= ARCHIVE_CHUNK_BYTES) {
                session.currentRes.end();
                session.currentRes = null;
                session.lastAttachedAt = Date.now();
            }
        } else {
            // Nobody's attached right now (between chunk requests) - queue a
            // little so the next request can start instantly, but stop once
            // there's a full chunk's worth ready rather than buffering the
            // rest of the VOD in memory. Node applies real backpressure to
            // ffmpeg's own stdout write() once we stop draining it.
            session.pending.push(chunk);
            const pendingBytes = session.pending.reduce((sum, c) => sum + c.length, 0);
            if (pendingBytes >= ARCHIVE_CHUNK_BYTES) {
                proc.stdout.pause();
            }
        }
    });

    return session;
}

function attachArchiveResponse(session, res) {
    session.currentRes = res;
    session.bytesSentForCurrentRes = 0;
    session.lastAttachedAt = Date.now();

    while (session.pending.length && session.bytesSentForCurrentRes < ARCHIVE_CHUNK_BYTES) {
        const chunk = session.pending.shift();
        res.write(chunk);
        session.bytesSentForCurrentRes += chunk.length;
    }

    if (session.bytesSentForCurrentRes >= ARCHIVE_CHUNK_BYTES) {
        res.end();
        session.currentRes = null;
    }

    if (session.process.stdout.isPaused()) {
        session.process.stdout.resume();
    }
}

function getRequestBaseUrl(req = null) {
    const configured = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
    if (configured) {
        return configured.replace(/\/+$/, '');
    }
    if (!req) {
        return null;
    }
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host;
    if (!host) {
        return null;
    }
    return `${proto}://${host}`;
}

function buildLivePlaybackUrl(req = null) {
    const baseUrl = getRequestBaseUrl(req) || `http://localhost:${process.env.PORT || 3000}`;
    return `${baseUrl}/live.mp3`;
}

function buildRecordingPlaybackUrl(req, recordingId, startSeconds, phoneNumber) {
    const baseUrl = getRequestBaseUrl(req) || `http://localhost:${process.env.PORT || 3000}`;
    const start = Math.max(0, Math.floor(startSeconds || 0));
    const caller = encodeURIComponent(phoneNumber || 'unknown-caller');
    return `${baseUrl}/recordings/${encodeURIComponent(recordingId)}/play?start=${start}&caller=${caller}`;
}

async function pollKickChannel() {
    // Runs every 90s forever, so unlike the archiving polls this one can't
    // just be delayed until nobody's listening - it would starve a long call
    // repeatedly. Skipping it while someone's live means we won't notice the
    // stream ending mid-call, but the transcode process will exit on its own
    // once the source actually goes away, which its exit handler covers.
    if (activeLiveRequests.size > 0) {
        return;
    }
    try {
        const { isLive, hlsUrl } = await kickBrowser.checkLiveStatus(KICK_CHANNEL);

        if (isLive && hlsUrl) {
            // Only start a fresh "recording" on an offline->live transition. A
            // mid-broadcast URL refresh (Kick can rotate the token) restarts the
            // transcode against the new URL.
            if (liveRelayUrl !== hlsUrl) {
                liveRelayUrl = hlsUrl;
                stopLiveTranscode();
                startLiveTranscode(liveRelayUrl);
            }
            if (!service.state.isLive) {
                service.startStream({ audioUrl: buildLivePlaybackUrl(), sourceUrl: liveRelayUrl });
            }
        } else if (isLive && !hlsUrl) {
            // Kick said live but didn't hand back a playback_url this tick - treat
            // as a transient glitch, not an end-of-stream signal. Leave state alone.
            console.warn('Kick reports live but no playback_url was returned; leaving current state as-is.');
        } else if (!isLive && service.state.isLive) {
            service.endStream();
            stopLiveTranscode();
            liveRelayUrl = null;
        }
    } catch (error) {
        console.error(`Kick live poll failed: ${error.message}`);
    }
}

// Kick video IDs already archived, so re-polling the videos list doesn't
// re-add (and re-resolve a fresh playback URL for) the same stream every tick.
const archivedKickVideoIds = new Set();
for (const recording of service.state.recordings) {
    if (recording.kickVideoId) {
        archivedKickVideoIds.add(recording.kickVideoId);
    }
}

async function pollKickVideos() {
    // Chrome (Puppeteer) and ffmpeg competing for the same CPU core can stall
    // audio delivery to an actively-listening caller badly enough that Twilio
    // gives up on the stream - defer background archiving until nobody's live.
    if (activeLiveRequests.size > 0) {
        return;
    }
    try {
        const videoIds = await kickBrowser.listRecentVideoIds(KICK_CHANNEL, 5);
        for (const videoId of videoIds) {
            // Re-checked per video (not just once at the top) - archiving all
            // 5 can take minutes, and a caller can connect to the live stream
            // partway through an already-running poll.
            if (activeLiveRequests.size > 0) {
                console.log('Pausing Kick video archiving: a caller is listening live');
                return;
            }
            if (archivedKickVideoIds.has(videoId)) {
                continue;
            }
            try {
                const info = await kickBrowser.getVodPlaybackInfo(KICK_CHANNEL, videoId);
                service.addRecording({
                    title: info.title || `${service.streamerName} archived stream`,
                    audioUrl: info.audioUrl,
                    durationSeconds: info.durationSeconds || 0,
                    kickVideoId: videoId
                });
                archivedKickVideoIds.add(videoId);
                // Reuse the URL we just paid the Puppeteer cost to fetch, so
                // the cache is already warm - a caller shouldn't be the one
                // to trigger the first (slow) resolution for a recording.
                vodUrlCache.set(videoId, { audioUrl: info.audioUrl, resolvedAt: Date.now() });
                console.log(`Archived Kick video ${videoId}: ${info.title}`);
            } catch (error) {
                console.error(`Failed to archive Kick video ${videoId}: ${error.message}`);
            }
        }
    } catch (error) {
        console.error(`Kick videos poll failed: ${error.message}`);
    }
}

// The VOD playback URL Kick hands back is signed with a token that expires
// ~1 hour after issuance, so it can't be stored permanently like an
// admin-provided direct link. It's kept warm by pollKickVideos (on archive)
// and refreshVodCache (periodically) - this on-demand path is a safety net,
// not the normal path, because resolving it live via Puppeteer takes 5-20+
// seconds, which is longer than Twilio's <Play> fetch will tolerate.
const vodUrlCache = new Map();

async function refreshVodCache() {
    if (activeLiveRequests.size > 0) {
        return;
    }
    const kickRecordings = service.state.recordings.filter((entry) => entry.kickVideoId && !entry.live);
    for (const recording of kickRecordings) {
        try {
            const info = await kickBrowser.getVodPlaybackInfo(KICK_CHANNEL, recording.kickVideoId);
            vodUrlCache.set(recording.kickVideoId, { audioUrl: info.audioUrl, resolvedAt: Date.now() });
        } catch (error) {
            console.error(`Failed to refresh playback URL for ${recording.kickVideoId}: ${error.message}`);
        }
    }
}

async function resolveRecordingAudioUrl(recording) {
    if (!recording.kickVideoId) {
        return recording.audioUrl;
    }

    const cached = vodUrlCache.get(recording.kickVideoId);
    if (cached && Date.now() - cached.resolvedAt < KICK_VOD_URL_TTL_MS) {
        return cached.audioUrl;
    }

    const info = await kickBrowser.getVodPlaybackInfo(KICK_CHANNEL, recording.kickVideoId);
    vodUrlCache.set(recording.kickVideoId, { audioUrl: info.audioUrl, resolvedAt: Date.now() });
    return info.audioUrl;
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            if (!body) {
                resolve({});
                return;
            }

            const parsed = {};
            body.split('&').forEach((pair) => {
                const [key, value] = pair.split('=');
                if (key) {
                    parsed[decodeURIComponent(key)] = decodeURIComponent(value || '');
                }
            });

            if (req.headers['content-type']?.includes('application/json')) {
                try {
                    Object.assign(parsed, JSON.parse(body));
                } catch (error) {
                    // Ignore malformed JSON and fall back to form parsing.
                }
            }

            resolve(parsed);
        });
        req.on('error', reject);
    });
}

function isAuthorizedAdmin(req) {
    const expectedToken = process.env.ADMIN_TOKEN || '';
    if (!expectedToken) {
        return true;
    }

    const authHeader = req.headers.authorization || '';
    return authHeader === `Bearer ${expectedToken}`;
}

function sendTwiml(res, body) {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(body);
}

function handleVoiceRequest(req, res, body) {
    const phoneNumber = body.From || body.phoneNumber || 'unknown-caller';
    const digits = body.Digits || body.digits || '';

    if (req.url === '/voice/live-continue') {
        // Reached when one live chunk finishes and the caller didn't press
        // anything - loop back for the next chunk. Silent (message is null)
        // while still live; gracefully falls back to the menu once it ends.
        const liveResult = service.selectLiveStream(phoneNumber);
        sendTwiml(res, service.buildLiveStreamTwiML(liveResult.message, liveResult.audioUrl));
        return;
    }

    if (req.url === '/voice/playback') {
        const action = service.handlePlaybackControl(phoneNumber, digits);

        if (action.type === 'menu') {
            sendTwiml(res, service.buildMenuTwiML(action.message));
            return;
        }

        if (action.type === 'paused') {
            sendTwiml(res, service.buildPausedTwiML(action.message));
            return;
        }

        if (action.type === 'live-resume') {
            sendTwiml(res, service.buildLiveStreamTwiML(null, buildLivePlaybackUrl(req)));
            return;
        }

        const playUrl = buildRecordingPlaybackUrl(req, action.recordingId, action.positionSeconds, phoneNumber);
        sendTwiml(res, service.buildPlaybackTwiML(null, playUrl));
        return;
    }

    if (digits) {
        if (digits === '1') {
            const liveResult = service.selectLiveStream(phoneNumber);
            sendTwiml(res, service.buildLiveStreamTwiML(liveResult.message, liveResult.audioUrl));
            return;
        }

        if (digits >= '2' && digits <= '6') {
            const recordingResult = service.selectRecording(phoneNumber, digits);
            if (recordingResult.type === 'error') {
                sendTwiml(res, service.buildMenuTwiML(recordingResult.message));
                return;
            }
            const playUrl = buildRecordingPlaybackUrl(req, recordingResult.recordingId, recordingResult.positionSeconds, phoneNumber);
            sendTwiml(res, service.buildPlaybackTwiML(recordingResult.message, playUrl));
            return;
        }

        if (digits === '7') {
            sendTwiml(res, service.buildControlsInfoTwiML());
            return;
        }
    }

    sendTwiml(res, service.buildMenuTwiML());
}

const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, streamer: service.streamerName, streamerHandle: 'Destiny' }));
        return;
    }

    // Reports whether the headless-browser Kick check is working from this
    // deployment's network, without leaking anything sensitive.
    if (req.url === '/diagnostics/kick') {
        const slug = KICK_CHANNEL || 'destiny';
        try {
            const result = await kickBrowser.checkLiveStatus(slug);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...result }));
        } catch (error) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: error.message }));
        }
        return;
    }

    // Runs the exact same resolve-then-ffmpeg-fetch path a real call uses,
    // but outside of Twilio - so nothing kills ffmpeg early and we can see
    // its full output (or lack thereof) to tell apart "too slow" from
    // "can't reach the URL at all" from Render's network.
    if (req.url === '/diagnostics/vod-fetch') {
        const recording = service.state.recordings.find((entry) => entry.kickVideoId && !entry.live);
        if (!recording) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'No archived Kick recording available to test with' }));
            return;
        }

        const startedAt = Date.now();
        let audioUrl;
        try {
            audioUrl = await resolveRecordingAudioUrl(recording);
        } catch (error) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, stage: 'resolve', error: error.message, resolveMs: Date.now() - startedAt }));
            return;
        }
        const resolveMs = Date.now() - startedAt;

        // Exactly the same args /recordings/:id/play uses in production
        // (including -ss and real mp3 encoding, not a discarded null output),
        // so any failure here reproduces the real bug, not a simplified version of it.
        const ffmpegStartedAt = Date.now();
        const proc = spawn(FFMPEG_PATH, [
            '-loglevel', 'verbose',
            '-ss', '0',
            '-i', audioUrl,
            '-t', String(ARCHIVE_CHUNK_SECONDS),
            '-vn',
            '-c:a', 'libmp3lame',
            '-b:a', '96k',
            '-ar', '44100',
            '-f', 'mp3',
            '-'
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderr = '';
        let stdoutBytes = 0;
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.stdout.on('data', (chunk) => {
            stdoutBytes += chunk.length;
        });

        const result = await new Promise((resolve) => {
            const hardTimeout = setTimeout(() => {
                proc.kill('SIGKILL');
                resolve({ timedOut: true });
            }, 25000);
            proc.on('exit', (code) => {
                clearTimeout(hardTimeout);
                resolve({ code });
            });
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            recordingTitle: recording.title,
            stdoutBytes,
            resolveMs,
            ffmpegMs: Date.now() - ffmpegStartedAt,
            ffmpegExitCode: result.code ?? null,
            ffmpegTimedOut: Boolean(result.timedOut),
            stderrTail: stderr.slice(-2500)
        }));
        return;
    }

    // Shows the current archive list (metadata only, no playback URLs) so we
    // can tell whether pollKickVideos has actually populated anything without
    // needing a real phone call to find out.
    if (req.url === '/diagnostics/recordings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            isLive: service.state.isLive,
            recordings: service.state.recordings.map((entry) => ({
                id: entry.id,
                title: entry.title,
                live: entry.live,
                kickVideoId: entry.kickVideoId || null,
                durationSeconds: entry.durationSeconds,
                startedAt: entry.startedAt
            }))
        }));
        return;
    }

    // Temporary: shows exactly what this container sees for the Chromium
    // cache location, to tell apart "the fix didn't deploy" from "the fix
    // deployed but doesn't work". Safe to remove once the Chrome issue is resolved.
    if (req.url === '/diagnostics/env') {
        const cacheDir = process.env.PUPPETEER_CACHE_DIR || null;
        let dirListing = null;
        let dirError = null;
        if (cacheDir) {
            try {
                dirListing = fs.readdirSync(cacheDir, { recursive: true });
            } catch (error) {
                dirError = error.message;
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            PUPPETEER_CACHE_DIR: cacheDir,
            HOME: process.env.HOME || null,
            dirListing,
            dirError
        }));
        return;
    }

    if (req.url === '/live.mp3' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!liveRelayUrl) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Live stream source not configured.' }));
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Connection': 'close',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        startLiveTranscode(liveRelayUrl);

        // Replay the catch-up buffer so this request produces audio
        // immediately instead of waiting on the next data event from the
        // (already-connected, persistent) transcode process. With the buffer
        // window kept above LIVE_CHUNK_SECONDS, this alone usually covers a
        // full chunk, so the response below can close (and become playable
        // to Twilio) right away instead of waiting on live data to trickle in.
        for (const { chunk } of liveTranscodeBuffer) {
            res.write(chunk);
            res.__liveBytesSent = (res.__liveBytesSent || 0) + chunk.length;
        }

        if (res.__liveBytesSent >= LIVE_CHUNK_BYTES) {
            res.end();
            return;
        }

        activeLiveRequests.add(res);

        // Safety net only - normal completion happens the instant this
        // response hits LIVE_CHUNK_BYTES (see startLiveTranscode's data
        // handler). This just guards against the transcoder stalling.
        const closeTimer = setTimeout(() => {
            activeLiveRequests.delete(res);
            if (!res.writableEnded) {
                res.end();
            }
        }, (LIVE_CHUNK_SECONDS + 15) * 1000);
        res.__liveCloseTimer = closeTimer;

        req.on('close', () => {
            clearTimeout(closeTimer);
            activeLiveRequests.delete(res);
        });
        return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && req.url.startsWith('/recordings/')) {
        const match = req.url.match(/^\/recordings\/([^/?]+)\/play(?:\?(.*))?$/);
        const recordingId = match ? decodeURIComponent(match[1]) : null;
        const recording = recordingId
            ? service.state.recordings.find((entry) => entry.id === recordingId && !entry.live)
            : null;

        if (!recording || !recording.audioUrl) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Recording not available' }));
            return;
        }

        const query = new URLSearchParams(match[2] || '');
        const start = Math.max(0, Number(query.get('start')) || 0);
        const caller = query.get('caller') || 'unknown-caller';

        let audioUrl;
        try {
            audioUrl = await resolveRecordingAudioUrl(recording);
        } catch (error) {
            console.error(`Failed to resolve playback URL for recording ${recording.id}: ${error.message}`);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Could not resolve playback URL' }));
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Connection': 'close',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        // Reuse this caller's existing session if it's the same recording and
        // picking up right where its persistent transcode has actually gotten
        // to (a natural chunk-boundary continuation) - only a real seek/jump
        // or a switch to a different recording pays the reconnect+reseek cost.
        let session = archiveSessions.get(caller);
        if (session) {
            const expectedPosition = session.startSeconds + (session.bytesProducedTotal / ARCHIVE_AUDIO_BYTES_PER_SECOND);
            const reusable = session.recordingId === recordingId
                && session.process
                && !session.process.killed
                && Math.abs(expectedPosition - start) <= ARCHIVE_POSITION_TOLERANCE_SECONDS;
            if (!reusable) {
                session = null;
            }
        }
        if (!session) {
            session = startArchiveSession(caller, recordingId, audioUrl, start);
        }

        attachArchiveResponse(session, res);

        req.on('close', () => {
            if (session.currentRes === res) {
                session.currentRes = null;
            }
        });

        return;
    }

    if (req.method === 'POST' && req.url === '/voice') {
        const body = await parseBody(req);
        handleVoiceRequest(req, res, body);
        return;
    }

    if (req.method === 'POST' && req.url === '/voice/menu') {
        const body = await parseBody(req);
        handleVoiceRequest(req, res, body);
        return;
    }

    if (req.method === 'POST' && req.url === '/voice/playback') {
        const body = await parseBody(req);
        handleVoiceRequest(req, res, body);
        return;
    }

    if (req.method === 'POST' && req.url === '/voice/live-continue') {
        const body = await parseBody(req);
        handleVoiceRequest(req, res, body);
        return;
    }

    if (req.method === 'POST' && req.url === '/admin/stream/live') {
        if (!isAuthorizedAdmin(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
            return;
        }

        const body = await parseBody(req);
        liveRelayUrl = body.audioUrl || liveRelayUrl;
        stopLiveTranscode();
        startLiveTranscode(liveRelayUrl);

        const recording = service.startStream({ audioUrl: buildLivePlaybackUrl(req), sourceUrl: liveRelayUrl });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, recording, livePlaybackUrl: buildLivePlaybackUrl(req) }));
        return;
    }

    if (req.method === 'POST' && req.url === '/admin/stream/stop') {
        if (!isAuthorizedAdmin(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
            return;
        }

        const result = service.endStream();
        stopLiveTranscode();
        liveRelayUrl = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
        return;
    }

    if (req.method === 'POST' && req.url === '/admin/stream/recording') {
        if (!isAuthorizedAdmin(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
            return;
        }

        const body = await parseBody(req);
        const recording = service.addRecording({ title: body.title, audioUrl: body.audioUrl || null });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, recording }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
    console.log(`Phone service listening on port ${port}`);
    console.log(`Streamer configured: ${service.streamerName}`);

    if (KICK_CHANNEL) {
        console.log(`Auto-detecting live status for Kick channel "${KICK_CHANNEL}" every ${KICK_POLL_INTERVAL_MS}ms`);
        pollKickChannel();
        setInterval(pollKickChannel, KICK_POLL_INTERVAL_MS);

        console.log(`Checking for new archived streams every ${KICK_VIDEOS_POLL_INTERVAL_MS}ms`);
        pollKickVideos();
        setInterval(pollKickVideos, KICK_VIDEOS_POLL_INTERVAL_MS);

        // pollKickVideos already warms the cache for anything newly archived;
        // this just keeps already-archived entries from going stale before a
        // caller needs them.
        console.log(`Refreshing archived-stream playback URLs every ${KICK_VOD_REFRESH_INTERVAL_MS}ms`);
        setInterval(refreshVodCache, KICK_VOD_REFRESH_INTERVAL_MS);
    } else {
        console.log('KICK_CHANNEL not set - start/stop the live stream manually via POST /admin/stream/live and /admin/stream/stop');
    }

    // Sweeps archive sessions nobody has reattached to in a while (hangup,
    // switched recordings, went to the menu) so their ffmpeg process and Kick
    // CDN connection don't stay open indefinitely.
    setInterval(() => {
        const now = Date.now();
        for (const [phoneNumber, session] of archiveSessions) {
            if (!session.currentRes && now - session.lastAttachedAt > ARCHIVE_SESSION_IDLE_MS) {
                stopArchiveSession(phoneNumber);
            }
        }
    }, 30000);
});

async function shutdown() {
    stopLiveTranscode();
    for (const phoneNumber of Array.from(archiveSessions.keys())) {
        stopArchiveSession(phoneNumber);
    }
    await kickBrowser.shutdown();
    server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
