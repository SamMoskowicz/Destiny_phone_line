const test = require('node:test');
const assert = require('node:assert/strict');
const twilio = require('twilio');
const { TwilioSecurity, buildPublicRequestUrl } = require('../src/twilioSecurity');

test('HTTP Twilio signatures use the configured public URL and expected account/number', () => {
    const authToken = 'test-auth-token';
    const url = 'https://phone.example/voice/menu';
    const params = {
        AccountSid: 'AC123',
        To: '+15550001111',
        From: '+15550002222',
        Digits: '8'
    };
    const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
    const security = new TwilioSecurity({
        authToken,
        accountSid: 'AC123',
        phoneNumber: '+15550001111',
        publicBaseUrl: 'https://phone.example'
    });
    const req = {
        url: '/voice/menu',
        headers: {
            host: 'attacker.example',
            'x-twilio-signature': signature
        }
    };

    assert.equal(security.validateHttpRequest(req, params), true);
    assert.equal(security.validateHttpRequest(req, { ...params, AccountSid: 'AC999' }), false);
});

test('WebSocket Twilio signatures validate the exact WSS stream URL', () => {
    const authToken = 'test-auth-token';
    const url = 'wss://phone.example/voice/ai-stream';
    const security = new TwilioSecurity({
        authToken,
        publicBaseUrl: 'https://phone.example'
    });
    const req = {
        url: '/voice/ai-stream',
        headers: {
            host: 'ignored.example',
            'x-twilio-signature': twilio.getExpectedTwilioSignature(authToken, url, {})
        }
    };

    assert.equal(security.validateWebSocketRequest(req), true);
    req.headers['x-twilio-signature'] = 'invalid';
    assert.equal(security.validateWebSocketRequest(req), false);
});

test('public request URL conversion preserves the request path and converts HTTPS to WSS', () => {
    const req = { url: '/voice/ai-stream', headers: { host: 'ignored.example' } };
    assert.equal(
        buildPublicRequestUrl(req, 'https://phone.example', { webSocket: true }),
        'wss://phone.example/voice/ai-stream'
    );
});
