"use strict";
/* Background side of the chat tools. Loaded after background.js (uses load, serial, notify, playHere).
 *
 * - One read-only, anonymous connection to Twitch chat (IRC over WebSocket, like any logged-out viewer),
 *   joined to the channels open in Twitch tabs. It's how the add-on learns about deleted messages, bans,
 *   timeouts, chat clears, first-time chatters and shared chat. Events are batched to the tabs showing that channel.
 * - Channel ids for the emote providers (7TV, BTTV, FFZ live in bg-emotes.js).
 * - Moderation log, emote usage, favorites and auto-claim counters (storage.local only).
 */

const L = TCWChatLib;
const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const CH_RE = /^[a-z0-9_]{1,25}$/;

// ---------- subscriptions (which tab/frame shows which channel) ----------

const chatSubs = new Map(); // "tabId:frameId" -> { tabId, frameId, channel, t }
const outbox = new Map(); // "tabId:frameId" -> [events]
let flushTimer = 0;

function wantedChannels() {
  const now = Date.now();
  const out = new Set();
  for (const [k, s] of chatSubs) {
    if (now - s.t > 90000) chatSubs.delete(k);
    else out.add(s.channel);
  }
  return out;
}

const emoteOnly = new Map(); // channel -> true/false, from the chat room's state

function deliver(channel, ev) {
  for (const [k, s] of chatSubs) {
    if (s.channel !== channel) continue;
    let box = outbox.get(k);
    if (!box) outbox.set(k, (box = []));
    box.push(ev);
    if (box.length > 400) box.splice(0, box.length - 400);
  }
  if (!flushTimer) flushTimer = setTimeout(flushOutbox, 250);
}

function flushOutbox() {
  flushTimer = 0;
  for (const [k, events] of outbox) {
    const s = chatSubs.get(k);
    if (s && events.length) {
      browser.tabs.sendMessage(s.tabId, { type: "irc:batch", events }, { frameId: s.frameId }).catch(() => chatSubs.delete(k));
    }
  }
  outbox.clear();
}

function unsubscribeTab(tabId) {
  for (const k of [...chatSubs.keys()]) if (k.startsWith(tabId + ":")) chatSubs.delete(k);
  irc.sync();
}

browser.tabs.onRemoved.addListener(unsubscribeTab);

// ---------- IRC ----------

const irc = {
  ws: null,
  ready: false,
  joined: new Set(),
  retry: 0,
  timer: 0,
  lastData: 0,
  enabled: true,
  emotes7tv: true,

  async sync() {
    const { settings } = await load();
    this.enabled = !!settings.ircOn;
    this.emotes7tv = !!(settings.emotes7tv || settings.emotesBttv || settings.emotesFfz);
    const want = this.enabled ? wantedChannels() : new Set();
    if (!want.size) {
      if (this.ws) this.close();
      return;
    }
    if (!this.ws) return this.connect();
    if (!this.ready) return;
    for (const ch of want) if (!this.joined.has(ch)) this.send("JOIN #" + ch);
    for (const ch of this.joined) if (!want.has(ch)) this.send("PART #" + ch);
  },

  connect() {
    clearTimeout(this.timer);
    let ws;
    try { ws = new WebSocket(IRC_URL); } catch (e) { return this.later(); }
    this.ws = ws;
    this.ready = false;
    this.joined = new Set();
    ws.onopen = () => {
      this.lastData = Date.now();
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS SCHMOOPIIE");
      ws.send("NICK justinfan" + (10000 + Math.floor(Math.random() * 80000)));
    };
    ws.onmessage = (e) => {
      this.lastData = Date.now();
      for (const line of String(e.data).split("\r\n")) if (line) this.onLine(line);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.joined.clear();
      this.later();
    };
    ws.onerror = () => { try { ws.close(); } catch (err) { /* already closed */ } };
  },

  later() {
    clearTimeout(this.timer);
    const delay = Math.min(60000, 1000 * 2 ** Math.min(this.retry++, 6));
    this.timer = setTimeout(() => { if (!this.ws) this.sync(); }, delay);
  },

  close() {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.joined.clear();
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
  },

  send(s) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(s);
  },

  onLine(line) {
    const m = L.parseIrc(line);
    if (!m) return;
    switch (m.command) {
      case "PING": return this.send("PONG :" + (m.params[0] || "tmi.twitch.tv"));
      case "001":
        this.ready = true;
        this.retry = 0;
        this.sync();
        return;
      case "JOIN":
        if (m.nick.startsWith("justinfan")) this.joined.add(String(m.params[0]).slice(1));
        return;
      case "PART":
        if (m.nick.startsWith("justinfan")) this.joined.delete(String(m.params[0]).slice(1));
        return;
      case "RECONNECT":
        try { this.ws.close(); } catch (e) { /* ignore */ }
        return;
    }
    const ev = L.ircEvent(m);
    if (!ev || !ev.ch) return;
    if (ev.k === "room") {
      roomIds.set(ev.ch, ev.room);
      if ("emoteOnly" in ev) emoteOnly.set(ev.ch, ev.emoteOnly);
      if (this.emotes7tv) ensureEmotes(ev.ch);
    }
    if (ev.k === "ban" || ev.k === "del" || ev.k === "clear") logModEvent(ev);
    deliver(ev.ch, ev);
  }
};

