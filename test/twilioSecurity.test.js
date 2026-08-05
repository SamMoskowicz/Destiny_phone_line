const test = require('node:test');
const assert = require('node:assert/strict');
const twilio = require('twilio');
const { TwilioSecurity, buildPublicRequestUrl } = require('../src/twilioSecurity');

test('HTTP Twilio signatures accept multiple numbers from the configured account', () => {
    const authToken = 'test-auth-token';
    const url = 'https://phone.example/voice/menu';
    const params = {
        AccountSid: 'AC123',
        To: '+15550001111',
        From: '+15550002222',
        Digits: '8'
    };
    const security = new TwilioSecurity({
        authToken,
        accountSid: 'AC123',
        publicBaseUrl: 'https://phone.example'
    });
    const signedRequest = (signedParams) => ({
        url: '/voice/menu',
        headers: {
            host: 'attacker.example',
            'x-twilio-signature': twilio.getExpectedTwilioSignature(authToken, url, signedParams)
        }
    });

    assert.equal(security.validateHttpRequest(signedRequest(params), params), true);
    const secondNumberParams = { ...params, To: '+18885550123' };
    assert.equal(
        security.validateHttpRequest(signedRequest(secondNumberParams), secondNumberParams),
        true
    );
    const wrongAccountParams = { ...params, AccountSid: 'AC999' };
    assert.equal(
        security.validateHttpRequest(signedRequest(wrongAccountParams), wrongAccountParams),
        false
    );
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
