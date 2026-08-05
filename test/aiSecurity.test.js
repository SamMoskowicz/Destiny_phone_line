const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createSafetyIdentifier,
    DualWindowRateLimiter,
    ExpiringIdempotencyCache,
    EphemeralSessionTokenStore
} = require('../src/aiSecurity');

test('safety identifiers are stable, salted, and do not expose phone numbers', () => {
    const first = createSafetyIdentifier('+15551234567', 'secret-one');
    const same = createSafetyIdentifier('+15551234567', 'secret-one');
    const differentSalt = createSafetyIdentifier('+15551234567', 'secret-two');

    assert.equal(first, same);
    assert.notEqual(first, differentSalt);
    assert.doesNotMatch(first, /15551234567/);
    assert.ok(first.length <= 64);
});

test('rate limiter enforces both short and long windows', () => {
    let now = 0;
    const limiter = new DualWindowRateLimiter({
        shortLimit: 2,
        shortWindowMs: 1000,
        longLimit: 3,
        longWindowMs: 10000,
        clock: () => now
    });

    assert.equal(limiter.consume('caller').allowed, true);
    assert.equal(limiter.consume('caller').allowed, true);
    assert.equal(limiter.consume('caller').scope, 'short');
    now = 1500;
    assert.equal(limiter.consume('caller').allowed, true);
    assert.equal(limiter.consume('caller').scope, 'long');
    now = 11000;
    assert.equal(limiter.consume('caller').allowed, true);
});

test('idempotency cache shares an in-flight result and caches the reply', async () => {
    let calls = 0;
    const cache = new ExpiringIdempotencyCache();
    const operation = async () => {
        calls += 1;
        await Promise.resolve();
        return 'reply';
    };

    const [first, second] = await Promise.all([
        cache.run('SM123', operation),
        cache.run('SM123', operation)
    ]);
    const third = await cache.run('SM123', operation);

    assert.equal(first, 'reply');
    assert.equal(second, 'reply');
    assert.equal(third, 'reply');
    assert.equal(calls, 1);
});

test('voice session tokens are opaque, one-time, expiring, and bound to CallSid', () => {
    let now = 100;
    const store = new EphemeralSessionTokenStore({ ttlMs: 1000, clock: () => now });
    const token = store.issue({ callSid: 'CA123', safetyIdentifier: 'usr_hash' });
    assert.equal(store.issue({ callSid: 'CA123', safetyIdentifier: 'usr_hash' }), token);

    assert.doesNotMatch(token, /CA123|usr_hash/);
    assert.equal(store.consume(token, 'wrong'), null);
    assert.equal(store.consume(token, 'CA123').safetyIdentifier, 'usr_hash');
    assert.equal(store.consume(token, 'CA123'), null);

    const expired = store.issue({ callSid: 'CA456', safetyIdentifier: 'usr_other' });
    now = 1200;
    assert.equal(store.consume(expired, 'CA456'), null);
});

test('voice token capacity one remains consumable and a safety mismatch revokes the prior token', () => {
    const capacityStore = new EphemeralSessionTokenStore({ maxEntries: 1 });
    const onlyToken = capacityStore.issue({ callSid: 'CA-only', safetyIdentifier: 'usr_only' });
    assert.equal(capacityStore.consume(onlyToken, 'CA-only').safetyIdentifier, 'usr_only');

    const replacementStore = new EphemeralSessionTokenStore({ maxEntries: 2 });
    const first = replacementStore.issue({ callSid: 'CA-shared', safetyIdentifier: 'usr_first' });
    const replacement = replacementStore.issue({ callSid: 'CA-shared', safetyIdentifier: 'usr_second' });

    assert.notEqual(replacement, first);
    assert.equal(replacementStore.consume(first, 'CA-shared'), null);
    assert.equal(
        replacementStore.consume(replacement, 'CA-shared').safetyIdentifier,
        'usr_second'
    );
});

test('idempotency cache fails closed instead of growing past all in-flight entries', async () => {
    const cache = new ExpiringIdempotencyCache({ maxEntries: 1 });
    let release;
    const pending = cache.run('first', () => new Promise((resolve) => {
        release = resolve;
    }));
    await Promise.resolve();
    await assert.rejects(
        cache.run('second', async () => 'second'),
        (error) => error.code === 'IDEMPOTENCY_CAPACITY'
    );
    release('first');
    assert.equal(await pending, 'first');
});