// a silent connection gets replaced (Twitch pings every ~5 minutes)
setInterval(() => {
  if (irc.ws && irc.ready && Date.now() - irc.lastData > 7 * 60000) {
    try { irc.ws.close(); } catch (e) { /* ignore */ }
  }
  irc.sync();
}, 60000);

// ---------- moderation log ----------

let modPending = [];
let modTimer = 0;

function logModEvent(ev) {
  const entry = { ch: ev.ch, k: ev.k, time: ev.time || Date.now() };
  if (ev.login) entry.login = ev.login;
  if (ev.k === "ban") { entry.duration = ev.duration; entry.permanent = ev.permanent; }
  if (ev.k === "del") entry.text = String(ev.text || "").slice(0, 300);
  modPending.push(entry);
  if (!modTimer) modTimer = setTimeout(flushModLog, 3000);
}

function flushModLog() {
  modTimer = 0;
  const batch = modPending;
  modPending = [];
  if (!batch.length) return;
  serial(async () => {
    const { settings } = await load();
    if (!settings.modLogOn) return;
    const d = await browser.storage.local.get("modLog");
    const log = Array.isArray(d.modLog) ? d.modLog : [];
    log.unshift(...batch.reverse());
    if (log.length > 500) log.length = 500;
    await browser.storage.local.set({ modLog: log });
  });
}

// ---------- channel ids (used by the emote providers in bg-emotes.js) ----------

const roomIds = new Map(); // channel -> Twitch user id

async function getJson(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: ctl.signal, ...opts });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(url + " " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Twitch's public web client id, the same one twitch.tv itself uses for logged-out requests.
const TWITCH_WEB_CLIENT = "kimne78kx3ncx6brgo4mv6wki5h1ko";

async function roomIdFor(channel) {
  if (roomIds.has(channel)) return roomIds.get(channel);
  const d = await getJson("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-Id": TWITCH_WEB_CLIENT, "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ query: `query { user(login: "${channel}") { id } }` })
  });
  const id = d && d.data && d.data.user && d.data.user.id;
  if (id && /^\d{1,20}$/.test(id)) roomIds.set(channel, id);
  return roomIds.get(channel) || "";
}

// ---------- emote usage, recent and favorites ----------

