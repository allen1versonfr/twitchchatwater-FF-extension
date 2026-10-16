"use strict";

const tabStatus = new Map();   // "tabId:frameId" -> latest status from a Twitch page
const lastAlert = new Map();   // login -> time of last sound/notification (cooldown)
const notifTargets = new Map(); // notification id -> { tabId, frameId, msgId, channel }
let unread = 0;
let audioCtx = null;

// All storage writes go through one queue so the UI, Firefox Sync and incoming chat hits never overwrite each other.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch((err) => console.error("[Chat Watcher]", err));
  return run;
}

async function load() {
  const d = await browser.storage.local.get(["settings", "users", "log"]);
  return {
    settings: { ...TCW.DEFAULT_SETTINGS, ...(d.settings || {}) },
    users: (Array.isArray(d.users) ? d.users : []).map((u, i) => TCW.fixUser(u, i)).filter(Boolean),
    log: Array.isArray(d.log) ? d.log : []
  };
}

async function migrate() {
  const d = await browser.storage.local.get(null);
  const settings = { ...TCW.DEFAULT_SETTINGS, ...(d.settings || {}) };
  if (!d.settings) {
    // v1 kept these at the top level
    if (typeof d.sound === "boolean") settings.sound = d.sound;
    if (typeof d.volume === "number") settings.volume = d.volume;
    if (typeof d.cooldown === "number") settings.cooldown = d.cooldown;
  }
  const seen = new Set();
  const users = [];
  (Array.isArray(d.users) ? d.users : []).forEach((u, i) => {
    const f = TCW.fixUser(u, i);
    if (f && !seen.has(f.login)) {
      seen.add(f.login);
      users.push(f);
    }
  });
  await browser.storage.local.set({ settings, users, log: Array.isArray(d.log) ? d.log : [] });
  const legacy = ["sound", "volume", "cooldown"].filter((k) => k in d);
  if (legacy.length) await browser.storage.local.remove(legacy);
}

// ---------- Firefox Sync ----------
// Each person is stored under their own "u:<login>" key (sync items are capped at 8 KB each),
// plus one "settings" key. Local storage stays the working copy; sync mirrors the shareable parts.

const syncArea = browser.storage.sync;
const SYNCABLE_SETTINGS = Object.keys(TCW.DEFAULT_SETTINGS).filter((k) => !TCW.LOCAL_ONLY_SETTINGS.includes(k));

function syncedUser(u) {
  const out = {};
  for (const k of TCW.SYNC_USER_FIELDS) out[k] = u[k];
  return out;
}

function syncedSettings(s) {
  const out = {};
  for (const k of SYNCABLE_SETTINGS) out[k] = s[k];
  return out;
}

