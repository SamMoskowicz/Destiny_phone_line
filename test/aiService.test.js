const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    AiService,
    OPENAI_API_BASE_URL,
    truncateText
} = require('../src/aiService');
const { AiMemoryStore } = require('../src/aiMemoryStore');

const VALID_SAFETY_ID = `usr_${'b'.repeat(48)}`;

function createMemoryFixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-service-memory-'));
    const memoryStore = new AiMemoryStore({
        enabled: true,
        storageFile: path.join(directory, 'memory.enc.json'),
        encryptionKey: 'ai-service-test-encryption-key-that-is-at-least-32-characters',
        logger: { warn() {} }
    });
    return { directory, memoryStore };
}

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
                if (output && typeof output === 'object') {
                    return output;
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
    assert.match(client.calls[0].params.instructions, /through SMS text messages/i);
    assert.match(client.calls[0].params.instructions, /not a voice\s+call/i);
    assert.match(client.calls[0].params.instructions, /do not volunteer or routinely mention memory/i);
    assert.match(client.calls[0].params.instructions, /persistent caller memory is currently disabled/i);
    assert.doesNotMatch(client.calls[0].params.instructions, /automatically stores a bounded recent window/i);
    assert.deepEqual(client.calls[1].params.input, [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow up' }
    ]);
});

