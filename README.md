# Destiny Stream Phone Line

A simple voice-service backend for one streamer: Destiny.

## What it does
- answers incoming calls with a brief phone menu
- press 1 to hear the live stream (or a short "not live" message)
- press 2 through 6 to hear the last five archived streams, with real skip/rewind/pause/resume
- press 7 to hear the in-playback controls
- auto-detects when Destiny's Kick channel goes live and relays it to callers over `/live.mp3`
- automatically archives Destiny's recent Kick VODs so the last five are always available to callers, no manual step required
- remembers each caller's position per recording and resumes from there

## How the automation works
Kick's API blocks plain server-side requests (confirmed - identical 403 from multiple networks/HTTP clients regardless of headers), so both live-detection and VOD archiving run through a real headless Chrome (`src/kickBrowser.js`, Puppeteer + a stealth plugin) that behaves like an actual browser: it loads Destiny's Kick pages, and where needed does a genuine trusted click (not a synthetic JS click - the player only initiates real playback for a trusted input event) to trigger the same requests a real viewer's browser would make.

- Every `KICK_POLL_INTERVAL_MS` (default 90s): checks live status and starts/stops the live relay.
- Every random interval between `KICK_VIDEOS_POLL_INTERVAL_MS` and `KICK_VIDEOS_POLL_MAX_INTERVAL_MS` (default 15-30 min, randomized so it isn't a perfectly predictable machine-like cadence): checks Destiny's videos list for any not-yet-archived VOD and adds it. Within a run, individual video pages are also fetched 1-3 minutes apart rather than back-to-back, and a video that just failed to archive isn't retried again for an hour - Kick's Cloudflare protection on individual video pages appears to score bursty/predictable automated traffic more harshly.
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
3. Live and archived playback are both served internally (`/live.mp3`, `/recordings/:id/play`) - you don't need a separate relay or tunnel.
4. For manual overrides, send requests to `/admin/stream/live`, `/admin/stream/stop`, and `/admin/stream/recording` with an `Authorization: Bearer <ADMIN_TOKEN>` header.

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
