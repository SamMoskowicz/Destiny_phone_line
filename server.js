const http = require('http');
const { spawn } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { PhoneService } = require('./src/phoneService');

const service = new PhoneService({
    streamerName: process.env.STREAMER_NAME || 'Destiny',
    storageFile: process.env.PHONE_SERVICE_STATE_FILE || undefined
});

const KICK_CHANNEL = process.env.KICK_CHANNEL || null;
const KICK_POLL_INTERVAL_MS = Number(process.env.KICK_POLL_INTERVAL_MS || 60000);

const liveRelayClients = new Set();
let liveRelayProcess = null;
let liveRelayUrl = process.env.LIVE_HLS_URL || null;

function startLiveRelay(hlsUrl) {
    if (!hlsUrl || liveRelayProcess) {
        return;
    }

    const proc = spawn(ffmpegInstaller.path, [
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

function ensureLiveRelay() {
    if (!liveRelayUrl) {
        return;
    }
    if (!liveRelayProcess) {
        startLiveRelay(liveRelayUrl);
    }
}

// Kick's playback_url isn't part of their documented developer API - this hits
// the same undocumented endpoint tools like streamlink use. It can change or
// get Cloudflare-blocked from a datacenter IP; POST /admin/stream/live with an
// explicit audioUrl always works as a manual fallback if polling stops working.
async function fetchKickLiveHlsUrl(channelSlug) {
    const response = await fetch(`https://kick.com/api/v1/channels/${encodeURIComponent(channelSlug)}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`Kick API returned ${response.status}`);
    }

    const data = await response.json();
    const isLive = Boolean(data && data.livestream && data.livestream.is_live);
    return { isLive, hlsUrl: isLive ? data.playback_url || null : null };
}

async function pollKickChannel() {
    try {
        const { isLive, hlsUrl } = await fetchKickLiveHlsUrl(KICK_CHANNEL);

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
        console.error(`Kick poll failed: ${error.message}`);
    }
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
        const action = service.handlePlaybackControl(phoneNumber, digits, body.recordingId || null);
        if (action.type === 'menu') {
            sendTwiml(res, service.buildMenuTwiML());
            return;
        }

        sendTwiml(res, service.buildPlaybackTwiML(action.message));
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
            sendTwiml(res, service.buildPlaybackTwiML(recordingResult.message, recordingResult.audioUrl));
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
    } else {
        console.log('KICK_CHANNEL not set - start/stop the live stream manually via POST /admin/stream/live and /admin/stream/stop');
    }
});
