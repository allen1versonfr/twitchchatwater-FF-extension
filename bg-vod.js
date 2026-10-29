"use strict";
/* VOD unmute: when Twitch has muted parts of a VOD (DMCA), its playlist points at silenced "123-muted.ts" segments.
 * The original "123.ts" often still exists on Twitch's CDN for a while (roughly 6–48 hours), so the playlist is
 * rewritten on its way to the player to use the originals. If an original is already gone (403/404), that request
 * is redirected back to the muted file, so playback never breaks. Nothing is sent anywhere.
 * Loaded after bg-chat.js (uses TCW and L). */

const VOD_HOSTS = ["cloudfront.net", "twitch.tv", "ttvnw.net", "akamaized.net", "twitchcdn.net", "jtvnw.net", "live-video.net"];
const VOD_PLAYLIST_URLS = VOD_HOSTS.map((h) => `*://*.${h}/*.m3u8*`);
const VOD_SEGMENT_URLS = VOD_HOSTS.flatMap((h) => [`*://*.${h}/*.ts*`, `*://*.${h}/*.mp4*`]);

let vodSettings = { vodUnmute: TCW.DEFAULT_SETTINGS.vodUnmute, debug: false };
const vodFallback = new Map(); // original segment url (no query) -> the muted url it replaced
const vodFiltered = new Set();  // request ids whose body we rewrite

function readVodSettings(s) {
  const all = { ...TCW.DEFAULT_SETTINGS, ...(s || {}) };
  vodSettings = { vodUnmute: all.vodUnmute !== false, debug: !!all.debug };
}
browser.storage.local.get("settings").then((d) => readVodSettings(d.settings)).catch(() => {});
browser.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.settings) readVodSettings(ch.settings.newValue);
});

function vodLog(...a) {
  if (vodSettings.debug) console.log("[Chat Watcher] VOD unmute:", ...a);
}

const noQuery = (u) => u.split(/[?#]/)[0];

// Live streams' playlists change every few seconds and are never muted; leave them alone.
function isLivePlaylist(url) {
  try {
    const u = new URL(url);
    return /^(?:usher|video-weaver|video-edge)\b/i.test(u.hostname) || /(?:^|\.)playlist\./i.test(u.hostname) ||
      u.pathname.startsWith("/api/channel/");
  } catch (e) {
    return true;
  }
}

browser.webRequest.onBeforeRequest.addListener((d) => {
  if (!vodSettings.vodUnmute || d.method !== "GET" || isLivePlaylist(d.url)) return;
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(d.requestId);
  } catch (e) {
    vodLog("can't read", d.url, e);
    return;
  }
  vodFiltered.add(d.requestId);
  const chunks = [];
  filter.ondata = (e) => chunks.push(new Uint8Array(e.data));
  filter.onerror = () => { vodFiltered.delete(d.requestId); };
  filter.onstop = () => {
    vodFiltered.delete(d.requestId);
    let out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    try {
      const text = new TextDecoder("utf-8").decode(out);
      if (text.includes("-muted.")) {
        const r = L.unmutePlaylist(text);
        if (r.swaps.length) {
          for (const [orig, muted] of r.swaps) {
            vodFallback.set(noQuery(new URL(orig, d.url).href), new URL(muted, d.url).href);
          }
          while (vodFallback.size > 20000) vodFallback.delete(vodFallback.keys().next().value);
          out = new TextEncoder().encode(r.text);
          vodLog(`restored ${r.swaps.length} muted segments in`, d.url);
        }
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

// The rewritten playlist can be shorter than Twitch said, so drop the length header for the ones we read.
browser.webRequest.onHeadersReceived.addListener((d) => {
  if (!vodFiltered.has(d.requestId)) return;
  return { responseHeaders: d.responseHeaders.filter((h) => h.name.toLowerCase() !== "content-length") };
}, { urls: VOD_PLAYLIST_URLS }, ["blocking", "responseHeaders"]);

// Safety net: an original that's already gone falls back to the muted file.
browser.webRequest.onHeadersReceived.addListener((d) => {
  if (d.statusCode !== 403 && d.statusCode !== 404) return;
  const muted = vodFallback.get(noQuery(d.url));
  if (!muted) return;
  vodLog("original gone, playing muted", d.url);
  return { redirectUrl: muted };
}, { urls: VOD_SEGMENT_URLS }, ["blocking"]);