function sameFields(a, b, keys) {
  if (!a || !b) return false;
  return keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

async function setSyncState(state) {
  await browser.storage.local.set({ syncState: { ...state, time: Date.now() } });
}

// Copy local -> sync, writing only what differs.
async function pushSync() {
  const { settings, users } = await load();
  if (!settings.syncEnabled) return;
  try {
    const remote = await syncArea.get(null);
    const toSet = {};
    const toRemove = [];
    const want = new Set();
    const s = syncedSettings(settings);
    if (!sameFields(remote.settings, s, SYNCABLE_SETTINGS)) toSet.settings = s;
    for (const u of users) {
      const key = "u:" + u.login;
      want.add(key);
      const rec = syncedUser(u);
      if (!sameFields(remote[key], rec, TCW.SYNC_USER_FIELDS)) toSet[key] = rec;
    }
    for (const k of Object.keys(remote)) if (k.startsWith("u:") && !want.has(k)) toRemove.push(k);
    if (toRemove.length) await syncArea.remove(toRemove);
    if (Object.keys(toSet).length) await syncArea.set(toSet);
    await setSyncState({ ok: true, people: users.length });
  } catch (e) {
    await setSyncState({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

// Copy sync -> local. union=true keeps local people that sync doesn't have (first sync on a computer).
async function pullSync(union) {
  const { settings, users } = await load();
  if (!settings.syncEnabled) return;
  let remote;
  try {
    remote = await syncArea.get(null);
  } catch (e) {
    await setSyncState({ ok: false, error: String(e && e.message ? e.message : e) });
    return;
  }

  let changed = false;
  const nextSettings = { ...settings };
  if (remote.settings && typeof remote.settings === "object") {
    for (const k of SYNCABLE_SETTINGS) {
      const v = remote.settings[k];
      if (typeof v === typeof TCW.DEFAULT_SETTINGS[k] && JSON.stringify(v) !== JSON.stringify(settings[k])) {
        nextSettings[k] = v;
        changed = true;
      }
    }
  }

  const remoteUsers = new Map();
  Object.keys(remote).filter((k) => k.startsWith("u:")).forEach((k, i) => {
    const f = TCW.fixUser({ ...remote[k], login: k.slice(2) }, i);
    if (f) remoteUsers.set(f.login, f);
  });

  const next = [];
  for (const u of users) {
    const r = remoteUsers.get(u.login);
    if (!r) {
      if (union) next.push(u);
      else changed = true; // removed on another computer
      continue;
    }
    const merged = { ...u, ...syncedUser(r) };
    if (!sameFields(u, merged, TCW.SYNC_USER_FIELDS)) changed = true;
    next.push(merged);
    remoteUsers.delete(u.login);
  }
  for (const r of [...remoteUsers.values()].sort((a, b) => a.added - b.added)) {
    next.push(r); // added on another computer
    changed = true;
  }

  if (changed) await browser.storage.local.set({ settings: nextSettings, users: next });
  await setSyncState({ ok: true, people: next.length });
}

async function startSync() {
  const { settings } = await load();
  if (!settings.syncEnabled) return;
  const { syncJoined } = await browser.storage.local.get("syncJoined");
  await pullSync(!syncJoined);
  await browser.storage.local.set({ syncJoined: true });
  await pushSync();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") serial(() => pullSync(false));
});

// ---------- watchlist edits ----------

async function addUsers(names) {
  const { users } = await load();
  const added = [];
  const existing = [];
  for (const raw of names || []) {
    const login = TCW.normalize(raw);
    if (!login) continue;
    if (users.some((u) => u.login === login)) {
      existing.push(String(raw).trim());
      continue;
    }
    const user = TCW.newUser(raw, users);
    users.push(user);
    added.push(user.name);
  }
  if (added.length) {
    await browser.storage.local.set({ users });
    await pushSync();
  }
  return { added, existing };
}

const EDITABLE = ["name", "color", "enabled", "sound", "notify", "note", "hits", "lastSeen"];

async function updateUser(login, patch) {
  const { users } = await load();
  const u = users.find((x) => x.login === login);
  if (!u) return false;
  for (const k of EDITABLE) if (patch && k in patch) u[k] = patch[k];
  users[users.indexOf(u)] = TCW.fixUser(u);
  await browser.storage.local.set({ users });
  if (patch && TCW.SYNC_USER_FIELDS.some((k) => k in patch)) await pushSync();
  return true;
}

async function removeUser(login) {
  const { users } = await load();
  await browser.storage.local.set({ users: users.filter((u) => u.login !== login) });
  lastAlert.delete(login);
  await pushSync();
}

async function setSettings(patch) {
  const { settings } = await load();
  const next = { ...settings };
  for (const k of Object.keys(TCW.DEFAULT_SETTINGS)) if (patch && k in patch) next[k] = patch[k];
  await browser.storage.local.set({ settings: next });
  if (!next.enabled) setBadge();
  if (patch && ("paintServer" in patch || "paintsOthers" in patch)) {
    paintCache.clear();
    paintBackoffUntil = 0;
    paintFails = 0;
  }
  if (patch && "syncEnabled" in patch) {
    if (next.syncEnabled && !settings.syncEnabled) {
      // turning sync back on: merge with what's in sync instead of overwriting it
      await browser.storage.local.set({ syncJoined: false });
      await startSync();
    } else if (!next.syncEnabled) {
      await setSyncState({ ok: true, off: true });
    }
  } else if (patch && SYNCABLE_SETTINGS.some((k) => k in patch)) {
    await pushSync();
  }
}

async function importData(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.users)) throw new Error("Not a Chat Watcher backup file.");
  const { log, settings: current } = await load();
  const seen = new Set();
  const users = [];
  data.users.forEach((u, i) => {
    const f = TCW.fixUser(u, i);
    if (f && !seen.has(f.login)) {
      seen.add(f.login);
      users.push(f);
    }
  });
  const settings = { ...TCW.DEFAULT_SETTINGS, syncEnabled: current.syncEnabled };
  if (data.settings && typeof data.settings === "object") {
    for (const k of SYNCABLE_SETTINGS.concat("debug")) {
      if (typeof data.settings[k] === typeof TCW.DEFAULT_SETTINGS[k]) settings[k] = data.settings[k];
    }
  }
  await browser.storage.local.set({ settings, users, log });
  await pushSync();
  return { users: users.length };
}

// ---------- alerts ----------

async function playHere(type, volume) {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state !== "running") {
      await Promise.race([audioCtx.resume(), new Promise((r) => setTimeout(r, 300))]);
    }
    if (audioCtx.state !== "running") return false;
    TCW.playSound(audioCtx, type, volume);
    return true;
  } catch (e) {
    return false;
  }
}

