const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConsentStore } = require('../src/consentStore');

test('AI consent opt-out and opt-in survive a store reload', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'destiny-consent-'));
    const storageFile = path.join(directory, 'ai-consent.json');
    const logger = { warn() {} };
    const identifier = `usr_${'a'.repeat(48)}`;
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const first = new ConsentStore({ storageFile, logger });
    assert.equal(first.isOptedOut(identifier), false);
    assert.equal(first.optOut(identifier), true);
    assert.equal(first.isOptedOut(identifier), true);

    const reloaded = new ConsentStore({ storageFile, logger });
    assert.equal(reloaded.isOptedOut(identifier), true);
    assert.equal(reloaded.optIn(identifier), true);

    const afterOptIn = new ConsentStore({ storageFile, logger });
    assert.equal(afterOptIn.isOptedOut(identifier), false);
});

test('AI consent store rejects malformed safety identifiers', () => {
    const store = new ConsentStore({ storageFile: null, logger: { warn() {} } });

    assert.equal(store.optOut('+15551234567'), false);
    assert.equal(store.optOut('usr_too-short'), false);
    assert.equal(store.isOptedOut('+15551234567'), false);
});
