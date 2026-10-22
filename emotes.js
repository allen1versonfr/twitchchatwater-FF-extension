/* Emotes: 7TV emotes in chat, the emote menu (favorites, recent, most used, popular in chat, 7TV),
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

  let seven = { channel: new Map(), global: new Map(), ch: "" };
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

  function sevenGet(name) {
    return seven.channel.get(name) || seven.global.get(name) || null;
  }

  function sevenSrc(e, size = 1) {
    return `${e.u}/${size}x.webp`;
  }

  function favSet() {
    return new Set(favs.map((f) => f.name));
  }

  // Everything we can suggest: { name, src, p, tag }
  function catalog() {
    const out = new Map();
    const add = (name, src, p, tag) => { if (name && !out.has(name)) out.set(name, { name, src, p, tag }); };
    for (const f of favs) add(f.name, f.src, f.p, "★");
    for (const e of seven.channel.values()) add(e.n, sevenSrc(e), "7tv", "7TV");
    for (const e of seven.global.values()) add(e.n, sevenSrc(e), "7tv", "7TV global");
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

  // ---------- 7TV in chat ----------

  function sevenActive() {
    return S().emotes7tv && (seven.channel.size || seven.global.size) && !document.querySelector(".seventv-chat-list, .seventv-message");
  }

  function emoteNode(e) {
    const img = el("img", {
      class: "tcw-emote", alt: e.n, src: sevenSrc(e, 1), srcset: `${sevenSrc(e, 1)} 1x, ${sevenSrc(e, 2)} 2x, ${sevenSrc(e, 4)} 4x`,
      loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", draggable: "false",
      "data-tcw-p": "7tv", "data-tcw-zw": e.z ? "1" : null
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
    for (const frag of textFragments(line)) {
      const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) if (!n.parentElement.closest(SEVEN_SKIP_SEL)) nodes.push(n);
      for (const node of nodes) {
        const parts = node.data.split(/(\s+)/);
        if (!parts.some((p) => p && sevenGet(p))) continue;
        const out = document.createDocumentFragment();
        let lastEmote = null;
        let buf = "";
        for (const p of parts) {
          const e = p && !/^\s+$/.test(p) ? sevenGet(p) : null;
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

  // Turns shown 7TV emotes back into their names (when 7TV emotes are switched off).
  function unrender7tv() {
    for (const wrap of document.querySelectorAll(".tcw-emote-wrap")) {
      const names = [...wrap.querySelectorAll("img.tcw-emote")].map((i) => i.alt).join(" ");
      wrap.replaceWith(document.createTextNode(names));
    }
    for (const frag of document.querySelectorAll("[data-a-target='chat-message-text'], .text-fragment")) frag.normalize();
  }

  function rerender7tv() {
    for (const line of C.lines()) if (line.isConnected) render7tv(line);
  }

  async function load7tv(ch) {
    seven = { channel: new Map(), global: seven.global, ch };
    if (!ch || !S().emotes7tv) return;
    try {
      const r = await browser.runtime.sendMessage({ type: "emotes:get", channel: ch });
      if (r) apply7tv(ch, r);
    } catch (e) { /* background restarting; it pushes the list when ready */ }
  }

  function apply7tv(ch, r) {
    if (ch !== C.currentChannel()) return;
    seven = {
      ch,
      channel: new Map((r.emotes || []).map((e) => [e.n, e])),
      global: new Map((r.global || []).map((e) => [e.n, e]))
    };
    C.debug("7TV emotes", ch, seven.channel.size, "channel,", seven.global.size, "global");
    rerender7tv();
    if (menu) renderMenu();
  }

  // ---------- emotes in a message ----------

  function lineEmotes(line) {
    const out = [];
    for (const img of line.querySelectorAll(TWITCH_EMOTE_SEL + ", img.tcw-emote")) {
      if (img.closest(".chat-badge, [data-a-target='chat-badge'], .tcw-recovered")) continue;
      const name = (img.getAttribute("alt") || "").trim();
      if (!name || /\s/.test(name) || name.length > 100) continue;
      const p = img.classList.contains("tcw-emote") ? "7tv" : "twitch";
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
      const hit = spam.add(found.map((e) => e.name), info.login);
      if (hit) showSpam(hit, found.find((e) => e.name === hit.name));
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

  // ---------- emote spam: "join in" button ----------

  let spamTimer = 0;

  function showSpam(hit, e) {
    if (!I().box()) return;
    const h = host("tcw-spam-host");
    const send = el("button", { class: "tcw-btn tcw-primary" }, "Send");
    const close = el("button", { class: "tcw-btn tcw-icon", title: "Dismiss", "aria-label": "Dismiss" }, "✕");
    const box = el("div", { class: "tcw-spam", role: "status" },
      emoteImg(e || { name: hit.name }, "tcw-spam-img"),
      el("div", { class: "tcw-spam-txt" }, el("b", {}, hit.name), el("small", {}, `${hit.count} messages from ${hit.users} people`)),
      send, close);
    h.replaceChildren(box);
    placeAbove(box, 300);
    clearTimeout(spamTimer);
    spamTimer = setTimeout(() => h.replaceChildren(), 12000);
    close.addEventListener("click", () => h.replaceChildren());
    send.addEventListener("click", async () => {
      h.replaceChildren();
      const r = await I().send(hit.name);
      if (!r.ok && r.why === "busy" && I().insert(hit.name)) C.toast(`Added ${hit.name} to your message`);
      else if (!r.ok && r.why === "insert") C.toast("Press Enter to send it");
      else if (!r.ok) C.toast("Couldn't find the chat box");
    });
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
      sections.push(["7tv", ch ? `7TV · ${ch}` : "7TV channel", [...seven.channel.values()].map((e) => ({ name: e.n, src: sevenSrc(e), p: "7tv", tag: "7TV" }))]);
      sections.push(["7tvg", "7TV global", [...seven.global.values()].map((e) => ({ name: e.n, src: sevenSrc(e), p: "7tv", tag: "7TV global" }))]);
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
    const e = sevenGet(name);
    if (!e) return;
    const h = host("tcw-tip-host");
    const box = el("div", { class: "tcw-etip" },
      el("img", { src: sevenSrc(e, 3), alt: "", referrerpolicy: "no-referrer" }),
      el("b", {}, name),
      el("small", {}, (seven.channel.has(name) ? "7TV channel emote" : "7TV global emote") + (e.z ? " · zero-width" : "")),
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
    if (name && !/\s/.test(name)) contextEmote = { name, src: httpsSrc(t.getAttribute("src")), p: t.classList.contains("tcw-emote") ? "7tv" : "twitch" };
  }, true);

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "getContextEmote") return Promise.resolve(contextEmote);
    if (msg.type === "emotes:7tv") apply7tv(msg.channel, msg);
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
    if (keys.has("emotes7tv")) {
      if (s.emotes7tv) load7tv(C.currentChannel());
      else {
        seven = { channel: new Map(), global: new Map(), ch: "" };
        unrender7tv();
        hideTip();
        if (menu) renderMenu();
      }
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

  C.emotes = { search, catalog, sevenGet, lineEmotes };
})();
