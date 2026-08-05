const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PhoneService, formatDuration } = require('../src/phoneService');

test('formats archived stream durations naturally', () => {
    assert.equal(formatDuration(1), '1 second');
    assert.equal(formatDuration(61), '1 minute and 1 second');
    assert.equal(formatDuration(7384), '2 hours, 3 minutes, and 4 seconds');
    assert.equal(formatDuration(0), null);
    assert.equal(formatDuration('unknown'), null);
});

test('menu announces live status and lists the other options', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });

    assert.match(service.getMenuPrompt(), /no live stream/i);
    assert.match(service.getMenuPrompt(), /2 through 6/i);
    assert.match(service.getMenuPrompt(), /press 7/i);
    assert.match(service.getMenuPrompt(), /press 8.*ChatGPT/i);

    service.startStream();
    assert.match(service.getMenuPrompt(), /press 1/i);

    fs.unlinkSync(tempFile);
});

test('controls info TwiML explains playback keys and returns to the menu', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });

    const twiml = service.buildControlsInfoTwiML();
    assert.match(twiml, /pause/i);
    assert.match(twiml, /action="\/voice\/menu"/);

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
});

test('keeps only five recent recordings and remembers caller progress', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });

    for (let index = 0; index < 6; index += 1) {
        service.addRecording({ title: `Stream ${index}` });
    }

    assert.equal(service.state.recordings.length, 5);
    assert.equal(service.state.recordings[0].title, 'Stream 5');

    const selection = service.selectRecording('+15551234567', '2');
    assert.equal(selection.type, 'recording');
    assert.equal(selection.positionSeconds, 0);

    service.updateProgress('+15551234567', selection.recordingId, 120);
    const resumed = service.resumeLastRecording('+15551234567');
    assert.equal(resumed.positionSeconds, 120);

    fs.unlinkSync(tempFile);
});

test('archived stream introduction ends with its total duration', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });
    service.addRecording({ title: 'Long stream', durationSeconds: 7384 });

    const selection = service.selectRecording('+15551234567', '2');

    assert.equal(
        selection.message,
        'You are now listening to Long stream. The total stream length is 2 hours, 3 minutes, and 4 seconds.'
    );

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
});

test('playback controls seek, pause/resume, and return to the menu', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });
    service.addRecording({ title: 'Test recording', audioUrl: 'https://example.com/test.mp3' });
    service.selectRecording('+15550001111', '2');

    const forward10 = service.handlePlaybackControl('+15550001111', '3');
    assert.equal(forward10.type, 'seek');
    assert.ok(forward10.positionSeconds >= 10);

    const back30min = service.handlePlaybackControl('+15550001111', '*');
    assert.equal(back30min.type, 'seek');
    assert.equal(back30min.positionSeconds, 0);

    const paused = service.handlePlaybackControl('+15550001111', '2');
    assert.equal(paused.type, 'paused');

    const resumed = service.handlePlaybackControl('+15550001111', '2');
    assert.equal(resumed.type, 'seek');

    const menuAction = service.handlePlaybackControl('+15550001111', '8');
    assert.equal(menuAction.type, 'menu');

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
});

test('archive slots skip the currently live entry', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });
    service.addRecording({ title: 'Archived stream' });
    service.startStream({ audioUrl: 'https://example.com/live.mp3' });

    const firstOption = service.getRecordingByOption('2');
    assert.equal(firstOption.title, 'Archived stream');
    assert.equal(firstOption.live, false);

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
});

test('builds a TwiML menu response for Destiny', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });
    service.startStream();

    const twiml = service.buildMenuTwiML();
    assert.match(twiml, /<Response>/);
    assert.match(twiml, /action="\/voice\/menu"/);
    assert.match(twiml, /Destiny/);

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
});

test('builds bidirectional AI Stream TwiML without a robotic preamble', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });

    const twiml = service.buildAiStreamTwiML('wss://example.com/voice/ai-stream?x=1&y=2', 'token"value');
    assert.match(twiml, /<Connect>/);
    assert.match(twiml, /<Stream url="wss:\/\/example\.com\/voice\/ai-stream\?x=1&amp;y=2">/);
    assert.match(twiml, /name="sessionToken" value="token&quot;value"/);
    assert.doesNotMatch(twiml, /<Say/i);
    assert.doesNotMatch(twiml, /speaking with ChatGPT/i);
    assert.match(twiml, /<Redirect method="POST">\/voice\/menu<\/Redirect>/);

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
});

test('the main menu starts ChatGPT without a storage or consent announcement', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });

    const prompt = service.getMenuPrompt();

    assert.match(prompt, /press 8 to talk with ChatGPT/i);
    assert.doesNotMatch(prompt, /agree|consent|saving|transcript|memory|call audio/i);
    assert.doesNotMatch(prompt, /press 9/i);

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
});
