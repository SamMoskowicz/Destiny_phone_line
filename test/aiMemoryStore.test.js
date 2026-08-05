const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AiMemoryStore } = require('../src/aiMemoryStore');

const SAFETY_ID = `usr_${'a'.repeat(48)}`;
const MEMORY_KEY = 'test-memory-encryption-key-that-is-long-enough-1234567890';

function createStore(options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-'));
    const storageFile = path.join(directory, 'memory.enc.json');
    const warnings = [];
    const store = new AiMemoryStore({
        enabled: true,
        storageFile,
        encryptionKey: MEMORY_KEY,
        logger: { warn: (...args) => warnings.push(args) },
        ...options
    });
    return { directory, storageFile, store, warnings };
}

test('encrypted memory survives reload without exposing transcript text or phone numbers', () => {
    const fixture = createStore();
    try {
        assert.equal(fixture.store.isConfigured(), true);
        assert.equal(fixture.store.appendExchange({
            safetyIdentifier: SAFETY_ID,
            exchangeId: 'sms-1',
            channel: 'sms',
            userText: 'My favorite color is green.',
            assistantText: 'I will remember that.'
        }), true);

        const encryptedFile = fs.readFileSync(fixture.storageFile, 'utf8');
        assert.doesNotMatch(encryptedFile, /favorite color|remember that|\+1555/i);

        const reloaded = new AiMemoryStore({
            enabled: true,
            storageFile: fixture.storageFile,
            encryptionKey: MEMORY_KEY,
            logger: { warn() {} }
        });
        const snapshot = reloaded.getSnapshot(SAFETY_ID);
        assert.equal(snapshot.exchanges.length, 1);
        assert.equal(snapshot.exchanges[0].userText, 'My favorite color is green.');
        assert.match(snapshot.context, /favorite color is green/i);
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('memory retains ten recent exchanges and folds older exchanges into a summary', () => {
    const fixture = createStore({ maxRecentExchanges: 10 });
    try {
        for (let index = 1; index <= 11; index += 1) {
            assert.equal(fixture.store.appendExchange({
                safetyIdentifier: SAFETY_ID,
                exchangeId: `exchange-${index}`,
                channel: index % 2 ? 'sms' : 'voice',
                userText: `Question ${index}`,
                assistantText: `Answer ${index}`
            }), true);
        }

        const work = fixture.store.getSummaryWork(SAFETY_ID);
        assert.deepEqual(work.exchanges.map((entry) => entry.id), ['exchange-1']);
        assert.equal(fixture.store.commitSummary({
            safetyIdentifier: SAFETY_ID,
            generation: work.generation,
            exchangeIds: work.exchanges.map((entry) => entry.id),
            summary: '- The caller previously asked question 1.'
        }), true);

        const snapshot = fixture.store.getSnapshot(SAFETY_ID);
        assert.equal(snapshot.exchanges.length, 10);
        assert.deepEqual(snapshot.exchanges.map((entry) => entry.id), [
            'exchange-2', 'exchange-3', 'exchange-4', 'exchange-5', 'exchange-6',
            'exchange-7', 'exchange-8', 'exchange-9', 'exchange-10', 'exchange-11'
        ]);
        assert.match(snapshot.context, /previously asked question 1/i);
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('deletion increments the generation so stale replies cannot recreate memory', () => {
    const fixture = createStore();
    try {
        const generation = fixture.store.getGeneration(SAFETY_ID);
        assert.equal(fixture.store.appendExchange({
            safetyIdentifier: SAFETY_ID,
            exchangeId: 'before-delete',
            channel: 'sms',
            userText: 'Remember this.',
            assistantText: 'Okay.',
            expectedGeneration: generation
        }), true);
        assert.equal(fixture.store.clear(SAFETY_ID), true);
        assert.equal(fixture.store.getSnapshot(SAFETY_ID).exchanges.length, 0);
        assert.equal(fixture.store.appendExchange({
            safetyIdentifier: SAFETY_ID,
            exchangeId: 'stale-reply',
            channel: 'sms',
            userText: 'Old in-flight message.',
            assistantText: 'Old in-flight answer.',
            expectedGeneration: generation
        }), false);
        assert.equal(fixture.store.getSnapshot(SAFETY_ID).exchanges.length, 0);
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('a wrong encryption key fails closed without returning another user memory', () => {
    const fixture = createStore();
    try {
        fixture.store.appendExchange({
            safetyIdentifier: SAFETY_ID,
            exchangeId: 'private',
            channel: 'voice',
            userText: 'Private transcript.',
            assistantText: 'Private response.'
        });
        const warnings = [];
        const wrongKeyStore = new AiMemoryStore({
            enabled: true,
            storageFile: fixture.storageFile,
            encryptionKey: 'a-different-encryption-key-that-is-also-long-enough-987654321',
            logger: { warn: (...args) => warnings.push(args) }
        });
        assert.equal(wrongKeyStore.isConfigured(), false);
        assert.equal(wrongKeyStore.getSnapshot(SAFETY_ID).exchanges.length, 0);
        assert.ok(warnings.length >= 1);
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('caller memory never expires based on elapsed time', () => {
    let now = Date.UTC(2026, 0, 1);
    const fixture = createStore({ clock: () => now });
    try {
        assert.equal(fixture.store.appendExchange({
            safetyIdentifier: SAFETY_ID,
            exchangeId: 'persistent-without-expiration',
            channel: 'sms',
            userText: 'Remember this without a time limit.',
            assistantText: 'Okay.'
        }), true);

        now += 10 * 365 * 24 * 60 * 60 * 1000;
        assert.equal(fixture.store.getSnapshot(SAFETY_ID).exchanges.length, 1);
        const reloaded = new AiMemoryStore({
            enabled: true,
            storageFile: fixture.storageFile,
            encryptionKey: MEMORY_KEY,
            clock: () => now,
            logger: { warn() {} }
        });
        assert.equal(reloaded.getSnapshot(SAFETY_ID).exchanges.length, 1);
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('disabled memory does not claim an existing encrypted file was deleted', () => {
    const fixture = createStore();
    try {
        fixture.store.appendExchange({
            safetyIdentifier: SAFETY_ID,
            exchangeId: 'still-on-disk',
            channel: 'sms',
            userText: 'Existing encrypted memory.',
            assistantText: 'Saved.'
        });
        const disabledStore = new AiMemoryStore({
            enabled: false,
            storageFile: fixture.storageFile,
            encryptionKey: MEMORY_KEY,
            logger: { warn() {} }
        });

        assert.equal(disabledStore.hasPersistentData(), true);
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('failed deletion persistence leaves memory intact and reports failure', () => {
    const fixture = createStore();
    try {
        fixture.store.appendExchange({
            safetyIdentifier: SAFETY_ID,
            exchangeId: 'must-not-claim-deleted',
            channel: 'sms',
            userText: 'Keep this unless deletion actually persists.',
            assistantText: 'Understood.'
        });
        fixture.store.persist = () => false;

        assert.equal(fixture.store.clear(SAFETY_ID), false);
        assert.equal(fixture.store.getSnapshot(SAFETY_ID).exchanges.length, 1);
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});
