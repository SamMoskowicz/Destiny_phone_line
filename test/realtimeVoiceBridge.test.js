const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { EphemeralSessionTokenStore } = require('../src/aiSecurity');
const {
    RealtimeVoiceBridge,
    buildSessionUpdate,
    isValidBase64
} = require('../src/realtimeVoiceBridge');

class FakeWebSocket extends EventEmitter {
    constructor(readyState = 1) {
        super();
        this.readyState = readyState;
        this.bufferedAmount = 0;
        this.sent = [];
        this.closeCalls = [];
    }

    send(value) {
        this.sent.push(JSON.parse(String(value)));
    }

    open() {
        this.readyState = 1;
        this.emit('open');
    }

    receive(value) {
        this.emit('message', Buffer.from(JSON.stringify(value)));
    }

    close(code, reason) {
        if (this.readyState === 3) {
            return;
        }
        this.closeCalls.push({ code, reason });
        this.readyState = 3;
        this.emit('close', code, reason);
    }

    terminate() {
        this.readyState = 3;
    }
}

function startEvent(token) {
    return {
        event: 'start',
        streamSid: 'MZ123',
        start: {
            callSid: 'CA123',
            streamSid: 'MZ123',
            customParameters: { sessionToken: token },
            mediaFormat: {
                encoding: 'audio/x-mulaw',
                sampleRate: 8000,
                channels: 1
            }
        }
    };
}

function createHarness({
    clock = () => Date.now(),
    answer = 'Deep answer.',
    deepUsageTokens = 0,
    bridgeOptions = {}
} = {}) {
    const tokenStore = new EphemeralSessionTokenStore();
    const token = tokenStore.issue({ callSid: 'CA123', safetyIdentifier: 'usr_hash' });
    const upstream = new FakeWebSocket(0);
    let connection;
    const aiService = {
        calls: [],
        isConfigured: () => true,
        async answerComplexVoice(args) {
            aiService.calls.push(args);
            aiService.lastArgs = args;
            return { answer, usageTokens: deepUsageTokens };
        }
    };
    const bridge = new RealtimeVoiceBridge({
        apiKey: 'server-secret-key',
        aiService,
        tokenStore,
        twilioSecurity: { isConfigured: () => true },
        openAiSocketFactory(url, options) {
            connection = { url, options };
            return upstream;
        },
        logger: { warn() {} },
        clock,
        ...bridgeOptions
    });
    const twilioSocket = new FakeWebSocket();
    const state = bridge.acceptTwilioSocket(twilioSocket);
    twilioSocket.receive({ event: 'connected' });
    twilioSocket.receive(startEvent(token));
    return { bridge, upstream, twilioSocket, aiService, state, connection: () => connection };
}

function completeSetup(upstream) {
    upstream.open();
    upstream.receive({
        type: 'session.updated',
        session: {
            audio: {
                input: { format: { type: 'audio/pcmu' } },
                output: { format: { type: 'audio/pcmu' } }
            }
        }
    });
}

test('session update configures PCMU, transcription, VAD, reasoning, and the deep tool', () => {
    const event = buildSessionUpdate();
    assert.equal(event.type, 'session.update');
    assert.deepEqual(event.session.output_modalities, ['audio']);
    assert.equal(event.session.audio.input.format.type, 'audio/pcmu');
    assert.equal(event.session.audio.output.format.type, 'audio/pcmu');
    assert.equal(event.session.audio.input.transcription.model, 'gpt-transcribe');
    assert.equal(event.session.audio.input.turn_detection.silence_duration_ms, 350);
    assert.deepEqual(event.session.reasoning, { effort: 'low' });
    assert.equal(event.session.tools[0].name, 'answer_complex_question');
});

test('a non-OpenAI Realtime URL disables the bridge before a secret can be sent', () => {
    let socketFactoryCalls = 0;
    const bridge = new RealtimeVoiceBridge({
        apiKey: 'server-secret-key',
        aiService: { isConfigured: () => true },
        tokenStore: new EphemeralSessionTokenStore(),
        twilioSecurity: { isConfigured: () => true },
        openAiUrl: 'wss://api.openai.com.attacker.example/v1/realtime',
        openAiSocketFactory() {
            socketFactoryCalls += 1;
            return new FakeWebSocket();
        }
    });

    assert.equal(bridge.openAiUrl, null);
    assert.equal(bridge.isConfigured(), false);
    assert.equal(socketFactoryCalls, 0);
    bridge.close();
});

