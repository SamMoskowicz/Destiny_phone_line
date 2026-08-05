const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { PhoneService, escapeXml } = require('./src/phoneService');
const { AiService } = require('./src/aiService');
const {
    createSafetyIdentifier,
    DualWindowRateLimiter,
    ExpiringIdempotencyCache,
    EphemeralSessionTokenStore
} = require('./src/aiSecurity');
const { TwilioSecurity, normalizeBaseUrl } = require('./src/twilioSecurity');
const { RealtimeVoiceBridge } = require('./src/realtimeVoiceBridge');
const { ConsentStore } = require('./src/consentStore');
const { AiMemoryStore } = require('./src/aiMemoryStore');
const { formatAiSms, smsMetrics } = require('./src/smsUtils');
const kickBrowser = require('./src/kickBrowser');
const hlsFetch = require('./src/hlsFetch');

// Prefer an explicit system ffmpeg (set via Dockerfile on Render) over the
// bundled @ffmpeg-installer/ffmpeg binary - see Dockerfile for why.
const FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegInstaller.path;

const service = new PhoneService({
    streamerName: process.env.STREAMER_NAME || 'Destiny',
    storageFile: process.env.PHONE_SERVICE_STATE_FILE || undefined
});

// When explicitly enabled, recent text transcripts and compact caller memory
// are encrypted before persistence. Raw phone numbers and call audio are not
// stored in the AI memory file.
const AI_SAFETY_SALT_CONFIGURED = String(process.env.AI_SAFETY_SALT || '').trim().length >= 32;
const AI_SAFETY_SALT = process.env.AI_SAFETY_SALT || 'ai-disabled-without-stable-salt';
const AI_MEMORY_REQUIRED = process.env.AI_MEMORY_ENABLED === 'true';
const aiMemoryStore = new AiMemoryStore();
const aiService = new AiService({ memoryStore: aiMemoryStore });
const twilioSecurity = new TwilioSecurity();
const consentStore = new ConsentStore();
const aiSessionTokens = new EphemeralSessionTokenStore();
const smsIdempotency = new ExpiringIdempotencyCache();
const smsUserLimiter = new DualWindowRateLimiter({
    shortLimit: Number(process.env.AI_SMS_PER_MINUTE || 3),
    shortWindowMs: 60 * 1000,
    longLimit: Number(process.env.AI_SMS_PER_DAY || 20)
});
const smsGlobalLimiter = new DualWindowRateLimiter({
    shortLimit: Number(process.env.AI_SMS_GLOBAL_PER_HOUR || 500),
    shortWindowMs: 60 * 60 * 1000,
    longLimit: Number(process.env.AI_SMS_GLOBAL_PER_DAY || 5000)
});
const smsNoticeLimiter = new DualWindowRateLimiter({
    shortLimit: 1,
    shortWindowMs: 60 * 60 * 1000,
    longLimit: 3,
    longWindowMs: 24 * 60 * 60 * 1000
});
const smsOutboundLimiter = new DualWindowRateLimiter({
    shortLimit: Number(process.env.AI_SMS_OUTBOUND_SEGMENTS_PER_HOUR || 1500),
    shortWindowMs: 60 * 60 * 1000,
    longLimit: Number(process.env.AI_SMS_OUTBOUND_SEGMENTS_PER_DAY || 10000),
    longWindowMs: 24 * 60 * 60 * 1000
});
const smsDeliveryGuard = new DualWindowRateLimiter({
    shortLimit: 1,
    shortWindowMs: 24 * 60 * 60 * 1000,
    longLimit: 1,
    longWindowMs: 24 * 60 * 60 * 1000,
    maxKeys: 50000
});
const AI_SMS_MAX_CONCURRENT = Math.max(1, Math.min(100, Number(process.env.AI_SMS_MAX_CONCURRENT || 10) || 10));
let activeSmsAiRequests = 0;
const voiceStartLimiter = new DualWindowRateLimiter({
    shortLimit: Number(process.env.AI_VOICE_STARTS_PER_10_MINUTES || 3),
    shortWindowMs: 10 * 60 * 1000,
    longLimit: Number(process.env.AI_VOICE_STARTS_PER_DAY || 10)
});
const aiVoiceBridge = new RealtimeVoiceBridge({
    apiKey: AI_SAFETY_SALT_CONFIGURED ? process.env.OPENAI_API_KEY : null,
    aiService,
    tokenStore: aiSessionTokens,
    twilioSecurity
});

