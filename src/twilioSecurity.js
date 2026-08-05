const twilio = require('twilio');

function normalizeBaseUrl(value, { requireHttps = false } = {}) {
    if (!value) {
        return null;
    }
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)
            || (requireHttps && url.protocol !== 'https:')
            || url.username
            || url.password) {
            return null;
        }
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/+$/, '');
    } catch (error) {
        return null;
    }
}

function buildPublicRequestUrl(req, publicBaseUrl, { webSocket = false } = {}) {
    const configured = normalizeBaseUrl(publicBaseUrl);
    if (publicBaseUrl && !configured) {
        return null;
    }
    let url;
    if (configured) {
        url = new URL(req.url, `${configured}/`);
    } else {
        const host = req.headers.host;
        if (!host) {
            return null;
        }
        const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        try {
            url = new URL(`${forwarded || 'http'}://${host}${req.url}`);
        } catch (error) {
            return null;
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            return null;
        }
    }
    if (webSocket) {
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    }
    return url.toString();
}

class TwilioSecurity {
    constructor({
        authToken = process.env.TWILIO_AUTH_TOKEN,
        accountSid = process.env.TWILIO_ACCOUNT_SID,
        publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL,
        allowDevelopmentHostFallback = process.env.NODE_ENV !== 'production'
    } = {}) {
        this.allowDevelopmentHostFallback = Boolean(allowDevelopmentHostFallback);
        this.authToken = authToken || null;
        this.accountSid = accountSid || null;
        this.publicBaseUrl = normalizeBaseUrl(publicBaseUrl, {
            requireHttps: !this.allowDevelopmentHostFallback
        });
    }

    isConfigured() {
        return Boolean(this.authToken);
    }

    hasFixedPublicUrl() {
        return Boolean(this.publicBaseUrl);
    }

    validateExpectedAccount(params) {
        if (this.accountSid && params.AccountSid !== this.accountSid) {
            return false;
        }
        return true;
    }

    validateHttpRequest(req, params) {
        if (!this.authToken || !this.validateExpectedAccount(params)) {
            return false;
        }
        if (!this.publicBaseUrl && !this.allowDevelopmentHostFallback) {
            return false;
        }
        const signature = req.headers['x-twilio-signature'];
        const url = buildPublicRequestUrl(req, this.publicBaseUrl);
        if (!signature || !url) {
            return false;
        }
        try {
            return twilio.validateRequest(this.authToken, signature, url, params);
        } catch (error) {
            return false;
        }
    }

    validateWebSocketRequest(req) {
        if (!this.authToken || (!this.publicBaseUrl && !this.allowDevelopmentHostFallback)) {
            return false;
        }
        const signature = req.headers['x-twilio-signature'];
        const url = buildPublicRequestUrl(req, this.publicBaseUrl, { webSocket: true });
        if (!signature || !url) {
            return false;
        }
        try {
            if (twilio.validateRequest(this.authToken, signature, url, {})) {
                return true;
            }
            // Twilio documents a trailing-slash edge case for Voice Media Stream WSS
            // validation. Accept the slash form only when it is the same path.
            const slashUrl = url.endsWith('/') ? url : `${url}/`;
            return twilio.validateRequest(this.authToken, signature, slashUrl, {});
        } catch (error) {
            return false;
        }
    }
}

module.exports = {
    TwilioSecurity,
    normalizeBaseUrl,
    buildPublicRequestUrl
};