test('Twilio PCMU audio passes through to OpenAI and OpenAI audio passes back unchanged', () => {
    const harness = createHarness();
    const { bridge, upstream, twilioSocket } = harness;
    assert.match(harness.connection().url, /model=gpt-realtime-2\.1/);
    assert.equal(harness.connection().options.headers.Authorization, 'Bearer server-secret-key');
    assert.equal(harness.connection().options.headers['OpenAI-Safety-Identifier'], 'usr_hash');

    completeSetup(upstream);
    assert.equal(upstream.sent[0].type, 'session.update');

    const callerAudio = Buffer.alloc(160, 127).toString('base64');
    twilioSocket.receive({ event: 'media', streamSid: 'MZ123', media: { payload: callerAudio } });
    assert.deepEqual(upstream.sent.at(-1), {
        type: 'input_audio_buffer.append',
        audio: callerAudio
    });

    const assistantAudio = Buffer.alloc(320, 42).toString('base64');
    upstream.receive({
        type: 'response.output_audio.delta',
        item_id: 'item-1',
        delta: assistantAudio
    });
    assert.deepEqual(twilioSocket.sent.at(-1), {
        event: 'media',
        streamSid: 'MZ123',
        media: { payload: assistantAudio }
    });

    twilioSocket.receive({ event: 'stop', streamSid: 'MZ123' });
    assert.equal(bridge.activeSessionCount, 0);
    assert.equal(upstream.readyState, 3);
    bridge.close();
});

test('caller audio stays queued until OpenAI confirms the negotiated PCMU session', () => {
    const { bridge, upstream, twilioSocket } = createHarness();
    upstream.open();

    const callerAudio = Buffer.alloc(160, 91).toString('base64');
    twilioSocket.receive({ event: 'media', streamSid: 'MZ123', media: { payload: callerAudio } });
    assert.equal(upstream.sent.some((event) => event.type === 'input_audio_buffer.append'), false);

    upstream.receive({
        type: 'session.updated',
        session: {
            audio: {
                input: { format: { type: 'audio/pcmu' } },
                output: { format: { type: 'audio/pcmu' } }
            }
        }
    });
    assert.deepEqual(upstream.sent.at(-1), {
        type: 'input_audio_buffer.append',
        audio: callerAudio
    });

    twilioSocket.receive({ event: 'stop', streamSid: 'MZ123' });
    bridge.close();
});

test('OpenAI setup closes both sides when PCMU negotiation is rejected', () => {
    const { bridge, upstream, twilioSocket } = createHarness();
    upstream.open();
    upstream.receive({
        type: 'session.updated',
        session: {
            audio: {
                input: { format: { type: 'audio/pcm' } },
                output: { format: { type: 'audio/pcmu' } }
            }
        }
    });

    assert.equal(bridge.activeSessionCount, 0);
    assert.equal(twilioSocket.readyState, 3);
    assert.equal(upstream.readyState, 3);
    bridge.close();
});

test('a silent caller gets two idle prompts before the third timeout closes the session', () => {
    const { bridge, upstream, twilioSocket, state } = createHarness({
        bridgeOptions: { maxIdlePrompts: 2 }
    });
    completeSetup(upstream);

    upstream.receive({ type: 'input_audio_buffer.timeout_triggered' });
    upstream.receive({ type: 'input_audio_buffer.timeout_triggered' });
    assert.equal(state.idlePromptCount, 2);
    assert.equal(bridge.activeSessionCount, 1);
    assert.equal(twilioSocket.readyState, 1);

    upstream.receive({ type: 'input_audio_buffer.timeout_triggered' });
    assert.equal(bridge.activeSessionCount, 0);
    assert.equal(twilioSocket.readyState, 3);
    assert.equal(upstream.readyState, 3);
    bridge.close();
});

test('a Realtime error after setup closes both sockets and releases the call slot', () => {
    const { bridge, upstream, twilioSocket } = createHarness();
    completeSetup(upstream);
    upstream.receive({
        type: 'error',
        error: { type: 'server_error', code: 'server_error' }
    });

    assert.equal(bridge.activeSessionCount, 0);
    assert.equal(twilioSocket.readyState, 3);
    assert.equal(upstream.readyState, 3);
    bridge.close();
});

test('barge-in clears queued Twilio audio and truncates unheard OpenAI audio', () => {
    let now = 1000;
    const { bridge, upstream, twilioSocket } = createHarness({ clock: () => now });
    completeSetup(upstream);
    upstream.receive({
        type: 'response.output_item.added',
        item: { id: 'item-1', type: 'message' }
    });
    upstream.receive({
        type: 'response.output_audio.delta',
        item_id: 'item-1',
        delta: Buffer.alloc(800, 42).toString('base64')
    });
    now += 50;
    upstream.receive({ type: 'input_audio_buffer.speech_started' });

    assert.ok(twilioSocket.sent.some((event) => event.event === 'clear'));
    const truncate = upstream.sent.find((event) => event.type === 'conversation.item.truncate');
    assert.deepEqual(truncate, {
        type: 'conversation.item.truncate',
        item_id: 'item-1',
        content_index: 0,
        audio_end_ms: 50
    });
    const mediaCount = twilioSocket.sent.filter((event) => event.event === 'media').length;
    upstream.receive({
        type: 'response.output_audio.delta',
        item_id: 'item-1',
        delta: Buffer.alloc(160, 7).toString('base64')
    });
    assert.equal(twilioSocket.sent.filter((event) => event.event === 'media').length, mediaCount);
    twilioSocket.receive({ event: 'dtmf', streamSid: 'MZ123', dtmf: { digit: '8' } });
    assert.equal(twilioSocket.readyState, 3);
    assert.equal(bridge.activeSessionCount, 0);
    bridge.close();
});