function notify(title, message, target) {
  const id = "tcw-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  if (target) notifTargets.set(id, target);
  browser.notifications
    .create(id, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/icon-96.png"),
      title,
      message: message || " "
    })
    .catch((e) => console.warn("[Chat Watcher] notification failed", e));
}

function setBadge() {
  browser.browserAction.setBadgeText({ text: unread > 0 ? String(Math.min(unread, 999)) : "" });
}

async function onHit(msg, sender) {
  const { settings, users, log } = await load();
  if (!settings.enabled) return {};
  const user = users.find((u) => u.login === msg.login);
  if (!user || !user.enabled) return {};

  const now = Date.now();
  const text = String(msg.text || "").slice(0, 300);
  const channel = String(msg.channel || "");
  const display = String(msg.display || user.name);
  const target = {
    tabId: sender.tab ? sender.tab.id : null,
    frameId: sender.frameId || 0,
    msgId: msg.msgId ? String(msg.msgId) : null,
    channel
  };

  user.hits = (user.hits || 0) + 1;
  user.lastSeen = { time: now, channel, text };
  log.unshift({ login: user.login, display, channel, text, time: now, color: user.color, ...target });
  if (log.length > settings.logLimit) log.length = settings.logLimit;
  await browser.storage.local.set({ users, log });

  unread++;
  setBadge();

  if (now - (lastAlert.get(user.login) || 0) < settings.cooldown * 1000) return {};
  lastAlert.set(user.login, now);

  const result = {};
  const soundType = user.sound !== "default" ? user.sound : settings.soundType;
  if (settings.sound && soundType !== "none") {
    const ok = await playHere(soundType, settings.volume);
    if (!ok) result.localSound = { type: soundType, volume: settings.volume };
  }
  if (settings.notifications && user.notify) {
    notify(channel ? `${display} in #${channel}` : display, text || "sent a message", target);
  }
  return result;
}

// ---------- mentions & replies to you ----------

let lastMentionSound = 0;

async function onMention(msg, sender) {
  const { settings, log } = await load();
  if (!settings.enabled || !settings.mentionAlert) return {};
  const kind = msg.kind === "reply" ? "reply" : "mention";
  const login = TCW.normalize(msg.login);
  if (!/^[a-z0-9_]{1,25}$/.test(login)) return {};
  const now = Date.now();
  const text = String(msg.text || "").slice(0, 300);
  const channel = String(msg.channel || "");
  const display = String(msg.display || login).slice(0, 40);
  const target = {
    tabId: sender.tab ? sender.tab.id : null,
    frameId: sender.frameId || 0,
    msgId: msg.msgId ? String(msg.msgId) : null,
    channel
  };
  log.unshift({ kind, login, display, channel, text, time: now, color: "#ff5f5f", ...target });
  if (log.length > settings.logLimit) log.length = settings.logLimit;
  await browser.storage.local.set({ log });
  unread++;
  setBadge();

  const result = {};
  if (now - lastMentionSound >= 1500) { // a burst of pings plays one sound
    lastMentionSound = now;
    if (settings.sound && settings.mentionSound !== "none") {
      const ok = await playHere(settings.mentionSound, settings.volume);
      if (!ok) result.localSound = { type: settings.mentionSound, volume: settings.volume };
    }
    if (settings.mentionNotify) {
      const where = channel ? ` in #${channel}` : "";
      notify(kind === "reply" ? `${display} replied to you${where}` : `${display} mentioned you${where}`, text || " ", target);
    }
  }
  return result;
}

// ---------- jump to a message ----------

async function jumpTo(target) {
  if (!target) return { ok: false };
  if (target.tabId != null) {
    let tab = null;
    try { tab = await browser.tabs.get(target.tabId); } catch (e) { /* closed */ }
    if (tab && /^https?:\/\/([a-z0-9-]+\.)?twitch\.tv\//i.test(tab.url || "")) {
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
      let ok = false;
      try {
        ok = await browser.tabs.sendMessage(tab.id, { type: "jump", msgId: target.msgId, channel: target.channel }, { frameId: target.frameId || 0 });
      } catch (e) { /* page reloaded */ }
      if (!ok) browser.tabs.sendMessage(tab.id, { type: "toast", text: "That message has scrolled out of chat" }).catch(() => {});
      return { ok: !!ok, focused: true };
    }
  }
  if (target.channel) {
    await browser.tabs.create({ url: "https://www.twitch.tv/" + encodeURIComponent(target.channel) });
    return { ok: false, opened: true };
  }
  return { ok: false };
}

