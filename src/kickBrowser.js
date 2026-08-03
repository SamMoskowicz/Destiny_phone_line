const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const hlsFetch = require('./hlsFetch');

puppeteerExtra.use(StealthPlugin());

const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu'
];

let browserPromise = null;

// Kick's playback API doesn't include an explicit broadcast start timestamp
// anywhere in video_session, but the underlying AWS IVS storage path is
// date-partitioned (.../2026/8/1/19/40/<id>/media/...) and that same
// structure shows up in the thumbnail URL, which is already part of the
// response we fetch - no extra request needed. Confirmed against real
// responses: matches the segment paths in the actual HLS manifest too.
// The path components are UTC (standard S3/IVS date partitioning).
function extractBroadcastStartedAt(url) {
    if (!url) {
        return null;
    }
    const match = url.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/(\d{1,2})\/(\d{1,2})\//);
    if (!match) {
        return null;
    }
    const [, year, month, day, hour, minute] = match.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Plain server-side requests to Kick's API are reliably blocked by Cloudflare
// (confirmed from multiple networks, identical block regardless of headers).
// A real headless Chrome - with the stealth plugin and genuine trusted input
// events, not synthetic JS clicks - gets through because it presents an actual
// browser fingerprint. Kept as a single shared browser instance (pages are
// opened/closed per call) so repeated polls don't pay Chromium's launch cost.
async function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteerExtra.launch({ headless: true, args: LAUNCH_ARGS }).catch((error) => {
            browserPromise = null;
            throw error;
        });
    }
    return browserPromise;
}

// If the shared browser crashed or was closed, newPage() throws - drop the
// stale instance and retry once with a freshly launched one.
async function withPage(fn) {
    let browser = await getBrowser();
    let page;
    try {
        page = await browser.newPage();
    } catch (error) {
        browserPromise = null;
        browser = await getBrowser();
        page = await browser.newPage();
    }

    try {
        await page.setViewport({ width: 1366, height: 900 });
        return await fn(page);
    } finally {
        await page.close().catch(() => {});
    }
}

// Some kick.com routes (confirmed on individual video pages) serve a
// Cloudflare "Just a moment..." bot-verification interstitial instead of the
// real page. For a real browser this normally clears itself within a few
// seconds - a background JS check, then an automatic redirect - so it's
// worth waiting out rather than treating the interstitial as the real page.
async function waitOutCloudflareChallenge(page, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const title = await page.title().catch(() => '');
        if (!/just a moment/i.test(title)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

async function checkLiveStatus(slug) {
    return withPage(async (page) => {
        await page.goto(`https://kick.com/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitOutCloudflareChallenge(page);
        const result = await page.evaluate(async (channelSlug) => {
            const res = await fetch(`https://kick.com/api/v1/channels/${channelSlug}`, {
                headers: { Accept: 'application/json' }
            });
            return { status: res.status, text: await res.text() };
        }, slug);

        if (result.status !== 200) {
            throw new Error(`Kick channel API returned ${result.status}`);
        }

        const data = JSON.parse(result.text);
        const isLive = Boolean(data.livestream && data.livestream.is_live);
        return { isLive, hlsUrl: isLive ? data.playback_url || null : null };
    });
}

async function listRecentVideoIds(slug, limit = 5) {
    return withPage(async (page) => {
        await page.goto(`https://kick.com/${slug}/videos`, { waitUntil: 'networkidle2', timeout: 30000 });
        await waitOutCloudflareChallenge(page);
        const ids = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*="/videos/"]'));
            const seen = new Set();
            const out = [];
            for (const anchor of anchors) {
                const href = anchor.getAttribute('href') || '';
                const match = href.match(/\/videos\/([0-9a-f-]{36})/i);
                if (match && !seen.has(match[1])) {
                    seen.add(match[1]);
                    out.push(match[1]);
                }
            }
            return out;
        });
        return ids.slice(0, limit);
    });
}

// The VOD's real audio URL only shows up after the player actually initiates
// playback (a POST to web.kick.com/.../playback), and only when that click is a
// genuine trusted input event - a JS-level element.click() doesn't trigger it.
async function getVodPlaybackInfo(slug, videoId) {
    return withPage(async (page) => {
        let captured = null;
        page.on('response', async (response) => {
            const req = response.request();
            if (req.method() !== 'POST' || !response.url().includes('/playback')) {
                return;
            }
            try {
                const parsed = JSON.parse(await response.text());
                if (parsed.playback_url && parsed.playback_url.vod) {
                    captured = parsed;
                }
            } catch (error) {
                // not the response we're looking for, keep waiting
            }
        });

        await page.goto(`https://kick.com/${slug}/videos/${videoId}`, { waitUntil: 'networkidle2', timeout: 30000 });
        await waitOutCloudflareChallenge(page);
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const videoHandle = await page.$('video');
        let clicked = false;
        if (videoHandle) {
            const box = await videoHandle.boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                clicked = true;
            } else {
                await videoHandle.click();
                clicked = true;
            }
        }

        const deadline = Date.now() + 20000;
        while (!captured && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        if (!captured) {
            // Grab enough of the page state to tell WHY the click didn't lead
            // to a playback response - a UI/consent overlay, a bot-detection
            // block page, or a page structure change - instead of guessing
            // blind on the next failure.
            const debugInfo = await page.evaluate(() => ({
                title: document.title,
                url: window.location.href,
                hasVideoTag: Boolean(document.querySelector('video')),
                bodyTextSnippet: document.body ? document.body.innerText.slice(0, 400) : null
            })).catch((error) => ({ evaluateError: error.message }));
            throw new Error(
                `Timed out waiting for playback info on video ${videoId} `
                + `(videoElementFoundOnLoad=${Boolean(videoHandle)}, clicked=${clicked}) `
                + `debug=${JSON.stringify(debugInfo)}`
            );
        }

        // The VOD manifest (web.kick.com) has to be fetched from inside this
        // already-trusted page - a plain Node HTTPS request to that host
        // gets a 403 regardless of headers or cookies (confirmed directly),
        // while the CloudFront-hosted variant playlist and segments it
        // points to fetch fine with plain HTTP once resolved. So the
        // manifest fetch and parse happens here, but the actual segment
        // downloads happen later via hlsFetch (plain Node), not through
        // Puppeteer - no need to burden the browser with hundreds of them.
        const manifestResult = await page.evaluate(async (url) => {
            const res = await fetch(url);
            return { status: res.status, text: await res.text() };
        }, captured.playback_url.vod);

        if (manifestResult.status !== 200) {
            throw new Error(`Fetching VOD manifest returned ${manifestResult.status}`);
        }

        const segments = await hlsFetch.resolveSegmentsFromText(manifestResult.text, captured.playback_url.vod);

        const session = captured.video_session || {};
        return {
            audioUrl: captured.playback_url.vod,
            segments,
            title: session.video_title || null,
            durationSeconds: session.video_duration || null,
            category: session.video_content_type || null,
            broadcastStartedAt: extractBroadcastStartedAt(captured.playback_url.thumbnail)
        };
    });
}

async function shutdown() {
    if (!browserPromise) {
        return;
    }
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    if (browser) {
        await browser.close().catch(() => {});
    }
}

module.exports = { checkLiveStatus, listRecentVideoIds, getVodPlaybackInfo, shutdown };
