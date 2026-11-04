/* Pins, in chat: saves messages pinned in Twitch chat to the Pins history (so they're still there after Twitch unpins
 * them), notices when a pin comes down, and adds a 📌 button next to the chat settings that lists this channel's pins.
 * Messages you pin yourself come from the right-click menu (background.js); Hype Chat pins also arrive over the chat
 * connection (bg-chat.js).
 *
 * Twitch draws a pin as a card at the top of chat (.pinned-chat__message, the same class BetterTTV relies on). The card
 * is often collapsed or stacked behind other highlights (polls, hype trains), so the text on screen can't be trusted:
 * the pin itself is read from the card's React props (where Twitch keeps the message, its sender and "pinnedBy"), with
 * the visible text as a fallback. */
(() => {
  "use strict";
  const C = globalThis.TCWChat;
  if (!C || C.pins) return;
  const S = () => C.settings;
  const el = (...a) => C.el(...a);

  const PIN_SEL = [
    ".pinned-chat__message",
    "[class*='pinned-chat' i]",
    "[class*='pinned-message' i]",
    "[class*='community-highlight' i]",
    "[data-test-selector*='pinned' i]",
    "[data-a-target*='pinned' i]"
  ].join(",");
  // boxes whose own text may be read when React has nothing (not polls, hype trains and other highlight cards)
  const PIN_TEXT_SEL = ".pinned-chat__message, [class*='pinned-chat' i], [class*='pinned-message' i], [data-test-selector*='pinned' i], [data-a-target*='pinned' i]";
  const NAME_IN_PIN = C.NAME_SEL + ", [data-a-target='chat-message-username'], [data-a-user]";
  const sent = new Map(); // key -> last time reported (this page)
  let onScreen = new Map(); // key -> pin, pins visible on the last scan
  let missing = new Map(); // key -> scans in a row it wasn't seen

  // ---------- reading a pin from Twitch's React props ----------

  function fiberOf(node) {
    const page = node.wrappedJSObject || node;
    let key;
    try { key = Object.keys(page).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")); } catch (e) { return null; }
    return key ? page[key] : null;
  }

  const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

  function timeOf(v) {
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    const t = Date.parse(str(v));
    return Number.isFinite(t) ? t : 0;
  }

  function textOf(m) {
    if (!m || typeof m !== "object") return "";
    const c = m.content;
    if (c && typeof c === "object") {
      if (str(c.text)) return c.text;
      if (Array.isArray(c.fragments)) return c.fragments.map((f) => str(f && (f.text || (f.content && f.content.text)))).join("");
    }
    for (const k of ["body", "messageBody", "text"]) if (str(m[k])) return m[k];
    if (Array.isArray(m.messageParts)) {
      return m.messageParts.map((p) => {
        const c2 = p && p.content;
        return typeof c2 === "string" ? c2 : c2 && (str(c2.alt) || str(c2.text) || str(c2.emoteText)) || "";
      }).join("");
    }
    return "";
  }

  // A pinned-message object in Twitch's props, in any of the shapes it has used, as our pin (or null).
  function fromProps(o) {
    if (!o || typeof o !== "object") return null;
    const pinnedBy = o.pinnedBy || o.pinned_by;
    let m = o.pinnedMessage || o.message || o;
    if (m && typeof m === "object" && !textOf(m) && o !== m && textOf(o)) m = o;
    const text = textOf(m).replace(/\s+/g, " ").trim();
    if (!text) return null;
    const sender = m.sender || m.user || m.from || o.sender || o.user || {};
    const display = str(sender.displayName) || str(sender.display_name) || str(sender.login) || str(sender.userDisplayName) || str(m.displayName);
    const login = TCW.normalize(str(sender.login) || str(sender.userLogin) || display);
    const pinner = pinnedBy && typeof pinnedBy === "object"
      ? str(pinnedBy.displayName) || str(pinnedBy.display_name) || str(pinnedBy.login)
      : str(pinnedBy);
    const type = str(o.type || m.type).toUpperCase();
    return {
      pinId: str(o.id) || str(m.id) || "",
      login, display: display || login, text: text.slice(0, 500),
      pinner: type === "PAID" ? "" : pinner,
      paid: type === "PAID" || !!(m.metadata && m.metadata.amount),
      time: timeOf(m.sentAt || m.sent_at || o.startsAt || o.starts_at) || Date.now(),
      pinnedAt: timeOf(o.startsAt || o.starts_at || o.updatedAt || o.updated_at) || 0
    };
  }

  // Looks through a props object (a few levels deep) for anything that's a pinned message.
  function findInProps(props, out, depth = 0, seenObjs = new Set()) {
    if (!props || typeof props !== "object" || depth > 4 || seenObjs.has(props) || seenObjs.size > 400) return;
    seenObjs.add(props);
    try {
      if (props.$$typeof || props.nodeType) return; // React elements and DOM nodes
      if (props.pinnedBy != null || props.pinned_by != null || (props.pinnedMessage != null && typeof props.pinnedMessage === "object")) {
        const pin = fromProps(props);
        if (pin) { out.push(pin); return; }
      }
      const keys = Array.isArray(props) ? [...props.keys()].slice(0, 25) : Object.keys(props).slice(0, 40);
      for (const k of keys) {
        if (k === "children" || k === "_owner" || k.startsWith("__")) continue;
        const v = props[k];
        if (v && typeof v === "object") findInProps(v, out, depth + 1, seenObjs);
      }
    } catch (e) { /* a page object we can't read */ }
  }

  function pinsFromReact(node) {
    const out = [];
    let f = fiberOf(node);
    for (let i = 0; f && i < 25 && !out.length; i++, f = f.return) {
      findInProps(f.memoizedProps || f.pendingProps, out);
    }
    return out;
  }

  // ---------- fallback: the text on screen ----------

  function readable(node) {
    let out = "";
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.tagName === "IMG" && n.alt) out += " " + n.alt + " ";
      else if (/^(BR|DIV|P|LI|BUTTON|HEADER|H[1-6])$/.test(n.tagName)) out += "\n";
    }
    return out;
  }

  function readPin(box) {
    const nameEl = box.querySelector(NAME_IN_PIN);
    const display = nameEl ? (nameEl.textContent || nameEl.getAttribute("data-a-user") || "").trim().replace(/:$/, "") : "";
    const login = TCW.normalize((nameEl && nameEl.getAttribute("data-a-user")) || display);
    const all = readable(box);
    const pinnerMatch = /pinned by\s+@?([A-Za-z0-9_]{2,25})/i.exec(all);
    if (!display && !pinnerMatch) return null;
    const body = box.querySelector(C.BODY_SEL);
    let text = body ? readable(body) : all;
    text = text.split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^pinned( by\b|$)/i.test(l) && !/^(unpin|dismiss|hide|show more|show less|view|see more)$/i.test(l) && !/^\d+\s*(s|sec|min|m|h)\b/i.test(l))
      .join(" ");
    if (display) {
      const i = text.indexOf(display);
      if (i >= 0 && i < 40) text = text.slice(i + display.length).replace(/^\s*:\s*/, "");
    }
    text = text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!text) return null;
    return { pinId: "", login, display, text, pinner: pinnerMatch ? pinnerMatch[1] : "", paid: false, time: Date.now(), pinnedAt: 0 };
  }

  // ---------- scanning ----------

  const keyOf = (ch, p) => ch + "|" + (p.pinId || p.login + "|" + p.text);

  function currentPins() {
    const boxes = [...document.querySelectorAll(PIN_SEL)].filter((b) => !b.closest("#tcw-pins-pop"));
    const found = new Map();
    const ch = C.currentChannel();
    for (const box of boxes) {
      let pins = pinsFromReact(box);
      // the visible text, only from the outermost box of each card and only when React had nothing
      if (!pins.length && box.matches(PIN_TEXT_SEL) && !boxes.some((o) => o !== box && o.contains(box) && o.matches(PIN_TEXT_SEL))) {
        const p = readPin(box);
        if (p) pins = [p];
      }
      for (const p of pins) {
        const k = keyOf(ch, p);
        // prefer the version that has Twitch's id and who pinned it
        const old = found.get(k);
        if (!old || (!old.pinner && p.pinner)) found.set(k, p);
      }
    }
    // a text-only copy of a pin we also read from React is the same pin
    for (const [k, p] of found) {
      if (!p.pinId && [...found.values()].some((o) => o.pinId && o.text === p.text)) found.delete(k);
    }
    return found;
  }

  function scan() {
    if (!S() || !S().enabled || !S().pinsAuto) return;
    const ch = C.currentChannel();
    if (!ch) return;
    const now = Date.now();
    const found = currentPins();
    for (const [k, p] of found) {
      missing.delete(k);
      if (now - (sent.get(k) || 0) < 10 * 60000) continue; // re-report now and then so a cleared history fills again
      sent.set(k, now);
      if (sent.size > 400) sent.delete(sent.keys().next().value);
      browser.runtime.sendMessage({ type: "pins:add", pin: { ...p, ch } }).catch(() => {});
    }
    // a pin that's gone for three scans in a row was taken down (or expired)
    for (const [k, p] of onScreen) {
      if (found.has(k)) continue;
      const n = (missing.get(k) || 0) + 1;
      missing.set(k, n);
      if (n === 3) {
        browser.runtime.sendMessage({ type: "pins:ended", pin: { ...p, ch } }).catch(() => {});
        missing.delete(k);
        sent.delete(k);
      } else {
        found.set(k, p); // keep watching it until then
      }
    }
    onScreen = found;
  }

  let scanTimer = 0;
  function soon() {
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, 300);
  }

  // react quickly when the top of chat changes, and look every couple of seconds anyway
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && (n.matches(PIN_SEL) || n.querySelector(PIN_SEL))) return soon();
      }
      if (r.removedNodes.length && onScreen.size) return soon();
    }
  });
  const watchRoot = () => document.querySelector(C.CONTAINER_SEL) || document.body;
  let watched = null;
  setInterval(() => {
    const root = watchRoot();
    if (root && root !== watched) {
      mo.disconnect();
      mo.observe(root, { childList: true, subtree: true });
      watched = root;
    }
    scan();
  }, 2000);

  // ---------- 📌 button: this channel's pins, right in chat ----------

  let pop = null;

  function ensureButton() {
    const want = S() && S().enabled && S().pinsButton !== false;
    const old = document.getElementById("tcw-pins-btn");
    const bar = want && C.input ? C.input.toolbar() : null;
    if (!bar) { if (old && !want) old.remove(); return; }
    if (old && bar.contains(old)) return;
    const b = el("button", { id: "tcw-pins-btn", class: "tcw-tb-btn", title: "Pinned messages in this channel (Chat Watcher)", "aria-label": "Pinned messages in this channel" }, "📌");
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (pop) closePop(); else openPop(); });
    bar.prepend(b);
  }

  function closePop() {
    if (pop) pop.remove();
    pop = null;
  }

  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function dur(ms) {
    const m = Math.round(ms / 60000);
    return m < 1 ? "under a minute" : m < 60 ? m + " min" : Math.round(m / 6) / 10 + " h";
  }

  async function openPop() {
    closePop();
    const ch = C.currentChannel();
    const d = await browser.storage.local.get("pins").catch(() => ({}));
    const list = (Array.isArray(d.pins) ? d.pins : []).filter((p) => p.ch === ch).slice(0, 30);
    const rows = list.length ? list.map((p) => {
      const copy = el("button", { class: "tcw-btn tcw-icon", title: "Copy", "aria-label": "Copy the message" }, "⧉");
      copy.addEventListener("click", () => navigator.clipboard.writeText(p.text).then(() => { copy.textContent = "✓"; }).catch(() => {}));
      const who = p.by === "you" ? "you" : p.paid ? "Hype Chat" : p.pinner || "chat";
      const meta = [`📌 ${who}`, ago(p.pinnedAt || p.time)];
      if (p.endedAt) meta.push(`up ${dur(p.endedAt - (p.pinnedAt || p.time))}`);
      else if (p.by === "twitch" && p.seenAt && Date.now() - p.seenAt < 12 * 60000) meta.push("pinned now");
      return el("div", { class: "tcw-pin-row" },
        el("div", { class: "tcw-pin-head" }, el("b", {}, p.display || p.login || "?"), el("small", {}, meta.join(" · ")), copy),
        el("div", { class: "tcw-pin-text" }, p.text));
    }) : [el("div", { class: "tcw-pin-empty" }, "No pinned messages saved for this channel yet. Right-click a message → Pin this message, or wait for one to be pinned in chat.")];
    pop = el("div", { id: "tcw-pins-pop", class: "tcw-pins-pop", role: "dialog", "aria-label": "Pinned messages" },
      el("div", { class: "tcw-pin-title" }, el("b", {}, `Pinned in #${ch || "this chat"}`),
        el("button", { class: "tcw-btn tcw-icon", "aria-label": "Close", onclick: closePop }, "✕")),
      el("div", { class: "tcw-pin-list" }, ...rows),
      el("div", { class: "tcw-pin-foot" }, "All channels: the Pins tab in the Chat Watcher toolbar button"));
    document.body.append(pop);
    const a = C.input.popupAnchor();
    const w = Math.min(340, window.innerWidth - 16);
    pop.style.width = w + "px";
    pop.style.left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8)) + "px";
    pop.style.bottom = Math.max(8, a.bottom) + "px";
    pop.style.maxHeight = Math.max(160, window.innerHeight - a.bottom - 16) + "px";
  }

  document.addEventListener("mousedown", (e) => {
    if (!pop) return;
    const path = e.composedPath();
    if (!path.includes(pop) && !path.includes(document.getElementById("tcw-pins-btn"))) closePop();
  }, true);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop) closePop(); });
  browser.storage.onChanged.addListener((chg, area) => { if (area === "local" && chg.pins && pop) openPop(); });
  setInterval(ensureButton, 2000);

  C.attach({
    settings: (s, keys) => { if (!keys || keys.has("pinsButton") || keys.has("enabled")) ensureButton(); },
    nav: () => { closePop(); onScreen = new Map(); missing = new Map(); }
  });

  C.pins = { scan, readPin, fromProps, findInProps, currentPins };
})();
