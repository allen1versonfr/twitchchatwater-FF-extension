"use strict";
/* VOD unmute: when Twitch has muted parts of a VOD (DMCA), its playlist points at silenced "123-muted.ts" segments.
 * The original "123.ts" often still exists on Twitch's CDN for a while (mostly within the first day), so the
 * playlist is rewritten on its way to the player to use it instead. Only segments that actually answer are swapped
 * in: the first segment of each muted stretch is checked, and if a swapped segment still fails to load, the request
 * is sent back to the muted one, so playback never breaks. Nothing leaves your computer except those checks to Twitch.
 * Loaded after bg-chat.js (uses TCW and L). */

const VOD_PLAYLIST_URLS = [
  "*://*.cloudfront.net/*.m3u8*",
  "*://*.twitch.tv/*.m3u8*",
  "*://*.ttvnw.net/*.m3u8*",
  "*://*.akamaized.net/*.m3u8*"
];
const VOD_SEGMENT_URLS = VOD_PLAYLIST_URLS.map((u) => u.replace("*.m3u8*", "*"));
const VOD_PROBE_TTL = 10 * 60 * 1000;
const VOD_MAX_RUNS = 60;     // muted stretches checked per playlist
const VOD_PROBES_AT_ONCE = 6;

let vodUnmuteOn = TCW.DEFAULT_SETTINGS.vodUnmute;
const vodProbes = new Map();   // segment url -> { ok: Promise<boolean>, t }
const vodFallback = new Map(); // swapped segment url -> the muted url it replaced

browser.storage.local.get("settings").then((d) => {
  vodUnmuteOn = { ...TCW.DEFAULT_SETTINGS, ...(d.settings || {}) }.vodUnmute !== false;
}).catch(() => {});
browser.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.settings) vodUnmuteOn = ({ ...TCW.DEFAULT_SETTINGS, ...(ch.settings.newValue || {}) }).vodUnmute !== false;
});

function fromTwitch(d) {
  const o = d.originUrl || d.documentUrl || "";
  return /^(?:blob:)?https?:\/\/(?:[^/]+\.)?twitch\.tv(?:[:/]|$)/i.test(o);
}

// Live streams' playlists (usher, video-weaver/edge) never have muted segments; skip them so live playback isn't touched.
function isVodPlaylist(url) {
  try {
    const u = new URL(url);
    if (!/\.m3u8$/i.test(u.pathname)) return false;
    return !/^(?:usher|video-weaver|video-edge)/i.test(u.hostname) && !u.pathname.startsWith("/api/");
  } catch (e) {
    return false;
  }
}

function probe(url) {
  const hit = vodProbes.get(url);
  if (hit && Date.now() - hit.t < VOD_PROBE_TTL) return hit.ok;
  const ok = fetch(url, { method: "HEAD", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false);
  vodProbes.set(url, { ok, t: Date.now() });
  if (vodProbes.size > 2000) vodProbes.delete(vodProbes.keys().next().value);
  return ok;
}

// The rewritten playlist, or null when there's nothing to change.
async function unmutePlaylist(text, base) {
  const segs = L.mutedSegments(text);
  if (!segs.length) return null;
  const runs = L.mutedRuns(segs).slice(0, VOD_MAX_RUNS);
  const swaps = new Map();
  let next = 0;
  async function worker() {
    while (next < runs.length) {
      const run = runs[next++];
      const cands = L.unmuteCandidates(run[0]);
      let pick = -1;
      for (let k = 0; k < cands.length && pick < 0; k++) {
        if (await probe(new URL(cands[k], base).href)) pick = k;
      }
      if (pick < 0) continue;
      for (const seg of run) {
        const uri = L.unmuteCandidates(seg)[pick];
        swaps.set(seg.line, uri);
        vodFallback.set(new URL(uri, base).href, new URL(seg.uri, base).href);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(VOD_PROBES_AT_ONCE, runs.length) }, worker));
  while (vodFallback.size > 5000) vodFallback.delete(vodFallback.keys().next().value);
  if (!swaps.size) return null;
  return L.rewritePlaylist(text, swaps);
}

browser.webRequest.onBeforeRequest.addListener((d) => {
  if (!vodUnmuteOn || d.tabId < 0 || !fromTwitch(d) || !isVodPlaylist(d.url)) return;
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(d.requestId);
  } catch (e) {
    return;
  }
  const chunks = [];
  filter.ondata = (e) => chunks.push(new Uint8Array(e.data));
  filter.onerror = () => {};
  filter.onstop = async () => {
    const len = chunks.reduce((n, c) => n + c.length, 0);
    let out = new Uint8Array(len);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    try {
      const text = new TextDecoder("utf-8").decode(out);
      if (text.startsWith("#EXTM3U") && /-(?:un)?muted\./.test(text)) {
        const fixed = await unmutePlaylist(text, d.url);
        if (fixed) out = new TextEncoder().encode(fixed);
      }
    } catch (e) {
      console.warn("[Chat Watcher] VOD unmute failed, playing muted", e);
    }
    try {
      filter.write(out);
      filter.close();
    } catch (e) {}
  };
}, { urls: VOD_PLAYLIST_URLS }, ["blocking"]);

// Safety net: a swapped segment that's gone (Twitch deletes the originals eventually) falls back to the muted one.
browser.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode < 400) return;
  const muted = vodFallback.get(d.url);
  if (!muted) return;
  return { redirectUrl: muted };
}, { urls: VOD_SEGMENT_URLS }, ["blocking"]);
