/* Talking to Twitch's chat box: read it, insert text, replace the word being typed, send.
 * Twitch's box is a rich-text editor (Slate). Text goes in with the browser's own insertText command,
 * so the editor sees normal typing; the Chat button sends it exactly as if you'd clicked it. */
(() => {
  "use strict";
  if (!globalThis.TCWChat || globalThis.TCWChat.input) return;

  const INPUT_SEL = "[data-a-target='chat-input'], .chat-wysiwyg-input__editor, .seventv-chat-input [contenteditable='true']";
  const SEND_SEL = "[data-a-target='chat-send-button'], button[aria-label='Send message' i]";

  function box() {
    for (const el of document.querySelectorAll(INPUT_SEL)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  function isBox(node) {
    const b = box();
    return !!(b && node && (node === b || b.contains(node)));
  }

  function clean(s) {
    return String(s || "").replace(/[﻿​]/g, "").replace(/ /g, " ");
  }

  function value(b = box()) {
    if (!b) return "";
    if (b.tagName === "TEXTAREA" || b.tagName === "INPUT") return b.value;
    return clean(b.innerText).replace(/\n+$/, "");
  }

  function textNodes(b) {
    const out = [];
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }

  // React-controlled <textarea> (older Twitch chat): set the value the way React notices.
  function setTextarea(b, v, caret) {
    const proto = b.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(b, v);
    b.dispatchEvent(new Event("input", { bubbles: true }));
    const at = caret == null ? v.length : caret;
    b.setSelectionRange(at, at);
  }

  function insertText(text) {
    if (!document.execCommand("insertText", false, text)) {
      // fallback: a paste the editor handles itself
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const b = box();
      if (b) b.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }
  }

  function caretAtEnd(b) {
    const nodes = textNodes(b);
    const sel = window.getSelection();
    const r = document.createRange();
    const last = nodes[nodes.length - 1];
    if (last) r.setStart(last, last.length);
    else r.selectNodeContents(b);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // Adds text at the caret (or the end), with a space before it if needed.
  function insert(text, opts = {}) {
    const b = box();
    if (!b) return false;
    b.focus();
    if (b.tagName === "TEXTAREA" || b.tagName === "INPUT") {
      const v = b.value;
      const at = b.selectionStart == null ? v.length : b.selectionEnd;
      const pad = at > 0 && !/\s$/.test(v.slice(0, at)) ? " " : "";
      const add = pad + text + (opts.space === false ? "" : " ");
      setTextarea(b, v.slice(0, at) + add + v.slice(at), at + add.length);
      return true;
    }
    const sel = window.getSelection();
    if (!sel.rangeCount || !b.contains(sel.anchorNode)) caretAtEnd(b);
    const before = wordBefore();
    const pad = before && before.textBefore && !/\s$/.test(before.textBefore) ? " " : "";
    insertText(pad + text + (opts.space === false ? "" : " "));
    return true;
  }

  // Adds `text` at the very end of the message, exactly as given (no padding).
  function append(text) {
    const b = box();
    if (!b) return false;
    if (b.tagName === "TEXTAREA" || b.tagName === "INPUT") {
      setTextarea(b, b.value + text);
      return true;
    }
    b.focus();
    caretAtEnd(b);
    insertText(text);
    return true;
  }

  // Replaces everything in the box.
  function set(text) {
    const b = box();
    if (!b) return false;
    b.focus();
    if (b.tagName === "TEXTAREA" || b.tagName === "INPUT") {
      setTextarea(b, text);
      return true;
    }
    const nodes = textNodes(b).filter((n) => clean(n.data).length);
    const sel = window.getSelection();
    if (nodes.length) {
      const r = document.createRange();
      r.setStart(nodes[0], 0);
      const last = nodes[nodes.length - 1];
      r.setEnd(last, last.length);
      sel.removeAllRanges();
      sel.addRange(r);
      if (!text) { document.execCommand("delete"); return true; }
    } else {
      caretAtEnd(b);
    }
    if (text) insertText(text);
    return true;
  }

  // The word right before the caret: { word, node, start, end, textBefore } or null.
  function wordBefore() {
    const b = box();
    if (!b) return null;
    if (b.tagName === "TEXTAREA" || b.tagName === "INPUT") {
      if (b.selectionStart !== b.selectionEnd) return null;
      const textBefore = b.value.slice(0, b.selectionStart);
      const m = /(\S+)$/.exec(textBefore);
      return { word: m ? m[1] : "", start: m ? b.selectionStart - m[1].length : b.selectionStart, end: b.selectionStart, textBefore, field: b };
    }
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed || !b.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode;
    if (node.nodeType !== 3) return { word: "", textBefore: clean(b.innerText) };
    const raw = node.data.slice(0, sel.anchorOffset);
    const m = /(\S+)$/.exec(raw.replace(/[﻿​]/g, " "));
    return {
      word: m ? clean(m[1]) : "",
      node,
      start: m ? sel.anchorOffset - m[1].length : sel.anchorOffset,
      end: sel.anchorOffset,
      textBefore: clean(raw)
    };
  }

  // Swaps the word before the caret for `text` (used by Tab completion and ":" suggestions).
  function replaceWord(info, text) {
    if (!info) return false;
    if (info.field) {
      const v = info.field.value;
      setTextarea(info.field, v.slice(0, info.start) + text + v.slice(info.end), info.start + text.length);
      return true;
    }
    if (!info.node || !info.node.isConnected) return insert(text, { space: false });
    const r = document.createRange();
    r.setStart(info.node, Math.max(0, Math.min(info.start, info.node.length)));
    r.setEnd(info.node, Math.max(0, Math.min(info.end, info.node.length)));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    insertText(text);
    return true;
  }

  function sendButton() {
    for (const b of document.querySelectorAll(SEND_SEL)) if (b.offsetParent !== null) return b;
    return null;
  }

  // Puts `text` in the (empty) chat box and sends it. Refuses if you're in the middle of typing something.
  async function send(text) {
    const b = box();
    if (!b) return { ok: false, why: "no-chat" };
    if (value(b).trim()) return { ok: false, why: "busy" };
    set(text);
    await new Promise((r) => setTimeout(r, 60));
    if (value(b).trim() !== text.trim()) return { ok: false, why: "insert" };
    const btn = sendButton();
    if (btn && (btn.disabled || btn.getAttribute("aria-disabled") === "true")) {
      return { ok: false, why: "send-disabled" };
    }
    if (btn) btn.click();
    else b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    // Twitch may ignore a click while its chat UI is updating. Don't report success
    // until the editor actually clears; leave any unsent text in place for recovery.
    await new Promise((r) => setTimeout(r, 180));
    if (value(b).trim()) return { ok: false, why: "send-failed" };
    return { ok: true };
  }

  // A small button row of the add-on's own, next to Twitch's chat settings (gear) button.
  // Twitch re-renders that area now and then, so callers ask again whenever they need it.
  function toolbar() {
    const gear = document.querySelector("[data-a-target='chat-settings']");
    let bar = document.getElementById("tcw-toolbar");
    if (!gear) return bar && bar.isConnected ? bar : null;
    const anchor = gear.parentElement && gear.parentElement !== gear.closest(".chat-input__buttons-container") ? gear.parentElement : gear;
    if (!bar) {
      bar = document.createElement("span");
      bar.id = "tcw-toolbar";
      bar.className = "tcw-toolbar";
    }
    if (bar.nextElementSibling !== anchor) anchor.before(bar);
    return bar;
  }

  // Where to put a popup that sits on top of the chat box: { left, right, bottom } in viewport pixels.
  function popupAnchor() {
    const b = box();
    const r = (b && (b.closest(".chat-input, .chat-wysiwyg-input__box") || b).getBoundingClientRect()) ||
      { left: window.innerWidth - 340, right: window.innerWidth - 10, top: window.innerHeight - 60 };
    let top = r.top;
    // stay above Twitch's own suggestion list if it's open
    for (const lb of document.querySelectorAll("[role='listbox']")) {
      if (lb.closest("[id^='tcw-']")) continue;
      const lr = lb.getBoundingClientRect();
      if (lr.height > 0 && lr.bottom <= r.top + 4 && lr.bottom > r.top - 400 && lr.right > r.left && lr.left < r.right) top = Math.min(top, lr.top);
    }
    return { left: r.left, right: r.right, bottom: window.innerHeight - top + 6 };
  }

  globalThis.TCWChat.input = { INPUT_SEL, SEND_SEL, box, isBox, value, insert, append, set, wordBefore, replaceWord, send, toolbar, popupAnchor };
})();
