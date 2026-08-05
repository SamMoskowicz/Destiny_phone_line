const crypto = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');
const {
    addMemoryRules,
    buildMemoryContextMessage,
    buildMemoryTransparencyInstructions
} = require('./aiService');

const OPEN = WebSocket.OPEN;
const CONNECTING = WebSocket.CONNECTING;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

const BASE_INSTRUCTIONS = `You are ChatGPT, a highly capable general AI assistant speaking on a live
phone call. Respond naturally and start with the answer. For greetings, simple facts, and easy
questions, answer directly in one to three concise sentences. For a question that needs careful
multi-step reasoning, calculation, comparison, coding analysis, or important medical, legal, or
financial nuance, call answer_complex_question exactly once, then speak its result clearly. Do not
mention tools or internal reasoning. Do not claim to have live web access. Let the caller finish,
handle interruptions gracefully, and ask one short clarifying question only when it is necessary.
Always finish the current sentence before ending a response. If the answer must be shortened,
omit secondary details instead of stopping partway through a sentence.`;
const DEFAULT_INSTRUCTIONS = `${BASE_INSTRUCTIONS}
${buildMemoryTransparencyInstructions()}`;

const CONTINUATION_SUFFIX = `For this response only, continue the immediately preceding spoken answer exactly where it stopped
and do not call a tool. Do not restart, repeat, summarize, apologize, or mention an output limit.
First finish the interrupted sentence, then complete any essential remaining answer. End only after
a complete sentence.`;
const CONTINUATION_INSTRUCTIONS = `${DEFAULT_INSTRUCTIONS}
${CONTINUATION_SUFFIX}`;

const INITIAL_GREETING_PURPOSE = 'initial_greeting';
const INITIAL_GREETING_INSTRUCTIONS = `Say exactly this short, natural greeting: "Hi! You're
speaking with ChatGPT. What would you like to talk about?" Do not add anything else and do not call
a tool.`;

function asInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function realtimeReasoningEffort(value) {
    return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value) ? value : 'low';
}

function normalizeOpenAiRealtimeUrl(value) {
    try {
        const url = new URL(value || OPENAI_REALTIME_URL);
        if (url.protocol !== 'wss:'
            || url.hostname !== 'api.openai.com'
            || url.port
            || url.username
            || url.password
            || url.pathname !== '/v1/realtime'
            || url.search
            || url.hash) {
            return null;
        }
        return OPENAI_REALTIME_URL;
    } catch (error) {
        return null;
    }
}

function buildTurnDetection(vadMode, createResponse = true) {
    return vadMode === 'semantic_vad'
        ? {
            type: 'semantic_vad',
            eagerness: 'high',
            create_response: createResponse,
            interrupt_response: true
        }
        : {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 350,
            create_response: createResponse,
            interrupt_response: true,
            idle_timeout_ms: 15000
        };
}

function isValidBase64(value, maxDecodedBytes = 4096) {
    if (typeof value !== 'string' || !value || value.length > Math.ceil(maxDecodedBytes * 4 / 3) + 4) {
        return false;
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
        return false;
    }
    try {
        const decoded = Buffer.from(value, 'base64');
        if (!decoded.length || decoded.length > maxDecodedBytes) {
            return false;
        }
        return decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
    } catch (error) {
        return false;
    }
}

function responseContainsAudio(response) {
    const output = Array.isArray(response?.output) ? response.output : [];
    return output.some((item) => (
        item?.type === 'message'
        && (Array.isArray(item.content) ? item.content : [])
            .some((content) => ['audio', 'output_audio'].includes(content?.type))
    ));
}

function buildSessionUpdate({
    voice = 'marin',
    reasoningEffort = 'low',
    transcriptionModel = 'gpt-transcribe',
    instructions = DEFAULT_INSTRUCTIONS,
    enableDeepTool = true,
    vadMode = 'server_vad'
} = {}) {
    const session = {
        type: 'realtime',
        instructions,
        output_modalities: ['audio'],
        parallel_tool_calls: false,
        reasoning: { effort: realtimeReasoningEffort(reasoningEffort) },
        max_output_tokens: 'inf',
        audio: {
            input: {
                format: { type: 'audio/pcmu' },
                transcription: { model: transcriptionModel },
                turn_detection: buildTurnDetection(vadMode)
            },
            output: {
                format: { type: 'audio/pcmu' },
                voice,
                speed: 1.05
            }
        },
        truncation: {
            type: 'retention_ratio',
            retention_ratio: 0.8,
            token_limits: { post_instructions: 12000 }
        }
    };

    if (enableDeepTool) {
        session.tools = [{
            type: 'function',
            name: 'answer_complex_question',
            description: 'Use for difficult questions that need more careful reasoning than a quick spoken answer. Do not use for greetings or easy factual questions.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    question: {
                        type: 'string',
                        description: 'The caller\'s complete question, rewritten only enough to be understandable on its own.'
                    }
                },
                required: ['question']
            }
        }];
        session.tool_choice = 'auto';
    }

    return { type: 'session.update', session };
}

function sendJson(socket, value, maxBufferedBytes) {
    if (!socket || socket.readyState !== OPEN || socket.bufferedAmount > maxBufferedBytes) {
        return false;
    }
    socket.send(JSON.stringify(value));
    return true;
}

function closeSocket(socket, code = 1000, reason = 'session ended') {
    if (!socket || ![CONNECTING, OPEN].includes(socket.readyState)) {
        return;
    }
    try {
        socket.close(code, reason);
    } catch (error) {
        socket.terminate?.();
    }
}

function rejectUpgrade(socket, statusCode, statusText) {
    try {
        socket.write(
            `HTTP/1.1 ${statusCode} ${statusText}\r\n`
            + 'Connection: close\r\n'
            + 'Content-Type: text/plain\r\n'
            + 'Content-Length: 0\r\n\r\n'
        );
    } finally {
        socket.destroy();
    }
}

