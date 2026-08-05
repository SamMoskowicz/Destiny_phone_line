const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MEMORY_FILE = path.join(process.cwd(), 'data', 'ai-memory.enc.json');
const MEMORY_FILE_AAD = Buffer.from('destiny-phone-line-ai-memory-v1');

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function normalizeSafetyIdentifier(value) {
    const identifier = String(value || '').trim();
    return /^usr_[a-f0-9]{48}$/.test(identifier) ? identifier : null;
}

function normalizeText(value, maximumCharacters) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }
    return text.slice(0, maximumCharacters);
}

function deriveEncryptionKey(secret) {
    const value = String(secret || '');
    if (value.length < 32) {
        return null;
    }
    return crypto.createHash('sha256')
        .update('destiny-phone-line-ai-memory-key-v1\0')
        .update(value)
        .digest();
}

function cloneProfile(profile) {
    return {
        generation: profile.generation,
        revision: profile.revision,
        summary: profile.summary,
        recent: profile.recent.map((entry) => ({ ...entry })),
        pendingSummary: profile.pendingSummary.map((entry) => ({ ...entry }))
    };
}

class AiMemoryStore {
    constructor({
        enabled = process.env.AI_MEMORY_ENABLED === 'true',
        storageFile = process.env.AI_MEMORY_FILE || DEFAULT_MEMORY_FILE,
        encryptionKey = process.env.AI_MEMORY_ENCRYPTION_KEY,
        maxRecentExchanges = process.env.AI_MEMORY_RECENT_EXCHANGES || 10,
        maxPendingSummary = process.env.AI_MEMORY_MAX_PENDING_SUMMARY || 10,
        maxUsers = process.env.AI_MEMORY_MAX_USERS || 10000,
        maxFieldCharacters = process.env.AI_MEMORY_MAX_FIELD_CHARACTERS || 16000,
        maxContextCharacters = process.env.AI_MEMORY_MAX_CONTEXT_CHARACTERS || 32000,
        maxFileBytes = 100 * 1024 * 1024,
        logger = console,
        clock = () => Date.now()
    } = {}) {
        this.enabled = Boolean(enabled);
        this.storageFile = storageFile ? path.resolve(storageFile) : null;
        this.encryptionKey = deriveEncryptionKey(encryptionKey);
        this.maxRecentExchanges = boundedInteger(maxRecentExchanges, 10, 1, 20);
        this.maxPendingSummary = boundedInteger(maxPendingSummary, 10, 1, 200);
        this.maxUsers = boundedInteger(maxUsers, 10000, 10, 100000);
        this.maxFieldCharacters = boundedInteger(maxFieldCharacters, 16000, 1000, 50000);
        this.maxContextCharacters = boundedInteger(maxContextCharacters, 32000, 4000, 100000);
        this.maxFileBytes = boundedInteger(maxFileBytes, 100 * 1024 * 1024, 1024, 500 * 1024 * 1024);
        this.logger = logger;
        this.clock = clock;
        this.users = new Map();
        this.tombstones = new Map();
        this.loadFailed = false;
        this.load();
    }

    isConfigured() {
        return Boolean(this.enabled && this.storageFile && this.encryptionKey && !this.loadFailed);
    }

    hasPersistentData() {
        if (!this.storageFile) {
            return false;
        }
        try {
            return fs.existsSync(this.storageFile) && fs.statSync(this.storageFile).size > 0;
        } catch (error) {
            // If the path cannot be inspected, never claim its data was deleted.
            return true;
        }
    }

    warn(code) {
        this.logger.warn?.('[ai-memory]', code);
    }

    createProfile(generation = 0) {
        return {
            generation,
            revision: 0,
            summary: '',
            recent: [],
            pendingSummary: []
        };
    }

    sanitizeExchange(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        const userText = normalizeText(value.userText, this.maxFieldCharacters);
        const assistantText = normalizeText(value.assistantText, this.maxFieldCharacters);
        if (!userText) {
            return null;
        }
        const id = String(value.id || '').trim().slice(0, 128);
        if (!id) {
            return null;
        }
        const channel = value.channel === 'voice' ? 'voice' : 'sms';
        const createdAt = Number.isFinite(new Date(value.createdAt).getTime())
            ? new Date(value.createdAt).toISOString()
            : new Date(this.clock()).toISOString();
        return { id, channel, userText, assistantText, createdAt };
    }

    sanitizeProfile(value, fallbackGeneration = 0) {
        const profile = this.createProfile(boundedInteger(value?.generation, fallbackGeneration, 0, Number.MAX_SAFE_INTEGER));
        profile.revision = boundedInteger(value?.revision, 0, 0, Number.MAX_SAFE_INTEGER);
        profile.summary = normalizeText(value?.summary, 8000);
        profile.recent = (Array.isArray(value?.recent) ? value.recent : [])
            .map((entry) => this.sanitizeExchange(entry))
            .filter(Boolean)
            .slice(-this.maxRecentExchanges);
        profile.pendingSummary = (Array.isArray(value?.pendingSummary) ? value.pendingSummary : [])
            .map((entry) => this.sanitizeExchange(entry))
            .filter(Boolean)
            .slice(-this.maxPendingSummary);
        return profile;
    }

