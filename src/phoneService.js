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

// TwiML is XML - any dynamic value dropped into <Say> text or a <Play> URL
// (recording titles from Kick, query strings with & in them, etc.) has to be
// escaped or a bare & or < makes the whole document invalid (Twilio error
// 12100 "Document parse failure", which surfaces to the caller as an
// immediate "application error" with no audio at all).
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

const ANNOUNCEMENT_TIME_ZONE = 'America/New_York';

// Fixed to a single timezone (not each caller's own) since there's no
// reliable way to know where a caller actually is from just a phone number -
// stated explicitly ("New York time") so it's unambiguous either way.
function formatBroadcastStartedAt(isoString) {
    if (!isoString) {
        return null;
    }
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    const weekday = date.toLocaleString('en-US', { timeZone: ANNOUNCEMENT_TIME_ZONE, weekday: 'long' });
    const monthDay = date.toLocaleString('en-US', { timeZone: ANNOUNCEMENT_TIME_ZONE, month: 'long', day: 'numeric' });
    const time = date.toLocaleString('en-US', {
        timeZone: ANNOUNCEMENT_TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true
    });
    return `${weekday}, ${monthDay}, at ${time} New York time`;
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
        return `${liveLine} Press 2 through 6 for the last five archived streams, from most recent to oldest. Press 7 to hear the playback controls.`;
    }

    getControlsInfoPrompt() {
        return 'During playback: press 2 to pause or play. Press 1 or 3 to go back or forward 10 seconds. '
            + 'Press 4 or 6 to go back or forward 30 seconds. Press 7 or 9 to go back or forward 5 minutes. '
            + 'Press star or pound to go back or forward 30 minutes. Press 8 to return to the main menu.';
    }

    buildMenuTwiML(customPrompt = null) {
        const menuPrompt = escapeXml(this.getMenuPrompt());
        // A status/error message (e.g. "that recording is not available") gets
        // said first, then a beat of silence, then the actual menu - otherwise
        // it runs into the menu as one monotonous sentence.
        const intro = customPrompt ? `\n  <Say voice="alice">${escapeXml(customPrompt)}</Say>\n  <Pause length="1"/>` : '';
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${intro}\n  <Gather action="/voice/menu" numDigits="1" timeout="10">\n    <Say voice="alice">${menuPrompt}</Say>\n  </Gather>\n  <Say voice="alice">${menuPrompt}</Say>\n</Response>`;
    }

    buildControlsInfoTwiML() {
        const menuPrompt = escapeXml(this.getMenuPrompt());
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say voice="alice">${escapeXml(this.getControlsInfoPrompt())}</Say>\n  <Pause length="1"/>\n  <Gather action="/voice/menu" numDigits="1" timeout="10">\n    <Say voice="alice">${menuPrompt}</Say>\n  </Gather>\n  <Say voice="alice">${menuPrompt}</Say>\n</Response>`;
    }

    buildPlaybackTwiML(prompt, audioUrl = null) {
        const say = prompt ? `\n    <Say voice="alice">${escapeXml(prompt)}</Say>` : '';
        const audioSection = audioUrl ? `\n    <Play>${escapeXml(audioUrl)}</Play>` : '';
        // Redirects to /voice/playback itself (not /voice/menu): a chunk ending
        // with no keypress posts empty Digits there, which handlePlaybackControl's
        // default path treats as "continue from the current position" - that's
        // what makes an archived recording keep playing across chunk boundaries
        // instead of dropping to the menu every ~60 seconds. timeout="1" (as
        // low as Twilio allows) matches the live path - keeps the dead air
        // between chunks as short as possible while still catching a keypress.
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather action="/voice/playback" numDigits="1" timeout="1" finishOnKey="">${say}${audioSection}\n  </Gather>\n  <Redirect>/voice/playback</Redirect>\n</Response>`;
    }

    buildPausedTwiML(message) {
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather action="/voice/playback" numDigits="1" timeout="120" finishOnKey="">\n    <Say voice="alice">${escapeXml(message)}</Say>\n  </Gather>\n  <Redirect>/voice/menu</Redirect>\n</Response>`;
    }

    buildLiveStreamTwiML(prompt, audioUrl = null) {
        if (audioUrl) {
            // /live.mp3 hands back one bounded chunk at a time (Twilio's <Play>
            // can't fetch a truly endless stream - see server.js). timeout="1"
            // (the minimum Twilio allows) keeps the post-chunk dead air before
            // the /voice/live-continue loop fires as short as possible, while
            // still leaving a beat to catch a keypress right at the boundary.
            return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather action="/voice/playback" numDigits="1" timeout="1" finishOnKey="">\n    <Play>${escapeXml(audioUrl)}</Play>\n  </Gather>\n  <Redirect>/voice/live-continue</Redirect>\n</Response>`;
        }
        return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say voice="alice">${escapeXml(prompt)}</Say>\n  <Pause length="1"/>\n  <Redirect>/voice/menu</Redirect>\n</Response>`;
    }

    ensureCaller(phoneNumber) {
        if (!this.state.callers[phoneNumber]) {
            this.state.callers[phoneNumber] = {
                phoneNumber,
                lastRecordingId: null,
                lastPositionSeconds: 0,
                positionsByRecording: {},
                lastVisitedAt: null,
                segmentStartedAt: null
            };
        }

        return this.state.callers[phoneNumber];
    }

    // Twilio never tells us how far into a <Play> a caller was when they hit a
    // button, so position is inferred from wall-clock time since the current
    // segment started. Accurate enough for 10s/30s/5min/30min granularity.
    getElapsedPosition(caller) {
        if (!caller.segmentStartedAt) {
            return caller.lastPositionSeconds || 0;
        }
        const elapsedSeconds = (Date.now() - new Date(caller.segmentStartedAt).getTime()) / 1000;
        return (caller.lastPositionSeconds || 0) + Math.max(0, elapsedSeconds);
    }

    startSegment(caller, recordingId, positionSeconds) {
        const clamped = Math.max(0, positionSeconds || 0);
        caller.lastRecordingId = recordingId;
        caller.lastPositionSeconds = clamped;
        caller.segmentStartedAt = new Date().toISOString();
        caller.positionsByRecording[recordingId] = clamped;
        caller.lastVisitedAt = caller.segmentStartedAt;
    }

    pauseSegment(caller) {
        const position = this.getElapsedPosition(caller);
        caller.lastPositionSeconds = position;
        if (caller.lastRecordingId) {
            caller.positionsByRecording[caller.lastRecordingId] = position;
        }
        caller.segmentStartedAt = null;
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

    addRecording({ title, audioUrl = null, durationSeconds = 0, kickVideoId = null, broadcastStartedAt = null } = {}) {
        const recording = {
            id: generateId(),
            title: title || `${this.streamerName} archived stream`,
            startedAt: new Date().toISOString(),
            // When the broadcast actually happened, not when our server got
            // around to archiving it (which can lag by a poll cycle or
            // more) - null for admin-added recordings that don't have it.
            broadcastStartedAt,
            audioUrl,
            durationSeconds: durationSeconds || 0,
            kickVideoId,
            live: false
        };

        this.state.recordings.unshift(recording);
        this.trimRecordings();
        this.saveState();
        return recording;
    }

    getRecordingByOption(option) {
        const archived = this.state.recordings.filter((entry) => !entry.live);
        const index = Number(option) - 2;
        return archived[index] || null;
    }

    selectLiveStream(phoneNumber) {
        const caller = this.ensureCaller(phoneNumber);
        const liveRecording = this.state.recordings.find((entry) => entry.id === this.state.currentLiveRecordingId);
        const audioUrl = this.state.isLive && liveRecording ? liveRecording.audioUrl : null;

        if (audioUrl) {
            this.startSegment(caller, liveRecording.id, 0);
        }
        this.saveState();

        return {
            recordingId: audioUrl ? liveRecording.id : null,
            audioUrl,
            message: audioUrl ? null : 'There is no live stream currently.'
        };
    }

    selectRecording(phoneNumber, option) {
        const recording = this.getRecordingByOption(option);
        if (!recording) {
            return { type: 'error', message: 'That recording is not available.' };
        }

        const caller = this.ensureCaller(phoneNumber);
        const savedPosition = caller.positionsByRecording[recording.id] || 0;
        this.startSegment(caller, recording.id, savedPosition);
        this.saveState();

        const broadcastTime = formatBroadcastStartedAt(recording.broadcastStartedAt);
        const message = broadcastTime
            ? `You are now listening to ${recording.title}, from ${broadcastTime}.`
            : `You are now listening to ${recording.title}.`;

        return {
            type: 'recording',
            recordingId: recording.id,
            title: recording.title,
            positionSeconds: savedPosition,
            message
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

    handlePlaybackControl(phoneNumber, digit) {
        const caller = this.ensureCaller(phoneNumber);
        const recording = caller.lastRecordingId
            ? this.state.recordings.find((entry) => entry.id === caller.lastRecordingId)
            : null;

        if (!recording) {
            return { type: 'menu' };
        }

        if (digit === '8') {
            this.pauseSegment(caller);
            this.saveState();
            return { type: 'menu' };
        }

        if (recording.live) {
            // Pause/skip/rewind don't apply to a live broadcast - there's no
            // position to seek to or pause-and-resume from. Every key except
            // 8 (menu, handled above) is a no-op that just keeps the caller
            // listening to the current live point.
            this.startSegment(caller, recording.id, 0);
            this.saveState();
            return { type: 'live-resume', recordingId: recording.id };
        }

        if (digit === '2') {
            if (caller.segmentStartedAt) {
                this.pauseSegment(caller);
                this.saveState();
                return { type: 'paused', message: 'Paused. Press 2 to resume.' };
            }
            const resumePosition = caller.lastPositionSeconds || 0;
            this.startSegment(caller, recording.id, resumePosition);
            this.saveState();
            return { type: 'seek', recordingId: recording.id, positionSeconds: resumePosition };
        }

        const deltaSeconds = {
            '1': -10, '3': 10,
            '4': -30, '6': 30,
            '7': -300, '9': 300,
            '*': -1800, '#': 1800
        }[digit];

        const currentPosition = this.getElapsedPosition(caller);
        const nextPosition = Math.max(0, currentPosition + (deltaSeconds || 0));

        // Each <Play> only covers a bounded chunk (see ARCHIVE_CHUNK_SECONDS in
        // server.js), so a natural chunk-end (digit === '') keeps calling this
        // with a same-position "continue" - without this check, a finished
        // recording would loop forever requesting past its own end.
        if (recording.durationSeconds && nextPosition >= recording.durationSeconds) {
            this.pauseSegment(caller);
            this.saveState();
            return { type: 'menu', message: `Finished playing ${recording.title}.` };
        }

        this.startSegment(caller, recording.id, nextPosition);
        this.saveState();

        if (deltaSeconds === undefined) {
            // No recognized seek key was pressed (natural chunk-end, or an
            // unmapped key) - positionSeconds here is only a wall-clock
            // estimate that drifts a little further off with every chunk
            // transition (Twilio's inter-chunk pause isn't audio time), so
            // server.js's persistent archive session should just keep
            // playing from wherever it actually is rather than treating this
            // as a real seek and reconnecting once that drift adds up.
            return { type: 'continue', recordingId: recording.id, positionSeconds: nextPosition };
        }

        return { type: 'seek', recordingId: recording.id, positionSeconds: nextPosition };
    }
}

module.exports = { PhoneService, createDefaultState };