// ---------- nametag paints ----------
// Library, active paint and hidden list live in storage.local. Other people's published paints are
// looked up from the paint server in batches (never per message) and cached here for every tab.

const PAINT_LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const PAINT_HIT_TTL = 15 * 60 * 1000;
const PAINT_MISS_TTL = 30 * 60 * 1000;
const PAINT_ERR_TTL = 2 * 60 * 1000;
const PAINT_CACHE_MAX = 5000;
const paintCache = new Map(); // login -> { paint|null, exp }
const paintInflight = new Map(); // login -> Promise
let paintChain = Promise.resolve();
let paintLastFetch = 0;
let paintFails = 0;
let paintBackoffUntil = 0;
let paintFetchCount = 0;

function paintConfig(settings) {
  const cfg = typeof TCW_CONFIG !== "undefined" ? TCW_CONFIG : {};
  let server = String(settings.paintServer || cfg.paintServer || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(server)) server = "";
  let clientId = String(settings.twitchClientId || cfg.twitchClientId || "").trim();
  if (!/^[a-z0-9]{10,64}$/i.test(clientId)) clientId = "";
  let redirectUrl = "";
  try { redirectUrl = browser.identity.getRedirectURL(); } catch (e) { /* identity unavailable */ }
  return { server, clientId, redirectUrl, canPublish: !!(server && clientId) };
}

function setPaintCache(login, paint, ttl) {
  paintCache.delete(login);
  paintCache.set(login, { paint: paint || null, exp: Date.now() + ttl });
  if (paintCache.size > PAINT_CACHE_MAX) paintCache.delete(paintCache.keys().next().value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPaintBatch(server, logins) {
  const wait = paintLastFetch + 1000 - Date.now(); // at most one request per second
  if (wait > 0) await sleep(wait);
  paintLastFetch = Date.now();
  paintFetchCount++;
  const r = await fetch(server + "/v1/paints?logins=" + logins.map(encodeURIComponent).join(","), {
    credentials: "omit",
    referrerPolicy: "no-referrer"
  });
  if (!r.ok) throw new Error("paint server " + r.status);
  const data = await r.json();
  const paints = data && typeof data.paints === "object" && data.paints ? data.paints : {};
  for (const l of logins) {
    const rec = Object.prototype.hasOwnProperty.call(paints, l) ? paints[l] : null;
    const p = rec ? TCWPaint.sanitize(rec.paint) : null;
    setPaintCache(l, p, p ? PAINT_HIT_TTL : PAINT_MISS_TTL);
  }
  paintFails = 0;
}

async function lookupPaints(logins) {
  const { settings } = await load();
  const cfg = paintConfig(settings);
  const list = [...new Set((logins || []).map((l) => String(l).toLowerCase()))].filter((l) => PAINT_LOGIN_RE.test(l)).slice(0, 300);
  const out = {};
  const need = [];
  const now = Date.now();
  for (const l of list) {
    const c = paintCache.get(l);
    if (c && c.exp > now) out[l] = c.paint;
    else need.push(l);
  }
  if (!need.length || !settings.paintsOn || !settings.paintsOthers || !cfg.server || now < paintBackoffUntil) return out;

  const missing = need.filter((l) => !paintInflight.has(l));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const job = (paintChain = paintChain.then(() => fetchPaintBatch(cfg.server, batch)).catch(() => {
      paintFails++;
      paintBackoffUntil = Date.now() + Math.min(10 * 60 * 1000, 15000 * 2 ** (paintFails - 1));
      batch.forEach((l) => setPaintCache(l, null, PAINT_ERR_TTL));
    }));
    batch.forEach((l) => paintInflight.set(l, job));
    job.finally(() => batch.forEach((l) => paintInflight.delete(l)));
  }
  await Promise.all([...new Set(need.map((l) => paintInflight.get(l)).filter(Boolean))]);
  for (const l of need) {
    const c = paintCache.get(l);
    out[l] = c ? c.paint : null;
  }
  return out;
}

async function loadPaintState() {
  const d = await browser.storage.local.get(["paintLib", "paintMe", "paintHidden", "paintRecent"]);
  return {
    lib: (Array.isArray(d.paintLib) ? d.paintLib : []).map(TCWPaint.sanitizeEntry).filter(Boolean),
    me: d.paintMe && typeof d.paintMe === "object" ? d.paintMe : { activeId: null, login: "", userId: "", published: null },
    hidden: Array.isArray(d.paintHidden) ? d.paintHidden.filter((l) => PAINT_LOGIN_RE.test(l)) : [],
    recent: Array.isArray(d.paintRecent) ? d.paintRecent.map(TCWPaint.hex).filter(Boolean) : []
  };
}

function findPaint(lib, id) {
  return lib.find((p) => p.id === id) || TCWPaint.PRESETS.find((p) => p.id === id) || null;
}

async function savePaintEntry(entry) {
  const clean = TCWPaint.sanitizeEntry({ ...entry, updated: Date.now() });
  if (!clean) throw new Error("That paint isn't valid.");
  if (clean.id.startsWith("preset-")) clean.id = TCWPaint.newId(); // presets are read-only; save a copy
  const st = await loadPaintState();
  const i = st.lib.findIndex((p) => p.id === clean.id);
  if (i >= 0) st.lib[i] = clean;
  else st.lib.unshift(clean);
  if (st.lib.length > 200) throw new Error("You can keep up to 200 paints.");
  const recent = [...new Set(clean.colors.map((c) => c.c).concat(st.recent))].slice(0, 12);
  await browser.storage.local.set({ paintLib: st.lib, paintRecent: recent });
  return clean;
}

async function deletePaintEntry(id) {
  const st = await loadPaintState();
  const lib = st.lib.filter((p) => p.id !== id);
  const patch = { paintLib: lib };
  if (st.me.activeId === id) patch.paintMe = { ...st.me, activeId: null };
  await browser.storage.local.set(patch);
}

async function setActivePaint(id) {
  const st = await loadPaintState();
  if (id && !findPaint(st.lib, id)) throw new Error("That paint doesn't exist any more.");
  await browser.storage.local.set({ paintMe: { ...st.me, activeId: id || null } });
}

async function importPaints(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.paints)) throw new Error("Not a paint export file.");
  const st = await loadPaintState();
  let added = 0;
  for (const raw of data.paints.slice(0, 200)) {
    const e = TCWPaint.sanitizeEntry({ ...raw, id: undefined }); // always new ids, never overwrite
    if (!e) continue;
    st.lib.push(e);
    added++;
  }
  if (st.lib.length > 200) st.lib.length = 200;
  await browser.storage.local.set({ paintLib: st.lib });
  return { added, skipped: data.paints.length - added };
}

