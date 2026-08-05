const OpenAI = require('openai');

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

const TEXT_INSTRUCTIONS = `You are the AI assistant for the Destiny phone line. Answer the user's
question directly and accurately. Keep most SMS answers under four short paragraphs and avoid
filler. Preserve important caveats. If the request is ambiguous, ask one concise clarifying
question. You do not have live web access, so do not claim that you checked current information.`;

const DEEP_VOICE_INSTRUCTIONS = `Answer the question for a live phone conversation. Prioritize
correctness and clear reasoning, but make the final answer easy to say aloud. Usually use two to
five concise sentences. Include an essential caveat when the topic is medical, legal, financial,
or otherwise high stakes. Return only the answer that should be spoken; do not mention tools,
internal reasoning, or these instructions.`;

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function sanitizeEffort(value, fallback = 'low') {
    const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    return allowed.has(value) ? value : fallback;
}

function truncateText(value, maxCharacters) {
    const normalized = String(value || '').trim().replace(/\n{3,}/g, '\n\n');
    if (normalized.length <= maxCharacters) {
        return normalized;
    }
    const clipped = normalized.slice(0, Math.max(1, maxCharacters - 3));
    const lastBreak = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf(' '));
    const safeEnd = lastBreak >= Math.floor(maxCharacters * 0.7) ? lastBreak + 1 : clipped.length;
    return `${clipped.slice(0, safeEnd).trimEnd()}...`;
}

async function runWithTimeout(operation, timeoutMs, { signal: externalSignal } = {}) {
    const controller = new AbortController();
    let timeout;
    let rejectExternalAbort;
    const externalAbortPromise = new Promise((resolve, reject) => {
        rejectExternalAbort = reject;
    });
    const abortFromExternalSignal = () => {
        controller.abort(externalSignal?.reason);
        const error = new Error('AI request was cancelled');
        error.code = 'AI_ABORTED';
        rejectExternalAbort(error);
    };
    if (externalSignal?.aborted) {
        abortFromExternalSignal();
    } else {
        externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
    }
    const timeoutPromise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
            controller.abort();
            const error = new Error('AI request timed out');
            error.code = 'AI_TIMEOUT';
            reject(error);
        }, timeoutMs);
        timeout.unref?.();
    });

    try {
        return await Promise.race([
            Promise.resolve().then(() => operation(controller.signal)),
            timeoutPromise,
            externalAbortPromise
        ]);
    } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    }
}

