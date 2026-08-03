const https = require('https');
const http = require('http');

// Plain HTTP fetches of Kick's CDN have never had trouble with Cloudflare's
// bot-challenge (that's specific to the browser-navigated kick.com video
// pages Puppeteer visits) - but Kick's own API domain (web.kick.com) does
// reject requests missing the headers a real player would send (Referer/
// Origin/User-Agent), confirmed via a 403 on a bare request that ffmpeg's
// own fetch of the identical URL did not hit.
const FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://kick.com/',
    Origin: 'https://kick.com'
};

function fetchText(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        client.get(url, { headers: FETCH_HEADERS }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function fetchSegmentBuffer(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        client.get(url, { headers: FETCH_HEADERS }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} fetching segment ${url}`));
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// Minimal M3U8 parser - only what's needed here: either a master playlist
// (#EXT-X-STREAM-INF variants) or a media playlist (#EXTINF segments).
// Relative URIs are resolved against whichever playlist they came from.
function parsePlaylist(text, baseUrl) {
    const lines = text.split('\n').map((line) => line.trim());
    const variants = [];
    const segments = [];
    let pendingBandwidth = null;
    let pendingDuration = null;

    for (const line of lines) {
        if (!line) {
            continue;
        }
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const match = line.match(/BANDWIDTH=(\d+)/);
            pendingBandwidth = match ? Number(match[1]) : 0;
            continue;
        }
        if (line.startsWith('#EXTINF:')) {
            const match = line.match(/#EXTINF:([\d.]+)/);
            pendingDuration = match ? Number(match[1]) : 0;
            continue;
        }
        if (line.startsWith('#')) {
            continue;
        }

        const resolved = new URL(line, baseUrl).toString();
        if (pendingBandwidth !== null) {
            variants.push({ url: resolved, bandwidth: pendingBandwidth });
            pendingBandwidth = null;
        } else {
            segments.push({ url: resolved, duration: pendingDuration || 0 });
            pendingDuration = null;
        }
    }

    return variants.length > 0 ? { type: 'master', variants } : { type: 'media', segments };
}

// Resolves already-fetched master/media playlist text down to a flat,
// ordered list of segments, following one level of master -> variant
// redirection if present. Picks the lowest-bandwidth variant since only the
// audio track is needed - the video bitrate difference between variants is
// otherwise wasted download. Split from resolveSegments() because the
// top-level Kick VOD manifest (web.kick.com) has to be fetched from inside
// an already-trusted Puppeteer page (see kickBrowser.js) - a plain Node
// HTTPS request to that specific host gets a 403 regardless of headers or
// cookies, unlike the CloudFront-hosted variant playlists and segments,
// which fetch fine with plain HTTP and don't need the browser at all.
async function resolveSegmentsFromText(text, baseUrl) {
    const parsed = parsePlaylist(text, baseUrl);
    if (parsed.type === 'media') {
        return parsed.segments;
    }

    const sorted = parsed.variants.slice().sort((a, b) => a.bandwidth - b.bandwidth);
    const variant = sorted[0];
    if (!variant) {
        throw new Error('Master playlist had no variants');
    }

    const variantText = await fetchText(variant.url);
    const variantParsed = parsePlaylist(variantText, variant.url);
    if (variantParsed.type !== 'media') {
        throw new Error('Variant playlist was not a media playlist');
    }
    return variantParsed.segments;
}

// Convenience wrapper for playlist URLs that don't need browser-context
// fetching (e.g. testing directly against a CloudFront URL).
async function resolveSegments(inputUrl) {
    const text = await fetchText(inputUrl);
    return resolveSegmentsFromText(text, inputUrl);
}

module.exports = { resolveSegments, resolveSegmentsFromText, fetchSegmentBuffer, parsePlaylist, fetchText };
