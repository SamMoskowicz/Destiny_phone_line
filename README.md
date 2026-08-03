# Destiny Stream Phone Line

A simple voice-service backend for one streamer: Destiny.

## What it does
- answers incoming calls with a brief phone menu
- press 1 to hear the live stream (or a short "not live" message)
- press 2 through 6 to hear the last five archived streams
- press 7 to hear the in-playback controls (pause/resume/skip/rewind/menu/live)
- auto-detects when Destiny's Kick channel goes live and relays it to callers over `/live.mp3`
- keeps only the five most recent recordings

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
1. Create a GitHub repository containing this folder.
2. Import the repo into Render.
3. Render will use the included `render.yaml` file, which sets `STREAMER_NAME` and `KICK_CHANNEL` for you.
4. In the Render dashboard, set `ADMIN_TOKEN` to a secret value (render.yaml declares it but leaves the value for you to fill in).
5. After deployment, copy the public Render URL. `RENDER_EXTERNAL_URL` is set automatically by Render, so the app already knows its own public URL for building the `/live.mp3` link.
6. In your phone provider, configure the webhook URL for incoming calls to:
   - `${RENDER_URL}/voice`

With `KICK_CHANNEL` set, the app polls Kick every 60 seconds (`KICK_POLL_INTERVAL_MS`) and automatically starts/stops relaying the live stream - no manual step needed when Destiny goes live. Kick's live-status endpoint isn't part of their official developer API, so if Kick ever blocks or changes it, polling will just log a warning and you can fall back to the manual admin call below.

## Twilio setup
If you use Twilio:
1. Buy or configure a phone number.
2. In the Twilio Voice configuration, set the webhook URL for incoming calls to `${RENDER_URL}/voice`.
3. Live playback is served internally at `${RENDER_URL}/live.mp3` - you don't need a separate relay or tunnel.
4. For admin stream updates, send requests to `/admin/stream/live`, `/admin/stream/stop`, and `/admin/stream/recording` with an `Authorization: Bearer <ADMIN_TOKEN>` header.

### Admin API examples
Manually start the live relay (only needed if you're not using `KICK_CHANNEL` auto-detection, or want to override it). `audioUrl` here is the upstream HLS/m3u8 source to relay, not a direct playable link:
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

Add an archived recording (a direct playable mp3/wav URL):
```bash
curl -X POST "${RENDER_URL}/admin/stream/recording" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Destiny archive","audioUrl":"https://example.com/destiny-archive.mp3"}'
```

## Environment variables
- STREAMER_NAME: defaults to Destiny if omitted
- PORT: defaults to 3000 if omitted
- KICK_CHANNEL: Kick channel slug to auto-detect live status for (e.g. `destiny`); leave unset to manage live status manually
- KICK_POLL_INTERVAL_MS: how often to poll Kick, in milliseconds; defaults to 60000
- ADMIN_TOKEN: protects the admin endpoints; leave unset only for local testing, since the endpoints are open to anyone if it's not set
- PUBLIC_BASE_URL: base URL used to build the `/live.mp3` link; normally unnecessary on Render (`RENDER_EXTERNAL_URL` is set automatically) but useful for local dev or other hosts
- LIVE_HLS_URL: optional, manually pins the HLS source to relay at startup instead of using `KICK_CHANNEL` or the admin API
