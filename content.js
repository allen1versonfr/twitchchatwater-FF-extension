(() => {
  "use strict";
  if (window.__tcwLoaded) return;
  window.__tcwLoaded = true;

  // A chat message row, across Twitch's live chat, VOD chat, FrankerFaceZ and 7TV.
  const LINE_SEL = [
    ".chat-line__message",
    "[data-a-target='chat-line-message']",
    ".vod-message",
    ".seventv-message"
  ].join(",");

  // The element holding the message author's name.
  const NAME_SEL = [
    "[data-a-target='chat-message-username']",
    ".chat-author__display-name",
    "[data-test-selector='message-username']",
    ".chat-line__username",
    ".video-chat__message-author",
    ".seventv-chat-user-username"
  ].join(",");

  // The message text itself.
  const BODY_SEL = [
    "[data-a-target='chat-line-message-body']",
    "[data-a-target='chat-message-text']",
    "[data-test-selector='chat-line-message-body']",
    ".seventv-chat-message-body"
  ].join(",");

  // Names inside these are mentions or reply headers, never the author.
  const SKIP_SEL = [
    BODY_SEL,
    ".mention-fragment",
    "[data-a-target='chat-message-mention']",
    "[data-test-selector*='reply' i]",
    "[data-a-target*='reply' i]",
    "[class*='reply-header' i]",
    "[class*='replyheader' i]"
  ].join(",");

  // Scrolling message lists (fallback for when Twitch renames its row classes).
  const CONTAINER_SEL = [
    "[role='log']",
    ".chat-scrollable-area__message-container",
    "[data-test-selector='chat-scrollable-area__message-container']",
    ".video-chat__message-list-wrapper",
    ".seventv-chat-list"
  ].join(",");

  const RESERVED = new Set(["directory", "settings", "search", "videos", "downloads", "jobs", "p",
    "subscriptions", "wallet", "inventory", "drops", "friends", "turbo", "prime", "u"]);
  const IS_TOP = window === window.top;
  const STYLE_CLASSES = ["tcw-both", "tcw-bg", "tcw-border", "tcw-none"];

  let settings = { ...TCW.DEFAULT_SETTINGS };
  let users = new Map();
  let allowChannels = null;
  let signature = "";
  let readyAt = Date.now() + settings.backlogSeconds * 1000;
  let lastHref = location.href;

  const seen = new WeakSet();
  const tracked = new Set();
  const recent = new Map();
  let linesSeen = 0;
  let hits = 0;
  let lastAuthor = "";
  let contextUser = null;
  let audio = null;

  const debug = (...a) => { if (settings.debug) console.log("[Chat Watcher]", ...a); };

  // ---------- settings ----------

  function setUsers(list) {
    users = new Map();
    (Array.isArray(list) ? list : []).forEach((u, i) => {
      const f = TCW.fixUser(u, i);
      if (f) users.set(f.login, f);
    });
  }

  function updateAllow() {
    const names = String(settings.channels || "").split(/[\s,]+/).map(TCW.normalize).filter(Boolean);
    allowChannels = names.length ? new Set(names) : null;
  }

  function makeSig() {
    return JSON.stringify([
      settings.enabled, settings.highlightStyle, settings.highlightOpacity, settings.showStar, settings.channels,
      [...users.values()].map((u) => [u.login, u.color, u.enabled])
    ]);
  }

  function currentChannel() {
    const parts = location.pathname.split("/").filter(Boolean).map((p) => p.toLowerCase());
    if (!parts.length) return "";
    if (["popout", "embed", "moderator"].includes(parts[0])) return parts[1] || "";
    if (RESERVED.has(parts[0])) return "";
    return parts[0];
  }

  function channelAllowed() {
    return !allowChannels || allowChannels.has(currentChannel());
  }

  // ---------- reading a chat row ----------

  function isSkipped(el, line) {
    if (el.matches(".mention-fragment, [data-a-target='chat-message-mention']")) return true;
    for (let p = el.parentElement; p && p !== line; p = p.parentElement) {
      if (p.matches(SKIP_SEL)) return true;
    }
    return false;
  }

  function firstGood(line, sel) {
    for (const el of line.querySelectorAll(sel)) if (!isSkipped(el, line)) return el;
    return null;
  }

  function getAuthor(line) {
    const names = [];
    const add = (v) => {
      const n = TCW.normalize(v);
      if (n && !names.includes(n)) names.push(n);
    };
    add(line.getAttribute("data-a-user"));
    add(line.getAttribute("data-user"));
    const userEl = firstGood(line, "[data-a-user]");
    if (userEl) add(userEl.getAttribute("data-a-user"));
    const nameEl = firstGood(line, NAME_SEL);
    let display = "";
    if (nameEl) {
      display = nameEl.textContent.trim().replace(/:$/, "");
      add(display);
    }
    const intl = firstGood(line, ".chat-author__intl-login");
    if (intl) add(intl.textContent.replace(/[()\s]/g, ""));
    return { names, display: display || names[0] || "", nameEl: nameEl || userEl };
  }

  function readable(el) {
    let out = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.tagName === "IMG" && n.alt) out += " " + n.alt + " ";
    }
    return out;
  }

  function getText(line, display) {
    const body = line.querySelector(BODY_SEL);
    let t = body ? readable(body) : "";
    if (!t.trim()) {
      const all = readable(line);
      const i = display ? all.indexOf(display) : -1;
      const rest = i >= 0 ? all.slice(i + display.length) : all;
      const c = rest.indexOf(":");
      t = c >= 0 ? rest.slice(c + 1) : rest;
    }
    return t.replace(/\s+/g, " ").trim().slice(0, 300);
  }

  // ---------- highlighting ----------

  function clear(line) {
    if (!line.classList.contains("tcw-hit")) return;
    line.classList.remove("tcw-hit", ...STYLE_CLASSES);
    line.style.removeProperty("--tcw-color");
    line.style.removeProperty("--tcw-alpha");
    line.querySelectorAll(".tcw-name").forEach((el) => el.classList.remove("tcw-name"));
  }

  function highlight(line, user, nameEl) {
    const style = STYLE_CLASSES.includes("tcw-" + settings.highlightStyle) ? settings.highlightStyle : "both";
    line.classList.add("tcw-hit", "tcw-" + style);
    line.style.setProperty("--tcw-color", user.color);
    line.style.setProperty("--tcw-alpha", Math.max(0, Math.min(100, settings.highlightOpacity)) + "%");
    if (settings.showStar && nameEl) nameEl.classList.add("tcw-name");
  }

  function matchUser(author) {
    for (const n of author.names) {
      const u = users.get(n);
      if (u && u.enabled) return u;
    }
    return null;
  }

  // ---------- alerts ----------

  function playLocal(type, volume) {
    try {
      audio = audio || new AudioContext();
      if (audio.state !== "running") audio.resume();
      TCW.playSound(audio, type, volume);
    } catch (e) {
      debug("could not play sound in page", e);
    }
  }

  let baseTitle = null;
  let flashTimer = null;
  function flashTitle(name) {
    if (!settings.flashTitle || !IS_TOP || !document.hidden) return;
    if (baseTitle === null) baseTitle = document.title;
    let on = false;
    clearInterval(flashTimer);
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? `★ ${name} is chatting` : baseTitle;
    }, 1000);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !flashTimer) return;
    clearInterval(flashTimer);
    flashTimer = null;
    if (baseTitle !== null) document.title = baseTitle;
    baseTitle = null;
  });

  function toast(text) {
    const el = document.createElement("div");
    el.className = "tcw-toast";
    el.textContent = text;
    (document.body || document.documentElement).appendChild(el);
    setTimeout(() => el.classList.add("tcw-toast-out"), 2200);
    setTimeout(() => el.remove(), 2700);
  }

  // ---------- processing ----------

  function evaluate(line, author, live) {
    clear(line);
    if (!settings.enabled || !channelAllowed()) return;
    const user = matchUser(author);
    if (!user) return;
    highlight(line, user, author.nameEl);
    if (!live || Date.now() < readyAt) return;

    const text = getText(line, author.display);
    const now = Date.now();
    const key = user.login + "|" + text;
    if (now - (recent.get(key) || 0) < 2500) return; // same row re-rendered by Twitch
    recent.set(key, now);
    if (recent.size > 200) for (const [k, t] of recent) if (now - t > 10000) recent.delete(k);

    hits++;
    debug("message from watched user", user.login, text);
    browser.runtime
      .sendMessage({ type: "hit", login: user.login, display: author.display || user.name, channel: currentChannel(), text, time: now })
      .then((r) => {
        if (r && r.localSound) playLocal(r.localSound.type, r.localSound.volume);
      })
      .catch((e) => {
        debug("background not reachable, playing in page", e);
        const type = user.sound !== "default" ? user.sound : settings.soundType;
        if (settings.sound && type !== "none") playLocal(type, settings.volume);
      });
    flashTitle(author.display || user.name);
    sendStatus();
  }

  function processLine(line, live) {
    if (seen.has(line)) return;
    seen.add(line);
    tracked.add(line);
    linesSeen++;
    const author = getAuthor(line);
    if (!author.names.length) return;
    lastAuthor = author.display;
    evaluate(line, author, live);
  }

  function findLines(node) {
    const parent = node.parentElement;
    if (parent) {
      const owner = parent.closest(LINE_SEL);
      if (owner) return [owner]; // something changed inside an existing row
      for (let p = parent; p; p = p.parentElement) {
        if (seen.has(p)) return [];
        if (p.matches(CONTAINER_SEL)) break;
      }
    }
    if (node.matches(LINE_SEL)) return [node];
    const inner = node.querySelectorAll(LINE_SEL);
    if (inner.length) return [...inner];
    if (parent && parent.closest(CONTAINER_SEL) && node.querySelector(NAME_SEL + ",[data-a-user]")) return [node];
    return [];
  }

  function scanAll() {
    const lines = document.querySelectorAll(LINE_SEL);
    if (lines.length) {
      lines.forEach((l) => processLine(l, false));
      return;
    }
    document.querySelectorAll(CONTAINER_SEL).forEach((c) => {
      for (const child of c.children) if (child.querySelector(NAME_SEL + ",[data-a-user]")) processLine(child, false);
    });
  }

  function rescan() {
    for (const line of tracked) {
      if (!line.isConnected) {
        tracked.delete(line);
        continue;
      }
      evaluate(line, getAuthor(line), false);
    }
    scanAll();
  }

  function onMutations(mutations) {
    if (location.href !== lastHref) {
      lastHref = location.href;
      readyAt = Date.now() + settings.backlogSeconds * 1000; // skip the history Twitch loads on a new channel
      for (const line of tracked) if (!line.isConnected) tracked.delete(line);
    }
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        for (const line of findLines(node)) processLine(line, true);
      }
    }
  }

  // ---------- status + messaging ----------

  function sendStatus() {
    if (!IS_TOP && !linesSeen) return;
    browser.runtime
      .sendMessage({
        type: "status",
        status: {
          channel: currentChannel(),
          chatFound: linesSeen > 0,
          containerFound: !!document.querySelector(CONTAINER_SEL),
          linesSeen,
          hits,
          lastAuthor,
          enabled: settings.enabled,
          allowed: channelAllowed()
        }
      })
      .catch(() => {});
  }

  document.addEventListener(
    "contextmenu",
    (e) => {
      contextUser = null;
      const t = e.target instanceof Element ? e.target : e.target && e.target.parentElement;
      if (!t) return;
      const mention = t.closest(".mention-fragment, [data-a-target='chat-message-mention']");
      if (mention) {
        contextUser = mention.textContent.trim().replace(/^@/, "") || null;
        return;
      }
      let line = t.closest(LINE_SEL);
      if (!line) for (let p = t; p; p = p.parentElement) if (seen.has(p)) { line = p; break; }
      if (line) {
        const a = getAuthor(line);
        contextUser = a.display || a.names[0] || null;
        return;
      }
      const nameEl = t.closest(NAME_SEL + ",[data-a-user]");
      if (nameEl) contextUser = (nameEl.getAttribute("data-a-user") || nameEl.textContent || "").trim() || null;
    },
    true
  );

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "getContextUser") return Promise.resolve(contextUser);
    if (msg.type === "toast") toast(msg.text);
  });

  browser.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !(ch.settings || ch.users)) return;
    if (ch.settings) settings = { ...TCW.DEFAULT_SETTINGS, ...(ch.settings.newValue || {}) };
    if (ch.users) setUsers(ch.users.newValue);
    updateAllow();
    const sig = makeSig();
    if (sig !== signature) {
      signature = sig;
      rescan();
    }
  });

  browser.storage.local.get(["settings", "users"]).then((d) => {
    settings = { ...TCW.DEFAULT_SETTINGS, ...(d.settings || {}) };
    setUsers(d.users);
    updateAllow();
    signature = makeSig();
    readyAt = Date.now() + settings.backlogSeconds * 1000;
    scanAll();
    new MutationObserver(onMutations).observe(document.documentElement, { childList: true, subtree: true });
    sendStatus();
    setInterval(sendStatus, 4000);
    debug("running on", location.href);
  });
})();
