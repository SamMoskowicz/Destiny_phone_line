const crypto = require('crypto');

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function createSafetyIdentifier(subject, secret) {
    const normalized = String(subject || 'unknown-user').trim().toLowerCase();
    const key = String(secret || 'local-development-salt');
    return `usr_${crypto.createHmac('sha256', key).update(normalized).digest('hex').slice(0, 48)}`;
}

class DualWindowRateLimiter {
    constructor({
        shortLimit,
        shortWindowMs,
        longLimit,
        longWindowMs = 24 * 60 * 60 * 1000,
        maxKeys = 10000,
        clock = () => Date.now()
    }) {
        this.shortLimit = positiveInteger(shortLimit, 1);
        this.shortWindowMs = positiveInteger(shortWindowMs, 60 * 1000);
        this.longLimit = positiveInteger(longLimit, this.shortLimit);
        this.longWindowMs = positiveInteger(longWindowMs, 24 * 60 * 60 * 1000);
        this.maxKeys = positiveInteger(maxKeys, 10000);
        this.clock = clock;
        this.records = new Map();
    }

    consume(key) {
        const now = this.clock();
        let timestamps = this.records.get(key) || [];
        timestamps = timestamps.filter((timestamp) => now - timestamp < this.longWindowMs);
        const shortTimestamps = timestamps.filter((timestamp) => now - timestamp < this.shortWindowMs);

        if (shortTimestamps.length >= this.shortLimit) {
            this.records.set(key, timestamps);
            return {
                allowed: false,
                scope: 'short',
                retryAfterMs: Math.max(1, this.shortWindowMs - (now - shortTimestamps[0]))
            };
        }
        if (timestamps.length >= this.longLimit) {
            this.records.set(key, timestamps);
            return {
                allowed: false,
                scope: 'long',
                retryAfterMs: Math.max(1, this.longWindowMs - (now - timestamps[0]))
            };
        }

        timestamps.push(now);
        this.records.delete(key);
        this.records.set(key, timestamps);
        while (this.records.size > this.maxKeys) {
            this.records.delete(this.records.keys().next().value);
        }
        return { allowed: true, retryAfterMs: 0 };
    }

    reset(key) {
        this.records.delete(key);
    }
}

class ExpiringIdempotencyCache {
    constructor({ ttlMs = 10 * 60 * 1000, maxEntries = 5000, clock = () => Date.now() } = {}) {
        this.ttlMs = positiveInteger(ttlMs, 10 * 60 * 1000);
        this.maxEntries = positiveInteger(maxEntries, 5000);
        this.clock = clock;
        this.entries = new Map();
    }

    prune() {
        const now = this.clock();
        for (const [key, entry] of this.entries) {
            if (!entry.promise && entry.expiresAt <= now) {
                this.entries.delete(key);
            }
        }
        while (this.entries.size > this.maxEntries) {
            let deleted = false;
            for (const [key, entry] of this.entries) {
                if (!entry.promise) {
                    this.entries.delete(key);
                    deleted = true;
                    break;
                }
            }
            if (!deleted) {
                break;
            }
        }
    }

    async run(key, operation) {
        this.prune();
        const existing = this.entries.get(key);
        if (existing) {
            if (existing.promise) {
                return existing.promise;
            }
            if (existing.expiresAt > this.clock()) {
                return existing.value;
            }
            this.entries.delete(key);
        }

        if (this.entries.size >= this.maxEntries) {
            let evicted = false;
            for (const [entryKey, entry] of this.entries) {
                if (!entry.promise) {
                    this.entries.delete(entryKey);
                    evicted = true;
                    break;
                }
            }
            if (!evicted) {
                const error = new Error('Idempotency cache is at capacity');
                error.code = 'IDEMPOTENCY_CAPACITY';
                throw error;
            }
        }

        const promise = Promise.resolve().then(operation);
        this.entries.set(key, { promise, expiresAt: this.clock() + this.ttlMs });
        try {
            const value = await promise;
            this.entries.set(key, {
                value,
                promise: null,
                expiresAt: this.clock() + this.ttlMs
            });
            return value;
        } catch (error) {
            this.entries.delete(key);
            throw error;
        }
    }
}

class EphemeralSessionTokenStore {
    constructor({ ttlMs = 2 * 60 * 1000, maxEntries = 1000, clock = () => Date.now() } = {}) {
        this.ttlMs = positiveInteger(ttlMs, 2 * 60 * 1000);
        this.maxEntries = positiveInteger(maxEntries, 1000);
        this.clock = clock;
        this.entries = new Map();
        this.tokensByCall = new Map();
    }

    prune() {
        const now = this.clock();
        for (const [token, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(token);
                if (this.tokensByCall.get(entry.callSid) === token) {
                    this.tokensByCall.delete(entry.callSid);
                }
            }
        }
        while (this.entries.size > this.maxEntries) {
            const token = this.entries.keys().next().value;
            const entry = this.entries.get(token);
            this.entries.delete(token);
            if (entry && this.tokensByCall.get(entry.callSid) === token) {
                this.tokensByCall.delete(entry.callSid);
            }
        }
    }

    issue({ callSid, safetyIdentifier }) {
        this.prune();
        const normalizedCallSid = String(callSid);
        const existingToken = this.tokensByCall.get(normalizedCallSid);
        const existingEntry = this.entries.get(existingToken);
        if (existingEntry && existingEntry.safetyIdentifier === String(safetyIdentifier)) {
            return existingToken;
        }
        if (existingEntry) {
            this.entries.delete(existingToken);
            this.tokensByCall.delete(normalizedCallSid);
        }
        while (this.entries.size >= this.maxEntries) {
            const oldestToken = this.entries.keys().next().value;
            const oldestEntry = this.entries.get(oldestToken);
            this.entries.delete(oldestToken);
            if (oldestEntry && this.tokensByCall.get(oldestEntry.callSid) === oldestToken) {
                this.tokensByCall.delete(oldestEntry.callSid);
            }
        }
        const token = crypto.randomBytes(24).toString('base64url');
        this.entries.set(token, {
            callSid: normalizedCallSid,
            safetyIdentifier: String(safetyIdentifier),
            expiresAt: this.clock() + this.ttlMs
        });
        this.tokensByCall.set(normalizedCallSid, token);
        return token;
    }

    consume(token, callSid) {
        this.prune();
        const entry = this.entries.get(String(token || ''));
        if (!entry || entry.callSid !== String(callSid || '')) {
            return null;
        }
        this.entries.delete(String(token));
        if (this.tokensByCall.get(entry.callSid) === String(token)) {
            this.tokensByCall.delete(entry.callSid);
        }
        return entry;
    }
}

module.exports = {
    createSafetyIdentifier,
    DualWindowRateLimiter,
    ExpiringIdempotencyCache,
    EphemeralSessionTokenStore
};