const KICK_CHANNEL = process.env.KICK_CHANNEL || null;
const KICK_POLL_INTERVAL_MS = Number(process.env.KICK_POLL_INTERVAL_MS || 90000);
// A perfectly exact interval, forever, is itself a machine-like pattern - the
// video-archiving poll (unlike the live-status poll, which needs to be
// reasonably prompt) has no real reason to be that predictable, so it's
// scheduled at a random point within [min, max] instead of a fixed tick.
const KICK_VIDEOS_POLL_MIN_INTERVAL_MS = Number(process.env.KICK_VIDEOS_POLL_INTERVAL_MS || 900000);
const KICK_VIDEOS_POLL_MAX_INTERVAL_MS = Number(
    process.env.KICK_VIDEOS_POLL_MAX_INTERVAL_MS || KICK_VIDEOS_POLL_MIN_INTERVAL_MS * 2
);
const KICK_VOD_URL_TTL_MS = 45 * 60 * 1000;
// How far ahead of actually going stale (KICK_VOD_URL_TTL_MS) a cached
// playback URL gets proactively refreshed - wide enough that a warming pass
// every ~15-30 min (the video-poll cadence) reliably catches it before a
// caller would ever hit the slow/fragile on-demand path.
const KICK_VOD_WARM_MARGIN_MS = 15 * 60 * 1000;

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
        // Kick's signed segment URLs don't end in a recognized media
        // extension (e.g. .../production-kick-vod/<uuid>/0/0, no .ts
        // suffix) - ffmpeg's HLS demuxer rejects fetching those by default
        // (its own "not in allowed_segment_extensions" error) unless told
        // to allow them.
        '-allowed_extensions', 'ALL',
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