async function twitchSignIn(cfg) {
  if (!cfg.clientId) throw new Error("Sharing isn't set up in this version yet.");
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const state = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.search = new URLSearchParams({
    response_type: "token",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUrl,
    scope: "",
    state
  }).toString();
  let result;
  try {
    result = await browser.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch (e) {
    throw new Error("Twitch sign-in was closed before it finished.");
  }
  const frag = new URLSearchParams(new URL(result).hash.slice(1));
  if (frag.get("error")) throw new Error(frag.get("error_description") || "Twitch sign-in was cancelled.");
  if (frag.get("state") !== state) throw new Error("Twitch sign-in didn't match. Try again.");
  const token = frag.get("access_token");
  if (!token) throw new Error("Twitch didn't return a sign-in.");
  return token;
}

async function paintServerCall(cfg, method, body) {
  const token = await twitchSignIn(cfg);
  let r;
  try {
    r = await fetch(cfg.server + "/v1/me/paint", {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit",
      referrerPolicy: "no-referrer"
    });
  } catch (e) {
    throw new Error("Couldn't reach the paint server. Check your connection and try again.");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.error === "string" ? data.error.slice(0, 200) : `Paint server error (${r.status}).`);
  return data;
}

async function setPaintMe(patch) {
  const st = await loadPaintState();
  const me = { ...st.me, ...patch };
  await browser.storage.local.set({ paintMe: me });
  return me;
}

async function publishPaint() {
  const { settings } = await load();
  const cfg = paintConfig(settings);
  if (!cfg.canPublish) throw new Error("Sharing isn't set up in this version yet.");
  const st = await loadPaintState();
  const entry = findPaint(st.lib, st.me.activeId);
  if (!entry) throw new Error("Choose a paint to use first.");
  const paint = TCWPaint.sanitize(entry);
  await setPaintMe({ busy: true, lastError: "" });
  try {
    const data = await paintServerCall(cfg, "PUT", { paint });
    const saved = TCWPaint.sanitize(data.paint) || paint;
    setPaintCache(String(data.login), saved, PAINT_HIT_TTL);
    return await setPaintMe({
      busy: false, login: String(data.login), userId: String(data.user_id),
      published: { key: TCWPaint.key(saved), at: data.updated, name: entry.name }
    });
  } catch (e) {
    await setPaintMe({ busy: false, lastError: e.message });
    throw e;
  }
}

async function unpublishPaint() {
  const { settings } = await load();
  const cfg = paintConfig(settings);
  if (!cfg.canPublish) throw new Error("Sharing isn't set up in this version yet.");
  await setPaintMe({ busy: true, lastError: "" });
  try {
    const data = await paintServerCall(cfg, "DELETE");
    setPaintCache(String(data.login), null, PAINT_MISS_TTL);
    return await setPaintMe({ busy: false, login: String(data.login), userId: String(data.user_id), published: null });
  } catch (e) {
    await setPaintMe({ busy: false, lastError: e.message });
    throw e;
  }
}

async function hidePaint(login, hidden) {
  login = String(login || "").toLowerCase();
  if (!PAINT_LOGIN_RE.test(login)) return;
  const st = await loadPaintState();
  const set = new Set(st.hidden);
  if (hidden) set.add(login);
  else set.delete(login);
  await browser.storage.local.set({ paintHidden: [...set].slice(0, 2000) });
}

// ---------- watch time ----------
// Twitch tabs report "I'm playing channel X" every few seconds. The clock runs here, once per
// channel, so two tabs on the same stream never count double, and a sleeping computer doesn't
// add hours (each tick adds at most a few seconds).
//
// Stored only in storage.local (never synced), in a format meant to last:
//   watch = { v: 1, updated, channels: { login: { display, total, liveTotal, first, last, sessions,
//             days: { "YYYY-MM-DD": seconds } } } }
//   watchSessions = [ { c: login, s: startMs, e: endMs, live: bool } ]   (newest last, capped)

const WT = Object.assign({ tick: 5000, beatTTL: 15000, maxStep: 15000, flushEvery: 30000, sessionGap: 120000, maxSessions: 5000 },
  typeof globalThis.TCW_WATCH_TUNING === "object" ? globalThis.TCW_WATCH_TUNING : {});
const WATCH_LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const watchBeats = new Map(); // tabId -> { channel, live, display, t }
const watchOpen = new Map();  // channel -> current session object (also inside watchSessions)
let watchData = null;
let watchSessions = null;
let watchDirty = false;
let watchLastTick = Date.now();
let watchLastFlush = Date.now();

function emptyWatch() {
  return { v: 1, updated: 0, channels: {} };
}

async function loadWatch() {
  const d = await browser.storage.local.get(["watch", "watchSessions"]);
  watchData = d.watch && typeof d.watch === "object" && d.watch.channels ? d.watch : emptyWatch();
  watchSessions = Array.isArray(d.watchSessions) ? d.watchSessions : [];
}

function watchTick() {
  const now = Date.now();
  const step = Math.min(now - watchLastTick, WT.maxStep);
  watchLastTick = now;
  if (!watchData) return;
  const active = new Map();
  for (const [tabId, b] of watchBeats) {
    if (now - b.t > WT.beatTTL) watchBeats.delete(tabId);
    else if (!active.has(b.channel) || b.live) active.set(b.channel, b);
  }
  for (const [ch, s] of watchOpen) if (!active.has(ch) && now - s.e > WT.sessionGap) watchOpen.delete(ch);
  if (!active.size || step <= 0) return maybeFlushWatch(now);

  const secs = step / 1000;
  const day = TCW.dayKey(now);
  for (const [ch, b] of active) {
    const c = watchData.channels[ch] || (watchData.channels[ch] = { display: ch, total: 0, liveTotal: 0, first: now, last: now, sessions: 0, days: {} });
    c.total = Math.round((c.total + secs) * 10) / 10;
    if (b.live) c.liveTotal = Math.round((c.liveTotal + secs) * 10) / 10;
    c.days[day] = Math.round(((c.days[day] || 0) + secs) * 10) / 10;
    c.last = now;
    if (b.display) c.display = b.display;
    let s = watchOpen.get(ch);
    if (!s || now - s.e > WT.sessionGap) {
      s = { c: ch, s: now - step, e: now, live: !!b.live };
      watchSessions.push(s);
      if (watchSessions.length > WT.maxSessions) watchSessions.splice(0, watchSessions.length - WT.maxSessions);
      watchOpen.set(ch, s);
      c.sessions = (c.sessions || 0) + 1;
    } else {
      s.e = now;
      if (b.live) s.live = true;
    }
  }
  watchData.updated = now;
  watchDirty = true;
  maybeFlushWatch(now);
}

function maybeFlushWatch(now, force) {
  if (!watchDirty || (!force && now - watchLastFlush < WT.flushEvery)) return Promise.resolve();
  watchLastFlush = now;
  watchDirty = false;
  return serial(() => browser.storage.local.set({ watch: watchData, watchSessions }));
}

function watchFor(channel) {
  const c = watchData && watchData.channels[channel];
  if (!c) return { total: 0, today: 0 };
  return { total: c.total, today: c.days[TCW.dayKey()] || 0, liveTotal: c.liveTotal, first: c.first, last: c.last, sessions: c.sessions, display: c.display };
}

setInterval(watchTick, WT.tick);
browser.tabs.onRemoved.addListener((tabId) => watchBeats.delete(tabId));

// Wraps a promise so errors reach the UI as { error } instead of a rejected message.
const safe = (p) => p.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));

