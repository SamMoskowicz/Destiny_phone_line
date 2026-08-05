const test = require('node:test');
const assert = require('node:assert/strict');
const { formatAiSms, smsMetrics } = require('../src/smsUtils');

const SMS_SUFFIX = '\nReply DELETE to erase AI memory; STOP to unsubscribe.';

test('GSM-7 metrics count extension-table characters and concatenated boundaries', () => {
    assert.deepEqual(smsMetrics('A'.repeat(160)), {
        encoding: 'GSM-7',
        units: 160,
        segments: 1
    });
    assert.equal(smsMetrics('A'.repeat(161)).segments, 2);
    assert.deepEqual(smsMetrics('^'.repeat(80)), {
        encoding: 'GSM-7',
        units: 160,
        segments: 1
    });
    assert.equal(smsMetrics('^'.repeat(81)).segments, 2);
    assert.deepEqual(smsMetrics('£é€'), {
        encoding: 'GSM-7',
        units: 4,
        segments: 1
    });
});

test('long GSM answers retain the compliance footer and fit exactly within three segments', () => {
    const message = formatAiSms('A'.repeat(2000));
    const metrics = smsMetrics(message);

    assert.equal(metrics.encoding, 'GSM-7');
    assert.equal(metrics.segments, 3);
    assert.ok(metrics.units <= 459);
    assert.match(message, /^ChatGPT: /);
    assert.match(message, /\.\.\.\nReply DELETE to erase AI memory; STOP to unsubscribe\.$/);
    assert.ok(message.endsWith(SMS_SUFFIX));
});

test('long Unicode answers fit three UCS-2 segments without splitting a surrogate pair', () => {
    const message = formatAiSms('🙂'.repeat(300));
    const metrics = smsMetrics(message);

    assert.equal(metrics.encoding, 'UCS-2');
    assert.equal(metrics.segments, 3);
    assert.ok(metrics.units <= 201);
    assert.ok(message.endsWith(SMS_SUFFIX));
    assert.doesNotMatch(
        message,
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    );
});