class RealtimeVoiceBridge {
    constructor({
        apiKey = process.env.OPENAI_API_KEY,
        aiService,
        tokenStore,
        twilioSecurity,
        model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
        voice = process.env.OPENAI_REALTIME_VOICE || 'marin',
        reasoningEffort = process.env.OPENAI_REALTIME_REASONING || 'low',
        transcriptionModel = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe',
        vadMode = process.env.OPENAI_REALTIME_VAD || 'server_vad',
        streamPath = '/voice/ai-stream',
        openAiUrl = OPENAI_REALTIME_URL,
        maxSessions = process.env.AI_VOICE_MAX_SESSIONS || 5,
        maxDurationMs = process.env.AI_VOICE_MAX_DURATION_MS || 10 * 60 * 1000,
        maxTurns = process.env.AI_VOICE_MAX_TURNS || 30,
        maxDeepToolCalls = process.env.AI_VOICE_MAX_DEEP_CALLS || 10,
        maxTokens = process.env.AI_VOICE_MAX_TOKENS || 50000,
        maxContinuations = process.env.AI_VOICE_MAX_CONTINUATIONS || 2,
        maxIdlePrompts = process.env.AI_VOICE_MAX_IDLE_PROMPTS || 2,
        maxBufferedBytes = process.env.AI_VOICE_MAX_BUFFERED_BYTES || 1024 * 1024,
        maxPendingAudioBytes = process.env.AI_VOICE_MAX_PENDING_AUDIO_BYTES || 32768,
        openAiSocketFactory = (url, options) => new WebSocket(url, options),
        logger = console,
        clock = () => Date.now()
    } = {}) {
        this.apiKey = apiKey || null;
        this.aiService = aiService;
        this.tokenStore = tokenStore;
        this.twilioSecurity = twilioSecurity;
        this.model = model;
        this.voice = voice;
        this.reasoningEffort = reasoningEffort;
        this.transcriptionModel = transcriptionModel;
        this.vadMode = vadMode;
        this.streamPath = streamPath;
        this.openAiUrl = normalizeOpenAiRealtimeUrl(openAiUrl);
        this.maxSessions = asInteger(maxSessions, 5, 1, 100);
        this.maxDurationMs = asInteger(maxDurationMs, 10 * 60 * 1000, 30 * 1000, 60 * 60 * 1000);
        this.maxTurns = asInteger(maxTurns, 30, 1, 1000);
        this.maxDeepToolCalls = asInteger(maxDeepToolCalls, 10, 1, 100);
        this.maxTokens = asInteger(maxTokens, 50000, 1000, 1000000);
        this.maxContinuations = asInteger(maxContinuations, 2, 0, 10);
        this.maxIdlePrompts = asInteger(maxIdlePrompts, 2, 0, 10);
        this.maxBufferedBytes = asInteger(maxBufferedBytes, 1024 * 1024, 65536, 16 * 1024 * 1024);
        this.maxPendingAudioBytes = asInteger(maxPendingAudioBytes, 32768, 4096, 1024 * 1024);
        this.openAiSocketFactory = openAiSocketFactory;
        this.logger = logger;
        this.clock = clock;
        this.sessions = new Map();
        this.activeByUser = new Map();
        this.pendingStates = new Set();
        this.server = null;
        this.upgradeHandler = null;
        this.wss = new WebSocketServer({
            noServer: true,
            maxPayload: 64 * 1024,
            perMessageDeflate: false
        });
    }

    get activeSessionCount() {
        return this.sessions.size;
    }

    buildInstructions() {
        const memoryStore = this.aiService?.memoryStore;
        return `${BASE_INSTRUCTIONS}\n${buildMemoryTransparencyInstructions({
            persistentMemory: Boolean(memoryStore?.isConfigured?.()),
            retentionDays: memoryStore?.retentionDays
        })}`;
    }

    isConfigured() {
        return Boolean(
            this.apiKey
            && this.openAiUrl
            && this.aiService?.isConfigured?.()
            && this.tokenStore
            && this.twilioSecurity?.isConfigured?.()
        );
    }

    attach(server) {
        if (this.server) {
            throw new Error('Realtime voice bridge is already attached');
        }
        this.server = server;
        this.upgradeHandler = (req, socket, head) => {
            let pathname;
            try {
                pathname = new URL(req.url, 'http://localhost').pathname;
            } catch (error) {
                rejectUpgrade(socket, 400, 'Bad Request');
                return;
            }
            if (pathname !== this.streamPath) {
                rejectUpgrade(socket, 404, 'Not Found');
                return;
            }
            if (!this.isConfigured()) {
                rejectUpgrade(socket, 503, 'Service Unavailable');
                return;
            }
            if (!this.twilioSecurity.validateWebSocketRequest(req)) {
                rejectUpgrade(socket, 403, 'Forbidden');
                return;
            }
            if (this.sessions.size + this.pendingStates.size >= this.maxSessions) {
                rejectUpgrade(socket, 503, 'Service Unavailable');
                return;
            }
            this.wss.handleUpgrade(req, socket, head, (twilioSocket) => {
                this.acceptTwilioSocket(twilioSocket, req);
            });
        };
        server.on('upgrade', this.upgradeHandler);
    }

