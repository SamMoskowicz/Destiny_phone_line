const { spawn } = require('child_process');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    stdio: 'inherit',
    env: process.env
});

child.on('exit', (code) => {
    process.exit(code || 0);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        if (!child.killed) {
            child.kill(signal);
        }
    });
}
