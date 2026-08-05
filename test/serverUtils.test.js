const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { parseBody, buildSmsTwiML, buildAiWebSocketUrl } = require('../server');

function requestWithBody(body, contentType = 'application/x-www-form-urlencoded') {
    const req = Readable.from([Buffer.from(body)]);
    req.headers = {
        'content-type': contentType,
        'content-length': String(Buffer.byteLength(body)),
        host: 'localhost:3000'
    };
    req.url = '/sms';
    return req;
}

test('form parser handles Twilio plus signs/spaces and imposes a size limit', async () => {
    const parsed = await parseBody(requestWithBody('From=%2B15551234567&Body=hello+there'));
    assert.equal(parsed.From, '+15551234567');
    assert.equal(parsed.Body, 'hello there');

    await assert.rejects(
        parseBody(requestWithBody('x'.repeat(100)), 20),
        (error) => error.statusCode === 413
    );
});

test('malformed JSON is a clean 400 error', async () => {
    await assert.rejects(
        parseBody(requestWithBody('{broken', 'application/json')),
        (error) => error.statusCode === 400
    );
});

test('SMS TwiML escapes model output exactly once', () => {
    assert.equal(
        buildSmsTwiML('A & B < C'),
        '<?xml version="1.0" encoding="UTF-8"?><Response><Message>A &amp; B &lt; C</Message></Response>'
    );
});

test('AI Media Stream URL uses WSS and never includes credentials', () => {
    const previous = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://phone.example';
    try {
        const url = buildAiWebSocketUrl({ url: '/voice/menu', headers: {} });
        assert.equal(url, 'wss://phone.example/voice/ai-stream');
        assert.doesNotMatch(url, /api[_-]?key|openai/i);
    } finally {
        if (previous === undefined) {
            delete process.env.PUBLIC_BASE_URL;
        } else {
            process.env.PUBLIC_BASE_URL = previous;
        }
    }
});
