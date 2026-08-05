# Destiny Stream Phone Line

A simple voice-service backend for one streamer: Destiny.

## What it does
- answers incoming calls with a brief phone menu
- press 1 to hear the live stream (or a short "not live" message)
- press 2 through 6 to hear the last five archived streams, with the total duration announced before playback and real skip/rewind/pause/resume
- press 7 to hear the in-playback controls
- press 8 to have a low-latency spoken conversation with ChatGPT
- text the same Twilio number to chat with the assistant over SMS
- automatically shares encrypted, per-caller memory between SMS and AI voice
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

When persistent memory is enabled, this returns HTTP 503 instead of silently running without memory if the encrypted store, STOP/START preference store, or safety salt is unavailable.

## Deploy to Render
This runs via **Docker**, not Render's Node buildpack, because headless Chrome needs system libraries (fonts, NSS, GTK, etc.) that the plain Node environment doesn't have. `Dockerfile` in this repo installs them.

1. Create a GitHub repository containing this folder.
2. Import the repo into Render as a **Docker** web service (or point an existing service at this repo - if it was originally created as a Node-runtime service, you'll likely need to recreate it as a Docker service, since Render doesn't support switching an existing service's runtime in place).
3. Render will use the included `render.yaml`, which sets `STREAMER_NAME` and `KICK_CHANNEL`, creates a 1 GB persistent disk at `/var/data`, and generates separate safety-salt and AI-memory encryption secrets. Only encrypted AI memory and pseudonymous STOP/START state use that disk; raw caller playback-progress state remains on the service's ephemeral filesystem.
4. In the Render dashboard, set `ADMIN_TOKEN` to a secret value (render.yaml declares it but leaves the value for you to fill in).
5. After deployment, copy the public Render URL. `RENDER_EXTERNAL_URL` is set automatically by Render, so the app already knows its own public URL for building playback links.
6. In your phone provider, configure the webhook URL for incoming calls to:
   - `${RENDER_URL}/voice`
7. Check `GET ${RENDER_URL}/diagnostics/kick` to confirm the headless-browser check works from Render's network.

**Resource note**: headless Chrome plus ffmpeg (live relay and/or per-caller recording playback) can add up on a small instance. Watch Render's memory metrics after deploying and size up if you see restarts/OOM kills.

**Persistent-disk note**: only files beneath the disk mount survive Render restarts and deploys. A disk adds storage cost, pins this service to one instance, and causes brief downtime during deploys. The Blueprint deliberately leaves `PHONE_SERVICE_STATE_FILE` off this disk so raw caller playback-progress state is not made durable alongside AI memory. If this existing service is not managed by the Blueprint, attach a 1 GB disk at `/var/data` in the Render dashboard and add the memory variables listed below manually. See [Render's persistent disk documentation](https://render.com/docs/disks).

## Twilio setup
If you use Twilio:
1. Buy or configure a phone number.
2. In the Twilio Voice configuration, set the webhook URL for incoming calls to `${RENDER_URL}/voice`.
3. In Messaging configuration, set **A message comes in** to `${RENDER_URL}/sms` using HTTP POST. A Twilio Messaging Service with Advanced Opt-Out is recommended. When Advanced Opt-Out is enabled, Twilio supplies its own HELP response instead of the application's HELP text.
4. Set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` for the account that owns your numbers. Any number in that account can use the webhooks; incoming voice, SMS, and AI Media Stream requests remain signature-checked. SMS and AI voice are disabled without the auth token.
5. Set `OPENAI_API_KEY`, a random `AI_SAFETY_SALT` of at least 32 characters, and a fixed HTTPS `PUBLIC_BASE_URL`. For persistent memory, also enable `AI_MEMORY_ENABLED` and set a separate generated `AI_MEMORY_ENCRYPTION_KEY`. The Blueprint generates both local memory secrets for a new service. These secrets stay on the server and are never placed in TwiML or sent to the caller.
6. Live and archived playback are both served internally (`/live.mp3`, `/recordings/:id/play`) - you don't need a separate relay or tunnel.
7. For manual overrides, send requests to `/admin/stream/live`, `/admin/stream/stop`, and `/admin/stream/recording` with an `Authorization: Bearer <ADMIN_TOKEN>` header.

## AI chat design

Voice and SMS use different paths so each can meet its own latency target:

- **Normal voice turns:** Twilio's bidirectional Media Stream passes 8 kHz PCMU audio directly to `gpt-realtime-2.1`. OpenAI performs speech understanding, optional `gpt-transcribe` transcription, reasoning, and speech generation. No ffmpeg conversion is needed.
- **Difficult or current voice turns:** the Realtime model calls a read-only `answer_complex_question` tool backed by `gpt-5.6-sol`, low reasoning, Fast mode, and a 10-second server timeout. That Responses API request can automatically use OpenAI's hosted web search before the Realtime model speaks the answer.
- **SMS:** `gpt-5.6-sol` uses low reasoning and Fast mode with a 12-second timeout. It can automatically search for explicit lookups and current, changing, niche, or uncertain facts, and a searched SMS keeps a clickable source URL. The same protected caller memory used by voice provides follow-up context.

Web search uses the Responses API's hosted `web_search` tool with a low search-context size and at most two tool calls per answer. Explicit lookups and clearly time-sensitive questions force the search tool and fail closed if no search call is returned; other potentially changing or uncertain questions let the model choose it automatically. The model skips it for ordinary conversation and stable questions it can answer confidently. Search is enabled by default and uses the existing `OPENAI_API_KEY`; no separate search provider or browser key is needed. Set `OPENAI_WEB_SEARCH_ENABLED=false` to turn it off. Hosted searches add OpenAI tool-call cost and may take longer than answers from model knowledge alone; see the [OpenAI web search guide](https://developers.openai.com/api/docs/guides/tools-web-search).

Search-enabled requests still contain the caller's current question and relevant conversation context. The instructions prohibit putting phone numbers, credentials, secrets, or private caller-memory details into search queries and treat retrieved pages as untrusted evidence, but that prompt is a guardrail rather than a hard data-loss boundary. Disable web search if the deployment's privacy policy does not permit live retrieval. In particular, OpenAI documents live Web Search as not HIPAA/BAA eligible; see [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data#web-search).

The timeouts are upper bounds, not a hard end-to-end guarantee: carrier delay, Twilio, OpenAI load, web search, and the length of the answer also affect timing. Easy spoken turns avoid the second model call and should be the quickest. Fast mode is deliberately enabled because the requested priority is intelligence within a few seconds; set `OPENAI_FAST_MODE=false` to reduce API cost at the expense of latency.

When persistent memory is enabled and available, every successful SMS and AI voice exchange updates memory automatically. There is no `AGREE` prompt, recurring notice, or separate consent step. If memory is disabled, SMS chat remains ephemeral. If memory is enabled but unavailable, AI chat fails closed until storage is healthy.

For voice, pressing 8 opens the Media Stream immediately: there is no additional Twilio text-to-speech preamble or storage notice, and the OpenAI voice gives a short natural ChatGPT greeting as soon as the Realtime session is ready. ChatGPT does not volunteer storage details, but if a caller asks, it explains accurately what is saved and how to delete it.

`DELETE` or `FORGET` clears the application's memory that exists for that caller at that moment while keeping SMS enabled. It does not permanently disable memory: a later successful chat can create new memory automatically. `STOP` clears memory and opts the caller out of SMS; after `START`, persistent SMS memory resumes automatically. Voice callers can press 9 at the main menu to erase memory, although that control is intentionally not announced on every call. Deletion does not remove Twilio carrier records, provider safety logs, or already-created infrastructure snapshots.

Disabling `AI_MEMORY_ENABLED` does not erase an existing encrypted file. Delete caller memory before disabling the feature, or remove the whole encrypted file deliberately if all profiles must be destroyed.

Memory is application-managed and shared across SMS and AI voice for the same protected caller identifier. The identifier is derived from the caller's `From` number, not the destination `To` number, so the same memory follows that caller across every Twilio number in the configured account that uses these webhooks. This is phone-number identity, not a verified person or account: if a carrier reassigns a number, its new owner can inherit the prior caller's memory. Add a PIN or account-verification layer if that risk is unacceptable.

By default, the newest 10 active exchanges are stored verbatim. When an older exchange rolls out of that active window, it moves into a bounded encrypted overflow of up to 10 exchanges while awaiting summarization. A `store: false` OpenAI request then folds important, explicitly stated key points into a compact summary and removes the summarized overflow. If summarization remains unavailable after that overflow fills, the oldest pending exchange is dropped to keep storage bounded. The summary deliberately excludes credentials and avoids inferred sensitive traits. Voice "verbatim" means the exact transcription returned by OpenAI, which can contain speech-recognition errors; raw call audio is never saved.

Caller profiles have no automatic time-based expiration. They remain until the caller uses `DELETE`, `FORGET`, `STOP`, or voice-menu key 9; an operator removes the data; infrastructure is lost; or a configured storage bound is reached.

The memory file is encrypted with AES-256-GCM using `AI_MEMORY_ENCRYPTION_KEY` and contains the HMAC-based caller identifier rather than the raw phone number. Rotating either that encryption key or `AI_SAFETY_SALT` makes existing memory unreadable or unreachable. Keep both secrets stable and backed up securely.

Pressing 8 during an active AI voice chat closes the Media Stream and returns to the main menu. The application does not impose a wall-clock duration limit. Voice sessions are limited to 30 turns by default, and repeated silence also ends a call. The upstream OpenAI Realtime service can still impose its own maximum session duration.

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
- AI_SAFETY_SALT: required random secret of at least 32 characters used to create stable, privacy-preserving OpenAI safety identifiers; AI is disabled without it and rotating it also changes locally stored preference identifiers
- AI_MEMORY_ENABLED: set to `true` to enable persistent cross-channel memory; the included Render Blueprint enables it
- AI_MEMORY_FILE: encrypted memory file; defaults to `data/ai-memory.enc.json`, and the Render Blueprint uses `/var/data/ai-memory.enc.json`
- AI_MEMORY_ENCRYPTION_KEY: separate random secret of at least 32 characters; required when memory is enabled and generated automatically for a new Blueprint service
- AI_MEMORY_RECENT_EXCHANGES: number of newest verbatim exchanges retained per caller; defaults to 10 and is clamped to 1-20
- AI_MEMORY_MAX_PENDING_SUMMARY: maximum encrypted verbatim overflow retained while older exchanges await key-point summarization; defaults to 10
- AI_MEMORY_MAX_USERS: maximum caller profiles; defaults to 10000
- AI_MEMORY_MAX_FIELD_CHARACTERS / AI_MEMORY_MAX_CONTEXT_CHARACTERS: abuse and model-context bounds; default to 16000 / 32000
- AI_CONSENT_FILE: local STOP/START opt-out-state file; defaults to `data/ai-consent.json`, and the Render Blueprint uses `/var/data/ai-consent.json` (the legacy variable name is retained for deployment compatibility)
- PHONE_SERVICE_STATE_FILE: optional archive/playback and caller-progress state file; defaults to `data/phone-service-state.json` and is intentionally not placed on the Render AI-memory disk because it contains raw caller playback state
- OPENAI_REALTIME_MODEL: defaults to `gpt-realtime-2.1` (the full model, not mini)
- OPENAI_REALTIME_REASONING: defaults to `low`; `medium` is smarter but is more likely to miss the latency target
- OPENAI_REALTIME_VOICE: defaults to `marin`
- OPENAI_REALTIME_VAD: defaults to `server_vad` with a short silence threshold; set `semantic_vad` for more natural but potentially slower turn detection
- OPENAI_TRANSCRIBE_MODEL: defaults to `gpt-transcribe`
- OPENAI_TEXT_MODEL / OPENAI_DEEP_VOICE_MODEL: both default to `gpt-5.6-sol`
- OPENAI_TEXT_REASONING / OPENAI_DEEP_VOICE_REASONING: default to `low`
- OPENAI_FAST_MODE: defaults to `true`; uses OpenAI Fast mode for GPT-5.6 calls
- OPENAI_WEB_SEARCH_ENABLED: defaults to `true`; offers hosted web search to SMS and deep voice requests, forcing it for clear lookups/time-sensitive questions and using automatic selection otherwise; set to `false` to disable it
- OPENAI_TEXT_TIMEOUT_MS / OPENAI_DEEP_VOICE_TIMEOUT_MS: default to 12000 / 10000 to allow search-backed answers to finish
- AI_VOICE_MAX_SESSIONS, AI_VOICE_MAX_TURNS, AI_VOICE_MAX_DEEP_CALLS, AI_VOICE_MAX_TOKENS, AI_VOICE_MAX_CONTINUATIONS, AI_VOICE_MAX_IDLE_PROMPTS: voice spend, completion, silence, and concurrency controls
- AI_SMS_PER_MINUTE, AI_SMS_PER_DAY, AI_SMS_GLOBAL_PER_HOUR, AI_SMS_GLOBAL_PER_DAY, AI_SMS_MAX_CONCURRENT: model-call abuse/spend controls
- AI_SMS_OUTBOUND_SEGMENTS_PER_HOUR / AI_SMS_OUTBOUND_SEGMENTS_PER_DAY: carrier-spend limits; each AI answer is also capped at three GSM-7 or UCS-2 segments

The included AI-memory file, STOP/START preference store, limiters, and idempotency caches assume one running instance. Before scaling horizontally, move AI memory, opt-out state, token consumption, SMS deduplication, rate limits, and active-call coordination to transactional shared storage such as a database or Redis, as appropriate.
