const fs = require('fs');
const path = require('path');

const DEFAULT_CONSENT_FILE = path.join(process.cwd(), 'data', 'ai-consent.json');

class ConsentStore {
    constructor({
        storageFile = process.env.AI_CONSENT_FILE || DEFAULT_CONSENT_FILE,
        maxFileBytes = 10 * 1024 * 1024,
        logger = console
    } = {}) {
        this.storageFile = storageFile ? path.resolve(storageFile) : null;
        this.maxFileBytes = Math.max(1024, Number(maxFileBytes) || 10 * 1024 * 1024);
        this.logger = logger;
        this.optedOut = new Map();
        this.load();
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
            this.logger.warn?.('[ai-consent] load_failed');
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
        this.optedOut.delete(identifier);
        this.optedOut.set(identifier, Date.now());
        this.persist();
        return true;
    }

    optIn(safetyIdentifier) {
        const identifier = this.normalize(safetyIdentifier);
        if (!identifier) {
            return false;
        }
        const changed = this.optedOut.delete(identifier);
        if (changed) {
            this.persist();
        }
        return changed;
    }

    persist() {
        if (!this.storageFile) {
            return;
        }
        try {
            fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
            const temporaryFile = `${this.storageFile}.${process.pid}.tmp`;
            const body = JSON.stringify({
                version: 1,
                optedOut: Array.from(this.optedOut.entries())
            });
            fs.writeFileSync(temporaryFile, body, { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(temporaryFile, this.storageFile);
        } catch (error) {
            this.logger.warn?.('[ai-consent] persist_failed');
        }
    }
}

module.exports = {
    ConsentStore,
    DEFAULT_CONSENT_FILE
};