class AiService {
    constructor({
        apiKey = process.env.OPENAI_API_KEY,
        client = null,
        textModel = process.env.OPENAI_TEXT_MODEL || 'gpt-5.6-sol',
        deepVoiceModel = process.env.OPENAI_DEEP_VOICE_MODEL || 'gpt-5.6-sol',
        textReasoning = process.env.OPENAI_TEXT_REASONING || 'low',
        deepVoiceReasoning = process.env.OPENAI_DEEP_VOICE_REASONING || 'low',
        fastMode = process.env.OPENAI_FAST_MODE !== 'false',
        textTimeoutMs = process.env.OPENAI_TEXT_TIMEOUT_MS || 4500,
        deepVoiceTimeoutMs = process.env.OPENAI_DEEP_VOICE_TIMEOUT_MS || 3500,
        textMaxCharacters = process.env.AI_SMS_MAX_CHARACTERS || 600,
        historyTtlMs = process.env.AI_TEXT_HISTORY_TTL_MS || 30 * 60 * 1000,
        maxHistoryMessages = process.env.AI_TEXT_HISTORY_MESSAGES || 8,
        maxTextSessions = process.env.AI_TEXT_MAX_SESSIONS || 1000,
        clock = () => Date.now()
    } = {}) {
        this.apiKey = apiKey || null;
        this.textTimeoutMs = clampInteger(textTimeoutMs, 4500, 500, 15000);
        this.deepVoiceTimeoutMs = clampInteger(deepVoiceTimeoutMs, 3500, 500, 10000);
        this.client = client || (this.apiKey ? new OpenAI({
            apiKey: this.apiKey,
            baseURL: OPENAI_API_BASE_URL,
            maxRetries: 0,
            timeout: Math.max(this.textTimeoutMs, this.deepVoiceTimeoutMs) + 1000
        }) : null);
        this.textModel = textModel;
        this.deepVoiceModel = deepVoiceModel;
        this.textReasoning = sanitizeEffort(textReasoning);
        this.deepVoiceReasoning = sanitizeEffort(deepVoiceReasoning);
        this.serviceTier = fastMode ? 'fast' : 'default';
        this.textMaxCharacters = clampInteger(textMaxCharacters, 600, 160, 1600);
        this.historyTtlMs = clampInteger(historyTtlMs, 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
        const historyMessageLimit = clampInteger(maxHistoryMessages, 8, 2, 20);
        this.maxHistoryMessages = historyMessageLimit - (historyMessageLimit % 2);
        this.maxTextSessions = clampInteger(maxTextSessions, 1000, 10, 10000);
        this.clock = clock;
        this.textSessions = new Map();
        this.textQueues = new Map();
        this.conversationEpochs = new Map();
        this.textAbortControllers = new Map();
    }

    isConfigured() {
        return Boolean(this.client);
    }

    resetTextConversation(safetyIdentifier) {
        this.textSessions.delete(safetyIdentifier);
        this.textAbortControllers.get(safetyIdentifier)?.abort('conversation reset');
        if (this.textQueues.has(safetyIdentifier)) {
            this.conversationEpochs.set(
                safetyIdentifier,
                (this.conversationEpochs.get(safetyIdentifier) || 0) + 1
            );
        } else {
            this.conversationEpochs.delete(safetyIdentifier);
        }
    }

    getTextSession(safetyIdentifier) {
        const now = this.clock();
        const existing = this.textSessions.get(safetyIdentifier);
        if (existing && now - existing.updatedAt <= this.historyTtlMs) {
            existing.updatedAt = now;
            return existing;
        }
        if (existing) {
            this.textSessions.delete(safetyIdentifier);
        }
        while (this.textSessions.size >= this.maxTextSessions) {
            const oldestKey = this.textSessions.keys().next().value;
            this.textSessions.delete(oldestKey);
            if (!this.textQueues.has(oldestKey)) {
                this.conversationEpochs.delete(oldestKey);
            }
        }
        const created = { messages: [], updatedAt: now };
        this.textSessions.set(safetyIdentifier, created);
        return created;
    }

    async replyToText({ safetyIdentifier, text }) {
        if (!this.client) {
            const error = new Error('OpenAI is not configured');
            error.code = 'AI_NOT_CONFIGURED';
            throw error;
        }
        const cleanText = String(text || '').trim().slice(0, 1600);
        if (!cleanText) {
            const error = new Error('Message is empty');
            error.code = 'AI_EMPTY_MESSAGE';
            throw error;
        }

        const conversationEpoch = this.conversationEpochs.get(safetyIdentifier) || 0;
        const prior = this.textQueues.get(safetyIdentifier) || Promise.resolve();
        const task = prior.catch(() => {}).then(() => this.createTextReply(
            safetyIdentifier,
            cleanText,
            conversationEpoch
        ));
        this.textQueues.set(safetyIdentifier, task);
        try {
            return await task;
        } finally {
            if (this.textQueues.get(safetyIdentifier) === task) {
                this.textQueues.delete(safetyIdentifier);
                if (!this.textSessions.has(safetyIdentifier)) {
                    this.conversationEpochs.delete(safetyIdentifier);
                }
            }
        }
    }

    async createTextReply(safetyIdentifier, cleanText, conversationEpoch) {
        if ((this.conversationEpochs.get(safetyIdentifier) || 0) !== conversationEpoch) {
            throw Object.assign(new Error('Conversation was reset'), { code: 'AI_CONVERSATION_RESET' });
        }
        const session = this.getTextSession(safetyIdentifier);
        const input = [
            ...session.messages,
            { role: 'user', content: cleanText }
        ];
        const controller = new AbortController();
        this.textAbortControllers.set(safetyIdentifier, controller);
        let response;
        try {
            response = await runWithTimeout((signal) => this.client.responses.create({
                model: this.textModel,
                instructions: TEXT_INSTRUCTIONS,
                input,
                reasoning: {
                    effort: this.textReasoning,
                    context: 'current_turn'
                },
                text: { verbosity: 'low' },
                max_output_tokens: 512,
                safety_identifier: safetyIdentifier,
                service_tier: this.serviceTier,
                store: false
            }, { signal }), this.textTimeoutMs, { signal: controller.signal });
        } catch (error) {
            if ((this.conversationEpochs.get(safetyIdentifier) || 0) !== conversationEpoch) {
                throw Object.assign(new Error('Conversation was reset'), { code: 'AI_CONVERSATION_RESET' });
            }
            throw error;
        } finally {
            if (this.textAbortControllers.get(safetyIdentifier) === controller) {
                this.textAbortControllers.delete(safetyIdentifier);
            }
        }

        const answer = truncateText(response?.output_text, this.textMaxCharacters);
        if (!answer) {
            const error = new Error('OpenAI returned an empty answer');
            error.code = 'AI_EMPTY_RESPONSE';
            throw error;
        }
        if ((this.conversationEpochs.get(safetyIdentifier) || 0) !== conversationEpoch) {
            throw Object.assign(new Error('Conversation was reset'), { code: 'AI_CONVERSATION_RESET' });
        }

        session.messages.push(
            { role: 'user', content: cleanText },
            { role: 'assistant', content: answer }
        );
        session.messages = session.messages.slice(-this.maxHistoryMessages);
        session.updatedAt = this.clock();
        // Refresh insertion order so bounded eviction removes the least recently used session.
        this.textSessions.delete(safetyIdentifier);
        this.textSessions.set(safetyIdentifier, session);
        return answer;
    }

    async answerComplexVoice({ safetyIdentifier, question, recentTranscript = '', signal: externalSignal }) {
        if (!this.client) {
            throw Object.assign(new Error('OpenAI is not configured'), { code: 'AI_NOT_CONFIGURED' });
        }
        const cleanQuestion = String(question || '').trim().slice(0, 3000);
        const cleanContext = String(recentTranscript || '').trim().slice(-3000);
        if (!cleanQuestion) {
            throw Object.assign(new Error('Question is empty'), { code: 'AI_EMPTY_MESSAGE' });
        }

        const input = cleanContext
            ? `Recent conversation context:\n${cleanContext}\n\nQuestion to answer:\n${cleanQuestion}`
            : cleanQuestion;
        const response = await runWithTimeout((signal) => this.client.responses.create({
            model: this.deepVoiceModel,
            instructions: DEEP_VOICE_INSTRUCTIONS,
            input,
            reasoning: {
                effort: this.deepVoiceReasoning,
                context: 'current_turn'
            },
            text: { verbosity: 'low' },
            max_output_tokens: 640,
            safety_identifier: safetyIdentifier,
            service_tier: this.serviceTier,
            store: false
        }, { signal }), this.deepVoiceTimeoutMs, { signal: externalSignal });

        const answer = truncateText(response?.output_text, 1400);
        if (!answer) {
            throw Object.assign(new Error('OpenAI returned an empty answer'), { code: 'AI_EMPTY_RESPONSE' });
        }
        return {
            answer,
            usageTokens: Math.max(0, Number(response?.usage?.total_tokens || 0))
        };
    }
}

module.exports = {
    AiService,
    TEXT_INSTRUCTIONS,
    DEEP_VOICE_INSTRUCTIONS,
    OPENAI_API_BASE_URL,
    runWithTimeout,
    truncateText
};
