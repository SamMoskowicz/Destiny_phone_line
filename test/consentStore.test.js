const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConsentStore } = require('../src/consentStore');

test('AI STOP/START preferences survive a store reload', (t) => {
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

test('AI preference store rejects malformed safety identifiers', () => {
    const store = new ConsentStore({ storageFile: null, logger: { warn() {} } });

    assert.equal(store.optOut('+15551234567'), false);
    assert.equal(store.optOut('usr_too-short'), false);
    assert.equal(store.isOptedOut('+15551234567'), false);
});

test('a malformed preference file fails closed instead of being overwritten', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'destiny-bad-consent-'));
    const storageFile = path.join(directory, 'ai-consent.json');
    const identifier = `usr_${'c'.repeat(48)}`;
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(storageFile, '{not valid json', 'utf8');

    const store = new ConsentStore({ storageFile, logger: { warn() {} } });

    assert.equal(store.isConfigured(), false);
    assert.equal(store.optOut(identifier), false);
    assert.equal(fs.readFileSync(storageFile, 'utf8'), '{not valid json');
});

test('failed preference persistence rolls back an in-memory opt-out', () => {
    const identifier = `usr_${'d'.repeat(48)}`;
    const store = new ConsentStore({ storageFile: null, logger: { warn() {} } });
    store.persist = () => false;

    assert.equal(store.optOut(identifier), false);
    assert.equal(store.isOptedOut(identifier), false);
});

test('STOP remains active without time-based expiration', () => {
    let now = Date.UTC(2026, 0, 1);
    const identifier = `usr_${'f'.repeat(48)}`;
    const store = new ConsentStore({
        storageFile: null,
        clock: () => now,
        logger: { warn() {} }
    });

    assert.equal(store.optOut(identifier), true);
    now += 10 * 365 * 24 * 60 * 60 * 1000;
    assert.equal(store.isOptedOut(identifier), true);
});

test('legacy files load STOP state while obsolete memory-consent metadata is ignored', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'destiny-legacy-preferences-'));
    const storageFile = path.join(directory, 'ai-consent.json');
    const identifier = `usr_${'b'.repeat(48)}`;
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(storageFile, JSON.stringify({
        version: 2,
        optedOut: [[identifier, Date.UTC(2026, 0, 1)]],
        memoryConsents: [[identifier, { version: 3, timestamp: Date.UTC(2026, 0, 1) }]]
    }));

    const store = new ConsentStore({ storageFile, logger: { warn() {} } });
    assert.equal(store.isConfigured(), true);
    assert.equal(store.isOptedOut(identifier), true);
    assert.equal('hasMemoryConsent' in store, false);
});