    acceptTwilioSocket(twilioSocket, req = {}) {
        const state = {
            req,
            twilioSocket,
            openAiSocket: null,
            openAiReady: false,
            phase: 'awaiting_connected',
            callSid: null,
            streamSid: null,
            safetyIdentifier: null,
            memoryGeneration: 0,
            memoryContext: '',
            memoryContextAdded: false,
            memorySessionId: crypto.randomBytes(12).toString('hex'),
            discardMemory: false,
            pendingAudio: [],
            pendingAudioBytes: 0,
            transcripts: [],
            inputItemEpochs: new Map(),
            voiceTurns: new Map(),
            finalizedResponses: new Map(),
            handledCallIds: new Set(),
            interruptedItemIds: new Set(),
            playedAssistantItemIds: new Set(),
            responseStates: new Map(),
            initialGreetingRequested: false,
            currentItemId: null,
            audioStartedAt: null,
            latestMediaTimestamp: null,
            audioStartedStreamTimestamp: null,
            audioSentMs: 0,
            confirmedPlayedMs: 0,
            bytesSinceMark: 0,
            markSequence: 0,
            pendingMarks: new Map(),
            turnCount: 0,
            turnEpoch: 0,
            deepToolCalls: 0,
            deepToolInFlight: false,
            deepToolAbortController: null,
            pendingTurnDuringTool: false,
            totalTokens: 0,
            continuationCount: 0,
            idlePromptCount: 0,
            finished: false,
            startTimer: null,
            durationTimer: null,
            openAiTimer: null,
            sessionReadyTimer: null,
            heartbeatTimer: null,
            heartbeatAlive: true
        };
        this.pendingStates.add(state);

        if (typeof twilioSocket.ping === 'function') {
            twilioSocket.on('pong', () => {
                state.heartbeatAlive = true;
            });
            state.heartbeatTimer = setInterval(() => {
                if (state.finished || twilioSocket.readyState !== OPEN) {
                    return;
                }
                if (!state.heartbeatAlive) {
                    this.finish(state, { code: 1001, reason: 'connection timeout', closeTwilio: true, closeOpenAi: true });
                    return;
                }
                state.heartbeatAlive = false;
                twilioSocket.ping();
            }, 20000);
            state.heartbeatTimer.unref?.();
        }

        state.startTimer = setTimeout(() => this.finish(state, {
            code: 1008,
            reason: 'start timeout',
            closeTwilio: true,
            closeOpenAi: true
        }), 5000);
        state.startTimer.unref?.();

        twilioSocket.on('message', (data) => this.handleTwilioMessage(state, data));
        twilioSocket.on('close', () => this.finish(state, { closeOpenAi: true }));
        twilioSocket.on('error', () => this.finish(state, { closeOpenAi: true }));
        return state;
    }

    handleTwilioMessage(state, rawData) {
        if (state.finished) {
            return;
        }
        const raw = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        if (Buffer.byteLength(raw) > 64 * 1024) {
            this.finish(state, { code: 1009, reason: 'message too large', closeTwilio: true, closeOpenAi: true });
            return;
        }
        let event;
        try {
            event = JSON.parse(raw);
        } catch (error) {
            this.finish(state, { code: 1008, reason: 'invalid event', closeTwilio: true, closeOpenAi: true });
            return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
            this.finish(state, { code: 1008, reason: 'invalid event', closeTwilio: true, closeOpenAi: true });
            return;
        }

        if (event.event === 'connected') {
            if (state.phase === 'awaiting_connected') {
                state.phase = 'awaiting_start';
            }
            return;
        }
        if (event.event === 'start') {
            if (!['awaiting_connected', 'awaiting_start'].includes(state.phase)) {
                this.finish(state, { code: 1008, reason: 'invalid start', closeTwilio: true, closeOpenAi: true });
                return;
            }
            this.startSession(state, event);
            return;
        }
        if (state.phase !== 'active') {
            return;
        }
        if (event.streamSid && event.streamSid !== state.streamSid) {
            this.finish(state, { code: 1008, reason: 'stream mismatch', closeTwilio: true, closeOpenAi: true });
            return;
        }

        if (event.event === 'media') {
            this.forwardCallerAudio(state, event.media?.payload, event.media?.timestamp);
        } else if (event.event === 'mark') {
            this.acknowledgeMark(state, event.mark?.name);
        } else if (event.event === 'dtmf' && String(event.dtmf?.digit) === '8') {
            this.finish(state, { code: 1000, reason: 'return to menu', closeTwilio: true, closeOpenAi: true });
        } else if (event.event === 'stop') {
            this.finish(state, { code: 1000, reason: 'call stopped', closeTwilio: true, closeOpenAi: true });
        }
    }

    startSession(state, event) {
        const start = event.start || {};
        const callSid = start.callSid;
        const streamSid = start.streamSid || event.streamSid;
        const format = start.mediaFormat || {};
        const token = start.customParameters?.sessionToken || start.customParameters?.sessiontoken;
        const tokenEntry = this.tokenStore.consume(token, callSid);

        if (!callSid || !streamSid || !tokenEntry
            || format.encoding !== 'audio/x-mulaw'
            || Number(format.sampleRate) !== 8000
            || Number(format.channels) !== 1
            || this.sessions.has(callSid)
            || this.activeByUser.has(tokenEntry.safetyIdentifier)
            || this.sessions.size >= this.maxSessions) {
            this.finish(state, { code: 1008, reason: 'unauthorized stream', closeTwilio: true, closeOpenAi: true });
            return;
        }

        clearTimeout(state.startTimer);
        state.startTimer = null;
        state.phase = 'active';
        state.callSid = callSid;
        state.streamSid = streamSid;
        state.safetyIdentifier = tokenEntry.safetyIdentifier;
        const memorySnapshot = this.aiService?.getMemorySnapshot?.(state.safetyIdentifier);
        if (memorySnapshot && typeof memorySnapshot === 'object') {
            state.memoryGeneration = Number(memorySnapshot.generation) || 0;
            state.memoryContext = String(memorySnapshot.context || '');
        }
        this.pendingStates.delete(state);
        this.sessions.set(callSid, state);
        this.activeByUser.set(state.safetyIdentifier, callSid);
        state.durationTimer = setTimeout(() => this.finish(state, {
            code: 1000,
            reason: 'session limit',
            closeTwilio: true,
            closeOpenAi: true
        }), this.maxDurationMs);
        state.durationTimer.unref?.();
        this.openOpenAiSocket(state);
    }

