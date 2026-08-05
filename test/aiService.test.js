const test = require('node:test');
const assert = require('node:assert/strict');
const { AiService, OPENAI_API_BASE_URL, truncateText } = require('../src/aiService');

function fakeClient(outputs) {
    const calls = [];
    return {
        calls,
        responses: {
            async create(params, options) {
                calls.push({ params, options });
                const output = outputs.shift();
                if (output instanceof Error) {
                    throw output;
                }
                return { output_text: output };
            }
        }
    };
}

test('text chat uses GPT-5.6 Sol Fast mode and bounded in-memory history', async () => {
    let now = 1000;
    const client = fakeClient(['First answer', 'Second answer']);
    const service = new AiService({
        client,
        clock: () => now,
        textMaxCharacters: 600,
        maxHistoryMessages: 4
    });

    const first = await service.replyToText({ safetyIdentifier: 'usr_hash', text: 'First question' });
    now += 100;
    const second = await service.replyToText({ safetyIdentifier: 'usr_hash', text: 'Follow up' });

    assert.equal(first, 'First answer');
    assert.equal(second, 'Second answer');
    assert.equal(client.calls[0].params.model, 'gpt-5.6-sol');
    assert.equal(client.calls[0].params.service_tier, 'fast');
    assert.deepEqual(client.calls[0].params.reasoning, { effort: 'low', context: 'current_turn' });
    assert.equal(client.calls[0].params.safety_identifier, 'usr_hash');
    assert.equal(client.calls[0].params.store, false);
    assert.deepEqual(client.calls[1].params.input, [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow up' }
    ]);
});

test('deep voice answers use the frontier model without storing the response', async () => {
    const client = fakeClient(['A careful spoken answer.']);
    const service = new AiService({ client, deepVoiceReasoning: 'medium' });

    const result = await service.answerComplexVoice({
        safetyIdentifier: 'usr_hash',
        question: 'Compare these two approaches.',
        recentTranscript: 'We were discussing a tradeoff.'
    });

    assert.deepEqual(result, { answer: 'A careful spoken answer.', usageTokens: 0 });
    assert.equal(client.calls[0].params.model, 'gpt-5.6-sol');
    assert.deepEqual(client.calls[0].params.reasoning, { effort: 'medium', context: 'current_turn' });
    assert.match(client.calls[0].params.input, /Recent conversation context/);
    assert.equal(client.calls[0].params.store, false);
});

test('SMS output is clipped cleanly to the configured length', () => {
    const result = truncateText('One sentence. '.repeat(100), 100);
    assert.ok(result.length <= 100);
    assert.match(result, /\.\.\.$/);
});

test('an unconfigured AI service fails closed', async () => {
    const service = new AiService({ apiKey: '', client: null });
    assert.equal(service.isConfigured(), false);
    await assert.rejects(
        service.replyToText({ safetyIdentifier: 'usr_hash', text: 'hello' }),
        (error) => error.code === 'AI_NOT_CONFIGURED'
    );
});

test('OPENAI_BASE_URL cannot redirect the built-in OpenAI client', () => {
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = 'https://attacker.example/v1';
    try {
        const service = new AiService({ apiKey: 'server-secret-key' });
        assert.equal(service.client.baseURL, OPENAI_API_BASE_URL);
    } finally {
        if (previous === undefined) {
            delete process.env.OPENAI_BASE_URL;
        } else {
            process.env.OPENAI_BASE_URL = previous;
        }
    }
});

test('invalid timeout and odd history configuration are normalized safely', async () => {
    const client = fakeClient(['one', 'two', 'three']);
    const service = new AiService({
        client,
        textTimeoutMs: 'not-a-number',
        deepVoiceTimeoutMs: 'also-invalid',
        maxHistoryMessages: 3
    });
    assert.equal(service.textTimeoutMs, 4500);
    assert.equal(service.deepVoiceTimeoutMs, 3500);
    assert.equal(service.maxHistoryMessages, 2);

    await service.replyToText({ safetyIdentifier: 'usr_hash', text: 'first' });
    await service.replyToText({ safetyIdentifier: 'usr_hash', text: 'second' });
    await service.replyToText({ safetyIdentifier: 'usr_hash', text: 'third' });
    assert.deepEqual(client.calls[2].params.input, [
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'third' }
    ]);
});

test('reset cancels in-flight and queued replies without resurrecting conversation history', async () => {
    const calls = [];
    const resolvers = [];
    const client = {
        responses: {
            create(params, options) {
                calls.push({ params, options });
                return new Promise((resolve) => resolvers.push(resolve));
            }
        }
    };
    const service = new AiService({ client });

    const first = service.replyToText({ safetyIdentifier: 'usr_reset', text: 'first' });
    const queued = service.replyToText({ safetyIdentifier: 'usr_reset', text: 'queued' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);

    service.resetTextConversation('usr_reset');
    assert.equal(calls[0].options.signal.aborted, true);
    resolvers[0]({ output_text: 'stale answer' });

    const results = await Promise.allSettled([first, queued]);
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    assert.ok(results.every((result) => result.reason?.code === 'AI_CONVERSATION_RESET'));
    assert.equal(calls.length, 1);
    assert.equal(service.textSessions.has('usr_reset'), false);

    const fresh = service.replyToText({ safetyIdentifier: 'usr_reset', text: 'after reset' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].params.input, [{ role: 'user', content: 'after reset' }]);
    resolvers[1]({ output_text: 'fresh answer' });
    assert.equal(await fresh, 'fresh answer');
});
