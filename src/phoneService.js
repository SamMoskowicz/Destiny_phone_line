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
        const liveLine = this.state.isLive
            ? `To hear Destiny's live stream, press 1.`
            : `There is no live stream right now.`;
        return `${liveLine} Press 2 through 6 for the last five archived streams. Press 7 to hear the playback controls.`;
    }

    getControlsInfoPrompt() {
        return 'During playback: press 1 to pause, 2 to resume, 3 to skip ahead, 4 to go back, 5 for the menu, or 6 to jump to live.';
    }

    getPlaybackControlsPrompt() {
        return '';
    }

    buildMenuTwiML(customPrompt = null) {
        const prompt = customPrompt || this.getMenuPrompt();
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather action="/voice/menu" numDigits="1" timeout="10">\n    <Say voice="alice">${prompt}</Say>\n  </Gather>\n  <Say voice="alice">${prompt}</Say>\n</Response>`;
    }

    buildControlsInfoTwiML() {
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say voice="alice">${this.getControlsInfoPrompt()}</Say>\n  <Gather action="/voice/menu" numDigits="1" timeout="10">\n    <Say voice="alice">${this.getMenuPrompt()}</Say>\n  </Gather>\n  <Say voice="alice">${this.getMenuPrompt()}</Say>\n</Response>`;
    }

    buildPlaybackTwiML(prompt, audioUrl = null) {
        const audioSection = audioUrl ? `\n  <Play>${audioUrl}</Play>` : '';
        const controls = this.getPlaybackControlsPrompt();
        const controlsSay = controls ? `\n    <Say voice="alice">${controls}</Say>` : '';
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather action="/voice/playback" numDigits="1" timeout="5">\n    <Say voice="alice">${prompt}</Say>${controlsSay}${audioSection}\n  </Gather>\n</Response>`;
    }

    buildLiveStreamTwiML(prompt, audioUrl = null) {
        if (audioUrl) {
            return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Play>${audioUrl}</Play>\n</Response>`;
        }
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say voice="alice">${prompt}</Say>\n</Response>`;
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

    startStream({ audioUrl = null, sourceUrl = null } = {}) {
        const recording = {
            id: generateId(),
            title: `${this.streamerName} live stream`,
            startedAt: new Date().toISOString(),
            audioUrl,
            sourceUrl,
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
        const liveRecording = this.state.recordings.find((entry) => entry.id === this.state.currentLiveRecordingId);
        caller.lastRecordingId = this.state.currentLiveRecordingId;
        caller.lastPositionSeconds = 0;
        caller.lastVisitedAt = new Date().toISOString();
        this.saveState();
        return {
            type: 'live',
            recordingId: this.state.currentLiveRecordingId,
            positionSeconds: 0,
            audioUrl: liveRecording ? liveRecording.audioUrl : null,
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
            audioUrl: recording.audioUrl,
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
            audioUrl: recording.audioUrl,
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
