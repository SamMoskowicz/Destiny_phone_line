const fs = require('fs');
const path = require('path');

const DEFAULT_CONSENT_FILE = path.join(process.cwd(), 'data', 'ai-consent.json');

class ConsentStore {
    constructor({
        storageFile = process.env.AI_CONSENT_FILE || DEFAULT_CONSENT_FILE,
        maxFileBytes = 10 * 1024 * 1024,
        logger = console,
        clock = () => Date.now()
    } = {}) {
        this.storageFile = storageFile ? path.resolve(storageFile) : null;
        this.maxFileBytes = Math.max(1024, Number(maxFileBytes) || 10 * 1024 * 1024);
        this.logger = logger;
        this.clock = clock;
        this.optedOut = new Map();
        this.loadFailed = false;
        this.load();
    }

    isConfigured() {
        return !this.loadFailed;
    }

    normalize(safetyIdentifier) {
        const value = String(safetyIdentifier || '').trim();
        return /^usr_[a-f0-9]{48}$/.test(value) ? value : null;
    }

    load() {
        if (!this.storageFile || !fs.existsSync(this.storageFile)) {
            return;
        }
        try {
            const stats = fs.statSync(this.storageFile);
            if (!stats.isFile() || stats.size > this.maxFileBytes) {
                throw new Error('Consent file is invalid or too large');
            }
            const parsed = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
            const entries = Array.isArray(parsed?.optedOut) ? parsed.optedOut : [];
            for (const entry of entries) {
                const identifier = this.normalize(Array.isArray(entry) ? entry[0] : entry);
                const timestamp = Number(Array.isArray(entry) ? entry[1] : 0);
                if (identifier) {
                    this.optedOut.set(identifier, Number.isFinite(timestamp) ? timestamp : 0);
                }
            }
        } catch (error) {
            this.optedOut.clear();
            this.loadFailed = true;
            this.logger.warn?.('[ai-preferences] load_failed');
        }
    }

    isOptedOut(safetyIdentifier) {
        const identifier = this.normalize(safetyIdentifier);
        return Boolean(identifier && this.optedOut.has(identifier));
    }

    optOut(safetyIdentifier) {
        const identifier = this.normalize(safetyIdentifier);
        if (!identifier) {
            return false;
        }
        const previousOptedOut = new Map(this.optedOut);
        this.optedOut.delete(identifier);
        this.optedOut.set(identifier, this.clock());
        if (this.persist()) {
            return true;
        }
        this.optedOut = previousOptedOut;
        return false;
    }

    optIn(safetyIdentifier) {
        const identifier = this.normalize(safetyIdentifier);
        if (!identifier) {
            return false;
        }
        const previousOptedOut = new Map(this.optedOut);
        const changed = this.optedOut.delete(identifier);
        if (changed && !this.persist()) {
            this.optedOut = previousOptedOut;
            return false;
        }
        return changed;
    }

    persist() {
        if (this.loadFailed) {
            return false;
        }
        if (!this.storageFile) {
            return true;
        }
        let temporaryFile = null;
        try {
            fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
            temporaryFile = `${this.storageFile}.${process.pid}.${Date.now()}.tmp`;
            const body = JSON.stringify({
                version: 3,
                optedOut: Array.from(this.optedOut.entries())
            });
            fs.writeFileSync(temporaryFile, body, { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(temporaryFile, this.storageFile);
            return true;
        } catch (error) {
            if (temporaryFile && fs.existsSync(temporaryFile)) {
                try {
                    fs.unlinkSync(temporaryFile);
                } catch (cleanupError) {
                    // A later write uses a new temporary filename.
                }
            }
            this.logger.warn?.('[ai-preferences] persist_failed');
            return false;
        }
    }
}

module.exports = {
    ConsentStore,
    DEFAULT_CONSENT_FILE
};
