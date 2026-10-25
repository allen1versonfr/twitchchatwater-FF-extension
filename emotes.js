/* Emotes: 7TV, BTTV and FFZ emotes in chat (incl. 7TV personal emotes and live updates), the emote menu
 * (favorites, recent, most used, popular in chat, channel and global emotes),
 * ":" suggestions, Tab completion carousel, emote-spam "join in" button and Up/Down message history. */
(() => {
  "use strict";
  const C = globalThis.TCWChat;
  if (!C || C.emotes) return;
  const L = TCWChatLib;
  const I = () => C.input;
  const S = () => C.settings;

  const TWITCH_EMOTE_SEL = "img.chat-line__message--emote, img.chat-image:not(.chat-badge), .chat-line__message--emote-button img";
  const SEVEN_SKIP_SEL = "a, .mention-fragment, [data-a-target='chat-message-mention'], .tcw-emote-wrap, .tcw-recovered";

  let seven = { channel: new Map(), global: new Map(), ch: "" }; // all providers, despite the name
  let personal = new Map(); // twitch login -> Map(name -> emote)   (7TV personal emotes)
  let favs = [];
  let recent = [];
  let stats = {};
  const twitchSeen = new Map(); // name -> src (emotes seen in chat this session)
  let popular = new Map(); // name -> { n, src, p, last }  (this channel, this session)
  let navAt = Date.now();
  let contextEmote = null;
  const spam = L.spamDetector();

  const el = (...a) => C.el(...a);
  const httpsSrc = (s) => (/^https:\/\//i.test(String(s || "")) ? String(s) : "");

  // ---------- catalog ----------

  const PROVIDER = { "7tv": "7TV", bttv: "BTTV", ffz: "FFZ" };

  // Channel emotes win, then the sender's personal 7TV emotes, then global ones.
  function sevenGet(name, login) {
    const own = login && personal.get(login);
    return seven.channel.get(name) || (own && own.get(name)) || seven.global.get(name) || null;
  }

  function sevenSrc(e, size = 1) {
    if (Array.isArray(e.s)) return e.s[size <= 1 ? 0 : size <= 2 ? 1 : 2];
    return `${e.u}/${size}x.webp`;
  }

  function providerOf(e) {
    return e.p || "7tv";
  }

  function favSet() {
    return new Set(favs.map((f) => f.name));
  }

  // Everything we can suggest: { name, src, p, tag }
  function catalog() {
    const out = new Map();
    const add = (name, src, p, tag) => { if (name && !out.has(name)) out.set(name, { name, src, p, tag }); };
    for (const f of favs) add(f.name, f.src, f.p, "★");
    for (const e of seven.channel.values()) add(e.n, sevenSrc(e), providerOf(e), PROVIDER[providerOf(e)]);
    const mine = personal.get(C.myLogin());
    if (mine) for (const e of mine.values()) add(e.n, sevenSrc(e), "7tv", "7TV personal");
    for (const e of seven.global.values()) add(e.n, sevenSrc(e), providerOf(e), PROVIDER[providerOf(e)] + " global");
    for (const [n, s] of Object.entries(stats)) add(n, s.src, s.p, "used");
    for (const [n, src] of twitchSeen) add(n, src, "twitch", "seen in chat");
    return out;
  }

  function search(q, limit) {
    if (!q) return [];
    const lq = q.toLowerCase();
    const fav = favSet();
    const scored = [];
    for (const e of catalog().values()) {
      const ln = e.name.toLowerCase();
      let score;
      if (e.name.startsWith(q)) score = 0;
      else if (ln.startsWith(lq)) score = 1;
      else if (ln.includes(lq)) score = 2;
      else continue;
      const uses = stats[e.name] ? stats[e.name].n : 0;
      scored.push({ e, score, uses, fav: fav.has(e.name) ? 0 : 1 });
    }
    scored.sort((a, b) => a.score - b.score || a.fav - b.fav || b.uses - a.uses || a.e.name.length - b.e.name.length);
    return scored.slice(0, limit).map((x) => x.e);
  }

  // ---------- 7TV / BTTV / FFZ in chat ----------

  function anyProvider() {
    return S().emotes7tv || S().emotesBttv || S().emotesFfz;
  }

  function sevenActive() {
    return anyProvider() && (seven.channel.size || seven.global.size || personal.size) && !document.querySelector(".seventv-chat-list, .seventv-message");
  }

  function emoteNode(e) {
    const img = el("img", {
      class: "tcw-emote", alt: e.n, src: sevenSrc(e, 1), srcset: `${sevenSrc(e, 1)} 1x, ${sevenSrc(e, 2)} 2x, ${sevenSrc(e, 4)} 4x`,
      loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", draggable: "false",
      "data-tcw-p": providerOf(e), "data-tcw-zw": e.z ? "1" : null
    });
    img.style.setProperty("--tcw-ew", e.w + "px");
    img.style.setProperty("--tcw-eh", e.h + "px");
    return el("span", { class: "tcw-emote-wrap" + (e.z ? " tcw-zw" : "") }, img);
  }

  function textFragments(line) {
    const body = line.querySelectorAll("[data-a-target='chat-message-text'], .text-fragment");
    if (body.length) return [...body];
    const b = line.querySelector(C.BODY_SEL);
    return b ? [b] : [];
  }

  function render7tv(line) {
    if (!sevenActive() || line.closest(".seventv-message")) return;
    const login = C.loginOf(line);
    for (const frag of textFragments(line)) {
      const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) if (!n.parentElement.closest(SEVEN_SKIP_SEL)) nodes.push(n);
      for (const node of nodes) {
        const parts = node.data.split(/(\s+)/);
        if (!parts.some((p) => p && sevenGet(p, login))) continue;
        const out = document.createDocumentFragment();
        let lastEmote = null;
        let buf = "";
        for (const p of parts) {
          const e = p && !/^\s+$/.test(p) ? sevenGet(p, login) : null;
          if (!e) {
            buf += p;
            if (p && !/^\s+$/.test(p)) lastEmote = null;
            continue;
          }
          if (e.z && lastEmote) { // zero-width emotes stack on the emote before them
            lastEmote.append(emoteNode(e).firstChild);
            lastEmote.classList.add("tcw-stack");
            continue;
          }
          if (buf) { out.append(buf); buf = ""; }
          lastEmote = emoteNode(e);
          out.append(lastEmote);
        }
        if (buf) out.append(buf);
        node.replaceWith(out);
      }
    }
  }

  // Turns shown emotes back into their names (when a provider is switched off or an emote removed).
  function unrender7tv(onlyLogin) {
    for (const wrap of document.querySelectorAll(".tcw-emote-wrap")) {
      if (onlyLogin) {
        const line = C.findChatRow(wrap);
        if (!line || C.loginOf(line) !== onlyLogin) continue;
      }
      const names = [...wrap.querySelectorAll("img.tcw-emote")].map((i) => i.alt).join(" ");
      wrap.replaceWith(document.createTextNode(names));
    }
    for (const frag of document.querySelectorAll("[data-a-target='chat-message-text'], .text-fragment")) frag.normalize();
  }

  function rerender7tv(onlyLogin) {
    for (const line of C.lines()) if (line.isConnected && (!onlyLogin || C.loginOf(line) === onlyLogin)) render7tv(line);
  }

  async function load7tv(ch) {
    seven = { channel: new Map(), global: seven.global, ch };
    if (!ch || !anyProvider()) return;
    try {
      const r = await browser.runtime.sendMessage({ type: "emotes:get", channel: ch });
      if (r) apply7tv(ch, r);
    } catch (e) { /* background restarting; it pushes the list when ready */ }
  }

  function apply7tv(ch, r) {
    if (ch !== C.currentChannel()) return;
    const before = seven;
    seven = {
      ch,
      channel: new Map((r.emotes || []).map((e) => [e.n, e])),
      global: new Map((r.global || []).map((e) => [e.n, e]))
    };
    if (r.personal && typeof r.personal === "object") {
      personal = new Map(Object.entries(r.personal).map(([login, list]) => [login, new Map((list || []).map((e) => [e.n, e]))]));
    }
    C.debug("emotes", ch, seven.channel.size, "channel,", seven.global.size, "global,", personal.size, "personal sets");
    // an emote that's gone (or now means something else) goes back to plain text first
    const gone = [...before.channel.keys(), ...before.global.keys()].some((n) => !seven.channel.has(n) && !seven.global.has(n));
    if (gone && before.ch === ch) unrender7tv();
    rerender7tv();
    if (menu) renderMenu();
    if (Array.isArray(r.changes) && r.changes.length && S().emoteLive) announce(r.changes);
  }

  function applyPersonal(login, list) {
    if (!/^[a-z0-9_]{1,25}$/.test(login || "")) return;
    const had = personal.has(login);
    if (list && list.length) {
      personal.delete(login);
      personal.set(login, new Map(list.map((e) => [e.n, e])));
      if (personal.size > 1000) personal.delete(personal.keys().next().value);
    } else {
      personal.delete(login);
    }
    if (had) unrender7tv(login);
    rerender7tv(login);
  }

  // "7TV: added catJAM · removed KEKW" as a line in chat
  function announce(changes) {
    const bits = [];
    for (const c of changes.slice(0, 3)) {
      const parts = [];
      if (c.added && c.added.length) parts.push("added " + c.added.slice(0, 8).join(", ") + (c.added.length > 8 ? ` +${c.added.length - 8}` : ""));
      if (c.removed && c.removed.length) parts.push("removed " + c.removed.slice(0, 8).join(", ") + (c.removed.length > 8 ? ` +${c.removed.length - 8}` : ""));
      if (parts.length) bits.push(`${c.p}: ${parts.join(" · ")}`);
    }
    if (bits.length && C.tools && C.tools.notice) C.tools.notice("🆕 " + bits.join("  |  "));
  }

  // ---------- emotes in a message ----------

  function lineEmotes(line) {
    const out = [];
    for (const img of line.querySelectorAll(TWITCH_EMOTE_SEL + ", img.tcw-emote")) {
      if (img.closest(".chat-badge, [data-a-target='chat-badge'], .tcw-recovered")) continue;
      const name = (img.getAttribute("alt") || "").trim();
      if (!name || /\s/.test(name) || name.length > 100) continue;
      const p = img.classList.contains("tcw-emote") ? img.dataset.tcwP || "7tv" : "twitch";
      out.push({ name, src: httpsSrc(img.getAttribute("src")), p });
    }
    return out;
  }

  function onLine(line, info) {
    render7tv(line);
    if (!info.live) return;
    const found = lineEmotes(line);
    if (!found.length) return;
    const me = C.myLogin();
    const mine = !!me && info.login === me;
    for (const e of found) {
      if (e.p === "twitch" && e.src) {
        twitchSeen.delete(e.name);
        twitchSeen.set(e.name, e.src);
        if (twitchSeen.size > 1500) twitchSeen.delete(twitchSeen.keys().next().value);
      }
      const pop = popular.get(e.name) || { n: 0, src: e.src, p: e.p, last: 0 };
      pop.n++;
      pop.last = Date.now();
      popular.set(e.name, pop);
    }
    if (popular.size > 2000) {
      const keep = [...popular].sort((a, b) => b[1].n - a[1].n).slice(0, 1000);
      popular = new Map(keep);
    }
    if (Date.now() - navAt < 6000) return; // history Twitch loads when you open a channel
    if (mine) {
      browser.runtime.sendMessage({ type: "emotes:used", emotes: found }).catch(() => {});
      return;
    }
    if (S().emoteSpam && S().enabled) {
      spam.opts.minMessages = Math.max(2, Number(S().spamMin) || 6);
      spam.opts.minUsers = Math.max(1, Math.min(spam.opts.minMessages, Number(S().spamUsers) || 4));
      spam.add(found.map((e) => e.name), info.login);
      refreshSpam(spam.active(), found);
    }
  }

  // ---------- floating UI helpers ----------

  function host(id) {
    let h = document.getElementById(id);
    if (!h) {
      h = el("div", { id, class: "tcw-pop-host" });
      (document.body || document.documentElement).append(h);
    }
    return h;
  }

  function placeAbove(box, width) {
    const a = I().popupAnchor();
    const w = Math.min(width, window.innerWidth - 16);
    box.style.width = w + "px";
    box.style.left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8)) + "px";
    box.style.bottom = Math.max(8, a.bottom) + "px";
    box.style.maxHeight = Math.max(120, window.innerHeight - Math.max(8, a.bottom) - 8) + "px";
  }

  function emoteImg(e, cls) {
    const src = httpsSrc(e.src);
    return src
      ? el("img", { class: cls || "", src, alt: e.name, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", draggable: "false" })
      : el("span", { class: (cls || "") + " tcw-noimg" }, e.name.slice(0, 3));
  }

  // ---------- emote spam: compact one-click "join in" suggestions ----------
  const SPAM_MAX = 3;
  const INVISIBLE = " \u{E0000}";
  let spamRows = [];
  let spamTimer = 0;
  let spamDismissed = new Set();
  let lastSent = { text: "", t: 0, alt: false };

  function closeSpam() {
    clearTimeout(spamTimer);
    spamTimer = 0;
    spamRows = [];
    spamDismissed.clear();
    const h = document.getElementById("tcw-spam-host");
    if (h) h.replaceChildren();
  }

  function burstSize(row) {
    // Match observed spam volume, capped to 10 emotes and Twitch's message-length limit.
    const byLength = Math.max(1, Math.floor(450 / (String(row.name || "").length + 1)));
    return Math.max(1, Math.min(10, row.count, byLength));
  }

  function spamText(row) {
    return `${row.count} messages · ${row.users} people · sends ${burstSize(row)}×`;
  }

  function refreshSpam(active, found = []) {
    const activeNames = new Set(active.map((x) => x.name));
    for (const name of spamDismissed) if (!activeNames.has(name)) spamDismissed.delete(name);
    const previous = new Map(spamRows.map((r) => [r.name, r]));
    const currentEmotes = new Map(found.map((e) => [e.name, e]));
    spamRows = active.filter((hit) => !spamDismissed.has(hit.name)).slice(0, SPAM_MAX).map((hit) => {
      const old = previous.get(hit.name);
      return {
        name: hit.name,
        e: currentEmotes.get(hit.name) || (old && old.e) || { name: hit.name },
        count: hit.count, users: hit.users, last: hit.last, expiresAt: hit.expiresAt,
        sent: old ? old.sent : 0
      };
    });
    if (!spamRows.length) {
      clearTimeout(spamTimer);
      spamTimer = 0;
      const h = document.getElementById("tcw-spam-host");
      if (h) h.replaceChildren();
      if (!active.length) spamDismissed.clear();
      return;
    }
    renderSpam();
    clearTimeout(spamTimer);
    // Refresh only when the oldest qualifying message expires; avoid repainting/flickering every second.
    const nextExpiry = Math.min(...spamRows.map((row) => row.expiresAt || (Date.now() + 1000)));
    spamTimer = setTimeout(() => refreshSpam(spam.active(), []), Math.max(25, nextExpiry - Date.now()));
  }

  function renderSpam() {
    const h = host("tcw-spam-host");
    if (!spamRows.length) return h.replaceChildren();
    const box = el("div", { class: "tcw-spam", role: "status", "aria-label": "Emotes currently being spammed" },
      spamRows.map((row) => {
        const copies = burstSize(row);
        const pick = el("button", {
          class: "tcw-spam-pick",
          title: `Send ${copies} ${row.name} emote${copies === 1 ? "" : "s"}`,
          "aria-label": `Send ${copies} ${row.name} emotes`
        }, emoteImg(row.e, "tcw-spam-img"),
        el("span", { class: "tcw-spam-copy" },
          el("b", {}, row.name),
          el("small", {}, spamText(row))));
        const dismiss = el("button", { class: "tcw-btn tcw-icon tcw-spam-dismiss", title: "Dismiss", "aria-label": "Dismiss " + row.name }, "×");
        pick.addEventListener("click", () => sendSpam(row, pick));
        dismiss.addEventListener("click", () => {
          spamDismissed.add(row.name);
          spamRows = spamRows.filter((r) => r.name !== row.name);
          renderSpam();
        });
        return el("div", { class: "tcw-spam-row" }, pick, dismiss);
      }));
    h.replaceChildren(box);
    placeAbove(box, 270);
  }

  async function sendSpam(row, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const copies = burstSize(row);
    const text = Array(copies).fill(row.name).join(" ");
    const now = Date.now();
    const repeat = lastSent.text === text && now - lastSent.t < 30000;
    const alt = repeat ? !lastSent.alt : false;
    const message = alt ? text + INVISIBLE : text;
    const r = await I().send(message);
    if (r.ok) {
      lastSent = { text, t: now, alt };
      const current = spamRows.find((x) => x.name === row.name);
      if (current) current.sent = (current.sent || 0) + copies;
    } else if (r.why === "busy" && I().insert(text)) {
      C.toast("Added emote burst to your message; press Enter to send");
    } else if (r.why === "insert") C.toast("Couldn't send the emote; try again");
    else C.toast("Couldn't find the chat box");
    setTimeout(() => { if (btn.isConnected) btn.disabled = false; }, 700);
  }

  // ---------- emote menu ----------

  let menu = null; // { box, q }
  const OPEN_KEY = "tcw-emote-sections";

  function sectionOpen(id) {
    try { return !(JSON.parse(localStorage.getItem(OPEN_KEY) || "{}")[id] === false); } catch (e) { return true; }
  }
  function setSectionOpen(id, open) {
    try {
      const o = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}");
      o[id] = open;
      localStorage.setItem(OPEN_KEY, JSON.stringify(o));
    } catch (e) { /* page storage blocked */ }
  }

  function toggleMenu() {
    if (menu) return closeMenu();
    const h = host("tcw-emote-host");
    const q = el("input", { type: "search", class: "tcw-em-q", placeholder: "Search emotes", spellcheck: "false", "aria-label": "Search emotes" });
    const list = el("div", { class: "tcw-em-list" });
    const box = el("div", { class: "tcw-em", role: "dialog", "aria-label": "Emotes" },
      el("div", { class: "tcw-em-head" }, q, el("button", { class: "tcw-btn tcw-icon", title: "Close", "aria-label": "Close", onclick: closeMenu }, "✕")),
      list,
      el("div", { class: "tcw-em-foot" }, "Click to add · right-click to favorite"));
    h.replaceChildren(box);
    menu = { box, q, list };
    q.addEventListener("input", renderMenu);
    q.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
      if (e.key === "Enter") {
        const first = list.querySelector(".tcw-em-item");
        if (first) first.click();
      }
    });
    renderMenu();
    placeAbove(box, 340);
    q.focus();
  }

  function closeMenu() {
    if (!menu) return;
    menu.box.parentElement.replaceChildren();
    menu = null;
  }

  function pick(e) {
    I().insert(e.name);
  }

  function renderMenu() {
    if (!menu) return;
    const q = menu.q.value.trim();
    const fav = favSet();
    const item = (e) => {
      const b = el("button", { class: "tcw-em-item" + (fav.has(e.name) ? " tcw-fav" : ""), title: e.name + (e.tag ? ` · ${e.tag}` : "") }, emoteImg(e));
      b.addEventListener("click", () => pick(e));
      b.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        browser.runtime.sendMessage({ type: "emotes:fav", emote: { name: e.name, src: e.src, p: e.p } }).catch(() => {});
      });
      return b;
    };
    const sections = [];
    if (q) {
      sections.push(["search", `Matching “${q}”`, search(q, 120)]);
    } else {
      const ch = C.currentChannel();
      sections.push(["fav", "Favorites", favs.map((f) => ({ ...f, tag: "favorite" }))]);
      sections.push(["recent", "Recently used", recent.map((r) => ({ ...r, tag: "recent" }))]);
      sections.push(["top", "Your most used", L.topEmotes(stats, 24).map((s) => ({ ...s, tag: `used ${s.n}×` }))]);
      sections.push(["popular", "Popular in this chat", [...popular].sort((a, b) => b[1].n - a[1].n).slice(0, 24)
        .map(([name, s]) => ({ name, src: s.src, p: s.p, tag: `${s.n}× since you opened the channel` }))]);
      const mine = personal.get(C.myLogin());
      if (mine && mine.size) sections.push(["7tvp", "Your 7TV personal emotes", [...mine.values()].map((e) => ({ name: e.n, src: sevenSrc(e), p: "7tv", tag: "7TV personal" }))]);
      for (const p of ["7tv", "bttv", "ffz"]) {
        const label = PROVIDER[p];
        sections.push([p, ch ? `${label} · ${ch}` : `${label} channel`, [...seven.channel.values()].filter((e) => providerOf(e) === p)
          .map((e) => ({ name: e.n, src: sevenSrc(e), p, tag: label }))]);
      }
      for (const p of ["7tv", "bttv", "ffz"]) {
        const label = PROVIDER[p];
        sections.push([p + "g", `${label} global`, [...seven.global.values()].filter((e) => providerOf(e) === p)
          .map((e) => ({ name: e.n, src: sevenSrc(e), p, tag: label + " global" }))]);
      }
    }
    const keep = menu.list.scrollTop;
    menu.list.replaceChildren(...sections.map(([id, title, items]) => {
      if (!items.length && id !== "fav") return null;
      const open = q || sectionOpen(id);
      const head = el("button", { class: "tcw-em-sec", "aria-expanded": String(!!open) }, (open ? "▾ " : "▸ ") + title, el("span", {}, String(items.length)));
      head.addEventListener("click", () => { setSectionOpen(id, !open); renderMenu(); });
      const grid = open
        ? (items.length ? el("div", { class: "tcw-em-grid" }, items.map(item)) : el("div", { class: "tcw-em-empty" }, "Right-click any emote here or in chat to favorite it."))
        : null;
      return el("div", {}, head, grid);
    }).filter(Boolean));
    if (!q) menu.list.scrollTop = keep;
  }

  function ensureButton() {
    const bar = S().emoteMenu ? I().toolbar() : null;
    const old = document.getElementById("tcw-emote-btn");
    if (!bar) { if (old && !S().emoteMenu) old.remove(); return; }
    if (old && bar.contains(old)) return;
    const b = el("button", { id: "tcw-emote-btn", class: "tcw-tb-btn", title: "Emotes (Chat Watcher)", "aria-label": "Emotes (Chat Watcher)" }, "☺");
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleMenu(); });
    bar.prepend(b);
  }

  // ---------- suggestions (":" and Tab) ----------

  let sug = null; // { mode: "colon"|"tab", items, idx, info?, box }

  function closeSug() {
    if (!sug) return;
    const h = document.getElementById("tcw-sug-host");
    if (h) h.replaceChildren();
    sug = null;
  }

  function drawSug() {
    const h = host("tcw-sug-host");
    if (!sug || !sug.items.length) return closeSug();
    const box = el("div", { class: "tcw-sug tcw-sug-" + sug.mode, role: "listbox", "aria-label": "Emote suggestions" },
      sug.items.map((e, i) => {
        const row = el("div", { class: "tcw-sug-item" + (i === sug.idx ? " tcw-on" : ""), role: "option", "aria-selected": String(i === sug.idx) },
          emoteImg(e), el("span", { class: "tcw-sug-name" }, e.name), e.tag ? el("small", {}, e.tag) : null);
        row.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          if (sug.mode === "colon") { sug.idx = i; return acceptColon(); }
          const info = I().wordBefore();
          if (info && info.word === sug.current) I().replaceWord(info, e.name + " ");
          closeSug();
        });
        return row;
      }),
      el("div", { class: "tcw-sug-hint" }, sug.mode === "tab" ? "Tab / Shift+Tab to cycle" : "↑↓ to pick · Tab or Enter to insert · Esc to close"));
    h.replaceChildren(box);
    placeAbove(box, sug.mode === "tab" ? 300 : 280);
    const on = box.querySelector(".tcw-on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }

  function updateColon() {
    if (!S().emoteColon) return;
    const info = I().wordBefore();
    const m = info && /^:([^\s:]{2,})$/.exec(info.word);
    if (!m) { if (sug && sug.mode === "colon") closeSug(); return; }
    const items = search(m[1], 10);
    if (!items.length) { closeSug(); return; }
    sug = { mode: "colon", items, idx: 0 };
    drawSug();
  }

  function acceptColon() {
    if (!sug) return;
    const e = sug.items[sug.idx];
    const info = I().wordBefore();
    closeSug();
    if (e && info && info.word.startsWith(":")) I().replaceWord(info, e.name + " ");
  }

  function tabComplete(back) {
    if (sug && sug.mode === "tab") {
      const n = sug.items.length;
      sug.idx = (sug.idx + (back ? -1 : 1) + n) % n;
      const info = I().wordBefore();
      if (info && info.word === sug.current) I().replaceWord(info, sug.items[sug.idx].name);
      sug.current = sug.items[sug.idx].name;
      drawSug();
      return true;
    }
    const info = I().wordBefore();
    if (!info || !info.word || info.word.length < 2 || info.word.startsWith("@") || info.word.startsWith("/")) return false;
    const items = search(info.word.replace(/^:/, ""), 30);
    if (!items.length || (items.length === 1 && items[0].name === info.word)) return false;
    sug = { mode: "tab", items, idx: back ? items.length - 1 : 0 };
    sug.current = items[sug.idx].name;
    I().replaceWord(info, sug.current);
    drawSug();
    return true;
  }

  // ---------- message history (Up / Down) ----------

  const history = [];
  let histPos = -1;

  function twitchListOpen() {
    for (const lb of document.querySelectorAll("[role='listbox']")) {
      if (!lb.closest("[id^='tcw-']") && lb.getBoundingClientRect().height > 0) return true;
    }
    return false;
  }

  function onKey(e) {
    if (!I() || !I().isBox(e.target)) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (sug && sug.mode === "colon") {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        sug.idx = (sug.idx + (e.key === "ArrowDown" ? 1 : -1) + sug.items.length) % sug.items.length;
        drawSug();
        return stop();
      }
      if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey) { stop(); return acceptColon(); }
      if (e.key === "Escape") { stop(); return closeSug(); }
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && S().emoteTab) {
      if (tabComplete(e.shiftKey)) return stop();
    } else if (sug && sug.mode === "tab" && e.key !== "Shift") {
      closeSug();
      if (e.key === "Escape") return stop();
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const v = I().value().trim();
      if (v) {
        if (history[0] !== v) history.unshift(v);
        if (history.length > 50) history.length = 50;
      }
      histPos = -1;
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && S().inputHistory && !e.shiftKey && !e.altKey && !e.ctrlKey && history.length) {
      const v = I().value().trim();
      if (twitchListOpen()) return;
      if (v && !(histPos >= 0 && history[histPos] === v)) return; // you're editing something else
      const next = histPos + (e.key === "ArrowUp" ? 1 : -1);
      if (next >= history.length) return stop();
      stop();
      histPos = next;
      I().set(next < 0 ? "" : history[next]);
    }
  }

  // ---------- emote tooltip ----------

  let tip = null;

  function showTip(img) {
    const name = img.alt;
    const row = C.findChatRow(img);
    const login = row ? C.loginOf(row) : "";
    const e = sevenGet(name, login);
    if (!e) return;
    const label = PROVIDER[providerOf(e)];
    const where = seven.channel.get(name) === e ? "channel emote" : seven.global.get(name) === e ? "global emote" : `personal emote of ${login}`;
    const h = host("tcw-tip-host");
    const box = el("div", { class: "tcw-etip" },
      el("img", { src: sevenSrc(e, 3), alt: "", referrerpolicy: "no-referrer" }),
      el("b", {}, name),
      el("small", {}, `${label} ${where}` + (e.z ? " · zero-width" : "")),
      el("small", { class: "tcw-etip-hint" }, "Right-click → Favorite emote"));
    h.replaceChildren(box);
    const r = img.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    box.style.left = Math.max(6, Math.min(r.left + r.width / 2 - br.width / 2, window.innerWidth - br.width - 6)) + "px";
    box.style.top = Math.max(6, r.top - br.height - 8) + "px";
    tip = img;
  }

  function hideTip() {
    if (!tip) return;
    const h = document.getElementById("tcw-tip-host");
    if (h) h.replaceChildren();
    tip = null;
  }

  document.addEventListener("mouseover", (e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.classList.contains("tcw-emote")) showTip(t);
    else if (tip) hideTip();
  }, true);

  // ---------- context menu: favorite this emote ----------

  document.addEventListener("contextmenu", (e) => {
    contextEmote = null;
    const t = e.target;
    if (!t || t.tagName !== "IMG") return;
    if (!(t.classList.contains("tcw-emote") || t.matches(TWITCH_EMOTE_SEL) || (t.closest(C.LINE_SEL) && !t.closest(".chat-badge")))) return;
    const name = (t.getAttribute("alt") || "").trim();
    if (name && !/\s/.test(name)) contextEmote = { name, src: httpsSrc(t.getAttribute("src")), p: t.classList.contains("tcw-emote") ? t.dataset.tcwP || "7tv" : "twitch" };
  }, true);

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "getContextEmote") return Promise.resolve(contextEmote);
    if (msg.type === "emotes:set") apply7tv(msg.channel, msg);
    if (msg.type === "emotes:personal") applyPersonal(msg.login, msg.emotes);
  });

  // ---------- wiring ----------

  function loadStored() {
    return browser.storage.local.get(["emoteFavs", "emoteRecent", "emoteStats"]).then((d) => {
      favs = Array.isArray(d.emoteFavs) ? d.emoteFavs : [];
      recent = Array.isArray(d.emoteRecent) ? d.emoteRecent : [];
      stats = d.emoteStats && typeof d.emoteStats === "object" ? d.emoteStats : {};
    }).catch(() => {});
  }

  browser.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !(ch.emoteFavs || ch.emoteRecent || ch.emoteStats)) return;
    if (ch.emoteFavs) favs = ch.emoteFavs.newValue || [];
    if (ch.emoteRecent) recent = ch.emoteRecent.newValue || [];
    if (ch.emoteStats) stats = ch.emoteStats.newValue || {};
    if (menu) renderMenu();
  });

  C.attach({
    line: onLine,
    nav: (ch) => {
      navAt = Date.now();
      popular = new Map();
      spam.reset();
      closeSpam();
      closeMenu();
      if (ch !== seven.ch) load7tv(ch);
    },
    settings: onSettings
  });

  function onSettings(s, keys) {
    if (!keys) {
      loadStored();
      load7tv(C.currentChannel());
      ensureButton();
      return;
    }
    if (["emotes7tv", "emotesBttv", "emotesFfz", "emotesPersonal"].some((k) => keys.has(k))) {
      // start over with only the providers that are on (no reload needed)
      seven = { channel: new Map(), global: new Map(), ch: "" };
      personal = new Map();
      unrender7tv();
      hideTip();
      if (menu) renderMenu();
      load7tv(C.currentChannel());
    }
    if (keys.has("emoteMenu")) ensureButton();
  }

  window.addEventListener("keydown", onKey, true);
  document.addEventListener("input", (e) => { if (I() && I().isBox(e.target)) updateColon(); }, true);
  document.addEventListener("mousedown", (e) => {
    const path = e.composedPath();
    if (menu && !path.includes(menu.box) && !path.includes(document.getElementById("tcw-emote-btn"))) closeMenu();
    if (sug && !path.some((n) => n.id === "tcw-sug-host")) closeSug();
  }, true);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu) closeMenu(); });
  window.addEventListener("resize", () => { closeSug(); closeMenu(); });
  setInterval(ensureButton, 2000);
  // keeps live emote updates coming for this channel (and picks up FFZ changes every 10 minutes)
  setInterval(() => {
    const ch = C.currentChannel();
    if (ch && anyProvider() && document.querySelector(C.CONTAINER_SEL)) browser.runtime.sendMessage({ type: "emotes:get", channel: ch }).catch(() => {});
  }, 60000);

  C.emotes = { search, catalog, sevenGet, lineEmotes };
})();
