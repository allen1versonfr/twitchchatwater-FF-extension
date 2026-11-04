/* Pins tab, part 1: notices messages pinned in Twitch chat (the banner at the top of chat) and keeps a copy in the
 * add-on's pinned history, so they're still there after Twitch unpins them. Messages you pin yourself come from the
 * right-click menu (background.js). Twitch's markup for pins isn't documented, so this looks for anything marked
 * "pinned" around the chat and reads the name and text out of it; if Twitch changes it, nothing breaks, it just
 * stops noticing. */
(() => {
  "use strict";
  const C = globalThis.TCWChat;
  if (!C || C.pins) return;
  const S = () => C.settings;

  const PIN_SEL = [
    "[class*='pinned-chat' i]",
    "[class*='pinned-message' i]",
    "[data-test-selector*='pinned' i]",
    "[data-a-target*='pinned' i]"
  ].join(",");
  const NAME_IN_PIN = C.NAME_SEL + ", [data-a-target='chat-message-username'], [data-a-user]";
  const seen = new Set();

  function readable(el) {
    let out = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.tagName === "IMG" && n.alt) out += " " + n.alt + " ";
      else if (/^(BR|DIV|P|LI|BUTTON|HEADER|H[1-6])$/.test(n.tagName)) out += "\n";
    }
    return out;
  }

  // { login, display, text, pinner } from a pinned-message box, or null if it doesn't look like a message
  function readPin(box) {
    if (box.closest(C.LINE_SEL)) return null; // a normal chat row that merely mentions "pinned"
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
      .filter((l) => l && !/^pinned( by\b|$)/i.test(l) && !/^(unpin|dismiss|hide|show more|show less|view)$/i.test(l) && !/^\d+\s*(s|sec|min|m|h)\b/i.test(l))
      .join(" ");
    if (display) {
      const i = text.indexOf(display);
      if (i >= 0 && i < 40) text = text.slice(i + display.length).replace(/^\s*:\s*/, "");
    }
    text = text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (text.length < 1) return null;
    return { login, display, text, pinner: pinnerMatch ? pinnerMatch[1] : "" };
  }

  function scan() {
    if (!S() || !S().enabled || !S().pinsAuto) return;
    const ch = C.currentChannel();
    if (!ch) return;
    const boxes = [...document.querySelectorAll(PIN_SEL)];
    // only the outermost box of each pin
    for (const box of boxes.filter((b) => !boxes.some((o) => o !== b && o.contains(b)))) {
      const pin = readPin(box);
      if (!pin) continue;
      const key = ch + "|" + pin.login + "|" + pin.text;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 300) seen.delete(seen.values().next().value);
      browser.runtime.sendMessage({ type: "pins:add", pin: { ...pin, ch, time: Date.now() } }).catch(() => {});
    }
  }

  setInterval(scan, 3000);
  C.pins = { scan, readPin };
})();
