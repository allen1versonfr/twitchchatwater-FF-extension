/* Chat tools: word and badge highlights, filters, timestamps, chat appearance, message details on hover,
 * shared-chat hiding, deleted-message recovery, and the moderation features (ban/timeout notices,
 * moderation panel and log, quick mod buttons, bulk removal, first-time chatter marks, chat-clear handling).
 * Moderation actions are sent as Twitch's own chat commands (/timeout, /ban), exactly as if you typed them. */
(() => {
  "use strict";
  const C = globalThis.TCWChat;
  if (!C || C.tools) return;
  const L = TCWChatLib;
  const S = () => C.settings;
  const el = (...a) => C.el(...a);

  const BADGE_SEL = "img.chat-badge, [data-a-target='chat-badge'] img, .chat-badge img, .seventv-chat-badge img";
  const DELETED_SEL = "[data-a-target='chat-deleted-message-placeholder'], .chat-line__message--deleted-notice, [data-test-selector='chat-deleted-message-placeholder']";
  const DELETED_TEXT = /^\s*(<message deleted>|message deleted by a moderator\.?|deleted by a moderator)\s*$/i;
  const SHARED_SEL = "[data-a-target='chat-message-source'], [class*='source-channel' i], [aria-label*='sent from' i]";
  const BADGE_KINDS = [
    ["Broadcaster", /broadcaster/, "#e91916"],
    ["Mod", /^(lead )?moderator$/, "#00ad03"],
    ["Vip", /^vip$/, "#e005b9"],
    ["Staff", /staff|admin|global moderator/, "#9147ff"],
    ["Sub", /subscriber|founder/, "#1f69ff"],
    ["Verified", /verified|partner/, "#a970ff"]
  ];

  let hlTerms = [];
  let filterTerms = [];
  let filterUsers = new Set();
  let navAt = Date.now();
  let channel = "";

  const snap = new WeakMap(); // row -> { text, time, live }
  const info = new WeakMap(); // row -> IRC message
  const delInfo = new WeakMap(); // row -> { text, why }
  const idLines = new Map(); // IRC message id -> WeakRef(row)
  let ircRecent = []; // IRC messages not yet paired with a row
  let domPending = []; // rows not yet paired with an IRC message
  const deletedIds = new Map(); // id -> CLEARMSG event (deleted before its row showed up)
  let banCount = new Map(); // login -> times timed out/banned (this channel, this session)
  let modEvents = []; // this channel, this session (newest first)
  let buffer = []; // recent rows for "chat was cleared" (oldest first)
  let modSelf = new Map(); // channel -> true when we've seen your mod/broadcaster badge there

  // ---------- helpers ----------

  function badgesOf(line) {
    return [...line.querySelectorAll(BADGE_SEL)].map((i) => (i.getAttribute("alt") || "").trim()).filter(Boolean);
  }

  function badgeKinds(line, irc) {
    const names = badgesOf(line).map((b) => b.toLowerCase().replace(/^\d+[- ](month|year)s?[- ]/, ""));
    const out = new Set();
    for (const [kind, re] of BADGE_KINDS) if (names.some((n) => re.test(n))) out.add(kind);
    if (irc && irc.badges) {
      const b = irc.badges;
      if (b.broadcaster) out.add("Broadcaster");
      if (b.moderator || b["lead_moderator"]) out.add("Mod");
      if (b.vip) out.add("Vip");
      if (b.staff || b.admin || b.global_mod) out.add("Staff");
      if (b.subscriber || b.founder) out.add("Sub");
      if (b.partner) out.add("Verified");
    }
    return out;
  }

  function isMod() {
    const ch = C.currentChannel();
    const me = C.myLogin();
    if (!ch || !me) return false;
    if (ch === me || /^\/moderator\//i.test(location.pathname)) return true;
    return modSelf.get(ch) === true;
  }
  C.isMod = isMod;

  function display(line) {
    const a = C.getAuthor(line);
    return a.display || a.names[0] || "";
  }

  function clock(t, mode) {
    const d = new Date(t);
    if (mode === "12") return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?[AP]M$/i, "");
    if (mode === "24s") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function linkify(text) {
    const out = [];
    for (const part of String(text || "").split(/(https?:\/\/[^\s<>"']+)/i)) {
      if (!part) continue;
      if (/^https?:\/\//i.test(part)) {
        let ok = false;
        try { ok = /^https?:$/.test(new URL(part).protocol); } catch (e) { /* not a URL */ }
        out.push(ok
          ? el("a", { class: "tcw-del-link", href: part, target: "_blank", rel: "noopener noreferrer nofollow", title: "Link from a deleted message — open with care" }, part)
          : part);
      } else {
        out.push(part);
      }
    }
    return out;
  }

  // The scrolling element around the chat rows, and whether it's scrolled to the bottom.
  function scroller(node) {
    for (let p = node; p && p !== document.body; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 1) return p;
    }
    return null;
  }

  function chatList() {
    return document.querySelector(".chat-scrollable-area__message-container, [data-test-selector='chat-scrollable-area__message-container']");
  }

  // Adds one of the add-on's own lines at the bottom of chat (keeping chat pinned to the bottom if it was).
  function appendNotice(node) {
    const list = chatList();
    if (!list) return false;
    const sc = scroller(list);
    const atBottom = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
    list.append(node);
    const mine = list.querySelectorAll(":scope > .tcw-notice");
    for (let i = 0; i < mine.length - 40; i++) mine[i].remove();
    if (sc && atBottom) sc.scrollTop = sc.scrollHeight;
    return true;
  }

  // ---------- per-row decoration ----------

  function decorate(line, data) {
    const s = S();
    const login = C.loginOf(line) || data.login || "";
    const sn = snap.get(line) || {};
    const text = sn.text || "";
    const irc = info.get(line);
    const me = C.myLogin();

    // filters
    const filtered = !!login && login !== me &&
      (filterUsers.has(login) || (filterTerms.length && !!L.matchTerms(filterTerms, text)));
    const dimOnly = s.filterMode === "dim" || (s.modCompat && isMod());
    line.classList.toggle("tcw-f-hide", filtered && !dimOnly);
    line.classList.toggle("tcw-f-dim", filtered && dimOnly);

    // word highlights
    const term = login && login !== me && hlTerms.length ? L.matchTerms(hlTerms, text) : null;
    line.classList.toggle("tcw-kw", !!term);
    if (term) line.style.setProperty("--tcw-kw", /^#[0-9a-f]{6}$/i.test(s.hlColor) ? s.hlColor : "#ff9f1a");

    // badge highlights
    let badgeColor = "";
    if (!term) {
      const kinds = badgeKinds(line, irc);
      for (const [kind, , color] of BADGE_KINDS) if (s["hlBadge" + kind] && kinds.has(kind)) { badgeColor = color; break; }
      if (me && login === me && (kinds.has("Mod") || kinds.has("Broadcaster"))) modSelf.set(C.currentChannel(), true);
    }
    line.classList.toggle("tcw-bhl", !!badgeColor);
    if (badgeColor) line.style.setProperty("--tcw-bhl", badgeColor);

    // shared chat
    const shared = !!(irc && irc.source && irc.room && irc.source !== irc.room) || !!line.querySelector(SHARED_SEL);
    line.classList.toggle("tcw-shared", shared);

    // timestamp
    const tsMode = s.timestamps;
    let ts = line.querySelector(":scope .tcw-ts");
    const when = irc ? irc.time : sn.live ? sn.time : 0;
    if (tsMode === "off" || !when || line.querySelector(".chat-line__timestamp")) {
      if (ts) ts.remove();
    } else {
      const txt = clock(when, tsMode);
      if (!ts) {
        ts = el("span", { class: "tcw-ts" });
        const anchor = line.querySelector(".chat-line__username-container") || C.getAuthor(line).nameEl;
        if (anchor && anchor.parentElement) anchor.before(ts);
        else line.prepend(ts);
      }
      if (ts.textContent !== txt) ts.textContent = txt;
      ts.title = new Date(when).toLocaleString();
    }

    // first-time / returning / previously timed out
    const marks = [];
    if (irc && irc.first && s.indFirst) marks.push(["🌱", "First message in this channel", "first"]);
    else if (irc && irc.returning && s.indReturning) marks.push(["↩", "Returning chatter", "ret"]);
    const n = banCount.get(login) || 0;
    if (n && s.indRepeat) marks.push(["⚠" + (n > 1 ? n : ""), `Timed out or banned ${n}× since you opened this channel`, "rep"]);
    line.classList.toggle("tcw-first", !!(irc && irc.first && s.indFirst));
    let ind = line.querySelector(":scope .tcw-ind");
    if (!marks.length) {
      if (ind) ind.remove();
    } else {
      const key = marks.map((m) => m[0]).join(" ");
      if (!ind) {
        ind = el("span", { class: "tcw-ind" });
        const nameEl = C.getAuthor(line).nameEl;
        const anchor = line.querySelector(".chat-line__username-container") || nameEl;
        if (anchor && anchor.parentElement) anchor.before(ind);
        else line.prepend(ind);
      }
      if (ind.dataset.k !== key) {
        ind.dataset.k = key;
        ind.replaceChildren(...marks.map(([t, title, cls]) => el("span", { class: "tcw-ind-" + cls, title }, t)));
      }
    }

    // a smoother page: decode emote images off the main thread
    for (const img of line.querySelectorAll("img")) if (img.decoding !== "async") img.decoding = "async";

    return term;
  }

  function redecorateAll() {
    for (const line of C.lines()) if (line.isConnected && snap.has(line)) decorate(line, {});
  }

  // ---------- new rows ----------

  function onLine(line, d) {
    snap.set(line, { text: d.text, time: Date.now(), live: d.live });
    pair(line, d);
    const term = decorate(line, d);
    if (term && d.live && Date.now() - navAt > 6000 && S().enabled) keywordAlert(line, d, term);
    checkDeleted(line);
    buffer.push({ display: d.author.display || d.login, login: d.login, text: d.text, t: Date.now() });
    if (buffer.length > 150) buffer.shift();
  }

  const kwRecent = new Map();
  function keywordAlert(line, d, term) {
    const key = d.login + "|" + d.text;
    const now = Date.now();
    if (now - (kwRecent.get(key) || 0) < 3000) return;
    kwRecent.set(key, now);
    if (kwRecent.size > 200) for (const [k, t] of kwRecent) if (now - t > 10000) kwRecent.delete(k);
    const name = d.author.display || d.login;
    browser.runtime.sendMessage({
      type: "keyword", term, login: d.login, display: name, channel: C.currentChannel(), text: d.text, msgId: line.dataset.tcwId || null
    }).then((r) => {
      if (r && r.localSound) C.playLocal(r.localSound.type, r.localSound.volume);
    }).catch(() => {});
    if (S().hlFlash) C.flashTitle(name, `🔔 ${name}: ${term}`, true);
  }

  // ---------- pairing rows with IRC messages ----------

  function sameKey(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return Math.min(a.length, b.length) >= 24 && (a.startsWith(b) || b.startsWith(a));
  }

  function pair(line, d) {
    const key = L.msgKey(d.text);
    const now = Date.now();
    for (let i = ircRecent.length - 1; i >= 0; i--) {
      const m = ircRecent[i];
      if (m.login === d.login && sameKey(m.key, key)) {
        ircRecent.splice(i, 1);
        link(line, m);
        return;
      }
    }
    domPending.push({ ref: new WeakRef(line), login: d.login, key, t: now });
    domPending = domPending.filter((p) => now - p.t < 30000).slice(-300);
  }

  function onIrcMessage(m) {
    m.key = L.msgKey(m.text);
    for (let i = 0; i < domPending.length; i++) {
      const p = domPending[i];
      if (p.login === m.login && sameKey(p.key, m.key)) {
        domPending.splice(i, 1);
        const line = p.ref.deref();
        if (line && line.isConnected) link(line, m);
        return;
      }
    }
    const now = Date.now();
    ircRecent.push(m);
    if (ircRecent.length > 400 || (ircRecent[0] && now - ircRecent[0].seenAt > 60000)) {
      ircRecent = ircRecent.filter((x) => now - x.seenAt < 60000).slice(-300);
    }
    if (m.login === C.myLogin() && (m.badges.moderator || m.badges.broadcaster || m.badges.lead_moderator)) modSelf.set(m.ch, true);
  }

  function link(line, m) {
    info.set(line, m);
    if (m.id) {
      idLines.set(m.id, new WeakRef(line));
      if (idLines.size > 3000) idLines.delete(idLines.keys().next().value);
      const del = deletedIds.get(m.id);
      if (del) markDeleted(line, del.text, "deleted");
    }
    decorate(line, {});
  }

  // ---------- deleted messages ----------

  function looksDeleted(line) {
    if (line.querySelector(DELETED_SEL)) return true;
    const body = line.querySelector(C.BODY_SEL);
    return !!body && DELETED_TEXT.test(body.textContent);
  }

  function checkDeleted(line) {
    const d = delInfo.get(line);
    if (d) return applyDeleted(line, d);
    if (looksDeleted(line)) {
      const sn = snap.get(line);
      markDeleted(line, sn ? sn.text : "", "deleted");
    }
  }

  function markDeleted(line, text, why) {
    const prev = delInfo.get(line);
    const d = { text: text || (prev && prev.text) || (snap.get(line) || {}).text || "", why: why || (prev && prev.why) || "deleted" };
    if (prev && prev.why !== "deleted" && d.why === "deleted") d.why = prev.why; // keep "timed out" over a plain "deleted"
    delInfo.set(line, d);
    applyDeleted(line, d);
  }

  function applyDeleted(line, d) {
    const mode = S().deletedMode;
    line.classList.add("tcw-del");
    for (const m of ["show", "strike", "hide", "twitch"]) line.classList.toggle("tcw-del-" + m, m === mode);
    let rec = line.querySelector(":scope .tcw-recovered");
    if (mode !== "show" && mode !== "strike") {
      if (rec) rec.remove();
      return;
    }
    // Twitch replaced the text: show what it said. Still there (e.g. you're a mod): just add the label.
    const withText = !!d.text && looksDeleted(line);
    const label = d.why;
    const key = label + (withText ? "|t" : "");
    if (rec && rec.dataset.why === key) return;
    if (!rec) rec = el("span", { class: "tcw-recovered" });
    rec.dataset.why = key;
    rec.title = withText ? `Recovered by Chat Watcher (${label})` : label;
    rec.replaceChildren(el("span", { class: "tcw-rec-tag" }, label), ...(withText ? [" ", ...linkify(d.text)] : []));
    if (!rec.isConnected) {
      const anchor = line.querySelector(DELETED_SEL) || line.querySelector(C.BODY_SEL);
      if (anchor && anchor.parentElement) anchor.after(rec);
      else line.append(rec);
    }
  }

  function linesOf(login) {
    const out = [];
    for (const line of C.lines()) if (line.isConnected && C.loginOf(line) === login) out.push(line);
    return out;
  }

  function onDelete(ev) {
    let line = ev.id && idLines.get(ev.id) ? idLines.get(ev.id).deref() : null;
    if (!line || !line.isConnected) {
      const key = L.msgKey(ev.text);
      line = linesOf(ev.login).reverse().find((l) => sameKey(L.msgKey((snap.get(l) || {}).text), key)) || null;
    }
    if (line) markDeleted(line, ev.text, "deleted");
    else if (ev.id) {
      deletedIds.set(ev.id, ev);
      if (deletedIds.size > 500) deletedIds.delete(deletedIds.keys().next().value);
    }
    addModEvent({ k: "del", login: ev.login, text: ev.text, time: ev.time });
  }

  function onBan(ev) {
    const why = ev.permanent ? "banned" : `timed out ${L.fmtDuration(ev.duration)}`;
    banCount.set(ev.login, (banCount.get(ev.login) || 0) + 1);
    for (const line of linesOf(ev.login)) {
      markDeleted(line, null, why);
      decorate(line, {});
    }
    addModEvent({ k: "ban", login: ev.login, duration: ev.duration, permanent: ev.permanent, time: ev.time });
    if (S().modNotices && !isMod()) {
      const name = (linesOf(ev.login).map(display).find(Boolean)) || ev.login;
      appendNotice(el("div", { class: "tcw-notice tcw-notice-ban" },
        ev.permanent ? "⛔ " : "⏱ ", el("b", {}, name), ev.permanent ? " has been banned" : ` has been timed out for ${L.fmtDuration(ev.duration)}`));
    }
  }

  function onClear(ev) {
    addModEvent({ k: "clear", time: ev.time });
    if (S().clearMode !== "keep") return;
    const rows = buffer.slice();
    buffer = [];
    const details = el("details", { class: "tcw-cleared" },
      el("summary", {}, `🧹 Chat was cleared by a moderator · show the ${rows.length} earlier message${rows.length === 1 ? "" : "s"}`),
      el("div", { class: "tcw-cleared-list" }, rows.map((r) =>
        el("div", { class: "tcw-cleared-row" }, el("span", { class: "tcw-ts" }, clock(r.t, "24")), el("b", {}, r.display + ": "), ...linkify(r.text)))));
    if (rows.length) appendNotice(el("div", { class: "tcw-notice tcw-notice-clear" }, details));
  }

  // ---------- moderation panel ----------

  function addModEvent(e) {
    modEvents.unshift(e);
    if (modEvents.length > 200) modEvents.length = 200;
    if (panel) renderPanel();
  }

  let panel = null;

  function togglePanel() {
    if (panel) return closePanel();
    let h = document.getElementById("tcw-mod-host");
    if (!h) { h = el("div", { id: "tcw-mod-host", class: "tcw-pop-host" }); document.body.append(h); }
    const box = el("div", { class: "tcw-modp", role: "dialog", "aria-label": "Moderation" });
    h.replaceChildren(box);
    panel = { box };
    renderPanel();
  }

  function closePanel() {
    if (!panel) return;
    panel.box.remove();
    panel = null;
  }

  function evText(e) {
    if (e.k === "ban") return e.permanent ? "banned" : `timed out ${L.fmtDuration(e.duration)}`;
    if (e.k === "del") return "message deleted";
    return "chat cleared";
  }

  function renderPanel() {
    if (!panel) return;
    const mod = isMod();
    const ircOk = S().ircOn;
    const rows = modEvents.slice(0, 80).map((e) => el("div", { class: "tcw-modp-row" },
      el("span", { class: "tcw-ts" }, clock(e.time, "24")),
      e.k === "ban" ? (e.permanent ? "⛔ " : "⏱ ") : e.k === "del" ? "🗑 " : "🧹 ",
      e.login ? el("b", {}, e.login + " ") : null,
      evText(e),
      e.text ? el("div", { class: "tcw-modp-quote" }, ...linkify(e.text)) : null));
    panel.box.replaceChildren(
      el("div", { class: "tcw-modp-head" },
        el("b", {}, "Moderation · #" + (C.currentChannel() || "?")),
        el("button", { class: "tcw-btn tcw-icon", "aria-label": "Close", title: "Close", onclick: closePanel }, "✕")),
      el("div", { class: "tcw-modp-sub" }, mod ? "You're a moderator here." : "Bans, timeouts and deletions anyone can see."),
      mod ? el("div", { class: "tcw-modp-actions" },
        el("button", { class: "tcw-btn" + (bulk ? " tcw-primary" : ""), onclick: () => setBulk(!bulk) }, bulk ? "Stop selecting" : "Select messages…"),
        el("span", { class: "tcw-modp-hint" }, "Pick messages, then purge, time out or ban their senders.")) : null,
      el("div", { class: "tcw-modp-list" }, rows.length ? rows : el("div", { class: "tcw-modp-empty" },
        ircOk ? "Nothing yet since you opened this channel." : "Turn on Settings → Chat → Connect to chat directly to see moderation events.")),
      el("div", { class: "tcw-modp-foot" },
        el("button", { class: "tcw-btn", onclick: () => browser.runtime.sendMessage({ type: "openPage", page: "modlog" }).catch(() => {}) }, "Full log")));
    place(panel.box);
  }

  function place(box) {
    const a = C.input.popupAnchor();
    const w = Math.min(340, window.innerWidth - 16);
    box.style.width = w + "px";
    box.style.left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8)) + "px";
    box.style.bottom = Math.max(8, a.bottom) + "px";
    box.style.maxHeight = Math.max(120, window.innerHeight - Math.max(8, a.bottom) - 8) + "px";
  }

  function ensureButton() {
    const bar = C.input.toolbar();
    if (!bar) return;
    let b = document.getElementById("tcw-mod-btn");
    if (b && bar.contains(b)) return;
    b = el("button", { id: "tcw-mod-btn", class: "tcw-tb-btn", title: "Moderation (Chat Watcher)", "aria-label": "Moderation (Chat Watcher)" }, "🛡");
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
    bar.append(b);
  }

  // ---------- moderator actions (sent as Twitch chat commands) ----------

  let busy = false;

  async function runCommands(cmds) {
    if (busy) return C.toast("Still working on the previous action");
    if (C.input.value().trim()) return C.toast("Empty your chat box first");
    busy = true;
    let done = 0;
    try {
      for (const cmd of cmds) {
        const r = await C.input.send(cmd);
        if (!r.ok) {
          C.toast(r.why === "busy" ? "Empty your chat box first" : "Couldn't use the chat box");
          break;
        }
        done++;
        if (cmds.length > 1) await new Promise((res) => setTimeout(res, 1100));
      }
    } finally {
      busy = false;
    }
    if (cmds.length > 1) C.toast(`Sent ${done} of ${cmds.length} commands`);
  }

  function modAction(kind, logins) {
    const me = C.myLogin();
    const ch = C.currentChannel();
    const list = [...new Set(logins)].filter((l) => /^[a-z0-9_]{1,25}$/.test(l) && l !== me && l !== ch);
    if (!list.length) return C.toast("Nobody to act on");
    if (kind === "ban" && !window.confirm(`Ban ${list.length === 1 ? list[0] : list.length + " people"} from #${ch}?`)) return;
    if (list.length > 3 && kind !== "ban" && !window.confirm(`${kind === "purge" ? "Purge" : "Time out"} ${list.length} people?`)) return;
    const cmd = (l) => (kind === "ban" ? `/ban ${l}` : kind === "purge" ? `/timeout ${l} 1` : `/timeout ${l} 600`);
    runCommands(list.map(cmd));
  }

  // hover buttons on a chat row
  let hoverLine = null;
  let modbar = null;

  function showModbar(line) {
    const login = C.loginOf(line);
    if (!login || login === C.myLogin() || login === C.currentChannel()) return hideModbar();
    if (!modbar) {
      modbar = el("div", { id: "tcw-modbar", class: "tcw-modbar" },
        el("button", { title: "Purge (1 s timeout removes their messages)", "data-k": "purge" }, "🧹"),
        el("button", { title: "Time out 10 minutes", "data-k": "timeout" }, "⏱"),
        el("button", { title: "Ban", "data-k": "ban" }, "⛔"));
      modbar.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b || !hoverLine) return;
        e.preventDefault();
        e.stopPropagation();
        modAction(b.dataset.k, [C.loginOf(hoverLine)]);
      });
      modbar.addEventListener("mouseleave", (e) => { if (!hoverLine || !hoverLine.contains(e.relatedTarget)) hideModbar(); });
      document.body.append(modbar);
    }
    hoverLine = line;
    const r = line.getBoundingClientRect();
    modbar.hidden = false;
    modbar.style.top = Math.max(0, r.top + 2) + "px";
    modbar.style.left = Math.max(0, r.right - modbar.offsetWidth - 6) + "px";
  }

  function hideModbar() {
    hoverLine = null;
    if (modbar) modbar.hidden = true;
  }

  // ---------- bulk removal ----------

  let bulk = false;
  const selected = new Set();
  let bulkBar = null;

  function setBulk(on) {
    bulk = on && isMod();
    document.documentElement.classList.toggle("tcw-bulk", bulk);
    if (!bulk) {
      for (const l of selected) l.classList.remove("tcw-sel");
      selected.clear();
      if (bulkBar) bulkBar.remove();
      bulkBar = null;
    } else {
      closePanel();
      drawBulkBar();
    }
    if (panel) renderPanel();
  }

  function drawBulkBar() {
    if (!bulk) return;
    if (!bulkBar) {
      bulkBar = el("div", { id: "tcw-bulkbar", class: "tcw-bulkbar" });
      document.body.append(bulkBar);
    }
    const logins = [...selected].map((l) => C.loginOf(l)).filter(Boolean);
    const people = new Set(logins).size;
    const act = (k) => () => { const l = logins.slice(); setBulk(false); modAction(k, l); };
    bulkBar.replaceChildren(
      el("span", {}, selected.size ? `${selected.size} message${selected.size === 1 ? "" : "s"} · ${people} ${people === 1 ? "person" : "people"}` : "Click messages to select them"),
      el("button", { class: "tcw-btn", disabled: !people, onclick: act("purge"), title: "1-second timeout: removes all their messages" }, "Purge"),
      el("button", { class: "tcw-btn", disabled: !people, onclick: act("timeout") }, "Time out 10m"),
      el("button", { class: "tcw-btn tcw-danger", disabled: !people, onclick: act("ban") }, "Ban"),
      el("button", { class: "tcw-btn tcw-icon", title: "Stop selecting", "aria-label": "Stop selecting", onclick: () => setBulk(false) }, "✕"));
    place(bulkBar);
  }

  window.addEventListener("click", (e) => {
    if (!bulk) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest("#tcw-bulkbar, #tcw-toolbar")) return;
    const line = C.findChatRow(t);
    if (!line || !snap.has(line)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (selected.has(line)) { selected.delete(line); line.classList.remove("tcw-sel"); }
    else { selected.add(line); line.classList.add("tcw-sel"); }
    drawBulkBar();
  }, true);

  // ---------- message details (hover / Shift) ----------

  let detailLine = null;
  let detailTimer = 0;
  let detailBox = null;
  let shiftDown = false;

  function showDetails(line) {
    const sn = snap.get(line);
    if (!sn) return;
    const irc = info.get(line);
    const a = C.getAuthor(line);
    const d = delInfo.get(line);
    const login = C.loginOf(line) || a.names[0] || "";
    const rows = [];
    const add = (k, v) => { if (v) rows.push(el("div", { class: "tcw-md-row" }, el("span", {}, k), el("div", {}, v))); };
    add("From", (a.display || login) + (a.display && a.display.toLowerCase() !== login ? ` (${login})` : ""));
    add("Sent", new Date(irc ? irc.time : sn.time).toLocaleString() + (irc || sn.live ? "" : " (loaded with the channel)"));
    add("Badges", badgesOf(line).join(", "));
    if (irc && irc.first) add("Note", "First message in this channel");
    else if (irc && irc.returning) add("Note", "Returning chatter");
    if (banCount.get(login)) add("Moderation", `Timed out or banned ${banCount.get(login)}× since you opened this channel`);
    if (line.classList.contains("tcw-shared")) add("Shared chat", "Sent in another channel of this shared chat");
    if (d) add("Status", d.why === "deleted" ? "Deleted" : d.why[0].toUpperCase() + d.why.slice(1));
    const full = irc ? irc.text : sn.text;
    add("Message", el("div", { class: "tcw-md-text" }, ...linkify(full)));
    add("Length", `${[...full].length} characters`);
    if (irc && irc.reply) add("Reply to", irc.reply);
    if (!detailBox) {
      detailBox = el("div", { id: "tcw-md", class: "tcw-md", role: "tooltip" });
      document.body.append(detailBox);
    }
    detailBox.replaceChildren(...rows);
    detailBox.hidden = false;
    const r = line.getBoundingClientRect();
    const br = detailBox.getBoundingClientRect();
    let left = r.left - br.width - 8;
    if (left < 8) left = Math.min(r.right + 8, window.innerWidth - br.width - 8);
    detailBox.style.left = Math.max(8, left) + "px";
    detailBox.style.top = Math.max(8, Math.min(r.top, window.innerHeight - br.height - 8)) + "px";
  }

  function hideDetails() {
    clearTimeout(detailTimer);
    if (detailBox) detailBox.hidden = true;
  }

  document.addEventListener("mouseover", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest("#tcw-modbar, #tcw-md")) return;
    const line = C.findChatRow(t);
    const tracked = line && snap.has(line) ? line : null;
    if (tracked !== detailLine) {
      detailLine = tracked;
      hideDetails();
      const mode = S().hoverDetails;
      if (tracked && (mode === "hover" || (mode === "shift" && (e.shiftKey || shiftDown)))) {
        detailTimer = setTimeout(() => showDetails(tracked), mode === "hover" ? 700 : 0);
      }
    }
    if (tracked && S().modIcons && isMod() && !bulk) showModbar(tracked);
    else if (!t.closest("#tcw-modbar") && hoverLine) hideModbar();
  }, true);

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Shift" || e.repeat) return;
    shiftDown = true;
    if (detailLine && S().hoverDetails === "shift") showDetails(detailLine);
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Shift") return;
    shiftDown = false;
    if (S().hoverDetails === "shift") hideDetails();
  }, true);
  window.addEventListener("blur", () => { shiftDown = false; hideDetails(); });

  // ---------- IRC subscription ----------

  function subscribe() {
    const ch = C.currentChannel();
    const hasChat = !!document.querySelector(C.CONTAINER_SEL);
    if (!S().ircOn || !ch || !hasChat) {
      if (channel) browser.runtime.sendMessage({ type: "irc:unsub" }).catch(() => {});
      channel = "";
      return;
    }
    channel = ch;
    browser.runtime.sendMessage({ type: "irc:sub", channel: ch }).catch(() => {});
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "irc:batch" || !Array.isArray(msg.events)) return;
    const ch = C.currentChannel();
    const now = Date.now();
    for (const ev of msg.events) {
      if (!ev || ev.ch !== ch) continue;
      if (ev.k === "msg") { ev.seenAt = now; onIrcMessage(ev); }
      else if (ev.k === "del") onDelete(ev);
      else if (ev.k === "ban") onBan(ev);
      else if (ev.k === "clear") onClear(ev);
    }
  });

  // ---------- settings ----------

  function applyRoot(s) {
    const root = document.documentElement;
    root.classList.toggle("tcw-alt", !!s.chatAltBg);
    root.classList.toggle("tcw-sep", !!s.chatSeparators);
    root.classList.toggle("tcw-hide-shared", !!s.hideShared);
    const fs = Number(s.chatFontSize) || 0;
    root.classList.toggle("tcw-fs", fs > 0);
    if (fs > 0) root.style.setProperty("--tcw-fs", Math.max(10, Math.min(28, fs)) + "px");
    else root.style.removeProperty("--tcw-fs");
  }

  function compile(s) {
    hlTerms = L.compileTerms(s.hlWords);
    filterTerms = L.compileTerms(s.filterWords);
    filterUsers = L.loginSet(s.filterUsers);
  }

  function onNav() {
    navAt = Date.now();
    ircRecent = [];
    domPending = [];
    banCount = new Map();
    modEvents = [];
    buffer = [];
    setBulk(false);
    closePanel();
    subscribe();
  }

  function onSettings(s, keys) {
    applyRoot(s);
    compile(s);
    if (!keys) return;
    if (keys.has("ircOn")) subscribe();
    if (keys.has("deletedMode")) for (const line of C.lines()) { const d = delInfo.get(line); if (d && line.isConnected) applyDeleted(line, d); }
    if (["hlWords", "hlColor", "filterWords", "filterUsers", "filterMode", "timestamps", "indFirst", "indReturning", "indRepeat", "modCompat"]
      .some((k) => keys.has(k)) || [...keys].some((k) => k.startsWith("hlBadge"))) redecorateAll();
  }

  C.attach({
    line: onLine,
    changed: (line) => { if (snap.has(line)) checkDeleted(line); },
    nav: onNav,
    settings: onSettings
  });

  document.addEventListener("mousedown", (e) => {
    if (panel && !e.composedPath().includes(panel.box) && !e.composedPath().includes(document.getElementById("tcw-mod-btn"))) closePanel();
  }, true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (panel) closePanel(); if (bulk) setBulk(false); }
  });
  // chat scrolls with every new message: keep the hover buttons on their row
  window.addEventListener("scroll", () => {
    if (hoverLine && hoverLine.isConnected && modbar && !modbar.hidden) {
      const r = hoverLine.getBoundingClientRect();
      modbar.style.top = Math.max(0, r.top + 2) + "px";
    } else if (hoverLine) hideModbar();
  }, true);

  setInterval(() => { subscribe(); ensureButton(); }, 30000);
  setInterval(ensureButton, 2000);
  setTimeout(subscribe, 1500);

  C.tools = { isMod, markDeleted, modAction, notice: (text) => appendNotice(el("div", { class: "tcw-notice tcw-notice-emote" }, text)) };
})();
