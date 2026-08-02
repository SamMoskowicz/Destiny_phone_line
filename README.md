# Destiny Stream Phone Line

A simple voice-service backend for one streamer: Destiny.

## What it does
- answers incoming calls with a Destiny-themed phone menu
- supports live stream, archived recordings, and resume-from-last-position
- stores caller progress per phone number
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
3. Render will use the included render.yaml file.
4. After deployment, copy the public Render URL.
5. In your phone provider, configure the webhook URLs to:
   - `${RENDER_URL}/voice`
   - `${RENDER_URL}/voice/menu`
   - `${RENDER_URL}/voice/playback`

## Twilio setup
If you use Twilio:
1. Buy or configure a phone number.
2. In the Twilio Voice configuration, set the webhook URL for incoming calls to `${RENDER_URL}/voice`.
3. If your provider expects separate menu and playback endpoints, use the matching paths above.
4. For admin stream updates, send requests to `/admin/stream/live`, `/admin/stream/stop`, and `/admin/stream/recording` with an `Authorization: Bearer <ADMIN_TOKEN>` header.

## Environment variables
- STREAMER_NAME: defaults to Destiny if omitted
- PORT: defaults to 3000 if omitted
- ADMIN_TOKEN: optional; protects the admin endpoints when set