test('barge-in truncation follows Twilio stream timestamps instead of server wall time', () => {
    let now = 1000;
    const { bridge, upstream, twilioSocket } = createHarness({ clock: () => now });
    completeSetup(upstream);

    const callerAudio = Buffer.alloc(160, 17).toString('base64');
    twilioSocket.receive({
        event: 'media',
        streamSid: 'MZ123',
        media: { payload: callerAudio, timestamp: '4000' }
    });
    upstream.receive({
        type: 'response.output_audio.delta',
        item_id: 'item-timestamped',
        delta: Buffer.alloc(8000, 42).toString('base64')
    });

    now += 9000;
    twilioSocket.receive({
        event: 'media',
        streamSid: 'MZ123',
        media: { payload: callerAudio, timestamp: '4250' }
    });
    upstream.receive({ type: 'input_audio_buffer.speech_started' });

    assert.deepEqual(upstream.sent.find((event) => event.type === 'conversation.item.truncate'), {
        type: 'conversation.item.truncate',
        item_id: 'item-timestamped',
        content_index: 0,
        audio_end_ms: 250
    });
    twilioSocket.receive({ event: 'stop', streamSid: 'MZ123' });
    bridge.close();
});

test('difficult-question tool results and usage are returned to Realtime', async () => {
    const { bridge, upstream, twilioSocket, aiService, state } = createHarness({
        answer: 'Use the second approach.',
        deepUsageTokens: 30
    });
    completeSetup(upstream);
    upstream.receive({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'We are comparing two approaches.'
    });
    upstream.receive({
        type: 'response.done',
        response: {
            status: 'completed',
            usage: { total_tokens: 20 },
            output: [{
                type: 'function_call',
                name: 'answer_complex_question',
                call_id: 'call-1',
                arguments: JSON.stringify({ question: 'Which approach is safer?' })
            }]
        }
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(aiService.lastArgs.safetyIdentifier, 'usr_hash');
    assert.match(aiService.lastArgs.recentTranscript, /comparing two approaches/);
    assert.equal(state.totalTokens, 50);
    const functionOutputIndex = upstream.sent.findIndex((event) => event.item?.call_id === 'call-1');
    const disableIndex = upstream.sent.findIndex((event) => (
        event.type === 'session.update'
        && event.session?.audio?.input?.turn_detection?.create_response === false
    ));
    const enableIndex = upstream.sent.findIndex((event, index) => (
        index > functionOutputIndex
        && event.type === 'session.update'
        && event.session?.audio?.input?.turn_detection?.create_response === true
    ));
    assert.deepEqual(upstream.sent[functionOutputIndex], {
        type: 'conversation.item.create',
        item: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: 'Use the second approach.'
        }
    });
    assert.ok(disableIndex >= 0 && disableIndex < functionOutputIndex);
    assert.ok(enableIndex > functionOutputIndex);
    assert.deepEqual(upstream.sent.at(-1), { type: 'response.create' });
    twilioSocket.receive({ event: 'stop', streamSid: 'MZ123' });
    bridge.close();
});

test('a second function call gets an immediate output while only one deep request runs', async () => {
    const { bridge, upstream, twilioSocket, aiService } = createHarness({
        answer: 'The first deep answer.'
    });
    completeSetup(upstream);
    upstream.receive({
        type: 'response.done',
        response: {
            status: 'completed',
            output: [
                {
                    id: 'function-item-first',
                    type: 'function_call',
                    name: 'answer_complex_question',
                    call_id: 'call-first',
                    arguments: JSON.stringify({ question: 'First question?' })
                },
                {
                    id: 'function-item-second',
                    type: 'function_call',
                    name: 'answer_complex_question',
                    call_id: 'call-second',
                    arguments: JSON.stringify({ question: 'Second question?' })
                }
            ]
        }
    });

    const secondOutput = upstream.sent.find((event) => event.item?.call_id === 'call-second');
    assert.deepEqual(secondOutput, {
        type: 'conversation.item.create',
        previous_item_id: 'function-item-second',
        item: {
            type: 'function_call_output',
            call_id: 'call-second',
            output: 'Skipped because another deeper analysis is already in progress.'
        }
    });
    assert.equal(aiService.calls.length, 1);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aiService.calls.length, 1);
    assert.equal(
        upstream.sent.find((event) => event.item?.call_id === 'call-first')?.item?.output,
        'The first deep answer.'
    );

    twilioSocket.receive({ event: 'stop', streamSid: 'MZ123' });
    bridge.close();
});