// Kick's HLS segments are fetched and piped in ourselves (see hlsFetch.js)
// rather than handed to ffmpeg as a URL to fetch on its own - some of them
// have no file extension, which trips ffmpeg's HLS demuxer safety check
// (confirmed reproducible across multiple recordings, not a one-off), and
// the top-level manifest URL itself needs browser-context fetching (a plain
// request gets a 403). ffmpeg here only transcodes a raw byte stream fed to
// its stdin - it never fetches or evaluates any of these URLs itself.
//
// `playbackSource` is either a resolved segment array (Kick-sourced
// recordings) or a plain URL string (admin-added recordings with a direct
// link and no Kick video ID) - the latter still lets ffmpeg fetch/seek the
// URL itself, since there's no Kick manifest involved to trip on.
function startArchiveSession(phoneNumber, recordingId, playbackSource, startSeconds) {
    stopArchiveSession(phoneNumber);

    const segments = Array.isArray(playbackSource) ? playbackSource : null;

    const proc = segments
        ? spawn(FFMPEG_PATH, [
            '-f', 'mpegts',
            '-i', 'pipe:0',
            '-vn',
            '-c:a', 'libmp3lame',
            '-b:a', '96k',
            '-ar', '44100',
            '-f', 'mp3',
            '-'
        ], { stdio: ['pipe', 'pipe', 'inherit'] })
        : spawn(FFMPEG_PATH, [
            '-ss', String(startSeconds),
            '-i', playbackSource,
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

    if (segments) {
        // ffmpeg exits (EPIPE) if we're still writing to stdin when it's
        // killed or exits on its own - swallow it here so it doesn't crash
        // the process; the 'exit' handler above already does real cleanup.
        proc.stdin.on('error', () => {});

        let elapsed = 0;
        let startIndex = 0;
        for (; startIndex < segments.length; startIndex++) {
            if (elapsed >= startSeconds) {
                break;
            }
            elapsed += segments[startIndex].duration;
        }
        feedSegmentsToStdin(proc, segments, startIndex).catch((error) => {
            console.error(`Failed to feed archive segments for ${phoneNumber}: ${error.message}`);
            if (!proc.killed) {
                proc.kill('SIGKILL');
            }
        });
    }

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

// Fetches segments in order starting at startIndex and writes their raw
// bytes to ffmpeg's stdin, honoring backpressure (waiting on 'drain' rather
// than buffering the whole VOD in Node memory) - the same throttling
// philosophy as the stdout side. A single bad segment is skipped rather than
// aborting the whole session, since one failed fetch shouldn't kill an
// otherwise-working stream.
async function feedSegmentsToStdin(proc, segments, startIndex) {
    for (let i = startIndex; i < segments.length; i++) {
        if (proc.killed || proc.stdin.destroyed) {
            return;
        }
        let buffer;
        try {
            buffer = await hlsFetch.fetchSegmentBuffer(segments[i].url);
        } catch (error) {
            console.error(`Failed to fetch archive segment: ${error.message}`);
            continue;
        }
        if (proc.killed || proc.stdin.destroyed) {
            return;
        }
        const canWriteMore = proc.stdin.write(buffer);
        if (!canWriteMore) {
            await new Promise((resolve) => proc.stdin.once('drain', resolve));
        }
    }
    if (!proc.stdin.destroyed) {
        proc.stdin.end();
    }
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
    const configured = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL);
    if (configured) {
        return configured;
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

function buildRecordingPlaybackUrl(req, recordingId, startSeconds, phoneNumber, isContinue = false) {
    const baseUrl = getRequestBaseUrl(req) || `http://localhost:${process.env.PORT || 3000}`;
    const start = Math.max(0, Math.floor(startSeconds || 0));
    const caller = encodeURIComponent(phoneNumber || 'unknown-caller');
    const continueParam = isContinue ? '&continue=1' : '';
    return `${baseUrl}/recordings/${encodeURIComponent(recordingId)}/play?start=${start}&caller=${caller}${continueParam}`;
}

async function pollKickChannel() {
    // Runs every 90s forever, so unlike the archiving polls this one can't
    // just be delayed until nobody's listening - it would starve a long call
    // repeatedly. Skipping it while someone's live means we won't notice the
    // stream ending mid-call, but the transcode process will exit on its own
    // once the source actually goes away, which its exit handler covers.
    if (activeLiveRequests.size > 0 || aiVoiceBridge.activeSessionCount > 0) {
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

// Hitting several video pages in one run - even spaced out - is still more
// requests to Kick's more heavily bot-protected video-detail route than a
// single visit. So each poll cycle attempts at most ONE not-yet-archived
// video (newest first); the next-oldest one only gets tried on a later
// cycle, once the randomized poll interval fires again. Catching up on
// several missing recordings now takes multiple cycles instead of one run,
// which is the intentional trade for looking as little like a scripted
// crawler as possible. A video that just failed isn't retried again for an
// hour, so a Cloudflare block on one doesn't get re-triggered every cycle.
const KICK_VIDEO_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const recentlyFailedKickVideoIds = new Map(); // videoId -> failedAt
let pollingVideosInProgress = false;

async function pollKickVideos() {
    // Chrome (Puppeteer) and ffmpeg competing for the same CPU core can stall
    // audio delivery to an actively-listening caller badly enough that Twilio
    // gives up on the stream - defer background archiving until nobody's live.
    if (activeLiveRequests.size > 0 || aiVoiceBridge.activeSessionCount > 0) {
        return;
    }
    if (pollingVideosInProgress) {
        return;
    }
    pollingVideosInProgress = true;
    try {
        const videoIds = await kickBrowser.listRecentVideoIds(KICK_CHANNEL, 5);
        const nextVideoId = videoIds.find((videoId) => {
            if (archivedKickVideoIds.has(videoId)) {
                return false;
            }
            const failedAt = recentlyFailedKickVideoIds.get(videoId);
            return !failedAt || Date.now() - failedAt >= KICK_VIDEO_RETRY_BACKOFF_MS;
        });

        if (nextVideoId) {
            try {
                const info = await kickBrowser.getVodPlaybackInfo(KICK_CHANNEL, nextVideoId);
                service.addRecording({
                    title: info.title || `${service.streamerName} archived stream`,
                    audioUrl: info.audioUrl,
                    durationSeconds: info.durationSeconds || 0,
                    kickVideoId: nextVideoId,
                    broadcastStartedAt: info.broadcastStartedAt || null
                });
                archivedKickVideoIds.add(nextVideoId);
                recentlyFailedKickVideoIds.delete(nextVideoId);
                // Reuse the segments we just paid the Puppeteer cost to
                // resolve, so the cache is already warm - a caller shouldn't
                // be the one to trigger the first (slow) resolution.
                vodUrlCache.set(nextVideoId, { segments: info.segments, resolvedAt: Date.now() });
                console.log(`Archived Kick video ${nextVideoId}: ${info.title}`);
            } catch (error) {
                recentlyFailedKickVideoIds.set(nextVideoId, Date.now());
                console.error(`Failed to archive Kick video ${nextVideoId}: ${error.message}`);
            }
            return;
        }

        // Nothing new to discover this cycle - spend this same one-visit
        // budget keeping an existing recording's cached playback URL warm
        // instead, so a caller pressing play isn't the one who discovers
        // Cloudflare is blocking a resolution. Still just one Kick
        // video-page visit per cycle either way, never both in the same run.
        await warmStalestVodUrl();
    } catch (error) {
        console.error(`Kick videos poll failed: ${error.message}`);
    } finally {
        pollingVideosInProgress = false;
    }
}

async function warmStalestVodUrl() {
    const kickRecordings = service.state.recordings.filter((entry) => entry.kickVideoId && !entry.live);
    let target = null;
    let targetAge = -1;
    for (const recording of kickRecordings) {
        const cached = vodUrlCache.get(recording.kickVideoId);
        const age = cached ? Date.now() - cached.resolvedAt : Infinity;
        if (age > targetAge) {
            targetAge = age;
            target = recording;
        }
    }
    if (!target || (targetAge !== Infinity && targetAge < KICK_VOD_URL_TTL_MS - KICK_VOD_WARM_MARGIN_MS)) {
        return;
    }
    try {
        const info = await kickBrowser.getVodPlaybackInfo(KICK_CHANNEL, target.kickVideoId);
        vodUrlCache.set(target.kickVideoId, { segments: info.segments, resolvedAt: Date.now() });
        console.log(`Pre-warmed playback URL for Kick video ${target.kickVideoId}`);
    } catch (error) {
        console.error(`Failed to warm playback URL for ${target.kickVideoId}: ${error.message}`);
    }
}

function scheduleNextKickVideosPoll() {
    const delay = KICK_VIDEOS_POLL_MIN_INTERVAL_MS
        + Math.random() * (KICK_VIDEOS_POLL_MAX_INTERVAL_MS - KICK_VIDEOS_POLL_MIN_INTERVAL_MS);
    setTimeout(async () => {
        await pollKickVideos();
        scheduleNextKickVideosPoll();
    }, delay);
}

// The VOD manifest Kick hands back is signed with a token that expires ~1
// hour after issuance, so the resolved segment list can't be stored
// permanently like an admin-provided direct link. It's kept warm by
// pollKickVideos, both at archive time and via warmStalestVodUrl's gentle
// one-at-a-time background refresh - a caller pressing play should almost
// always hit a cache that's already fresh, since a resolution failing (e.g.
// a Cloudflare block) right when someone's actually trying to listen is the
// worst time for it to happen. resolveRecordingPlayback below is still the
// on-demand fallback for whatever the background pass hasn't gotten to yet.
const vodUrlCache = new Map();

// Returns either { segments } for a Kick-sourced recording (resolved via
// kickBrowser/hlsFetch - see startArchiveSession) or { audioUrl } for an
// admin-added recording with a plain direct link and no Kick video ID.
async function resolveRecordingPlayback(recording) {
    if (!recording.kickVideoId) {
        return { audioUrl: recording.audioUrl };
    }

    const cached = vodUrlCache.get(recording.kickVideoId);
    if (cached && Date.now() - cached.resolvedAt < KICK_VOD_URL_TTL_MS) {
        return { segments: cached.segments };
    }

    const info = await kickBrowser.getVodPlaybackInfo(KICK_CHANNEL, recording.kickVideoId);
    vodUrlCache.set(recording.kickVideoId, { segments: info.segments, resolvedAt: Date.now() });
    return { segments: info.segments };
}

class HttpRequestError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
    }
}

function parseBody(req, maxBytes = 16 * 1024) {
    return new Promise((resolve, reject) => {
        const declaredLength = Number(req.headers['content-length'] || 0);
        if (declaredLength > maxBytes) {
            req.resume();
            reject(new HttpRequestError('Request body is too large', 413));
            return;
        }

        const chunks = [];
        let bytes = 0;
        let settled = false;
        req.on('data', (chunk) => {
            if (settled) {
                return;
            }
            bytes += chunk.length;
            if (bytes > maxBytes) {
                settled = true;
                req.resume();
                reject(new HttpRequestError('Request body is too large', 413));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) {
                return;
            }
            settled = true;
            const rawBody = Buffer.concat(chunks).toString('utf8');
            if (!rawBody) {
                resolve({});
                return;
            }

            const contentType = String(req.headers['content-type'] || '').toLowerCase();
            if (contentType.includes('application/json')) {
                try {
                    const parsed = JSON.parse(rawBody);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        throw new Error('JSON body must be an object');
                    }
                    resolve(parsed);
                } catch (error) {
                    reject(new HttpRequestError('Malformed JSON body', 400));
                }
                return;
            }

            const parsed = {};
            for (const [key, value] of new URLSearchParams(rawBody)) {
                if (Object.hasOwn(parsed, key)) {
                    parsed[key] = Array.isArray(parsed[key])
                        ? [...parsed[key], value]
                        : [parsed[key], value];
                } else {
                    parsed[key] = value;
                }
            }
            resolve(parsed);
        });
        req.on('error', (error) => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
    });
}

function getRequestPath(req) {
    return new URL(req.url, 'http://localhost').pathname;
}

function getBodyValue(body, name) {
    const value = body[name];
    return Array.isArray(value) ? value[value.length - 1] : value;
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

function buildSmsTwiML(message = null) {
    const messageXml = message === null ? '' : `<Message>${escapeXml(message)}</Message>`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${messageXml}</Response>`;
}

function sendSmsReply(res, messageSid, message = null) {
    if (message === null || !messageSid) {
        sendTwiml(res, buildSmsTwiML());
        return;
    }
    if (!smsDeliveryGuard.consume(messageSid).allowed) {
        sendTwiml(res, buildSmsTwiML());
        return;
    }
    const segmentCount = smsMetrics(message).segments;
    for (let index = 0; index < segmentCount; index += 1) {
        if (!smsOutboundLimiter.consume('global').allowed) {
            sendTwiml(res, buildSmsTwiML());
            return;
        }
    }
    sendTwiml(res, buildSmsTwiML(message));
}

function validateTwilioWebhook(req, res, body, { required = false } = {}) {
    if (!twilioSecurity.isConfigured()) {
        if (!required) {
            return true;
        }
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Twilio authentication is not configured');
        return false;
    }
    if (!twilioSecurity.validateHttpRequest(req, body)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return false;
    }
    return true;
}

function buildAiWebSocketUrl(req = null) {
    const baseUrl = getRequestBaseUrl(req);
    if (!baseUrl) {
        return null;
    }
    const url = new URL('/voice/ai-stream', `${baseUrl}/`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function normalizeCallerNumber(value) {
    const number = String(value || '').trim();
    return /^\+[1-9]\d{7,14}$/.test(number) ? number : null;
}

function isAiMemoryReady() {
    return !AI_MEMORY_REQUIRED || (
        AI_SAFETY_SALT_CONFIGURED
        && aiMemoryStore.isConfigured()
        && consentStore.isConfigured()
    );
}

const AI_MEMORY_SMS_HELP = 'ChatGPT answers questions sent to this number. Reply STOP to unsubscribe.';
const AI_MEMORY_UNAVAILABLE = 'ChatGPT memory is temporarily unavailable, so no AI conversation was processed. Please try again later.';

async function handleSmsRequest(req, res, body) {
    if (!validateTwilioWebhook(req, res, body, { required: true })) {
        return;
    }
    const from = String(getBodyValue(body, 'From') || '').trim().slice(0, 64);
    const normalizedFrom = normalizeCallerNumber(from);
    const messageSid = String(getBodyValue(body, 'MessageSid') || '').trim().slice(0, 128);
    const text = String(getBodyValue(body, 'Body') || '').trim().slice(0, 1600);
    const identitySource = AI_MEMORY_REQUIRED ? normalizedFrom : from;
    const safetyIdentifier = AI_SAFETY_SALT_CONFIGURED && identitySource
        ? createSafetyIdentifier(identitySource, AI_SAFETY_SALT)
        : null;
    const keyword = text.toUpperCase();
    const optOutType = String(getBodyValue(body, 'OptOutType') || '').toUpperCase();
    const stopKeywords = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
    const startKeywords = new Set(['START', 'UNSTOP']);

    if (optOutType === 'STOP' || stopKeywords.has(keyword)) {
        if (safetyIdentifier) {
            aiVoiceBridge.forgetUser(safetyIdentifier);
            if (!aiService.resetTextConversation(safetyIdentifier)) {
                console.warn('[ai-memory] stop_delete_failed');
            }
            if (!consentStore.optOut(safetyIdentifier)) {
                console.warn('[ai-preferences] stop_persist_failed');
            }
        }
        sendTwiml(res, buildSmsTwiML());
        return;
    }
    if (optOutType === 'START' || startKeywords.has(keyword)) {
        if (safetyIdentifier) {
            if (!aiService.resetTextConversation(safetyIdentifier)) {
                console.warn('[ai-memory] start_reset_failed');
            }
            const wasOptedOut = consentStore.isOptedOut(safetyIdentifier);
            if (wasOptedOut && !consentStore.optIn(safetyIdentifier)) {
                console.warn('[ai-preferences] start_persist_failed');
            }
        }
        sendTwiml(res, buildSmsTwiML());
        return;
    }
    if (['DELETE', 'FORGET', 'DELETE MEMORY', 'FORGET ME'].includes(keyword)) {
        let memoryCleared = false;
        if (safetyIdentifier) {
            aiVoiceBridge.forgetUser(safetyIdentifier);
            memoryCleared = aiService.resetTextConversation(safetyIdentifier);
        }
        sendSmsReply(
            res,
            messageSid,
            memoryCleared
                ? 'Your saved AI conversation memory for this number has been deleted. You can keep chatting or reply STOP to unsubscribe.'
                : 'I could not verify that your saved AI memory was deleted. Please try again later.'
        );
        return;
    }
    if (optOutType === 'HELP') {
        // Twilio Advanced Opt-Out supplies its own HELP confirmation.
        sendTwiml(res, buildSmsTwiML());
        return;
    }
    if (['HELP', 'INFO'].includes(keyword)) {
        if (safetyIdentifier && smsNoticeLimiter.consume(safetyIdentifier).allowed) {
            sendSmsReply(
                res,
                messageSid,
                AI_MEMORY_REQUIRED
                    ? AI_MEMORY_SMS_HELP
                    : 'ChatGPT answers questions sent to this number. Reply STOP to unsubscribe.'
            );
        } else {
            sendTwiml(res, buildSmsTwiML());
        }
        return;
    }
    if (!messageSid || !from) {
        sendTwiml(res, buildSmsTwiML());
        return;
    }
    if (AI_MEMORY_REQUIRED && !isAiMemoryReady()) {
        sendSmsReply(res, messageSid, AI_MEMORY_UNAVAILABLE);
        return;
    }
    if (AI_MEMORY_REQUIRED && !normalizedFrom) {
        sendTwiml(res, buildSmsTwiML());
        return;
    }
    if (!safetyIdentifier || consentStore.isOptedOut(safetyIdentifier)) {
        sendTwiml(res, buildSmsTwiML());
        return;
    }
    if (!text || !aiService.isConfigured()) {
        sendTwiml(res, buildSmsTwiML());
        return;
    }
    let message = null;
    try {
        message = await smsIdempotency.run(messageSid, async () => {
            const userLimit = smsUserLimiter.consume(safetyIdentifier);
            if (!userLimit.allowed) {
                return null;
            }
            const globalLimit = smsGlobalLimiter.consume('global');
            if (!globalLimit.allowed) {
                return null;
            }
            if (activeSmsAiRequests >= AI_SMS_MAX_CONCURRENT) {
                return null;
            }
            activeSmsAiRequests += 1;
            try {
                const answer = await aiService.replyToText({
                    safetyIdentifier,
                    text,
                    exchangeId: `sms-${messageSid}`
                });
                if (consentStore.isOptedOut(safetyIdentifier)) {
                    return null;
                }
                return formatAiSms(answer, { maxSegments: 3 });
            } catch (error) {
                if (error?.code === 'AI_CONVERSATION_RESET') {
                    return null;
                }
                console.warn('[ai-sms] response_failed', { code: String(error?.code || error?.status || 'unknown').slice(0, 80) });
                return null;
            } finally {
                activeSmsAiRequests -= 1;
            }
        });
    } catch (error) {
        if (error?.code !== 'IDEMPOTENCY_CAPACITY') {
            throw error;
        }
        message = null;
    }
    if (consentStore.isOptedOut(safetyIdentifier)) {
        message = null;
    }
    sendSmsReply(res, messageSid, message);
}

function startAiVoiceSession(req, res, body, phoneNumber) {
    const callSid = String(getBodyValue(body, 'CallSid') || '');
    const webSocketUrl = buildAiWebSocketUrl(req);
    if (!callSid || !webSocketUrl || !aiVoiceBridge.isConfigured() || !twilioSecurity.hasFixedPublicUrl()) {
        sendTwiml(res, service.buildMenuTwiML('ChatGPT voice is not configured yet.'));
        return;
    }
    if (!isAiMemoryReady()) {
        sendTwiml(res, service.buildMenuTwiML('ChatGPT memory is temporarily unavailable. Please try again later.'));
        return;
    }
    const normalizedPhoneNumber = normalizeCallerNumber(phoneNumber);
    if (AI_MEMORY_REQUIRED && !normalizedPhoneNumber) {
        sendTwiml(res, service.buildMenuTwiML('ChatGPT memory requires caller ID. Please call again without blocking your number.'));
        return;
    }
    if (aiVoiceBridge.activeSessionCount >= aiVoiceBridge.maxSessions) {
        sendTwiml(res, service.buildMenuTwiML('ChatGPT voice is busy. Please try again shortly.'));
        return;
    }
    const safetyIdentifier = createSafetyIdentifier(
        AI_MEMORY_REQUIRED ? normalizedPhoneNumber : phoneNumber,
        AI_SAFETY_SALT
    );
    const limit = voiceStartLimiter.consume(safetyIdentifier);
    if (!limit.allowed) {
        sendTwiml(res, service.buildMenuTwiML('The AI call limit has been reached for now.'));
        return;
    }
    const sessionToken = aiSessionTokens.issue({ callSid, safetyIdentifier });
    sendTwiml(res, service.buildAiStreamTwiML(webSocketUrl, sessionToken));
}

function handleVoiceRequest(req, res, body) {
    const phoneNumber = getBodyValue(body, 'From') || getBodyValue(body, 'phoneNumber') || 'unknown-caller';
    const digits = getBodyValue(body, 'Digits') || getBodyValue(body, 'digits') || '';
    const requestPath = getRequestPath(req);

    if (requestPath === '/voice/live-continue') {
        // Reached when one live chunk finishes and the caller didn't press
        // anything - loop back for the next chunk. Silent (message is null)
        // while still live; gracefully falls back to the menu once it ends.
        const liveResult = service.selectLiveStream(phoneNumber);
        sendTwiml(res, service.buildLiveStreamTwiML(liveResult.message, liveResult.audioUrl));
        return;
    }

    if (requestPath === '/voice/playback') {
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

        const playUrl = buildRecordingPlaybackUrl(
            req, action.recordingId, action.positionSeconds, phoneNumber, action.type === 'continue'
        );
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

        if (digits === '8') {
            if (!getBodyValue(body, 'CallSid')
                || !buildAiWebSocketUrl(req)
                || !aiVoiceBridge.isConfigured()
                || !twilioSecurity.hasFixedPublicUrl()) {
                sendTwiml(res, service.buildMenuTwiML('ChatGPT voice is not configured yet.'));
                return;
            }
            if (!isAiMemoryReady()) {
                sendTwiml(res, service.buildMenuTwiML('ChatGPT memory is temporarily unavailable. Please try again later.'));
                return;
            }
            if (AI_MEMORY_REQUIRED && !normalizeCallerNumber(phoneNumber)) {
                sendTwiml(res, service.buildMenuTwiML('ChatGPT memory requires caller ID. Please call again without blocking your number.'));
                return;
            }
            startAiVoiceSession(req, res, body, phoneNumber);
            return;
        }

        if (digits === '9') {
            if (!isAiMemoryReady()) {
                sendTwiml(res, service.buildMenuTwiML('ChatGPT memory is temporarily unavailable. Please try again later.'));
                return;
            }
            const normalizedPhoneNumber = normalizeCallerNumber(phoneNumber);
            if (AI_MEMORY_REQUIRED && !normalizedPhoneNumber) {
                sendTwiml(res, service.buildMenuTwiML('ChatGPT memory requires caller ID. Please call again without blocking your number.'));
                return;
            }
            const safetyIdentifier = createSafetyIdentifier(
                AI_MEMORY_REQUIRED ? normalizedPhoneNumber : phoneNumber,
                AI_SAFETY_SALT
            );
            aiVoiceBridge.forgetUser(safetyIdentifier);
            const memoryCleared = aiService.resetTextConversation(safetyIdentifier);
            sendTwiml(res, service.buildMenuTwiML(memoryCleared
                ? 'Your saved ChatGPT memory has been deleted.'
                : 'I could not verify that your saved ChatGPT memory was deleted. Please try again later.'));
            return;
        }
    }

    sendTwiml(res, service.buildMenuTwiML());
}

async function handleVoiceWebhook(req, res) {
    const body = await parseBody(req);
    if (!validateTwilioWebhook(req, res, body)) {
        return;
    }
    handleVoiceRequest(req, res, body);
}

async function handleHttpRequest(req, res) {
    const requestPath = getRequestPath(req);
    if (requestPath === '/health') {
        const memoryReady = isAiMemoryReady();
        res.writeHead(memoryReady ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: memoryReady,
            aiMemory: {
                enabled: AI_MEMORY_REQUIRED,
                ready: memoryReady
            }
        }));
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
        let playback;
        try {
            playback = await resolveRecordingPlayback(recording);
        } catch (error) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, stage: 'resolve', error: error.message, resolveMs: Date.now() - startedAt }));
            return;
        }
        const resolveMs = Date.now() - startedAt;

        if (!playback.segments) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Resolved to a direct URL, not Kick segments - nothing to test here' }));
            return;
        }

        // Same path /recordings/:id/play's persistent archive session uses
        // in production (startArchiveSession + feedSegmentsToStdin): ffmpeg
        // only transcodes a raw stream we feed it, never fetches the segment
        // URLs itself. -loglevel verbose and a segment-count cap so this
        // terminates on its own instead of running indefinitely.
        const ffmpegStartedAt = Date.now();
        const proc = spawn(FFMPEG_PATH, [
            '-loglevel', 'verbose',
            '-f', 'mpegts',
            '-i', 'pipe:0',
            '-vn',
            '-c:a', 'libmp3lame',
            '-b:a', '96k',
            '-ar', '44100',
            '-f', 'mp3',
            '-'
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let stderr = '';
        let stdoutBytes = 0;
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.stdout.on('data', (chunk) => {
            stdoutBytes += chunk.length;
        });
        proc.stdin.on('error', () => {});

        const segmentsToFeed = playback.segments.slice(0, 10);
        let segmentFetchError = null;
        feedSegmentsToStdin(proc, segmentsToFeed, 0).catch((error) => {
            segmentFetchError = error.message;
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
            totalSegments: playback.segments.length,
            segmentsFedThisTest: segmentsToFeed.length,
            segmentFetchError,
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
        const isContinue = query.get('continue') === '1';

        let playback;
        try {
            playback = await resolveRecordingPlayback(recording);
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

        // A natural chunk-boundary continuation (isContinue) trusts the
        // caller's session as-is and never reconnects - no position
        // comparison at all, since the only position we could compare
        // against is a wall-clock estimate that drifts a little further off
        // with every chunk transition (Twilio's inter-chunk pause isn't
        // audio time), which would eventually misfire as a "seek" on a
        // plain, uninterrupted listen. An explicit seek/skip always pays the
        // reconnect+reseek cost, since it's a genuine jump to a new position.
        let session = archiveSessions.get(caller);
        if (session) {
            const sameRecording = session.recordingId === recordingId
                && session.process
                && !session.process.killed;
            const reusable = isContinue
                ? sameRecording
                : sameRecording && Math.abs(
                    (session.startSeconds + session.bytesProducedTotal / ARCHIVE_AUDIO_BYTES_PER_SECOND) - start
                ) <= ARCHIVE_POSITION_TOLERANCE_SECONDS;
            if (!reusable) {
                session = null;
            }
        }
        if (!session) {
            session = startArchiveSession(caller, recordingId, playback.segments || playback.audioUrl, start);
        }

        attachArchiveResponse(session, res);

        req.on('close', () => {
            if (session.currentRes === res) {
                session.currentRes = null;
            }
        });

        return;
    }

    if (req.method === 'POST' && requestPath === '/voice') {
        await handleVoiceWebhook(req, res);
        return;
    }

    if (req.method === 'POST' && requestPath === '/voice/menu') {
        await handleVoiceWebhook(req, res);
        return;
    }

    if (req.method === 'POST' && requestPath === '/voice/playback') {
        await handleVoiceWebhook(req, res);
        return;
    }

    if (req.method === 'POST' && requestPath === '/voice/live-continue') {
        const body = await parseBody(req);
        if (!validateTwilioWebhook(req, res, body)) {
            return;
        }
        handleVoiceRequest(req, res, body);
        return;
    }

    if (req.method === 'POST' && requestPath === '/sms') {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (!contentType.includes('application/x-www-form-urlencoded')) {
            throw new HttpRequestError('SMS webhook requires a form-encoded body', 415);
        }
        const body = await parseBody(req, 8 * 1024);
        await handleSmsRequest(req, res, body);
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
}

const server = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch((error) => {
        if (res.writableEnded) {
            return;
        }
        if (res.headersSent) {
            res.destroy();
            return;
        }
        const statusCode = Number(error?.statusCode) || 500;
        if (statusCode >= 500) {
            console.error('[http] request_failed', {
                code: String(error?.code || error?.name || 'unknown').slice(0, 80)
            });
        }
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: false,
            error: statusCode >= 500 ? 'Internal server error' : error.message
        }));
    });
});
aiVoiceBridge.attach(server);

function startServer() {
    const port = Number(process.env.PORT || 3000);
    server.listen(port, () => {
        console.log(`Phone service listening on port ${port}`);
        console.log(`Streamer configured: ${service.streamerName}`);
        console.log(`AI text chat: ${AI_SAFETY_SALT_CONFIGURED && aiService.isConfigured() && twilioSecurity.isConfigured() ? 'configured' : 'not configured'}`);
        console.log(`AI voice chat: ${aiVoiceBridge.isConfigured() && twilioSecurity.hasFixedPublicUrl() ? 'configured' : 'not configured'}`);
        console.log(`AI persistent memory: ${aiMemoryStore.isConfigured() ? 'configured' : 'not configured'}`);
        if (!AI_SAFETY_SALT_CONFIGURED) {
            console.warn('AI_SAFETY_SALT must contain at least 32 characters; AI text and voice endpoints are disabled.');
        }
        if (process.env.NODE_ENV === 'production' && !twilioSecurity.isConfigured()) {
            console.warn('TWILIO_AUTH_TOKEN is unset; SMS and AI voice endpoints are disabled.');
        }
        if (AI_MEMORY_REQUIRED && !isAiMemoryReady()) {
            console.warn('AI memory is enabled but its file, encryption key, or AI_SAFETY_SALT is invalid. AI chat is disabled.');
        }

        if (KICK_CHANNEL) {
            console.log(`Auto-detecting live status for Kick channel "${KICK_CHANNEL}" every ${KICK_POLL_INTERVAL_MS}ms`);
            pollKickChannel();
            const livePollTimer = setInterval(pollKickChannel, KICK_POLL_INTERVAL_MS);
            livePollTimer.unref?.();

            console.log(
                `Checking for new archived streams every ${KICK_VIDEOS_POLL_MIN_INTERVAL_MS}-`
                + `${KICK_VIDEOS_POLL_MAX_INTERVAL_MS}ms (randomized)`
            );
            pollKickVideos();
            scheduleNextKickVideosPoll();
        } else {
            console.log('KICK_CHANNEL not set - start/stop the live stream manually via POST /admin/stream/live and /admin/stream/stop');
        }

        // Sweeps archive sessions nobody has reattached to in a while (hangup,
        // switched recordings, went to the menu) so their ffmpeg process and Kick
        // CDN connection don't stay open indefinitely.
        const archiveSweepTimer = setInterval(() => {
            const now = Date.now();
            for (const [phoneNumber, session] of archiveSessions) {
                if (!session.currentRes && now - session.lastAttachedAt > ARCHIVE_SESSION_IDLE_MS) {
                    stopArchiveSession(phoneNumber);
                }
            }
        }, 30000);
        archiveSweepTimer.unref?.();

    });
    return server;
}

async function shutdown() {
    stopLiveTranscode();
    aiVoiceBridge.close();
    for (const phoneNumber of Array.from(archiveSessions.keys())) {
        stopArchiveSession(phoneNumber);
    }
    await kickBrowser.shutdown();
    server.close(() => process.exit(0));
}

if (require.main === module) {
    startServer();
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

module.exports = {
    server,
    service,
    startServer,
    shutdown,
    parseBody,
    buildSmsTwiML,
    buildAiWebSocketUrl,
    handleHttpRequest
};