    load() {
        if (!this.isConfigured() || !fs.existsSync(this.storageFile)) {
            return;
        }
        try {
            const stats = fs.statSync(this.storageFile);
            if (!stats.isFile() || stats.size > this.maxFileBytes) {
                throw new Error('invalid memory file');
            }
            const envelope = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
            if (envelope?.version !== 1 || envelope?.algorithm !== 'aes-256-gcm') {
                throw new Error('unsupported memory file');
            }
            const iv = Buffer.from(String(envelope.iv || ''), 'base64');
            const tag = Buffer.from(String(envelope.tag || ''), 'base64');
            const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
            if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
                throw new Error('invalid memory envelope');
            }
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
            decipher.setAAD(MEMORY_FILE_AAD);
            decipher.setAuthTag(tag);
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            const parsed = JSON.parse(plaintext.toString('utf8'));
            const users = Array.isArray(parsed?.users) ? parsed.users : [];
            for (const entry of users.slice(-this.maxUsers)) {
                const identifier = normalizeSafetyIdentifier(entry?.[0]);
                if (identifier) {
                    this.users.set(identifier, this.sanitizeProfile(entry[1]));
                }
            }
            const tombstones = Array.isArray(parsed?.tombstones) ? parsed.tombstones : [];
            for (const entry of tombstones.slice(-this.maxUsers)) {
                const identifier = normalizeSafetyIdentifier(entry?.[0]);
                const generation = boundedInteger(entry?.[1], 0, 0, Number.MAX_SAFE_INTEGER);
                if (identifier && generation > 0) {
                    this.tombstones.set(identifier, generation);
                }
            }
        } catch (error) {
            this.users.clear();
            this.tombstones.clear();
            this.loadFailed = true;
            this.warn('load_failed');
        }
    }

    serialize(users, tombstones) {
        const plaintext = Buffer.from(JSON.stringify({
            version: 1,
            users: Array.from(users.entries()),
            tombstones: Array.from(tombstones.entries())
        }));
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
        cipher.setAAD(MEMORY_FILE_AAD);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const body = JSON.stringify({
            version: 1,
            algorithm: 'aes-256-gcm',
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64')
        });
        if (Buffer.byteLength(body) > this.maxFileBytes) {
            throw new Error('memory file capacity exceeded');
        }
        return body;
    }

    persist(users, tombstones) {
        if (!this.isConfigured()) {
            return false;
        }
        let temporaryFile = null;
        try {
            const directory = path.dirname(this.storageFile);
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            temporaryFile = `${this.storageFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
            fs.writeFileSync(temporaryFile, this.serialize(users, tombstones), {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx'
            });
            fs.renameSync(temporaryFile, this.storageFile);
            return true;
        } catch (error) {
            if (temporaryFile && fs.existsSync(temporaryFile)) {
                try {
                    fs.unlinkSync(temporaryFile);
                } catch (cleanupError) {
                    // The next successful write uses a unique temporary name.
                }
            }
            this.warn('persist_failed');
            return false;
        }
    }

    getGeneration(safetyIdentifier) {
        const identifier = normalizeSafetyIdentifier(safetyIdentifier);
        if (!identifier || !this.isConfigured()) {
            return null;
        }
        return this.users.get(identifier)?.generation || this.tombstones.get(identifier) || 0;
    }

    getSnapshot(safetyIdentifier) {
        const identifier = normalizeSafetyIdentifier(safetyIdentifier);
        if (!identifier || !this.isConfigured()) {
            return { generation: 0, summary: '', exchanges: [], context: '' };
        }
        const profile = this.users.get(identifier);
        const generation = profile?.generation || this.tombstones.get(identifier) || 0;
        if (!profile) {
            return { generation, summary: '', exchanges: [], context: '' };
        }
        // Overflow awaiting summarization remains encrypted on disk, but only the
        // configured recent window is ever supplied verbatim to the model.
        const exchanges = profile.recent;
        const selected = [];
        let usedCharacters = profile.summary.length;
        for (let index = exchanges.length - 1; index >= 0; index -= 1) {
            const entry = exchanges[index];
            const size = entry.userText.length + entry.assistantText.length + 160;
            if (selected.length && usedCharacters + size > this.maxContextCharacters) {
                break;
            }
            selected.unshift({ ...entry });
            usedCharacters += size;
        }
        const sections = [];
        if (profile.summary) {
            sections.push(`Important key points from older conversations:\n${profile.summary}`);
        }
        if (selected.length) {
            const history = selected.map((entry) => (
                `[${entry.channel.toUpperCase()} ${entry.createdAt}]\n`
                + `Caller: ${entry.userText}\n`
                + (entry.assistantText ? `Assistant: ${entry.assistantText}` : 'Assistant: No completed reply was recorded.')
            )).join('\n\n');
            sections.push(`Recent exchanges, quoted verbatim:\n${history}`);
        }
        return {
            generation,
            summary: profile.summary,
            exchanges: selected,
            context: sections.join('\n\n')
        };
    }

    appendExchange({
        safetyIdentifier,
        exchangeId = crypto.randomUUID(),
        channel,
        userText,
        assistantText = '',
        createdAt = new Date(this.clock()).toISOString(),
        expectedGeneration
    } = {}) {
        const identifier = normalizeSafetyIdentifier(safetyIdentifier);
        if (!identifier || !this.isConfigured()) {
            return false;
        }
        const currentGeneration = this.getGeneration(identifier);
        if (currentGeneration === null) {
            return false;
        }
        if (expectedGeneration !== undefined && currentGeneration !== expectedGeneration) {
            return false;
        }
        const exchange = this.sanitizeExchange({
            id: exchangeId,
            channel,
            userText,
            assistantText,
            createdAt
        });
        if (!exchange) {
            return false;
        }
        const existing = this.users.get(identifier);
        const profile = existing ? cloneProfile(existing) : this.createProfile(currentGeneration);
        if ([...profile.pendingSummary, ...profile.recent].some((entry) => entry.id === exchange.id)) {
            return true;
        }
        profile.recent.push(exchange);
        while (profile.recent.length > this.maxRecentExchanges) {
            profile.pendingSummary.push(profile.recent.shift());
        }
        if (profile.pendingSummary.length > this.maxPendingSummary) {
            profile.pendingSummary = profile.pendingSummary.slice(-this.maxPendingSummary);
            this.warn('summary_backlog_clipped');
        }
        profile.revision += 1;

        const nextUsers = new Map(this.users);
        nextUsers.delete(identifier);
        nextUsers.set(identifier, profile);
        while (nextUsers.size > this.maxUsers) {
            nextUsers.delete(nextUsers.keys().next().value);
        }
        const nextTombstones = new Map(this.tombstones);
        nextTombstones.delete(identifier);
        if (!this.persist(nextUsers, nextTombstones)) {
            return false;
        }
        this.users = nextUsers;
        this.tombstones = nextTombstones;
        return true;
    }

    getSummaryWork(safetyIdentifier, maximumExchanges = 10) {
        const identifier = normalizeSafetyIdentifier(safetyIdentifier);
        if (!identifier || !this.isConfigured()) {
            return null;
        }
        const profile = identifier ? this.users.get(identifier) : null;
        if (!profile?.pendingSummary.length) {
            return null;
        }
        const exchanges = profile.pendingSummary.slice(0, boundedInteger(maximumExchanges, 10, 1, 20));
        return {
            safetyIdentifier: identifier,
            generation: profile.generation,
            summary: profile.summary,
            exchanges: exchanges.map((entry) => ({ ...entry }))
        };
    }

    commitSummary({ safetyIdentifier, generation, exchangeIds, summary } = {}) {
        const identifier = normalizeSafetyIdentifier(safetyIdentifier);
        if (!identifier || !this.isConfigured()) {
            return false;
        }
        const existing = identifier ? this.users.get(identifier) : null;
        const cleanSummary = normalizeText(summary, 8000);
        if (!existing || existing.generation !== generation || !cleanSummary) {
            return false;
        }
        const ids = new Set((Array.isArray(exchangeIds) ? exchangeIds : []).map(String));
        if (!ids.size || !existing.pendingSummary.some((entry) => ids.has(entry.id))) {
            return false;
        }
        const profile = cloneProfile(existing);
        profile.pendingSummary = profile.pendingSummary.filter((entry) => !ids.has(entry.id));
        profile.summary = cleanSummary;
        profile.revision += 1;
        const nextUsers = new Map(this.users);
        nextUsers.delete(identifier);
        nextUsers.set(identifier, profile);
        if (!this.persist(nextUsers, this.tombstones)) {
            return false;
        }
        this.users = nextUsers;
        return true;
    }

    clear(safetyIdentifier) {
        const identifier = normalizeSafetyIdentifier(safetyIdentifier);
        if (!identifier || !this.isConfigured()) {
            return false;
        }
        const currentGeneration = this.getGeneration(identifier);
        if (currentGeneration === null) {
            return false;
        }
        const generation = currentGeneration + 1;
        const nextUsers = new Map(this.users);
        nextUsers.delete(identifier);
        const nextTombstones = new Map(this.tombstones);
        nextTombstones.delete(identifier);
        nextTombstones.set(identifier, generation);
        while (nextTombstones.size > this.maxUsers) {
            nextTombstones.delete(nextTombstones.keys().next().value);
        }
        if (!this.persist(nextUsers, nextTombstones)) {
            return false;
        }
        this.users = nextUsers;
        this.tombstones = nextTombstones;
        return true;
    }
}

module.exports = {
    AiMemoryStore,
    DEFAULT_MEMORY_FILE,
    normalizeSafetyIdentifier
};
