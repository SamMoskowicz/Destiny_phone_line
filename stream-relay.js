const http = require('http');
const { spawn } = require('child_process');

const hlsUrl = process.argv[2];
const port = Number(process.argv[3] || process.env.STREAM_RELAY_PORT || 9000);

if (!hlsUrl) {
    console.error('Usage: node stream-relay.js <HLS_URL> [PORT]');
    process.exit(1);
}

const clients = new Set();

const ffmpeg = spawn('ffmpeg', [
    '-re',
    '-i', hlsUrl,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '96k',
    '-ar', '44100',
    '-f', 'mp3',
    '-'
], { stdio: ['ignore', 'pipe', 'inherit'] });

ffmpeg.on('exit', (code, signal) => {
    console.error(`ffmpeg exited with code=${code} signal=${signal}`);
    for (const res of clients) {
        if (!res.writableEnded) {
            res.end();
        }
    }
    process.exit(code || 0);
});

ffmpeg.stdout.on('data', (chunk) => {
    for (const res of clients) {
        const ok = res.write(chunk);
        if (!ok) {
            // backpressure: do nothing, Node will manage buffering
        }
    }
});

ffmpeg.stdout.on('end', () => {
    for (const res of clients) {
        res.end();
    }
});

const server = http.createServer((req, res) => {
    if (req.url !== '/live.mp3') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
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

    clients.add(res);
    req.on('close', () => {
        clients.delete(res);
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`Live audio relay running on http://0.0.0.0:${port}/live.mp3`);
    console.log(`Source HLS URL: ${hlsUrl}`);
});
