const http = require('http');
const { PhoneService } = require('./src/phoneService');

const service = new PhoneService({
    streamerName: process.env.STREAMER_NAME || 'Steven Kenneth Bonnell',
    storageFile: process.env.PHONE_SERVICE_STATE_FILE || undefined
});

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
            sendTwiml(res, service.buildPlaybackTwiML(liveResult.message));
            return;
        }

        if (digits >= '2' && digits <= '6') {
            const recordingResult = service.selectRecording(phoneNumber, digits);
            if (recordingResult.type === 'error') {
                sendTwiml(res, service.buildMenuTwiML(recordingResult.message));
                return;
            }
            sendTwiml(res, service.buildPlaybackTwiML(recordingResult.message));
            return;
        }

        if (digits === '7') {
            const resumeResult = service.resumeLastRecording(phoneNumber);
            if (resumeResult.type === 'error') {
                sendTwiml(res, service.buildMenuTwiML(resumeResult.message));
                return;
            }
            sendTwiml(res, service.buildPlaybackTwiML(resumeResult.message));
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
        const recording = service.startStream({ audioUrl: body.audioUrl || null });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, recording }));
        return;
    }

    if (req.method === 'POST' && req.url === '/admin/stream/stop') {
        if (!isAuthorizedAdmin(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
            return;
        }

        const result = service.endStream();
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
});