// ---------- status of open Twitch tabs ----------

function statusList() {
  const now = Date.now();
  const out = [];
  for (const [k, s] of tabStatus) {
    if (now - s.updated > 15000) tabStatus.delete(k);
    else out.push(s);
  }
  const byTab = new Map();
  for (const s of out) {
    const cur = byTab.get(s.tabId);
    if (!cur || s.linesSeen > cur.linesSeen) byTab.set(s.tabId, s);
  }
  return [...byTab.values()].sort((a, b) => b.linesSeen - a.linesSeen);
}

// ---------- messaging ----------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "hit":
      return serial(() => onHit(msg, sender));
    case "mention":
      return serial(() => onMention(msg, sender));
    case "addUsers":
      return serial(() => addUsers(msg.names));
    case "updateUser":
      return serial(() => updateUser(msg.login, msg.patch));
    case "removeUser":
      return serial(() => removeUser(msg.login));
    case "setSettings":
      return serial(() => setSettings(msg.patch));
    case "clearLog":
      return serial(() => browser.storage.local.set({ log: [] }));
    case "resetStats":
      return serial(async () => {
        const { users } = await load();
        users.forEach((u) => { u.hits = 0; u.lastSeen = null; });
        await browser.storage.local.set({ users });
      });
    case "import":
      return serial(() => importData(msg.data));
    case "resetAll":
      return serial(async () => {
        await browser.storage.local.clear();
        lastAlert.clear();
        unread = 0;
        setBadge();
        await migrate();
        watchData = emptyWatch();
        watchSessions = [];
        watchOpen.clear();
        watchDirty = false;
        // an erase is deliberate: clear the synced copy too instead of merging it back in
        await browser.storage.local.set({ syncJoined: true });
        await pushSync();
      });
    case "syncNow":
      return serial(async () => { await pullSync(false); await pushSync(); });
    case "jump":
      return jumpTo(msg.target);
    case "test":
      return serial(async () => {
        const { settings } = await load();
        if (settings.notifications) notify("Chat Watcher test", "This is what an alert looks like.", null);
        return { notifications: settings.notifications };
      });
    case "status":
      if (sender.tab) {
        tabStatus.set(`${sender.tab.id}:${sender.frameId || 0}`, {
          ...msg.status,
          tabId: sender.tab.id,
          title: sender.tab.title || "",
          updated: Date.now()
        });
      }
      return;
    case "getStatus":
      return Promise.resolve(statusList());
    case "watch:beat": {
      if (!sender.tab || !WATCH_LOGIN_RE.test(String(msg.channel || ""))) return;
      return load().then(({ settings }) => {
        if (!settings.watchTrack) return;
        const display = typeof msg.display === "string" ? msg.display.trim().slice(0, 40) : "";
        watchBeats.set(sender.tab.id, { channel: msg.channel, live: !!msg.live, display, t: Date.now() });
      });
    }
    case "watch:stop":
      if (sender.tab) watchBeats.delete(sender.tab.id);
      return;
    case "watch:get":
      return Promise.resolve(watchFor(String(msg.channel || "").toLowerCase()));
    case "watch:all":
      return maybeFlushWatch(Date.now(), true).then(() => ({ data: watchData, sessions: watchSessions }));
    case "watch:reset":
      return serial(async () => {
        watchData = emptyWatch();
        watchSessions = [];
        watchOpen.clear();
        watchDirty = false;
        await browser.storage.local.set({ watch: watchData, watchSessions });
      });
    case "watch:import":
      return safe(serial(async () => {
        const d = msg.data;
        if (!d || typeof d !== "object" || !d.watch || typeof d.watch.channels !== "object") throw new Error("Not a watch-time export file.");
        let n = 0;
        for (const [login, c] of Object.entries(d.watch.channels)) {
          if (!WATCH_LOGIN_RE.test(login) || !c || typeof c !== "object") continue;
          const cur = watchData.channels[login] || (watchData.channels[login] = { display: login, total: 0, liveTotal: 0, first: Date.now(), last: 0, sessions: 0, days: {} });
          const num = (v) => (Number.isFinite(v) && v >= 0 && v < 1e9 ? v : 0);
          for (const [day, sec] of Object.entries(c.days || {})) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
            cur.days[day] = Math.max(cur.days[day] || 0, num(sec)); // max, so importing twice doesn't double
          }
          cur.total = Math.max(cur.total, num(c.total), Object.values(cur.days).reduce((a, b) => a + b, 0));
          cur.liveTotal = Math.max(cur.liveTotal, num(c.liveTotal));
          if (typeof c.display === "string") cur.display = c.display.slice(0, 40);
          if (num(c.first)) cur.first = Math.min(cur.first, c.first);
          cur.last = Math.max(cur.last, num(c.last));
          n++;
        }
        // already inside the storage queue, so write directly (queuing again would wait on itself)
        watchDirty = false;
        watchLastFlush = Date.now();
        await browser.storage.local.set({ watch: watchData, watchSessions });
        return { channels: n };
      }));
    case "paints:lookup":
      return lookupPaints(msg.logins);
    case "paints:config":
      return load().then(({ settings }) => ({ ...paintConfig(settings), fetches: paintFetchCount, cached: paintCache.size }));
    case "paints:save":
      return safe(serial(() => savePaintEntry(msg.entry)));
    case "paints:delete":
      return safe(serial(() => deletePaintEntry(msg.id)));
    case "paints:setActive":
      return safe(serial(() => setActivePaint(msg.id)));
    case "paints:import":
      return safe(serial(() => importPaints(msg.data)));
    case "paints:hide":
      return safe(serial(() => hidePaint(msg.login, msg.hidden)));
    case "paints:reset":
      return safe(serial(async () => {
        const st = await loadPaintState();
        await browser.storage.local.set({ paintLib: [], paintRecent: [], paintHidden: [], paintMe: { ...st.me, activeId: null } });
      }));
    case "paints:publish":
      return safe(publishPaint());
    case "paints:unpublish":
      return safe(unpublishPaint());
    case "paints:clearCache":
      paintCache.clear();
      paintBackoffUntil = 0;
      paintFails = 0;
      return Promise.resolve(true);
    case "clearBadge":
      unread = 0;
      setBadge();
      return Promise.resolve(true);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  for (const k of [...tabStatus.keys()]) if (k.startsWith(tabId + ":")) tabStatus.delete(k);
});

