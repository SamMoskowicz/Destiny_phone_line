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

const liveRelayClients = new Set();
let liveRelayProcess = null;
let liveRelayUrl = process.env.LIVE_HLS_URL || null;

function startLiveRelay(hlsUrl) {
    if (!hlsUrl || liveRelayProcess) {
        return;
    }

    const proc = spawn(FFMPEG_PATH, [
        '-re',
        '-i', hlsUrl,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '96k',
        '-ar', '44100',
        '-f', 'mp3',
        '-'
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    liveRelayProcess = proc;

    proc.on('error', (error) => {
        console.error('live relay ffmpeg error:', error);
    });

    // Guarded with `liveRelayProcess === proc` because kill() is async: if this
    // process was already replaced by stopLiveRelay()+startLiveRelay(), its
    // delayed exit must not null out the newer process or drop its listeners.
    proc.on('exit', (code, signal) => {
        console.error(`live relay ffmpeg exited with code=${code} signal=${signal}`);
        if (liveRelayProcess === proc) {
            for (const res of liveRelayClients) {
                if (!res.writableEnded) {
                    res.end();
                }
            }
            liveRelayClients.clear();
            liveRelayProcess = null;
        }
    });

    proc.stdout.on('data', (chunk) => {
        if (liveRelayProcess !== proc) {
            return;
        }
        for (const res of liveRelayClients) {
            const ok = res.write(chunk);
            if (!ok) {
                // backpressure is handled by Node streams
            }
        }
    });

    proc.stdout.on('end', () => {
        if (liveRelayProcess === proc) {
            for (const res of liveRelayClients) {
                res.end();
            }
            liveRelayClients.clear();
        }
    });
}

function stopLiveRelay() {
    if (liveRelayProcess) {
        liveRelayProcess.kill('SIGKILL');
        liveRelayProcess = null;
    }
    for (const res of liveRelayClients) {
        if (!res.writableEnded) {
            res.end();
        }
    }
    liveRelayClients.clear();
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

function buildRecordingPlaybackUrl(req, recordingId, startSeconds) {
    const baseUrl = getRequestBaseUrl(req) || `http://localhost:${process.env.PORT || 3000}`;
    const start = Math.max(0, Math.floor(startSeconds || 0));
    return `${baseUrl}/recordings/${encodeURIComponent(recordingId)}/play?start=${start}`;
}

function ensureLiveRelay() {
    if (!liveRelayUrl) {
        return;
    }
    if (!liveRelayProcess) {
        startLiveRelay(liveRelayUrl);
    }
}

async function pollKickChannel() {
    // Runs every 90s forever, so unlike the archiving polls this one can't
    // just be delayed until nobody's listening - it would starve a long call
    // repeatedly. Skipping it while someone's live means we won't notice the
    // stream ending mid-call, but ffmpeg will exit on its own once the source
    // actually goes away, which the existing exit handler already covers.
    if (liveRelayClients.size > 0) {
        return;
    }
    try {
        const { isLive, hlsUrl } = await kickBrowser.checkLiveStatus(KICK_CHANNEL);

        if (isLive && hlsUrl) {
            // Only start a fresh "recording" on an offline->live transition. A
            // mid-broadcast URL refresh (Kick can rotate the token) should just
            // restart the relay, not spam the 5-slot archive list with duplicates.
            if (liveRelayUrl !== hlsUrl) {
                liveRelayUrl = hlsUrl;
                stopLiveRelay();
                ensureLiveRelay();
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
            stopLiveRelay();
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
    if (liveRelayClients.size > 0) {
        return;
    }
    try {
        const videoIds = await kickBrowser.listRecentVideoIds(KICK_CHANNEL, 5);
        for (const videoId of videoIds) {
            // Re-checked per video (not just once at the top) - archiving all
            // 5 can take minutes, and a caller can connect to the live stream
            // partway through an already-running poll.
            if (liveRelayClients.size > 0) {
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
    if (liveRelayClients.size > 0) {
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

    if (req.url === '/voice/playback') {
        const action = service.handlePlaybackControl(phoneNumber, digits);

        if (action.type === 'menu') {
            sendTwiml(res, service.buildMenuTwiML());
            return;
        }

        if (action.type === 'paused') {
            sendTwiml(res, service.buildPausedTwiML(action.message));
            return;
        }

        if (action.type === 'live-resume') {
            ensureLiveRelay();
            sendTwiml(res, service.buildLiveStreamTwiML(null, buildLivePlaybackUrl(req)));
            return;
        }

        const playUrl = buildRecordingPlaybackUrl(req, action.recordingId, action.positionSeconds);
        sendTwiml(res, service.buildPlaybackTwiML(null, playUrl));
        return;
    }

    if (digits) {
        if (digits === '1') {
            const liveResult = service.selectLiveStream(phoneNumber);
            if (liveResult.audioUrl) {
                ensureLiveRelay();
            }
            sendTwiml(res, service.buildLiveStreamTwiML(liveResult.message, liveResult.audioUrl));
            return;
        }

        if (digits >= '2' && digits <= '6') {
            const recordingResult = service.selectRecording(phoneNumber, digits);
            if (recordingResult.type === 'error') {
                sendTwiml(res, service.buildMenuTwiML(recordingResult.message));
                return;
            }
            const playUrl = buildRecordingPlaybackUrl(req, recordingResult.recordingId, recordingResult.positionSeconds);
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

        ensureLiveRelay();
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

        liveRelayClients.add(res);
        req.on('close', () => {
            liveRelayClients.delete(res);
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

        // Seeking into a static recording is a one-off per-caller ffmpeg process
        // (unlike the fan-out live relay) since each caller can be at a different
        // position - -ss before -i does an efficient input-side seek.
        const proc = spawn(FFMPEG_PATH, [
            '-ss', String(start),
            '-i', audioUrl,
            '-vn',
            '-c:a', 'libmp3lame',
            '-b:a', '96k',
            '-ar', '44100',
            '-f', 'mp3',
            '-'
        ], { stdio: ['ignore', 'pipe', 'inherit'] });

        proc.on('error', (error) => {
            console.error('recording relay error:', error);
            if (!res.writableEnded) {
                res.end();
            }
        });

        proc.stdout.pipe(res);

        req.on('close', () => {
            proc.kill('SIGKILL');
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

    if (req.method === 'POST' && req.url === '/admin/stream/live') {
        if (!isAuthorizedAdmin(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
            return;
        }

        const body = await parseBody(req);
        liveRelayUrl = body.audioUrl || liveRelayUrl;
        stopLiveRelay();
        ensureLiveRelay();

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
        stopLiveRelay();
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
});

async function shutdown() {
    stopLiveRelay();
    await kickBrowser.shutdown();
    server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