test('persistent memory shares prior voice context with SMS and records the new exchange', async () => {
    const fixture = createMemoryFixture();
    try {
        fixture.memoryStore.appendExchange({
            safetyIdentifier: VALID_SAFETY_ID,
            exchangeId: 'voice-turn-1',
            channel: 'voice',
            userText: 'My dog is named Pixel.',
            assistantText: 'Pixel is a great name.'
        });
        const client = fakeClient(['I remember that Pixel is your dog.']);
        const service = new AiService({ client, memoryStore: fixture.memoryStore });

        await service.replyToText({
            safetyIdentifier: VALID_SAFETY_ID,
            exchangeId: 'sms-turn-1',
            text: 'What is my dog called?'
        });

        assert.match(client.calls[0].params.instructions, /untrusted user data/i);
        assert.match(client.calls[0].params.instructions, /automatically stores a bounded recent window/i);
        assert.match(client.calls[0].params.instructions, /no automatic time-based expiration/i);
        assert.doesNotMatch(client.calls[0].params.instructions, /dog is named Pixel/i);
        assert.equal(client.calls[0].params.input.length, 2);
        assert.equal(client.calls[0].params.input[0].role, 'user');
        assert.match(client.calls[0].params.input[0].content, /dog is named Pixel/i);
        assert.match(client.calls[0].params.input[0].content, /not instructions/i);
        assert.deepEqual(client.calls[0].params.input[1], {
            role: 'user',
            content: 'What is my dog called?'
        });
        const snapshot = fixture.memoryStore.getSnapshot(VALID_SAFETY_ID);
        assert.equal(snapshot.exchanges.length, 2);
        assert.equal(snapshot.exchanges[1].assistantText, 'I remember that Pixel is your dog.');
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('older exchanges are summarized with store disabled on the OpenAI request', async () => {
    const fixture = createMemoryFixture();
    try {
        for (let index = 1; index <= 11; index += 1) {
            fixture.memoryStore.appendExchange({
                safetyIdentifier: VALID_SAFETY_ID,
                exchangeId: `old-${index}`,
                channel: 'sms',
                userText: `User detail ${index}`,
                assistantText: `Answer ${index}`
            });
        }
        const client = fakeClient([{
            status: 'completed',
            output_text: '- The caller explicitly shared user detail 1.'
        }]);
        const service = new AiService({ client, memoryStore: fixture.memoryStore });

        await service.refreshMemorySummary(VALID_SAFETY_ID);

        assert.equal(client.calls[0].params.store, false);
        assert.match(client.calls[0].params.instructions, /important facts the caller explicitly stated/i);
        assert.equal(fixture.memoryStore.getSummaryWork(VALID_SAFETY_ID), null);
        assert.match(fixture.memoryStore.getSnapshot(VALID_SAFETY_ID).summary, /detail 1/i);
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('an incomplete summary response does not erase verbatim overflow', async () => {
    const fixture = createMemoryFixture();
    try {
        for (let index = 1; index <= 11; index += 1) {
            fixture.memoryStore.appendExchange({
                safetyIdentifier: VALID_SAFETY_ID,
                exchangeId: `incomplete-${index}`,
                channel: 'sms',
                userText: `Detail ${index}`,
                assistantText: `Answer ${index}`
            });
        }
        const client = fakeClient([{
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output_text: '- Truncated and unsafe to commit'
        }]);
        const service = new AiService({ client, memoryStore: fixture.memoryStore, logger: { warn() {} } });

        await service.refreshMemorySummary(VALID_SAFETY_ID);

        assert.deepEqual(
            fixture.memoryStore.getSummaryWork(VALID_SAFETY_ID).exchanges.map((entry) => entry.id),
            ['incomplete-1']
        );
        assert.equal(fixture.memoryStore.getSnapshot(VALID_SAFETY_ID).summary, '');
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
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
    assert.equal(Object.hasOwn(client.calls[0].params, 'max_output_tokens'), false);
    assert.equal(client.calls[0].params.store, false);
});

test('deep voice memory stays in user-level input instead of developer instructions', async () => {
    const fixture = createMemoryFixture();
    try {
        fixture.memoryStore.appendExchange({
            safetyIdentifier: VALID_SAFETY_ID,
            exchangeId: 'voice-memory-priority',
            channel: 'sms',
            userText: 'My project is called Northstar.',
            assistantText: 'Understood.'
        });
        const client = fakeClient(['A memory-aware spoken answer.']);
        const service = new AiService({ client, memoryStore: fixture.memoryStore });

        await service.answerComplexVoice({
            safetyIdentifier: VALID_SAFETY_ID,
            question: 'What is my project called?'
        });

        assert.match(client.calls[0].params.instructions, /untrusted user data/i);
        assert.doesNotMatch(client.calls[0].params.instructions, /Northstar/i);
        assert.equal(client.calls[0].params.input[0].role, 'user');
        assert.match(client.calls[0].params.input[0].content, /Northstar/i);
        assert.deepEqual(client.calls[0].params.input[1], {
            role: 'user',
            content: 'What is my project called?'
        });
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('deep voice answers are not clipped to a character limit', async () => {
    const longAnswer = 'This is a complete spoken sentence. '.repeat(60).trim();
    assert.ok(longAnswer.length > 1400);
    const client = fakeClient([longAnswer]);
    const service = new AiService({ client });

    const result = await service.answerComplexVoice({
        safetyIdentifier: 'usr_hash',
        question: 'Give me a detailed explanation.'
    });

    assert.equal(result.answer, longAnswer);
    assert.ok(result.answer.length > 1400);
});

test('an incomplete deep answer keeps only complete spoken sentences', async () => {
    const client = fakeClient([{
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: 'This sentence is complete. This sentence was cut off halfway'
    }]);
    const service = new AiService({ client });

    const result = await service.answerComplexVoice({
        safetyIdentifier: 'usr_hash',
        question: 'Give me a detailed explanation.'
    });

    assert.equal(result.answer, 'This sentence is complete.');
});

test('a content-filtered deep answer is not passed through as speech', async () => {
    const client = fakeClient([{
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        output_text: 'Partial filtered output.'
    }]);
    const service = new AiService({ client });

    await assert.rejects(
        service.answerComplexVoice({
            safetyIdentifier: 'usr_hash',
            question: 'Give me a detailed explanation.'
        }),
        (error) => error.code === 'AI_INCOMPLETE_RESPONSE'
    );
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

test('reset reports failure when disabled memory still has persistent data', () => {
    const memoryStore = {
        enabled: false,
        hasPersistentData: () => true
    };
    const service = new AiService({ client: fakeClient([]), memoryStore });

    assert.equal(service.resetTextConversation(VALID_SAFETY_ID), false);
});