test('deep-model usage is enforced against the same session token budget', async () => {
    const { bridge, upstream, twilioSocket, state } = createHarness({
        answer: 'This answer crosses the budget.',
        deepUsageTokens: 200,
        bridgeOptions: { maxTokens: 1000 }
    });
    completeSetup(upstream);
    upstream.receive({
        type: 'response.done',
        response: {
            status: 'completed',
            usage: { total_tokens: 900 },
            output: [{
                type: 'function_call',
                name: 'answer_complex_question',
                call_id: 'over-budget-call',
                arguments: JSON.stringify({ question: 'Use more tokens?' })
            }]
        }
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(state.totalTokens, 1100);
    assert.equal(bridge.activeSessionCount, 0);
    assert.equal(twilioSocket.readyState, 3);
    assert.equal(upstream.readyState, 3);
    bridge.close();
});

test('a stale deep result is cancelled before the newer caller turn is answered', async () => {
    let resolveAnswer;
    const answerPromise = new Promise((resolve) => {
        resolveAnswer = resolve;
    });
    const deferredAiService = {
        isConfigured: () => true,
        answerComplexVoice: () => answerPromise
    };
    const { bridge, upstream, twilioSocket } = createHarness({
        bridgeOptions: { aiService: deferredAiService }
    });
    completeSetup(upstream);
    upstream.receive({
        type: 'response.done',
        response: {
            status: 'completed',
            output: [{
                id: 'function-item-old',
                type: 'function_call',
                name: 'answer_complex_question',
                call_id: 'call-old',
                arguments: JSON.stringify({ question: 'The old question?' })
            }]
        }
    });

    upstream.receive({ type: 'input_audio_buffer.speech_started' });
    upstream.receive({ type: 'input_audio_buffer.speech_stopped' });
    resolveAnswer({ answer: 'This stale answer must not be spoken.', usageTokens: 12 });
    await new Promise((resolve) => setImmediate(resolve));

    const cancellationIndex = upstream.sent.findIndex((event) => event.item?.call_id === 'call-old');
    const enableIndex = upstream.sent.findIndex((event, index) => (
        index > cancellationIndex
        && event.type === 'session.update'
        && event.session?.audio?.input?.turn_detection?.create_response === true
    ));
    const responseIndex = upstream.sent.findIndex((event, index) => (
        index > enableIndex && event.type === 'response.create'
    ));
    assert.deepEqual(upstream.sent[cancellationIndex], {
        type: 'conversation.item.create',
        previous_item_id: 'function-item-old',
        item: {
            type: 'function_call_output',
            call_id: 'call-old',
            output: 'Cancelled because the caller started a newer question.'
        }
    });
    assert.ok(enableIndex > cancellationIndex);
    assert.ok(responseIndex > enableIndex);
    assert.equal(upstream.sent.some((event) => event.item?.output === 'This stale answer must not be spoken.'), false);

    twilioSocket.receive({ event: 'stop', streamSid: 'MZ123' });
    bridge.close();
});

test('audio validation rejects malformed or oversized payloads', () => {
    assert.equal(isValidBase64(Buffer.alloc(160).toString('base64')), true);
    assert.equal(isValidBase64('not base64!'), false);
    assert.equal(isValidBase64(Buffer.alloc(5000).toString('base64')), false);
});

test('valid JSON primitives do not crash either WebSocket event handler', () => {
    const first = createHarness();
    completeSetup(first.upstream);
    first.upstream.receive(null);
    assert.equal(first.bridge.activeSessionCount, 1);
    first.twilioSocket.receive(null);
    assert.equal(first.twilioSocket.readyState, 3);
    assert.equal(first.bridge.activeSessionCount, 0);
    first.bridge.close();
});

test('cancelled function calls never invoke the deep reasoning model', async () => {
    const { bridge, upstream, twilioSocket, aiService } = createHarness();
    completeSetup(upstream);
    upstream.receive({
        type: 'response.done',
        response: {
            status: 'cancelled',
            usage: { total_tokens: 5 },
            output: [{
                type: 'function_call',
                name: 'answer_complex_question',
                call_id: 'cancelled-call',
                arguments: '{"question":"unfinished"}'
            }]
        }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aiService.lastArgs, undefined);
    assert.equal(upstream.sent.some((event) => event.item?.call_id === 'cancelled-call'), false);
    twilioSocket.receive({ event: 'stop', streamSid: 'MZ123' });
    bridge.close();
});