    openOpenAiSocket(state) {
        const separator = this.openAiUrl.includes('?') ? '&' : '?';
        const url = `${this.openAiUrl}${separator}model=${encodeURIComponent(this.model)}`;
        let socket;
        try {
            socket = this.openAiSocketFactory(url, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'OpenAI-Safety-Identifier': state.safetyIdentifier
                },
                perMessageDeflate: false,
                maxPayload: 2 * 1024 * 1024
            });
        } catch (error) {
            this.logWarning('openai_socket_create_failed', error?.code);
            this.finish(state, { code: 1011, reason: 'AI unavailable', closeTwilio: true, closeOpenAi: true });
            return;
        }
        state.openAiSocket = socket;
        state.openAiTimer = setTimeout(() => this.finish(state, {
            code: 1011,
            reason: 'AI connection timeout',
            closeTwilio: true,
            closeOpenAi: true
        }), 5000);
        state.openAiTimer.unref?.();
        socket.on('open', () => {
            clearTimeout(state.openAiTimer);
            state.openAiTimer = null;
            if (state.finished) {
                closeSocket(socket);
                return;
            }
            const update = buildSessionUpdate({
                voice: this.voice,
                reasoningEffort: this.reasoningEffort,
                transcriptionModel: this.transcriptionModel,
                vadMode: this.vadMode,
                instructions: addMemoryRules(this.buildInstructions(), state.memoryContext),
                enableDeepTool: Boolean(this.aiService?.isConfigured?.())
            });
            if (!sendJson(socket, update, this.maxBufferedBytes)) {
                this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
                return;
            }
            // Audio remains queued until session.updated confirms PCMU was accepted.
            state.sessionReadyTimer = setTimeout(() => this.finish(state, {
                code: 1011,
                reason: 'AI setup timeout',
                closeTwilio: true,
                closeOpenAi: true
            }), 3000);
            state.sessionReadyTimer.unref?.();
        });
        socket.on('message', (data) => this.handleOpenAiMessage(state, data));
        socket.on('close', () => this.finish(state, {
            code: 1011,
            reason: 'AI disconnected',
            closeTwilio: true
        }));
        socket.on('error', (error) => {
            this.logWarning('openai_socket_error', error?.code);
            this.finish(state, { code: 1011, reason: 'AI unavailable', closeTwilio: true, closeOpenAi: true });
        });
    }

    forwardCallerAudio(state, payload, timestamp = undefined) {
        if (!isValidBase64(payload)) {
            this.finish(state, { code: 1008, reason: 'invalid audio', closeTwilio: true, closeOpenAi: true });
            return;
        }
        const bytes = Buffer.from(payload, 'base64').length;
        const parsedTimestamp = Number(timestamp);
        if (Number.isFinite(parsedTimestamp) && parsedTimestamp >= 0) {
            state.latestMediaTimestamp = parsedTimestamp;
        }
        const socket = state.openAiSocket;
        if (socket?.readyState === OPEN && state.openAiReady) {
            if (!sendJson(socket, { type: 'input_audio_buffer.append', audio: payload }, this.maxBufferedBytes)) {
                this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
            }
            return;
        }
        state.pendingAudio.push(payload);
        state.pendingAudioBytes += bytes;
        while (state.pendingAudioBytes > this.maxPendingAudioBytes && state.pendingAudio.length > 1) {
            const removed = state.pendingAudio.shift();
            state.pendingAudioBytes -= Buffer.from(removed, 'base64').length;
        }
    }

    handleOpenAiMessage(state, rawData) {
        if (state.finished) {
            return;
        }
        let event;
        try {
            event = JSON.parse(Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData));
        } catch (error) {
            this.logWarning('openai_invalid_event');
            return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
            this.logWarning('openai_invalid_event');
            return;
        }

        if (event.type === 'session.updated') {
            this.finishOpenAiSetup(state, event);
        } else if (event.type === 'response.created') {
            this.trackResponseCreated(state, event.response);
        } else if (event.type === 'response.output_item.added' && event.item?.type === 'message') {
            if (this.isStaleResponse(state, event.response_id)) {
                return;
            }
            this.beginAssistantItem(state, event.item.id);
        } else if (event.type === 'response.output_audio.delta') {
            this.forwardAssistantAudio(state, event);
        } else if (event.type === 'response.output_audio_transcript.done'
            || event.type === 'response.audio_transcript.done') {
            this.captureAssistantTranscript(state, {
                responseId: event.response_id,
                itemId: event.item_id,
                contentIndex: event.content_index,
                text: event.transcript
            });
        } else if (event.type === 'response.output_text.done') {
            this.captureAssistantTranscript(state, {
                responseId: event.response_id,
                itemId: event.item_id,
                contentIndex: event.content_index,
                text: event.text
            });
        } else if (event.type === 'input_audio_buffer.committed') {
            const itemId = String(event.item_id || '').trim();
            if (itemId) {
                state.inputItemEpochs.set(itemId, state.turnEpoch);
                while (state.inputItemEpochs.size > 50) {
                    state.inputItemEpochs.delete(state.inputItemEpochs.keys().next().value);
                }
            }
        } else if (event.type === 'input_audio_buffer.speech_started') {
            state.turnEpoch += 1;
            state.continuationCount = 0;
            state.idlePromptCount = 0;
            state.deepToolAbortController?.abort('caller started a newer turn');
            this.handleBargeIn(state);
        } else if (event.type === 'input_audio_buffer.speech_stopped') {
            state.turnCount += 1;
            if (state.deepToolInFlight) {
                state.pendingTurnDuringTool = true;
            }
            if (state.turnCount > this.maxTurns) {
                this.finish(state, { code: 1000, reason: 'turn limit', closeTwilio: true, closeOpenAi: true });
            }
        } else if (event.type === 'input_audio_buffer.timeout_triggered') {
            state.idlePromptCount += 1;
            if (state.idlePromptCount > this.maxIdlePrompts) {
                this.finish(state, { code: 1000, reason: 'idle limit', closeTwilio: true, closeOpenAi: true });
            }
        } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
            const transcript = String(event.transcript || '').trim();
            if (transcript) {
                state.transcripts.push(transcript.slice(0, 1200));
                state.transcripts = state.transcripts.slice(-6);
                this.captureCallerTranscript(state, event, transcript);
            }
        } else if (event.type === 'conversation.item.truncated') {
            this.removeInterruptedAssistantTranscript(state, event.item_id);
        } else if (event.type === 'response.done') {
            this.handleResponseDone(state, event);
        } else if (event.type === 'error') {
            this.logWarning('openai_realtime_error', event.error?.code || event.error?.type);
            this.finish(state, { code: 1011, reason: 'AI unavailable', closeTwilio: true, closeOpenAi: true });
        }
    }

    finishOpenAiSetup(state, event) {
        const inputFormat = event.session?.audio?.input?.format?.type;
        const outputFormat = event.session?.audio?.output?.format?.type;
        if (inputFormat !== 'audio/pcmu' || outputFormat !== 'audio/pcmu') {
            this.logWarning('openai_audio_format_rejected');
            this.finish(state, { code: 1011, reason: 'AI setup failed', closeTwilio: true, closeOpenAi: true });
            return;
        }
        clearTimeout(state.sessionReadyTimer);
        state.sessionReadyTimer = null;
        state.openAiReady = true;
        const memoryMessage = buildMemoryContextMessage(state.memoryContext);
        if (memoryMessage && !state.memoryContextAdded) {
            if (!sendJson(state.openAiSocket, {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: memoryMessage }]
                }
            }, this.maxBufferedBytes)) {
                this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
                return;
            }
            state.memoryContextAdded = true;
        }
        for (const audio of state.pendingAudio) {
            if (!sendJson(state.openAiSocket, { type: 'input_audio_buffer.append', audio }, this.maxBufferedBytes)) {
                this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
                return;
            }
        }
        state.pendingAudio = [];
        state.pendingAudioBytes = 0;
        if (!state.initialGreetingRequested) {
            const greetingEpoch = state.turnEpoch;
            if (!sendJson(state.openAiSocket, {
                type: 'response.create',
                response: {
                    conversation: 'auto',
                    output_modalities: ['audio'],
                    instructions: INITIAL_GREETING_INSTRUCTIONS,
                    max_output_tokens: 80,
                    tools: [],
                    tool_choice: 'none',
                    metadata: {
                        response_purpose: INITIAL_GREETING_PURPOSE,
                        turn_epoch: String(greetingEpoch)
                    }
                }
            }, this.maxBufferedBytes)) {
                this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
                return;
            }
            state.initialGreetingRequested = true;
        }
    }

    getVoiceTurn(state, turnEpoch) {
        const epoch = Number.isSafeInteger(Number(turnEpoch)) && Number(turnEpoch) >= 0
            ? Number(turnEpoch)
            : state.turnEpoch;
        if (!state.voiceTurns.has(epoch)) {
            state.voiceTurns.set(epoch, {
                userParts: new Map(),
                assistantParts: new Map()
            });
        }
        return { epoch, turn: state.voiceTurns.get(epoch) };
    }

    captureCallerTranscript(state, event, transcript) {
        const itemId = String(event.item_id || '').trim();
        const mappedEpoch = itemId ? state.inputItemEpochs.get(itemId) : undefined;
        const { turn } = this.getVoiceTurn(state, mappedEpoch ?? state.turnEpoch);
        const key = `${itemId || 'unknown'}:${Number(event.content_index) || 0}`;
        turn.userParts.set(key, String(transcript).slice(0, 16000));
    }

    captureAssistantTranscript(state, {
        responseId,
        itemId,
        contentIndex = 0,
        text
    } = {}) {
        const transcript = String(text || '').trim().slice(0, 16000);
        const normalizedResponseId = String(responseId || '').trim();
        const normalizedItemId = String(itemId || '').trim();
        if (!transcript || (normalizedItemId && state.interruptedItemIds.has(normalizedItemId))) {
            return;
        }
        const responseState = normalizedResponseId ? state.responseStates.get(normalizedResponseId) : null;
        const finalized = normalizedResponseId ? state.finalizedResponses.get(normalizedResponseId) : null;
        if (responseState?.purpose === INITIAL_GREETING_PURPOSE) {
            return;
        }
        if (finalized && !finalized.keep) {
            return;
        }
        if (responseState && responseState.turnEpoch !== state.turnEpoch) {
            return;
        }
        const turnEpoch = responseState?.turnEpoch ?? finalized?.turnEpoch ?? state.turnEpoch;
        const { turn } = this.getVoiceTurn(state, turnEpoch);
        const key = `${normalizedResponseId || 'unknown'}:${normalizedItemId || 'unknown'}:${Number(contentIndex) || 0}`;
        turn.assistantParts.set(key, {
            responseId: normalizedResponseId,
            itemId: normalizedItemId,
            text: transcript,
            status: finalized?.status || 'pending'
        });
    }

    removeInterruptedAssistantTranscript(state, itemId) {
        const normalizedItemId = String(itemId || '').trim();
        if (!normalizedItemId) {
            return;
        }
        for (const turn of state.voiceTurns.values()) {
            for (const [key, part] of turn.assistantParts) {
                if (part.itemId === normalizedItemId) {
                    turn.assistantParts.delete(key);
                }
            }
        }
    }

    finalizeResponseMemory(state, response) {
        const responseId = String(response?.id || '').trim();
        const responseState = responseId ? state.responseStates.get(responseId) : null;
        const turnEpoch = responseState?.turnEpoch ?? state.turnEpoch;
        const isCurrentResponse = !responseState || responseState.turnEpoch === state.turnEpoch;
        const responsePurpose = responseState?.purpose || String(response?.metadata?.response_purpose || '');
        const incompleteReason = response?.status_details?.reason || response?.incomplete_details?.reason;
        const keep = responsePurpose !== INITIAL_GREETING_PURPOSE && isCurrentResponse && (
            response?.status === 'completed'
            || (response?.status === 'incomplete' && incompleteReason === 'max_output_tokens')
        );

        if (keep) {
            for (const item of Array.isArray(response?.output) ? response.output : []) {
                if (item?.type !== 'message') {
                    continue;
                }
                for (let index = 0; index < (Array.isArray(item.content) ? item.content.length : 0); index += 1) {
                    const content = item.content[index];
                    const transcript = ['audio', 'output_audio'].includes(content?.type)
                        ? content.transcript
                        : content?.type === 'output_text'
                            ? content.text
                            : '';
                    this.captureAssistantTranscript(state, {
                        responseId,
                        itemId: item.id,
                        contentIndex: index,
                        text: transcript
                    });
                }
            }
        }

        for (const turn of state.voiceTurns.values()) {
            for (const [key, part] of turn.assistantParts) {
                if (part.responseId !== responseId) {
                    continue;
                }
                if (keep) {
                    part.status = response.status;
                } else {
                    turn.assistantParts.delete(key);
                }
            }
        }
        if (responseId) {
            state.finalizedResponses.set(responseId, {
                turnEpoch,
                status: String(response.status || 'unknown'),
                keep
            });
            while (state.finalizedResponses.size > 30) {
                state.finalizedResponses.delete(state.finalizedResponses.keys().next().value);
            }
        }
    }

    persistVoiceMemory(state) {
        if (state.discardMemory || !state.safetyIdentifier || !this.aiService?.recordConversationExchange) {
            return;
        }
        for (const [turnEpoch, turn] of Array.from(state.voiceTurns.entries()).sort((a, b) => a[0] - b[0])) {
            const userText = Array.from(turn.userParts.values()).join('\n').trim();
            if (!userText) {
                continue;
            }
            const assistantText = Array.from(turn.assistantParts.values())
                .filter((part) => (
                    ['completed', 'incomplete'].includes(part.status)
                    && part.itemId
                    && state.playedAssistantItemIds.has(part.itemId)
                ))
                .map((part) => part.text)
                .join(' ')
                .trim();
            const saved = this.aiService.recordConversationExchange({
                safetyIdentifier: state.safetyIdentifier,
                exchangeId: `voice-${state.memorySessionId}-${turnEpoch}`,
                channel: 'voice',
                userText,
                assistantText,
                expectedGeneration: state.memoryGeneration
            });
            if (saved === false) {
                this.logWarning('memory_write_failed');
            }
        }
    }

    beginAssistantItem(state, itemId) {
        state.currentItemId = itemId || null;
        state.audioStartedAt = null;
        state.audioStartedStreamTimestamp = null;
        state.audioSentMs = 0;
        state.confirmedPlayedMs = 0;
        state.bytesSinceMark = 0;
    }

    trackResponseCreated(state, response) {
        if (!response?.id) {
            return;
        }
        const metadataEpoch = Number(response.metadata?.turn_epoch);
        state.responseStates.set(response.id, {
            turnEpoch: Number.isSafeInteger(metadataEpoch) && metadataEpoch >= 0
                ? metadataEpoch
                : state.turnEpoch,
            purpose: String(response.metadata?.response_purpose || ''),
            hasAudio: false
        });
        while (state.responseStates.size > 30) {
            state.responseStates.delete(state.responseStates.keys().next().value);
        }
    }

    isStaleResponse(state, responseId) {
        const responseState = responseId ? state.responseStates.get(responseId) : null;
        return Boolean(responseState && responseState.turnEpoch !== state.turnEpoch);
    }

    forwardAssistantAudio(state, event) {
        if (this.isStaleResponse(state, event.response_id)) {
            return;
        }
        const responseState = event.response_id
            ? state.responseStates.get(event.response_id)
            : null;
        if (responseState) {
            responseState.hasAudio = true;
        }
        if (event.item_id && state.interruptedItemIds.has(event.item_id)) {
            return;
        }
        if (!isValidBase64(event.delta, 64 * 1024)) {
            this.logWarning('openai_invalid_audio');
            return;
        }
        if (event.item_id && event.item_id !== state.currentItemId) {
            this.beginAssistantItem(state, event.item_id);
        }
        const bytes = Buffer.from(event.delta, 'base64').length;
        if (state.audioStartedAt === null) {
            state.audioStartedAt = this.clock();
            state.audioStartedStreamTimestamp = state.latestMediaTimestamp;
        }
        state.audioSentMs += bytes / 8;
        state.bytesSinceMark += bytes;

        if (!sendJson(state.twilioSocket, {
            event: 'media',
            streamSid: state.streamSid,
            media: { payload: event.delta }
        }, this.maxBufferedBytes)) {
            this.finish(state, { code: 1011, reason: 'call backpressure', closeTwilio: true, closeOpenAi: true });
            return;
        }

        if (state.bytesSinceMark >= 6400) {
            this.sendPlaybackMark(state);
        }
    }

    sendPlaybackMark(state, final = false) {
        state.markSequence += 1;
        const name = `ai-${state.markSequence}`;
        if (!sendJson(state.twilioSocket, {
            event: 'mark',
            streamSid: state.streamSid,
            mark: { name }
        }, this.maxBufferedBytes)) {
            return false;
        }
        state.pendingMarks.set(name, {
            playedMs: state.audioSentMs,
            itemId: state.currentItemId,
            final
        });
        state.bytesSinceMark = 0;
        return true;
    }

    acknowledgeMark(state, name) {
        const normalizedName = String(name || '');
        const mark = state.pendingMarks.get(normalizedName);
        if (!mark) {
            return;
        }

        let clearCurrentItem = false;
        for (const [markName, pendingMark] of state.pendingMarks) {
            state.pendingMarks.delete(markName);
            if (pendingMark.itemId === state.currentItemId) {
                state.confirmedPlayedMs = Math.max(state.confirmedPlayedMs, pendingMark.playedMs);
            }
            if (pendingMark.final && pendingMark.itemId) {
                state.playedAssistantItemIds.add(pendingMark.itemId);
                if (pendingMark.itemId === state.currentItemId
                    && pendingMark.playedMs >= state.audioSentMs) {
                    clearCurrentItem = true;
                }
            }
            if (markName === normalizedName) {
                break;
            }
        }
        if (clearCurrentItem) {
            this.beginAssistantItem(state, null);
        }
    }

    handleBargeIn(state) {
        if (!state.currentItemId || state.audioStartedAt === null) {
            return;
        }
        if (!sendJson(state.twilioSocket, {
            event: 'clear',
            streamSid: state.streamSid
        }, this.maxBufferedBytes)) {
            this.finish(state, { code: 1011, reason: 'call backpressure', closeTwilio: true, closeOpenAi: true });
            return;
        }

        const streamElapsedMs = Number.isFinite(state.latestMediaTimestamp)
            && Number.isFinite(state.audioStartedStreamTimestamp)
            ? state.latestMediaTimestamp - state.audioStartedStreamTimestamp
            : null;
        const elapsedMs = Math.max(0, streamElapsedMs === null
            ? this.clock() - state.audioStartedAt
            : streamElapsedMs);
        const playedMs = Math.floor(Math.min(
            state.audioSentMs,
            Math.max(state.confirmedPlayedMs, elapsedMs)
        ));
        if (!sendJson(state.openAiSocket, {
            type: 'conversation.item.truncate',
            item_id: state.currentItemId,
            content_index: 0,
            audio_end_ms: playedMs
        }, this.maxBufferedBytes)) {
            this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
            return;
        }
        state.interruptedItemIds.add(state.currentItemId);
        this.removeInterruptedAssistantTranscript(state, state.currentItemId);
        while (state.interruptedItemIds.size > 20) {
            state.interruptedItemIds.delete(state.interruptedItemIds.values().next().value);
        }
        // Twilio returns queued marks after a clear. Forget them first so those
        // acknowledgements cannot make interrupted audio eligible for memory.
        state.pendingMarks.clear();
        this.beginAssistantItem(state, null);
    }

    handleResponseDone(state, event) {
        const response = event.response || {};
        this.finalizeResponseMemory(state, response);
        const responseState = response.id ? state.responseStates.get(response.id) : null;
        const isCurrentResponse = !responseState || responseState.turnEpoch === state.turnEpoch;
        const hasAudio = Boolean(responseState?.hasAudio || responseContainsAudio(response));
        if (response.id) {
            state.responseStates.delete(response.id);
        }
        const usage = response.usage;
        state.totalTokens += Number(usage?.total_tokens || 0);
        if (state.totalTokens > this.maxTokens) {
            this.finish(state, { code: 1000, reason: 'usage limit', closeTwilio: true, closeOpenAi: true });
            return;
        }
        if (response.status === 'failed') {
            this.logWarning(
                'openai_response_failed',
                response.status_details?.error?.code || response.status_details?.reason
            );
            this.finish(state, { code: 1011, reason: 'AI response failed', closeTwilio: true, closeOpenAi: true });
            return;
        }
        if (response.status === 'incomplete') {
            const reason = response.status_details?.reason || 'unknown';
            this.logWarning('openai_response_incomplete', reason);
            let requestedContinuation = false;
            if (reason === 'max_output_tokens'
                && isCurrentResponse
                && hasAudio
                && responseState?.purpose !== INITIAL_GREETING_PURPOSE
                && state.continuationCount < this.maxContinuations) {
                state.continuationCount += 1;
                requestedContinuation = sendJson(state.openAiSocket, {
                    type: 'response.create',
                    response: {
                        conversation: 'auto',
                        output_modalities: ['audio'],
                        instructions: `${this.buildInstructions()}\n${CONTINUATION_SUFFIX}`,
                        max_output_tokens: 'inf',
                        tools: [],
                        tool_choice: 'none',
                        metadata: {
                            response_purpose: 'max_token_continuation',
                            source_response_id: String(response.id || 'unknown').slice(0, 512),
                            turn_epoch: String(state.turnEpoch),
                            continuation_depth: String(state.continuationCount)
                        }
                    }
                }, this.maxBufferedBytes);
                if (!requestedContinuation) {
                    this.finish(state, {
                        code: 1011,
                        reason: 'AI backpressure',
                        closeTwilio: true,
                        closeOpenAi: true
                    });
                }
            }
            if (isCurrentResponse && hasAudio && !this.sendPlaybackMark(state, true)) {
                this.finish(state, { code: 1011, reason: 'call backpressure', closeTwilio: true, closeOpenAi: true });
            }
            return;
        }
        if (response.status !== 'completed') {
            this.logWarning('openai_response_cancelled', response.status_details?.reason || response.status);
            return;
        }
        if (isCurrentResponse && hasAudio && !this.sendPlaybackMark(state, true)) {
            this.finish(state, { code: 1011, reason: 'call backpressure', closeTwilio: true, closeOpenAi: true });
            return;
        }
        if (isCurrentResponse) {
            state.continuationCount = 0;
        }
        const calls = (Array.isArray(response.output) ? response.output : []).filter((item) => (
            item?.type === 'function_call'
            && item.name === 'answer_complex_question'
            && item.call_id
        ));
        for (const call of calls) {
            if (state.handledCallIds.has(call.call_id)) {
                continue;
            }
            state.handledCallIds.add(call.call_id);
            if (state.handledCallIds.size > 50) {
                state.handledCallIds.delete(state.handledCallIds.values().next().value);
            }
            if (state.deepToolInFlight) {
                if (!this.sendDeepToolOutput(
                    state,
                    call,
                    'Skipped because another deeper analysis is already in progress.'
                )) {
                    this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
                }
                continue;
            }
            void this.executeDeepTool(state, call);
        }
    }

    sendDeepToolOutput(state, call, output) {
        const outputEvent = {
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: call.call_id,
                output: String(output || '')
            }
        };
        if (call.id) {
            outputEvent.previous_item_id = call.id;
        }
        return sendJson(state.openAiSocket, outputEvent, this.maxBufferedBytes);
    }

    async executeDeepTool(state, call) {
        const turnEpoch = state.turnEpoch;
        state.deepToolInFlight = true;
        state.pendingTurnDuringTool = false;
        if (!this.setAutomaticResponses(state, false)) {
            this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
            return;
        }
        let question = '';
        try {
            if (String(call.arguments || '').length > 8000) {
                throw new Error('Arguments too large');
            }
            question = String(JSON.parse(call.arguments || '{}').question || '').trim();
        } catch (error) {
            question = '';
        }

        state.deepToolCalls += 1;
        let answer;
        if (state.deepToolCalls > this.maxDeepToolCalls) {
            answer = 'The deeper-analysis limit for this call has been reached. I can still answer a simpler question directly.';
        } else {
            const controller = new AbortController();
            state.deepToolAbortController = controller;
            try {
                const result = await this.aiService.answerComplexVoice({
                    safetyIdentifier: state.safetyIdentifier,
                    question,
                    recentTranscript: state.transcripts.join('\n'),
                    signal: controller.signal
                });
                if (result && typeof result === 'object') {
                    answer = String(result.answer || '');
                    state.totalTokens += Math.max(0, Number(result.usageTokens || 0));
                } else {
                    answer = String(result || '');
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    this.logWarning('deep_voice_answer_failed', error?.code || error?.status);
                }
                answer = error?.code === 'AI_TIMEOUT'
                    ? 'I could not finish the deeper analysis within a few seconds. Try asking for a shorter answer or split the question into parts.'
                    : 'I could not complete the deeper analysis just now. Please try that question again.';
            } finally {
                if (state.deepToolAbortController === controller) {
                    state.deepToolAbortController = null;
                }
            }
        }
        if (state.totalTokens > this.maxTokens) {
            this.finish(state, { code: 1000, reason: 'usage limit', closeTwilio: true, closeOpenAi: true });
            return;
        }
        if (state.finished || state.openAiSocket?.readyState !== OPEN) {
            state.deepToolInFlight = false;
            return;
        }
        const stale = state.turnEpoch !== turnEpoch;
        if (!this.sendDeepToolOutput(
            state,
            call,
            stale ? 'Cancelled because the caller started a newer question.' : answer
        )) {
            this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
            return;
        }
        state.deepToolInFlight = false;
        const shouldAnswerNewTurn = stale && state.pendingTurnDuringTool;
        state.pendingTurnDuringTool = false;
        if (!this.setAutomaticResponses(state, true)) {
            this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
            return;
        }
        if (stale && !shouldAnswerNewTurn) {
            return;
        }
        if (!sendJson(state.openAiSocket, { type: 'response.create' }, this.maxBufferedBytes)) {
            this.finish(state, { code: 1011, reason: 'AI backpressure', closeTwilio: true, closeOpenAi: true });
        }
    }

    setAutomaticResponses(state, enabled) {
        return sendJson(state.openAiSocket, {
            type: 'session.update',
            session: {
                type: 'realtime',
                audio: {
                    input: {
                        turn_detection: buildTurnDetection(this.vadMode, enabled)
                    }
                }
            }
        }, this.maxBufferedBytes);
    }

    finish(state, {
        code = 1000,
        reason = 'session ended',
        closeTwilio = false,
        closeOpenAi = false
    } = {}) {
        if (state.finished) {
            return;
        }
        state.finished = true;
        state.phase = 'finished';
        this.persistVoiceMemory(state);
        this.pendingStates.delete(state);
        clearTimeout(state.startTimer);
        clearTimeout(state.durationTimer);
        clearTimeout(state.openAiTimer);
        clearTimeout(state.sessionReadyTimer);
        clearInterval(state.heartbeatTimer);
        if (state.callSid) {
            this.sessions.delete(state.callSid);
        }
        if (state.safetyIdentifier && this.activeByUser.get(state.safetyIdentifier) === state.callSid) {
            this.activeByUser.delete(state.safetyIdentifier);
        }
        state.deepToolAbortController?.abort('session ended');
        state.deepToolAbortController = null;
        state.deepToolInFlight = false;
        state.pendingTurnDuringTool = false;
        state.pendingAudio = [];
        state.transcripts = [];
        state.inputItemEpochs.clear();
        state.voiceTurns.clear();
        state.finalizedResponses.clear();
        state.handledCallIds.clear();
        state.interruptedItemIds.clear();
        state.playedAssistantItemIds.clear();
        state.responseStates.clear();
        state.pendingMarks.clear();
        state.currentItemId = null;
        if (closeOpenAi) {
            closeSocket(state.openAiSocket, code, reason);
        }
        if (closeTwilio) {
            closeSocket(state.twilioSocket, code, reason);
        }
    }

    forgetUser(safetyIdentifier) {
        const callSid = this.activeByUser.get(String(safetyIdentifier || ''));
        const state = callSid ? this.sessions.get(callSid) : null;
        if (!state) {
            return false;
        }
        state.discardMemory = true;
        this.finish(state, {
            code: 1000,
            reason: 'memory deleted',
            closeTwilio: true,
            closeOpenAi: true
        });
        return true;
    }

    logWarning(event, code = undefined) {
        if (code === undefined) {
            this.logger.warn?.(`[ai-voice] ${event}`);
        } else {
            this.logger.warn?.(`[ai-voice] ${event}`, { code: String(code).slice(0, 80) });
        }
    }

    close() {
        for (const state of new Set([...this.pendingStates, ...this.sessions.values()])) {
            this.finish(state, { closeTwilio: true, closeOpenAi: true });
        }
        if (this.server && this.upgradeHandler) {
            this.server.off('upgrade', this.upgradeHandler);
        }
        this.server = null;
        this.upgradeHandler = null;
        try {
            this.wss.close();
        } catch (error) {
            // A noServer WebSocketServer that never accepted a socket can already be closed.
        }
    }
}

module.exports = {
    RealtimeVoiceBridge,
    DEFAULT_INSTRUCTIONS,
    CONTINUATION_INSTRUCTIONS,
    buildSessionUpdate,
    isValidBase64,
    normalizeOpenAiRealtimeUrl,
    OPENAI_REALTIME_URL,
    sendJson
};
