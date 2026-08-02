const fs = require('fs');
const path = require('path');

function createDefaultState(streamerName) {
    return {
        streamerName,
        isLive: false,
        currentLiveRecordingId: null,
        recordings: [],
        callers: {}
    };
}

function generateId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

class PhoneService {
    constructor({ streamerName = 'Destiny', storageFile } = {}) {
        this.streamerName = streamerName || 'Destiny';
        this.storageFile = storageFile || path.join(process.cwd(), 'data', 'phone-service-state.json');
        this.state = this.loadState();
    }

    loadState() {
        if (fs.existsSync(this.storageFile)) {
            try {
                const raw = fs.readFileSync(this.storageFile, 'utf8');
                const parsed = JSON.parse(raw);
                return {
                    ...createDefaultState(this.streamerName),
                    ...parsed,
                    recordings: Array.isArray(parsed.recordings) ? parsed.recordings : [],
                    callers: parsed.callers && typeof parsed.callers === 'object' ? parsed.callers : {}
                };
            } catch (error) {
                console.warn('Unable to read state file, starting fresh.', error.message);
            }
        }

        return createDefaultState(this.streamerName);
    }

    saveState() {
        fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
        fs.writeFileSync(this.storageFile, JSON.stringify(this.state, null, 2));
    }

    getMenuPrompt() {
        const basePrompt = `For Destiny, press 1 to hear the live stream. Press 2 through 6 to hear the five most recent recorded streams, from newest to oldest. Press 7 to continue the last recorded stream you listened to.`;
        return this.state.isLive ? basePrompt : `There is no live stream currently for Destiny. ${basePrompt}`;
    }

    getPlaybackControlsPrompt() {
        return 'Press 1 to pause, 2 to resume, 3 to skip forward, 4 to go backward, 5 to return to the menu, 6 to jump to the live point.';
    }

    buildMenuTwiML(customPrompt = null) {
        const prompt = customPrompt || this.getMenuPrompt();
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather action="/voice/menu" numDigits="1" timeout="10">\n    <Say voice="alice">${prompt}</Say>\n  </Gather>\n  <Say voice="alice">${prompt}</Say>\n</Response>`;
    }

    buildPlaybackTwiML(prompt, audioUrl = null) {
        const audioSection = audioUrl ? `\n  <Play>${audioUrl}</Play>` : '';
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather action="/voice/playback" numDigits="1" timeout="5">\n    <Say voice="alice">${prompt}</Say>\n    <Say voice="alice">${this.getPlaybackControlsPrompt()}</Say>${audioSection}\n  </Gather>\n</Response>`;
    }

    ensureCaller(phoneNumber) {
        if (!this.state.callers[phoneNumber]) {
            this.state.callers[phoneNumber] = {
                phoneNumber,
                lastRecordingId: null,
                lastPositionSeconds: 0,
                positionsByRecording: {},
                lastVisitedAt: null
            };
        }

        return this.state.callers[phoneNumber];
    }

    trimRecordings() {
        if (this.state.recordings.length > 5) {
            this.state.recordings = this.state.recordings.slice(0, 5);
        }
    }

    startStream({ audioUrl = null } = {}) {
        const recording = {
            id: generateId(),
            title: `${this.streamerName} live stream`,
            startedAt: new Date().toISOString(),
            audioUrl,
            durationSeconds: 0,
            live: true
        };

        this.state.isLive = true;
        this.state.currentLiveRecordingId = recording.id;
        this.state.recordings.unshift(recording);
        this.trimRecordings();
        this.saveState();
        return recording;
    }

    endStream() {
        this.state.isLive = false;
        this.state.currentLiveRecordingId = null;
        this.saveState();
        return { isLive: false };
    }

    addRecording({ title, audioUrl = null } = {}) {
        const recording = {
            id: generateId(),
            title: title || `${this.streamerName} archived stream`,
            startedAt: new Date().toISOString(),
            audioUrl,
            durationSeconds: 0,
            live: false
        };

        this.state.recordings.unshift(recording);
        this.trimRecordings();
        this.saveState();
        return recording;
    }

    getRecordingByOption(option) {
        const index = Number(option) - 2;
        return this.state.recordings[index] || null;
    }

    selectLiveStream(phoneNumber) {
        const caller = this.ensureCaller(phoneNumber);
        caller.lastRecordingId = this.state.currentLiveRecordingId;
        caller.lastPositionSeconds = 0;
        caller.lastVisitedAt = new Date().toISOString();
        this.saveState();
        return {
            type: 'live',
            recordingId: this.state.currentLiveRecordingId,
            positionSeconds: 0,
            message: this.state.isLive ? 'You are now listening to the live stream.' : 'There is no live stream currently.'
        };
    }

    selectRecording(phoneNumber, option) {
        const recording = this.getRecordingByOption(option);
        if (!recording) {
            return { type: 'error', message: 'That recording is not available.' };
        }

        const caller = this.ensureCaller(phoneNumber);
        const savedPosition = caller.positionsByRecording[recording.id] || 0;
        caller.lastRecordingId = recording.id;
        caller.lastPositionSeconds = savedPosition;
        caller.lastVisitedAt = new Date().toISOString();
        this.saveState();

        return {
            type: 'recording',
            recordingId: recording.id,
            title: recording.title,
            positionSeconds: savedPosition,
            message: `You are now listening to ${recording.title}.`
        };
    }

    resumeLastRecording(phoneNumber) {
        const caller = this.ensureCaller(phoneNumber);
        if (!caller.lastRecordingId) {
            return { type: 'error', message: 'You have not listened to a recording yet.' };
        }

        const recording = this.state.recordings.find((entry) => entry.id === caller.lastRecordingId);
        if (!recording) {
            return { type: 'error', message: 'The last recording is no longer available.' };
        }

        const savedPosition = caller.positionsByRecording[recording.id] || caller.lastPositionSeconds || 0;
        caller.lastPositionSeconds = savedPosition;
        caller.lastVisitedAt = new Date().toISOString();
        this.saveState();

        return {
            type: 'recording',
            recordingId: recording.id,
            title: recording.title,
            positionSeconds: savedPosition,
            message: `Continuing ${recording.title} from your saved position.`
        };
    }

    updateProgress(phoneNumber, recordingId, positionSeconds) {
        const caller = this.ensureCaller(phoneNumber);
        if (recordingId) {
            caller.positionsByRecording[recordingId] = positionSeconds;
            caller.lastRecordingId = recordingId;
            caller.lastPositionSeconds = positionSeconds;
            caller.lastVisitedAt = new Date().toISOString();
            this.saveState();
        }
        return caller;
    }

    handlePlaybackControl(phoneNumber, digit, recordingId) {
        const caller = this.ensureCaller(phoneNumber);
        const currentPosition = caller.positionsByRecording[recordingId] || caller.lastPositionSeconds || 0;
        const nextPosition = currentPosition;

        switch (digit) {
            case '1':
                return { type: 'paused', message: 'Playback paused.' };
            case '2':
                return { type: 'resumed', message: 'Playback resumed.' };
            case '3':
                return { type: 'skipped', message: 'Skipped forward 30 seconds.', positionSeconds: nextPosition + 30 };
            case '4':
                return { type: 'rewound', message: 'Moved backward 30 seconds.', positionSeconds: Math.max(0, nextPosition - 30) };
            case '5':
                return { type: 'menu', message: this.getMenuPrompt() };
            case '6':
                return { type: 'live', message: 'Jumping to the live point.' };
            default:
                return { type: 'noop', message: 'No action taken.' };
        }
    }
}

module.exports = { PhoneService, createDefaultState };
