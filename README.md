# Destiny Stream Phone Line

A simple voice-service backend for one streamer: Destiny.

## What it does
- answers incoming calls with a brief phone menu
- press 1 to hear the live stream (or a short "not live" message)
- press 2 through 6 to hear the last five archived streams, with real skip/rewind/pause/resume
- press 7 to hear the in-playback controls
- press 8 to have a low-latency spoken conversation with an OpenAI assistant
- text the same Twilio number to chat with the assistant over SMS
- auto-detects when Destiny's Kick channel goes live and relays it to callers over `/live.mp3`
- automatically archives Destiny's recent Kick VODs so the last five are always available to callers, no manual step required
- remembers each caller's position per recording and resumes from there

## How the automation works
Kick's API blocks plain server-side requests (confirmed - identical 403 from multiple networks/HTTP clients regardless of headers), so both live-detection and VOD archiving run through a real headless Chrome (`src/kickBrowser.js`, Puppeteer + a stealth plugin) that behaves like an actual browser: it loads Destiny's Kick pages, and where needed does a genuine trusted click (not a synthetic JS click - the player only initiates real playback for a trusted input event) to trigger the same requests a real viewer's browser would make.

- Every `KICK_POLL_INTERVAL_MS` (default 90s): checks live status and starts/stops the live relay.
- Every random interval between `KICK_VIDEOS_POLL_INTERVAL_MS` and `KICK_VIDEOS_POLL_MAX_INTERVAL_MS` (default 15-30 min, randomized so it isn't a perfectly predictable machine-like cadence): checks Destiny's videos list and archives at most one not-yet-archived VOD (newest first) per cycle - never several in the same run. Catching up on multiple missing recordings takes multiple cycles. A video that just failed to archive isn't retried again for an hour - Kick's Cloudflare protection on individual video pages appears to score bursty/predictable automated traffic more harshly.
- A VOD's actual playback URL is signed and expires ~1 hour after being fetched, so it isn't stored permanently - it's re-resolved (with a short-lived cache) the moment a caller actually plays that recording, not when it's archived.

Because this is an undocumented/unofficial mechanism, it can break if Kick changes something. `GET /diagnostics/kick` reports whether the browser-based live check is currently working. If Kick ever blocks headless Chrome too, `POST /admin/stream/live` and `/admin/stream/recording` (below) still work as a fully manual fallback.

## Run locally
```bash
npm install
npm start
```

## Health check
```bash
curl http://localhost:3000/health
```

## Deploy to Render
This runs via **Docker**, not Render's Node buildpack, because headless Chrome needs system libraries (fonts, NSS, GTK, etc.) that the plain Node environment doesn't have. `Dockerfile` in this repo installs them.

1. Create a GitHub repository containing this folder.
2. Import the repo into Render as a **Docker** web service (or point an existing service at this repo - if it was originally created as a Node-runtime service, you'll likely need to recreate it as a Docker service, since Render doesn't support switching an existing service's runtime in place).
3. Render will use the included `render.yaml`, which sets `STREAMER_NAME` and `KICK_CHANNEL` for you.
4. In the Render dashboard, set `ADMIN_TOKEN` to a secret value (render.yaml declares it but leaves the value for you to fill in).
5. After deployment, copy the public Render URL. `RENDER_EXTERNAL_URL` is set automatically by Render, so the app already knows its own public URL for building playback links.
6. In your phone provider, configure the webhook URL for incoming calls to:
   - `${RENDER_URL}/voice`
7. Check `GET ${RENDER_URL}/diagnostics/kick` to confirm the headless-browser check works from Render's network.

**Resource note**: headless Chrome plus ffmpeg (live relay and/or per-caller recording playback) can add up on a small instance. Watch Render's memory metrics after deploying and size up if you see restarts/OOM kills.

## Twilio setup
If you use Twilio:
1. Buy or configure a phone number.
2. In the Twilio Voice configuration, set the webhook URL for incoming calls to `${RENDER_URL}/voice`.
3. In Messaging configuration, set **A message comes in** to `${RENDER_URL}/sms` using HTTP POST. A Twilio Messaging Service with Advanced Opt-Out is recommended.
4. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` to the values for that number. Incoming voice, SMS, and AI Media Stream requests are signature-checked when these are configured; SMS and AI voice are disabled without the auth token.
5. Set `OPENAI_API_KEY`, `AI_SAFETY_SALT`, and a fixed HTTPS `PUBLIC_BASE_URL`. The API key stays on the server and is never placed in TwiML or sent to the caller.
6. Live and archived playback are both served internally (`/live.mp3`, `/recordings/:id/play`) - you don't need a separate relay or tunnel.
7. For manual overrides, send requests to `/admin/stream/live`, `/admin/stream/stop`, and `/admin/stream/recording` with an `Authorization: Bearer <ADMIN_TOKEN>` header.

## AI chat design

Voice and SMS use different paths so each can meet its own latency target:

- **Normal voice turns:** Twilio's bidirectional Media Stream passes 8 kHz PCMU audio directly to `gpt-realtime-2.1`. OpenAI performs speech understanding, optional `gpt-transcribe` transcription, reasoning, and speech generation. No ffmpeg conversion is needed.
- **Difficult voice turns:** the Realtime model can call a read-only `answer_complex_question` tool backed by `gpt-5.6-sol`, low reasoning, Fast mode, and a 3.5-second server timeout. The Realtime model then speaks that answer.
- **SMS:** `gpt-5.6-sol` uses low reasoning and Fast mode with a 4.5-second timeout. A small in-memory conversation history provides follow-up context.

Those are aggressive latency-oriented defaults, not a hard end-to-end guarantee: carrier delay, Twilio, OpenAI load, and the length of the answer also affect timing. Easy spoken turns avoid the second model call and should be the quickest. Fast mode is deliberately enabled because the requested priority is intelligence within a few seconds; set `OPENAI_FAST_MODE=false` to reduce API cost at the expense of latency.

Pressing 8 during AI voice chat closes the Media Stream and returns to the main menu. Voice sessions are limited to 10 minutes and 30 turns by default, and repeated silence also ends a call. SMS history, AI transcripts, and audio are held only in process memory. STOP/START consent is the exception: only a keyed, non-phone-number identifier is saved in `data/ai-consent.json` (or `AI_CONSENT_FILE`). Put that file on durable storage in production and use a shared consent/rate-limit store before scaling beyond one instance.

All model traffic uses the official OpenAI API endpoints. The key-bearing endpoints are pinned to OpenAI rather than being configurable through `OPENAI_BASE_URL` or a Realtime URL override.

### Admin API examples
Manually start the live relay (only needed to override auto-detection). `audioUrl` here is the upstream HLS/m3u8 source to relay, not a direct playable link:
```bash
curl -X POST "${RENDER_URL}/admin/stream/live" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"audioUrl":"https://example.com/live-destiny-stream.m3u8"}'
```

Stop live stream:
```bash
curl -X POST "${RENDER_URL}/admin/stream/stop" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Manually add an archived recording (only needed to override auto-archiving - a direct playable mp3/wav URL, not signed/expiring):
```bash
curl -X POST "${RENDER_URL}/admin/stream/recording" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Destiny archive","audioUrl":"https://example.com/destiny-archive.mp3"}'
```

## Environment variables
- STREAMER_NAME: defaults to Destiny if omitted
- PORT: defaults to 3000 if omitted
- KICK_CHANNEL: Kick channel slug to auto-detect live status and archive VODs for (e.g. `destiny`); leave unset to manage everything manually via the admin API
- KICK_POLL_INTERVAL_MS: how often to check live status, in milliseconds; defaults to 90000
- KICK_VIDEOS_POLL_INTERVAL_MS: minimum time between checks for new VODs to archive, in milliseconds; defaults to 900000 (15 min)
- KICK_VIDEOS_POLL_MAX_INTERVAL_MS: maximum time between those checks; defaults to double KICK_VIDEOS_POLL_INTERVAL_MS (so 15-30 min by default) - each check is scheduled at a random point in this range
- ADMIN_TOKEN: protects the admin endpoints; leave unset only for local testing, since the endpoints are open to anyone if it's not set
- PUBLIC_BASE_URL: base URL used to build playback links; normally unnecessary on Render (`RENDER_EXTERNAL_URL` is set automatically) but useful for local dev or other hosts
- LIVE_HLS_URL: optional, manually pins the HLS source to relay at startup instead of using `KICK_CHANNEL` or the admin API
- OPENAI_API_KEY: server-side OpenAI API key; required for both AI modes
- TWILIO_ACCOUNT_SID: expected Twilio account for signed webhooks
- TWILIO_AUTH_TOKEN: validates Twilio HTTP and WebSocket signatures; required for SMS and AI voice
- TWILIO_PHONE_NUMBER: expected destination number, in E.164 format
- AI_SAFETY_SALT: required long random secret used to create stable, privacy-preserving OpenAI safety identifiers; AI is disabled without it and rotating it also changes locally stored consent identifiers
- AI_CONSENT_FILE: local STOP/START consent file; defaults to `data/ai-consent.json` and should live on durable storage
- OPENAI_REALTIME_MODEL: defaults to `gpt-realtime-2.1` (the full model, not mini)
- OPENAI_REALTIME_REASONING: defaults to `low`; `medium` is smarter but is more likely to miss the latency target
- OPENAI_REALTIME_VOICE: defaults to `marin`
- OPENAI_REALTIME_VAD: defaults to `server_vad` with a short silence threshold; set `semantic_vad` for more natural but potentially slower turn detection
- OPENAI_TRANSCRIBE_MODEL: defaults to `gpt-transcribe`
- OPENAI_TEXT_MODEL / OPENAI_DEEP_VOICE_MODEL: both default to `gpt-5.6-sol`
- OPENAI_TEXT_REASONING / OPENAI_DEEP_VOICE_REASONING: default to `low`
- OPENAI_FAST_MODE: defaults to `true`; uses OpenAI Fast mode for GPT-5.6 calls
- OPENAI_TEXT_TIMEOUT_MS / OPENAI_DEEP_VOICE_TIMEOUT_MS: default to 4500 / 3500
- AI_VOICE_MAX_SESSIONS, AI_VOICE_MAX_DURATION_MS, AI_VOICE_MAX_TURNS, AI_VOICE_MAX_DEEP_CALLS, AI_VOICE_MAX_TOKENS, AI_VOICE_MAX_CONTINUATIONS, AI_VOICE_MAX_IDLE_PROMPTS: voice spend, completion, silence, and concurrency controls
- AI_SMS_PER_MINUTE, AI_SMS_PER_DAY, AI_SMS_GLOBAL_PER_HOUR, AI_SMS_GLOBAL_PER_DAY, AI_SMS_MAX_CONCURRENT: model-call abuse/spend controls
- AI_SMS_OUTBOUND_SEGMENTS_PER_HOUR / AI_SMS_OUTBOUND_SEGMENTS_PER_DAY: carrier-spend limits; each AI answer is also capped at three GSM-7 or UCS-2 segments

The included limiters and idempotency caches are in memory, which is appropriate for the current single-instance Render service. Before running multiple instances, move consent, token consumption, SMS deduplication, rate limits, and active-call coordination to a durable shared store such as Redis or a database.