function cleanEmote(e) {
  if (!e || typeof e !== "object") return null;
  const name = String(e.name || "").slice(0, 100);
  const src = String(e.src || "");
  if (!name || /\s/.test(name)) return null;
  if (src && !/^https:\/\/(static-cdn\.jtvnw\.net|cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com)\//i.test(src)) return null;
  return { name, src, p: ["7tv", "bttv", "ffz"].includes(e.p) ? e.p : "twitch" };
}

async function emotesUsed(list, channel) {
  const used = (Array.isArray(list) ? list : []).slice(0, 50).map(cleanEmote).filter(Boolean);
  if (!used.length) return;
  const d = await browser.storage.local.get(["emoteStats", "emoteRecent", "emoteLearn"]);
  const stats = d.emoteStats && typeof d.emoteStats === "object" ? d.emoteStats : {};
  let recent = Array.isArray(d.emoteRecent) ? d.emoteRecent : [];
  const now = Date.now();
  for (const e of used) {
    const s = stats[e.name] || (stats[e.name] = { n: 0, last: 0, src: e.src, p: e.p });
    s.n++;
    s.last = now;
    if (e.src) s.src = e.src;
    s.p = e.p;
    recent = [e, ...recent.filter((r) => r.name !== e.name)];
  }
  const names = Object.keys(stats);
  if (names.length > 600) {
    names.sort((a, b) => stats[a].n - stats[b].n || stats[a].last - stats[b].last);
    for (const n of names.slice(0, names.length - 500)) delete stats[n];
  }
  const learn = CH_RE.test(String(channel || "")) ? L.learnRecord(d.emoteLearn, { channel, used: used.map((e) => e.name) }, now) : d.emoteLearn;
  await browser.storage.local.set({ emoteStats: stats, emoteRecent: recent.slice(0, 36), emoteLearn: learn || {} });
}

// You picked `name` from the suggestions after typing `typed`: next time it comes first for that.
async function emotePicked(typed, name) {
  typed = String(typed || "").slice(0, 16);
  name = String(name || "").slice(0, 100);
  if (!typed || !name || /\s/.test(name)) return;
  const d = await browser.storage.local.get("emoteLearn");
  await browser.storage.local.set({ emoteLearn: L.learnRecord(d.emoteLearn, { pick: { typed, name } }) });
}

async function toggleFavorite(e, on) {
  const x = cleanEmote(e);
  if (!x) return false;
  const d = await browser.storage.local.get("emoteFavs");
  let favs = (Array.isArray(d.emoteFavs) ? d.emoteFavs : []).filter((f) => f && f.name !== x.name);
  const want = on == null ? !(Array.isArray(d.emoteFavs) && d.emoteFavs.some((f) => f && f.name === x.name)) : !!on;
  if (want) favs = [...favs, x].slice(-150);
  await browser.storage.local.set({ emoteFavs: favs });
  return want;
}

// ---------- auto-claim ----------

async function countClaim(kind, channel) {
  if (!["points", "drops", "moments"].includes(kind)) return;
  const d = await browser.storage.local.get("claimStats");
  const s = d.claimStats && typeof d.claimStats === "object" ? d.claimStats : {};
  s[kind] = (Number(s[kind]) || 0) + 1;
  s.last = { kind, channel: CH_RE.test(String(channel || "")) ? channel : "", time: Date.now() };
  await browser.storage.local.set({ claimStats: s });
}

// Optional: every 30 minutes, open the Drops inventory in a quiet background tab so it can claim, then close it.
const dropTabs = new Set();
let lastDropCheck = 0;

async function dropsCheck() {
  const { settings } = await load();
  if (!settings.autoDrops || !settings.autoDropsBg || dropTabs.size) return;
  if (Date.now() - lastDropCheck < 30 * 60000) return;
  const twitchTabs = await browser.tabs.query({ url: "*://*.twitch.tv/*" });
  if (!twitchTabs.length) return; // only while you're using Twitch anyway
  lastDropCheck = Date.now();
  const tab = await browser.tabs.create({ url: "https://www.twitch.tv/drops/inventory?tcw-autoclaim=1", active: false });
  dropTabs.add(tab.id);
  browser.tabs.update(tab.id, { muted: true }).catch(() => {});
  setTimeout(() => closeDropTab(tab.id), 90000);
}

function closeDropTab(id) {
  if (!dropTabs.delete(id)) return;
  browser.tabs.remove(id).catch(() => {});
}

setInterval(() => dropsCheck().catch(() => {}), 5 * 60000);
setTimeout(() => dropsCheck().catch(() => {}), 2 * 60000);
browser.tabs.onRemoved.addListener((id) => dropTabs.delete(id));

// ---------- keyword highlight alerts ----------

let lastKeywordSound = 0;

async function onKeyword(msg, sender) {
  const { settings, log } = await load();
  if (!settings.enabled) return {};
  const login = TCW.normalize(msg.login);
  if (!CH_RE.test(login)) return {};
  const now = Date.now();
  const text = String(msg.text || "").slice(0, 300);
  const channel = String(msg.channel || "");
  const display = String(msg.display || login).slice(0, 40);
  const term = String(msg.term || "").slice(0, 60);
  const target = {
    tabId: sender.tab ? sender.tab.id : null,
    frameId: sender.frameId || 0,
    msgId: msg.msgId ? String(msg.msgId) : null,
    channel
  };
  log.unshift({ kind: "keyword", term, login, display, channel, text, time: now, color: settings.hlColor, ...target });
  if (log.length > logCap(settings)) log.length = logCap(settings);
  await browser.storage.local.set({ log });

  const result = {};
  if (now - lastKeywordSound >= 1500) {
    lastKeywordSound = now;
    if (settings.sound && settings.hlSound !== "none") {
      const ok = await playHere(settings.hlSound, settings.volume);
      if (!ok) result.localSound = { type: settings.hlSound, volume: settings.volume };
    }
    if (settings.hlNotify) notify(`${display}${channel ? " in #" + channel : ""} · “${term}”`, text || " ", target);
  }
  return result;
}

// ---------- start in Twitch tabs that were already open ----------
// After installing, updating or re-enabling, open Twitch tabs get the add-on right away instead of needing a reload.

async function injectInto(tab) {
  try {
    if (await browser.tabs.sendMessage(tab.id, { type: "tcw:ping" }, { frameId: 0 })) return false;
  } catch (e) { /* not running there yet */ }
  const cs = (browser.runtime.getManifest().content_scripts || [])[0];
  if (!cs) return false;
  try {
    for (const file of cs.css || []) await browser.tabs.insertCSS(tab.id, { file, allFrames: true });
    for (const file of cs.js || []) await browser.tabs.executeScript(tab.id, { file, allFrames: true, runAt: "document_idle" });
    return true;
  } catch (e) {
    return false; // unloaded (discarded) tab: it gets the add-on normally when it loads
  }
}

async function injectAll() {
  let tabs = [];
  try { tabs = await browser.tabs.query({ url: "*://*.twitch.tv/*" }); } catch (e) { return 0; }
  let n = 0;
  for (const tab of tabs) if (!tab.discarded && (await injectInto(tab))) n++;
  return n;
}

setTimeout(() => injectAll().catch(() => {}), 500);

// ---------- messaging ----------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "irc:sub": {
      if (!sender.tab) return;
      const key = `${sender.tab.id}:${sender.frameId || 0}`;
      const channel = String(msg.channel || "").toLowerCase();
      if (!CH_RE.test(channel)) chatSubs.delete(key);
      else chatSubs.set(key, { tabId: sender.tab.id, frameId: sender.frameId || 0, channel, t: Date.now() });
      irc.sync();
      return Promise.resolve({ connected: !!irc.ready, emoteOnly: emoteOnly.get(channel) });
    }
    case "irc:unsub":
      if (sender.tab) chatSubs.delete(`${sender.tab.id}:${sender.frameId || 0}`);
      irc.sync();
      return;
    case "irc:state":
      return Promise.resolve({ connected: !!irc.ready, channels: [...irc.joined] });
    case "emotes:used":
      return serial(() => emotesUsed(msg.emotes, msg.channel));
    case "emotes:pick":
      return serial(() => emotePicked(msg.typed, msg.name));
    case "emotes:fav":
      return serial(() => toggleFavorite(msg.emote, msg.on));
    case "emotes:resetStats":
      return serial(() => browser.storage.local.set({ emoteStats: {}, emoteRecent: [], emoteLearn: {} }));
    case "keyword":
      return serial(() => onKeyword(msg, sender));
    case "modlog:clear":
      return serial(() => browser.storage.local.set({ modLog: [] }));
    case "claim":
      return serial(() => countClaim(msg.kind, msg.channel));
    case "drops:done":
      if (sender.tab) closeDropTab(sender.tab.id);
      return;
    case "injectAll":
      return injectAll();
    case "openPage":
      return browser.tabs.create({ url: browser.runtime.getURL("ui.html#" + (msg.page === "modlog" ? "modlog" : "activity")) }).then(() => true);
    case "drops:checkNow":
      lastDropCheck = 0;
      return dropsCheck().then(() => true).catch((e) => ({ error: String(e) }));
  }
});

browser.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.settings) irc.sync();
});

// Right-click an emote in chat -> add it to (or remove it from) your favorites
browser.menus.create(
  {
    id: "tcw-fav-emote",
    title: "Favorite emote (Chat Watcher)",
    contexts: ["image"],
    documentUrlPatterns: ["*://*.twitch.tv/*"]
  },
  () => void browser.runtime.lastError
);

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "tcw-fav-emote" || !tab) return;
  const opts = { frameId: info.frameId || 0 };
  let emote = null;
  try { emote = await browser.tabs.sendMessage(tab.id, { type: "getContextEmote" }, opts); } catch (e) { /* page not ready */ }
  let text = "Right-click an emote in chat to favorite it.";
  if (emote) {
    const on = await serial(() => toggleFavorite(emote));
    text = on ? `★ ${emote.name} added to favorites` : `${emote.name} removed from favorites`;
  }
  browser.tabs.sendMessage(tab.id, { type: "toast", text }, opts).catch(() => {});
});
