const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PhoneService } = require('../src/phoneService');

test('menu announces live status and records the correct menu prompt', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });

    assert.match(service.getMenuPrompt(), /press 1 to hear the live stream/i);
    assert.match(service.getMenuPrompt(), /Press 2 through 6/i);

    service.startStream();
    assert.match(service.getMenuPrompt(), /press 1 to hear the live stream/i);

    fs.unlinkSync(tempFile);
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

test('playback controls expose pause resume and menu options', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });

    const action = service.handlePlaybackControl('+15550001111', '3', 'recording-1');
    assert.equal(action.type, 'skipped');
    assert.equal(action.positionSeconds, 30);

    const menuAction = service.handlePlaybackControl('+15550001111', '5', 'recording-1');
    assert.equal(menuAction.type, 'menu');

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
});

test('builds a TwiML menu response for Destiny', () => {
    const tempFile = path.join(os.tmpdir(), `phone-service-${Date.now()}-${Math.random()}.json`);
    const service = new PhoneService({ streamerName: 'Destiny', storageFile: tempFile });

    const twiml = service.buildMenuTwiML();
    assert.match(twiml, /<Response>/);
    assert.match(twiml, /action="\/voice\/menu"/);
    assert.match(twiml, /Destiny/);

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }
});
