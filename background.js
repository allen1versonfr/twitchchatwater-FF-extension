"use strict";

const tabStatus = new Map();   // "tabId:frameId" -> latest status from a Twitch page
const lastAlert = new Map();   // login -> time of last sound/notification (cooldown)
const notifTabs = new Map();   // notification id -> tab id
let unread = 0;
let audioCtx = null;

// All storage writes go through one queue so the UI and incoming chat hits never overwrite each other.
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
  if (added.length) await browser.storage.local.set({ users });
  return { added, existing };
}

const EDITABLE = ["name", "color", "enabled", "sound", "notify", "note", "hits", "lastSeen"];

async function updateUser(login, patch) {
  const { users } = await load();
  const u = users.find((x) => x.login === login);
  if (!u) return false;
  for (const k of EDITABLE) if (patch && k in patch) u[k] = patch[k];
  const fixed = TCW.fixUser(u);
  users[users.indexOf(u)] = fixed;
  await browser.storage.local.set({ users });
  return true;
}

async function removeUser(login) {
  const { users } = await load();
  await browser.storage.local.set({ users: users.filter((u) => u.login !== login) });
  lastAlert.delete(login);
}

async function setSettings(patch) {
  const { settings } = await load();
  const next = { ...settings };
  for (const k of Object.keys(TCW.DEFAULT_SETTINGS)) if (patch && k in patch) next[k] = patch[k];
  await browser.storage.local.set({ settings: next });
  if (!next.enabled) setBadge();
}

async function importData(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.users)) throw new Error("Not a Chat Watcher backup file.");
  const { log } = await load();
  const seen = new Set();
  const users = [];
  data.users.forEach((u, i) => {
    const f = TCW.fixUser(u, i);
    if (f && !seen.has(f.login)) {
      seen.add(f.login);
      users.push(f);
    }
  });
  const settings = { ...TCW.DEFAULT_SETTINGS };
  if (data.settings && typeof data.settings === "object") {
    for (const k of Object.keys(TCW.DEFAULT_SETTINGS)) {
      if (typeof data.settings[k] === typeof TCW.DEFAULT_SETTINGS[k]) settings[k] = data.settings[k];
    }
  }
  await browser.storage.local.set({ settings, users, log });
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

function notify(title, message, tabId) {
  const id = "tcw-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  if (tabId != null) notifTabs.set(id, tabId);
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

  user.hits = (user.hits || 0) + 1;
  user.lastSeen = { time: now, channel, text };
  log.unshift({ login: user.login, display, channel, text, time: now, color: user.color });
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
    notify(channel ? `${display} in #${channel}` : display, text || "sent a message", sender.tab ? sender.tab.id : null);
  }
  return result;
}

// ---------- status of open Twitch tabs ----------

function statusList() {
  const now = Date.now();
  const out = [];
  for (const [k, s] of tabStatus) {
    if (now - s.updated > 15000) tabStatus.delete(k);
    else out.push(s);
  }
  // one row per tab: prefer the frame that actually has chat
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
      });
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
    case "clearBadge":
      unread = 0;
      setBadge();
      return Promise.resolve(true);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  for (const k of [...tabStatus.keys()]) if (k.startsWith(tabId + ":")) tabStatus.delete(k);
});

browser.notifications.onClicked.addListener(async (id) => {
  const tabId = notifTabs.get(id);
  notifTabs.delete(id);
  browser.notifications.clear(id);
  if (tabId == null) return;
  try {
    const tab = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
  } catch (e) { /* tab was closed */ }
});
browser.notifications.onClosed.addListener((id) => notifTabs.delete(id));

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
