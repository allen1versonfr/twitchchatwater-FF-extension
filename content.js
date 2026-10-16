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

  const PAGE_ID = Math.random().toString(36).slice(2, 8); // keeps message ids unique across reloads
  const MAX_PEOPLE = 1000;
  const MAX_MSGS = 100;
  const people = new Map();  // login -> { login, display, first, msgs[], lastLine }
  const aliases = new Map(); // other name forms (localized display names) -> login
  let msgCounter = 0;
  let bypassClick = false;

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
      settings.paintsOn, settings.paintsOthers, settings.paintsAnimate, settings.paints7tvWins, settings.paintServer,
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
  function flashTitle(name, text) {
    if (!settings.flashTitle || !IS_TOP || !document.hidden) return;
    if (baseTitle === null) baseTitle = document.title;
    let on = false;
    clearInterval(flashTimer);
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? (text || `★ ${name} is chatting`) : baseTitle;
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

  function evaluate(line, author, live, knownText) {
    clear(line);
    if (!settings.enabled || !channelAllowed()) return;
    const user = matchUser(author);
    if (!user) return;
    highlight(line, user, author.nameEl);
    if (!live || Date.now() < readyAt) return;

    const text = knownText != null ? knownText : getText(line, author.display);
    const now = Date.now();
    const key = user.login + "|" + text;
    if (now - (recent.get(key) || 0) < 2500) return; // same row re-rendered by Twitch
    recent.set(key, now);
    if (recent.size > 200) for (const [k, t] of recent) if (now - t > 10000) recent.delete(k);

    hits++;
    debug("message from watched user", user.login, text);
    browser.runtime
      .sendMessage({
        type: "hit", login: user.login, display: author.display || user.name,
        channel: currentChannel(), text, time: now, msgId: line.dataset.tcwId || null
      })
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
    const id = PAGE_ID + "-" + ++msgCounter;
    line.dataset.tcwId = id;
    const text = getText(line, author.display);
    remember(author, line, id, text, live);
    evaluate(line, author, live, text);
    lineLogin.set(line, author.names[0]);
    paintLine(line, author.names[0]);
    checkMention(line, author, live, text);
    noteChatter(author.names[0]);
  }

  // ---------- active chatters (counted from the chat this tab shows) ----------
  // Twitch doesn't expose who is connected to a chat (only moderators can get that list), so this counts
  // the different people who actually sent a message.

  let chatters = new Map(); // login -> last message time
  let chattersChannel = "";
  let chattersSince = Date.now();

  function noteChatter(login) {
    const ch = currentChannel();
    if (!login || !ch) return;
    if (ch !== chattersChannel) {
      chatters = new Map();
      chattersChannel = ch;
      chattersSince = Date.now();
    }
    chatters.set(login, Date.now());
    if (chatters.size > 50000) chatters.delete(chatters.keys().next().value);
  }

  function chatterCounts() {
    const win = Number(settings.chattersWindow) || 0;
    const cutoff = win ? Date.now() - win * 60000 : 0;
    let active = 0;
    for (const t of chatters.values()) if (t >= cutoff) active++;
    return { active, total: chatters.size, win };
  }

  function updateChattersBadge(ch) {
    let badge = document.getElementById("tcw-chatters-badge");
    const anchor = ch && settings.chattersBadge ? document.querySelector(VIEWERS_SEL) : null;
    if (!anchor || ch !== chattersChannel) {
      if (badge) badge.remove();
      return;
    }
    const c = chatterCounts();
    if (!badge) badge = el("span", { id: "tcw-chatters-badge", class: "tcw-watch tcw-chatters" });
    const fmt = (n) => n.toLocaleString();
    const opened = TCW.ago(chattersSince).replace(" ago", "");
    badge.textContent = "💬 " + fmt(c.active);
    badge.title = c.win
      ? `${fmt(c.active)} people chatted in the last ${c.win} min · ${fmt(c.total)} since you opened this channel (${opened} ago). Counted by Chat Watcher from this chat.`
      : `${fmt(c.total)} people chatted since you opened this channel (${opened} ago). Counted by Chat Watcher from this chat.`;
    badge.setAttribute("aria-label", badge.title);
    if (anchor.nextElementSibling !== badge) anchor.after(badge);
  }

  // ---------- mentions & replies to you ----------

  const REPLY_SEL = "[data-test-selector*='reply' i], [data-a-target*='reply' i], [class*='reply-header' i], [class*='replyheader' i]";
  const MENTION_SEL = ".mention-fragment, [data-a-target='chat-message-mention']";

  function myLogin() {
    return TCW.normalize(settings.mentionName) || cookieLogin() || TCW.normalize(paintMe.login);
  }

  function mentionKind(line, me, text) {
    const header = line.querySelector(REPLY_SEL);
    if (header) {
      const m = header.textContent.match(/@([a-z0-9_]{1,25})/i);
      if (m && m[1].toLowerCase() === me) return "reply";
    }
    for (const f of line.querySelectorAll(MENTION_SEL)) {
      if (!header || !header.contains(f)) {
        if (TCW.normalize(f.textContent) === me) return "mention";
      }
    }
    const esc = me.replace(/[^a-z0-9_]/g, "");
    if (esc && new RegExp(`(^|[^a-z0-9_])@${esc}(?![a-z0-9_])`, "i").test(text || "")) return "mention";
    return null;
  }

  function checkMention(line, author, live, text) {
    if (!live || Date.now() < readyAt || !settings.enabled || !settings.mentionAlert) return;
    const me = myLogin();
    if (!me || author.names.includes(me)) return; // your own messages never alert you
    const kind = mentionKind(line, me, text);
    if (!kind) return;
    const now = Date.now();
    const key = "m|" + author.names[0] + "|" + text;
    if (now - (recent.get(key) || 0) < 2500) return; // same row re-rendered
    recent.set(key, now);
    const display = author.display || author.names[0];
    browser.runtime.sendMessage({
      type: "mention", kind, login: author.names[0], display,
      channel: currentChannel(), text, msgId: line.dataset.tcwId || null
    }).then((r) => {
      if (r && r.localSound) playLocal(r.localSound.type, r.localSound.volume);
    }).catch(() => {
      if (settings.sound && settings.mentionSound !== "none") playLocal(settings.mentionSound, settings.volume);
    });
    flashTitle(display, kind === "reply" ? `↩ ${display} replied to you` : `@ ${display} mentioned you`);
  }

  // ---------- per-person history (this page only, kept in memory) ----------

  function remember(author, line, id, text, live) {
    const login = author.names[0];
    let p = people.get(login);
    if (p) people.delete(login); // keep most recently active at the end
    else p = { login, display: login, first: Date.now(), msgs: [] };
    people.set(login, p);
    if (author.display) p.display = author.display;
    p.lastLine = new WeakRef(line);
    for (const n of author.names.slice(1)) aliases.set(n, login);
    p.msgs.push({ id, text, time: Date.now(), channel: currentChannel(), backlog: !live });
    if (p.msgs.length > MAX_MSGS) p.msgs.shift();
    if (people.size > MAX_PEOPLE) people.delete(people.keys().next().value);
    if (card && card.login === login) scheduleCardRender();
  }

  function resolveLogin(name) {
    const n = TCW.normalize(name);
    return people.has(n) ? n : aliases.get(n) || n;
  }

  // ---------- jump to message ----------

  function jumpLocal(id) {
    if (!id) return false;
    const el = document.querySelector(`[data-tcw-id="${CSS.escape(id)}"]`);
    if (!el || !el.isConnected) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("tcw-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("tcw-flash");
    setTimeout(() => el.classList.remove("tcw-flash"), 2400);
    return true;
  }

  // ---------- nametag paints ----------
  // Own paint comes from the local library (shows even if unpublished — only on your screen).
  // Everyone else's comes from the background page, which batches and caches server lookups.

  const PAINT_TARGET_SEL = ".chat-author__display-name, [data-a-target='chat-message-username'], .seventv-chat-user-username";
  const REMOTE_TTL = 15 * 60 * 1000;
  let paintLib = [];
  let paintMe = {};
  let paintHidden = new Set();
  const remotePaints = new Map(); // login -> { paint|null, t }
  const paintQueue = new Set();
  const paintPending = new Set();
  const lineLogin = new WeakMap(); // chat row -> author login
  const paintKeys = new WeakMap(); // paint object -> comparison key
  let paintTimer = 0;

  function cookieLogin() {
    const m = document.cookie.match(/(?:^|;\s*)login=([a-z0-9_]{1,25})(?:;|$)/i);
    return m ? m[1].toLowerCase() : "";
  }

  function selfLogin() {
    return String(paintMe.login || cookieLogin() || "").toLowerCase();
  }

  function activePaint() {
    const id = paintMe.activeId;
    if (!id) return null;
    return paintLib.find((p) => p.id === id) || TCWPaint.PRESETS.find((p) => p.id === id) || null;
  }

  function theme() {
    return document.documentElement.classList.contains("tw-root--theme-light") ? "light" : "dark";
  }

  function animateOK() {
    return settings.paintsAnimate !== false;
  }

  function paintFor(login, noFetch) {
    if (!settings.paintsOn || !login || paintHidden.has(login)) return null;
    if (login === selfLogin()) {
      const mine = activePaint();
      if (mine) return mine;
    }
    if (!settings.paintsOthers) return null;
    const r = remotePaints.get(login);
    if (!noFetch && (!r || Date.now() - r.t > REMOTE_TTL)) queuePaint(login);
    return r ? r.paint : null;
  }

  function queuePaint(login) {
    if (paintPending.has(login)) return;
    paintQueue.add(login);
    if (!paintTimer) paintTimer = setTimeout(flushPaints, 400);
  }

  async function flushPaints() {
    paintTimer = 0;
    const logins = [...paintQueue].slice(0, 300);
    logins.forEach((l) => { paintQueue.delete(l); paintPending.add(l); });
    if (paintQueue.size) paintTimer = setTimeout(flushPaints, 400);
    if (!logins.length) return;
    let res = {};
    try {
      res = (await browser.runtime.sendMessage({ type: "paints:lookup", logins })) || {};
    } catch (e) {
      debug("paint lookup failed", e);
    }
    const now = Date.now();
    const changed = new Set();
    for (const l of logins) {
      paintPending.delete(l);
      const p = Object.prototype.hasOwnProperty.call(res, l) && res[l] ? TCWPaint.sanitize(res[l]) : null;
      const before = remotePaints.get(l);
      remotePaints.set(l, { paint: p, t: now });
      if ((before && before.paint ? keyOf(before.paint) : "") !== (p ? keyOf(p) : "")) changed.add(l);
    }
    if (remotePaints.size > 3000) {
      for (const k of remotePaints.keys()) {
        remotePaints.delete(k);
        if (remotePaints.size <= 2500) break;
      }
    }
    if (changed.size) repaint(changed);
  }

  function keyOf(paint) {
    let k = paintKeys.get(paint);
    if (k === undefined) {
      k = TCWPaint.key(paint);
      paintKeys.set(paint, k);
    }
    return k;
  }

  function sevenTvPainted(el) {
    if (el.classList.contains("tcw-paint")) return false;
    const bg = getComputedStyle(el).backgroundImage;
    return !!bg && bg !== "none";
  }

  function paintLine(line, login) {
    const target = firstGood(line, PAINT_TARGET_SEL);
    if (!target) return;
    const paint = paintFor(login);
    if (!paint) {
      if (target.classList.contains("tcw-paint")) {
        TCWPaint.clear(target);
        delete target.dataset.tcwPaint;
      }
      return;
    }
    const k = keyOf(paint) + "|" + theme() + "|" + animateOK();
    if (target.dataset.tcwPaint === k && target.classList.contains("tcw-paint")) return; // already done
    if (settings.paints7tvWins && sevenTvPainted(target)) return;
    TCWPaint.apply(target, paint, { theme: theme(), animate: animateOK() });
    target.dataset.tcwPaint = k;
  }

  function repaint(onlyLogins) {
    for (const line of tracked) {
      if (!line.isConnected) continue;
      const login = lineLogin.get(line);
      if (!login || (onlyLogins && !onlyLogins.has(login))) continue;
      paintLine(line, login);
    }
    if (card && (!onlyLogins || onlyLogins.has(card.login))) scheduleCardRender();
  }

  function setPaintState(d) {
    if ("paintLib" in d) paintLib = (Array.isArray(d.paintLib) ? d.paintLib : []).map(TCWPaint.sanitizeEntry).filter(Boolean);
    if ("paintMe" in d) paintMe = d.paintMe && typeof d.paintMe === "object" ? d.paintMe : {};
    if ("paintHidden" in d) paintHidden = new Set(Array.isArray(d.paintHidden) ? d.paintHidden : []);
  }

  // ---------- profile card ----------

  // Card styles live in content.css (an extension stylesheet the page can't block).

  let card = null; // { login, display, anchor, host, root, box }
  let cardRaf = 0;

  function closeCard() {
    if (!card) return;
    card.host.remove();
    card = null;
  }

  function scheduleCardRender() {
    if (cardRaf) return;
    cardRaf = requestAnimationFrame(() => {
      cardRaf = 0;
      renderCard();
    });
  }

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") for (const [prop, val] of Object.entries(v)) e.style.setProperty(prop, val);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : String(kid));
    return e;
  }

  function clockTime(t) {
    return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  async function openCard(login, display, anchor, x, y) {
    closeCard();
    const host = el("div", { id: "tcw-card-host" });
    const box = el("div", { class: "tcw-c", role: "dialog", "aria-label": "Chat Watcher profile", tabindex: "-1" });
    host.append(box);
    (document.body || document.documentElement).append(host);
    card = { login, display, anchor, host, box, log: [], watch: null };
    renderCard();
    place(x, y);
    browser.runtime.sendMessage({ type: "watch:get", channel: login }).then((w) => {
      if (card && card.login === login && w && w.total >= 60) {
        card.watch = w;
        scheduleCardRender();
      }
    }).catch(() => {});
    try {
      const d = await browser.storage.local.get("log");
      if (card && card.login === login) {
        card.log = (d.log || []).filter((e) => e.login === login);
        renderCard();
      }
    } catch (e) { /* ignore */ }
  }

  function place(x, y) {
    const r = card.box.getBoundingClientRect();
    const left = Math.max(8, Math.min(x + 14, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(y - 24, window.innerHeight - r.height - 8));
    card.box.style.left = left + "px";
    card.box.style.top = top + "px";
  }

  function nameColor(line) {
    if (!line) return "";
    const n = line.querySelector(".chat-author__display-name, [data-a-target='chat-message-username'], .seventv-chat-user-username") ||
      line.querySelector(NAME_SEL);
    return n ? getComputedStyle(n).color : "";
  }

  function badgeClones(line) {
    if (!line) return [];
    return [...line.querySelectorAll("img.chat-badge, [data-a-target='chat-badge'] img, .chat-badge img")]
      .slice(0, 6)
      .map((img) => {
        // copy only the picture itself, never other attributes from the page
        const c = document.createElement("img");
        const src = img.getAttribute("src") || "";
        if (/^https:\/\//i.test(src)) c.src = src;
        const srcset = img.getAttribute("srcset");
        if (srcset && /^https:\/\//i.test(srcset.trim())) c.srcset = srcset;
        c.alt = img.alt || "";
        c.title = img.alt || "";
        c.referrerPolicy = "no-referrer";
        return c;
      })
      .filter((c) => c.src);
  }

  function openTwitchCard() {
    let target = card.anchor && card.anchor.isConnected ? card.anchor : null;
    if (!target) {
      const p = people.get(card.login);
      const line = p && p.lastLine && p.lastLine.deref();
      target = line && line.isConnected ? line.querySelector(NAME_SEL) : null;
    }
    closeCard();
    if (!target) return toast("Their name isn't in chat right now");
    bypassClick = true;
    try { target.click(); } finally { bypassClick = false; }
  }

  function renderCard() {
    if (!card) return;
    const { login, box } = card;
    const p = people.get(login);
    const watched = users.get(login);
    const line = p && p.lastLine ? p.lastLine.deref() : null;
    const liveLine = line && line.isConnected ? line : null;
    const display = (p && p.display) || card.display || login;
    const color = nameColor(liveLine);

    // merge this page's messages with the saved activity log (other channels/tabs)
    const items = [];
    const ids = new Set();
    for (const m of p ? p.msgs : []) {
      items.push({ ...m, local: true });
      ids.add(m.id);
    }
    for (const e of card.log) {
      if (e.msgId && ids.has(e.msgId)) continue;
      items.push({ id: e.msgId, text: e.text, time: e.time, channel: e.channel, target: e });
    }
    items.sort((a, b) => b.time - a.time);

    const here = p ? p.msgs.length : 0;
    const metaBits = [];
    metaBits.push(here ? `${here} message${here === 1 ? "" : "s"} on this page` : "No messages on this page yet");
    if (p && here) metaBits.push(`first seen ${TCW.ago(p.first)}`);
    if (card.watch) metaBits.push(`you've watched them ${TCW.duration(card.watch.total)}`);

    const nameSpan = el("span", { class: "tcw-c-name", title: display }, display);
    const cardPaint = paintFor(login, true);
    if (cardPaint) TCWPaint.apply(nameSpan, cardPaint, { theme: "dark", animate: animateOK() });
    else if (color) nameSpan.style.color = color;

    const actions = [];
    if (watched) {
      const swatch = el("input", { type: "color", class: "tcw-c-swatch", value: watched.color, title: "Highlight color", "aria-label": "Highlight color" });
      swatch.addEventListener("change", () =>
        browser.runtime.sendMessage({ type: "updateUser", login, patch: { color: swatch.value } }));
      actions.push(swatch, el("button", {
        class: "tcw-c-btn",
        onclick: () => browser.runtime.sendMessage({ type: "removeUser", login })
      }, "Unwatch"));
    } else {
      actions.push(el("button", {
        class: "tcw-c-btn tcw-c-primary",
        onclick: () => browser.runtime.sendMessage({ type: "addUsers", names: [display] })
      }, "★ Watch"));
    }
    if (cardPaint || paintHidden.has(login)) {
      const hidden = paintHidden.has(login);
      actions.push(el("button", {
        class: "tcw-c-btn",
        title: hidden ? "Show this person's nametag paint again" : "Stop showing this person's nametag paint",
        onclick: () => browser.runtime.sendMessage({ type: "paints:hide", login, hidden: !hidden })
      }, hidden ? "Show paint" : "Hide paint"));
    }
    actions.push(
      el("button", { class: "tcw-c-btn", onclick: openTwitchCard, title: "Open Twitch's own card (mod tools, follow, gift)" }, "Twitch card"),
      el("button", {
        class: "tcw-c-btn",
        onclick: () => window.open("https://www.twitch.tv/" + encodeURIComponent(login), "_blank", "noopener")
      }, "Channel ↗")
    );

    const hist = el("div", { class: "tcw-c-hist" });
    if (!items.length) {
      hist.append(el("div", { class: "tcw-c-empty" }, "Nothing from them since this page opened."));
    }
    const chan = currentChannel();
    for (const m of items) {
      const inPage = m.local && document.querySelector(`[data-tcw-id="${CSS.escape(m.id)}"]`);
      const canJump = inPage || (!m.local && m.target);
      const row = el("div", {
        class: "tcw-c-msg" + (canJump ? " tcw-c-live" : " tcw-c-gone"),
        title: inPage ? "Jump to message" : m.local ? "Scrolled out of chat" : m.channel ? `Go to #${m.channel}` : ""
      },
        el("span", { class: "tcw-c-t" }, m.backlog ? "earlier" : clockTime(m.time)),
        m.channel && m.channel !== chan ? el("span", { class: "tcw-c-ch" }, "#" + m.channel) : null,
        m.text || "—"
      );
      if (inPage) row.addEventListener("click", () => jumpLocal(m.id));
      else if (canJump) row.addEventListener("click", () => {
        if (!jumpLocal(m.id)) browser.runtime.sendMessage({ type: "jump", target: m.target });
      });
      hist.append(row);
    }

    const keepScroll = box.querySelector(".tcw-c-hist") ? box.querySelector(".tcw-c-hist").scrollTop : 0;
    box.replaceChildren(
      el("div", { class: "tcw-c-head" },
        el("span", { class: "tcw-c-badges" }, badgeClones(liveLine)),
        nameSpan,
        TCW.normalize(display) !== login ? el("span", { class: "tcw-c-login" }, "(" + login + ")") : null,
        el("button", { class: "tcw-c-btn tcw-c-icon tcw-c-x", title: "Close (Esc)", "aria-label": "Close", onclick: closeCard }, "✕")
      ),
      el("div", { class: "tcw-c-meta" },
        watched ? el("span", { class: "tcw-c-star", style: { "--c": watched.color } },
          `★ Watching · ${watched.hits || 0} total${watched.enabled ? "" : " (paused)"}`) : null,
        watched ? el("br") : null,
        metaBits.join(" · ")
      ),
      watched && watched.note ? el("div", { class: "tcw-c-note" }, watched.note) : null,
      el("div", { class: "tcw-c-actions" }, actions),
      el("div", { class: "tcw-c-hist-head" }, "Recent messages"),
      hist
    );
    hist.scrollTop = keepScroll;
    enableDrag(box.querySelector(".tcw-c-head"));
  }

  function enableDrag(handle) {
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      const box = card.box;
      const r = box.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev) => {
        box.style.left = Math.max(0, Math.min(ev.clientX - dx, window.innerWidth - r.width)) + "px";
        box.style.top = Math.max(0, Math.min(ev.clientY - dy, window.innerHeight - 40)) + "px";
      };
      const up = () => {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mouseup", up, true);
      };
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mouseup", up, true);
    });
  }

  function findChatRow(node) {
    const line = node.closest(LINE_SEL);
    if (line) return line;
    for (let p = node; p; p = p.parentElement) if (seen.has(p)) return p;
    return null;
  }

  function onNameClick(e) {
    if (bypassClick || settings.cardTrigger === "off" || e.button !== 0) return;
    const wantMod = settings.cardTrigger === "ctrl";
    if (wantMod !== (e.ctrlKey || e.metaKey)) return;
    const t = e.target instanceof Element ? e.target : e.target && e.target.parentElement;
    if (!t || (card && card.host.contains(t))) return;

    let login = null;
    let display = null;
    let anchor = null;
    const mention = t.closest(".mention-fragment, [data-a-target='chat-message-mention']");
    if (mention && findChatRow(mention)) {
      display = mention.textContent.trim().replace(/^@/, "");
      login = resolveLogin(display);
      anchor = null;
    } else {
      const nameEl = t.closest(NAME_SEL + ", .chat-line__username");
      if (!nameEl) return;
      const line = findChatRow(nameEl);
      if (!line || isSkipped(nameEl, line)) return;
      const a = getAuthor(line);
      if (!a.names.length) return;
      login = a.names[0];
      display = a.display;
      anchor = nameEl;
    }
    if (!login) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openCard(login, display, anchor, e.clientX, e.clientY);
  }

  window.addEventListener("click", onNameClick, true);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && card) closeCard(); }, true);
  window.addEventListener("mousedown", (e) => {
    if (card && !e.composedPath().includes(card.host)) closeCard();
  }, true);

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
      const author = getAuthor(line);
      evaluate(line, author, false);
      if (author.names.length) {
        lineLogin.set(line, author.names[0]);
        paintLine(line, author.names[0]);
      }
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

  // ---------- watch time ----------
  // Every few seconds: if the main stream video on a channel page is playing, tell the background.
  // The background does the counting (one clock per channel, even with several tabs open).

  const WATCH_BEAT = (globalThis.TCW_WATCH_TUNING && globalThis.TCW_WATCH_TUNING.beat) || 5000;
  const VIEWERS_SEL = "[data-a-target='animated-channel-viewers-count'], [data-a-target='channel-viewers-count']";
  let watchWasPlaying = false;

  function watchChannel() {
    const parts = location.pathname.split("/").filter(Boolean).map((p) => p.toLowerCase());
    if (parts.length === 1 && !RESERVED.has(parts[0]) && /^[a-z0-9_]{1,25}$/.test(parts[0])) return parts[0];
    if (parts[0] === "moderator" && parts.length === 2 && /^[a-z0-9_]{1,25}$/.test(parts[1])) return parts[1];
    return "";
  }

  // The stream player is by far the biggest <video> on the page; hover previews are small.
  function mainVideo() {
    let best = null;
    let bestArea = 200 * 110;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area >= bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function channelDisplay(ch) {
    const el = document.querySelector(".channel-info-content h1, [data-a-target='stream-info-card-component'] h1, h1.tw-title");
    const t = el ? el.textContent.trim() : "";
    return TCW.normalize(t) === ch ? t : "";
  }

  async function watchBeat() {
    const ch = watchChannel();
    const v = ch && settings.watchTrack ? mainVideo() : null;
    const playing = !!v && !v.paused && !v.ended && v.readyState >= 2 && !(settings.watchVisibleOnly && document.hidden);
    try {
      if (playing) {
        await browser.runtime.sendMessage({ type: "watch:beat", channel: ch, live: !!document.querySelector(VIEWERS_SEL), display: channelDisplay(ch) });
      } else if (watchWasPlaying) {
        await browser.runtime.sendMessage({ type: "watch:stop" });
      }
    } catch (e) { /* background restarting */ }
    watchWasPlaying = playing;
    updateChattersBadge(currentChannel());
    updateWatchBadge(ch);
  }

  async function updateWatchBadge(ch) {
    let badge = document.getElementById("tcw-watch-badge");
    const anchor = ch && settings.watchBadge && settings.watchTrack ? document.querySelector(VIEWERS_SEL) : null;
    if (!anchor) {
      if (badge) badge.remove();
      return;
    }
    let info = null;
    try { info = await browser.runtime.sendMessage({ type: "watch:get", channel: ch }); } catch (e) { /* ignore */ }
    if (!info) return;
    if (!badge) badge = el("span", { id: "tcw-watch-badge", class: "tcw-watch" });
    const name = info.display || ch;
    badge.textContent = "⏱ " + TCW.duration(info.total);
    badge.title = `Your watch time on ${name}: ${TCW.duration(info.total)} total, ${TCW.duration(info.today)} today (Chat Watcher)`;
    badge.setAttribute("aria-label", badge.title);
    const after = document.getElementById("tcw-chatters-badge");
    const ref = after && after.previousElementSibling === anchor ? after : anchor;
    if (ref.nextElementSibling !== badge) ref.after(badge);
  }

  if (IS_TOP) {
    setInterval(watchBeat, WATCH_BEAT);
    window.addEventListener("pagehide", () => {
      if (watchWasPlaying) browser.runtime.sendMessage({ type: "watch:stop" }).catch(() => {});
    });
  }

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
    if (msg.type === "jump") return Promise.resolve(jumpLocal(msg.msgId));
  });

  browser.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.paintLib || ch.paintMe || ch.paintHidden) {
      const d = {};
      for (const k of ["paintLib", "paintMe", "paintHidden"]) if (ch[k]) d[k] = ch[k].newValue;
      setPaintState(d);
      repaint(null);
    }
    if (!(ch.settings || ch.users || ch.log)) return;
    if (card && ch.log) {
      card.log = (ch.log.newValue || []).filter((e) => e.login === card.login);
      scheduleCardRender();
    }
    if (!(ch.settings || ch.users)) return;
    if (ch.settings) {
      const before = settings.paintServer;
      settings = { ...TCW.DEFAULT_SETTINGS, ...(ch.settings.newValue || {}) };
      if (settings.paintServer !== before) remotePaints.clear();
    }
    if (ch.users) {
      setUsers(ch.users.newValue);
      if (card) scheduleCardRender();
    }
    updateAllow();
    if (ch.settings && IS_TOP) {
      updateChattersBadge(currentChannel());
      updateWatchBadge(watchChannel());
    }
    const sig = makeSig();
    if (sig !== signature) {
      signature = sig;
      rescan();
    }
  });

  browser.storage.local.get(["settings", "users", "paintLib", "paintMe", "paintHidden"]).then((d) => {
    settings = { ...TCW.DEFAULT_SETTINGS, ...(d.settings || {}) };
    setUsers(d.users);
    setPaintState({ paintLib: d.paintLib, paintMe: d.paintMe, paintHidden: d.paintHidden });
    const detected = cookieLogin();
    if (IS_TOP && detected) {
      browser.storage.local.get("twitchSelf").then((x) => {
        if (x.twitchSelf !== detected) browser.storage.local.set({ twitchSelf: detected });
      }).catch(() => {});
    }
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