browser.notifications.onClicked.addListener((id) => {
  const target = notifTargets.get(id);
  notifTargets.delete(id);
  browser.notifications.clear(id);
  if (target) jumpTo(target);
});
browser.notifications.onClosed.addListener((id) => notifTargets.delete(id));

// Right-click a chat message -> "Watch this chat user"
browser.menus.create(
  {
    id: "tcw-watch",
    title: "Watch this chat user",
    contexts: ["all"],
    documentUrlPatterns: ["*://*.twitch.tv/*"]
  },
  () => void browser.runtime.lastError
);

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "tcw-watch" || !tab) return;
  const opts = { frameId: info.frameId || 0 };
  let name = null;
  try {
    name = await browser.tabs.sendMessage(tab.id, { type: "getContextUser" }, opts);
  } catch (e) { /* page not ready */ }
  let text;
  if (!name) {
    text = "Right-click directly on a chat message to watch its author.";
  } else {
    const r = await serial(() => addUsers([name]));
    text = r.added.length ? `Now watching ${name}` : `Already watching ${name}`;
  }
  browser.tabs.sendMessage(tab.id, { type: "toast", text }, opts).catch(() => {});
});

browser.browserAction.setBadgeBackgroundColor({ color: "#9147ff" });
serial(migrate);
serial(startSync);
serial(loadWatch);
