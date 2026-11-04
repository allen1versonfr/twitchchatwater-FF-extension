"use strict";
/* Pins tab: messages pinned in Twitch chat (saved automatically) and ones you pinned yourself (right-click →
 * Pin this message). Loaded after ui.js (uses $, $$, h, ago, armed, send, jumpTo, openChannel, userColor). */
(() => {
  let pins = [];
  let by = "";
  let shown = [];

  function dur(ms) {
    const m = Math.round(ms / 60000);
    return m < 1 ? "under a minute" : m < 60 ? m + " min" : Math.round(m / 6) / 10 + " h";
  }

  function render() {
    const sel = $("#pinChannel");
    const keep = sel.value;
    const channels = [...new Set(pins.map((p) => p.ch).filter(Boolean))].sort();
    sel.replaceChildren(h("option", { value: "" }, "All channels"), ...channels.map((c) => h("option", { value: c }, "#" + c)));
    sel.value = channels.includes(keep) ? keep : "";

    const words = $("#pinFilter").value.toLowerCase().split(/\s+/).filter(Boolean);
    const list = pins.filter((p) =>
      (!sel.value || p.ch === sel.value) && (!by || p.by === by) &&
      words.every((w) => `${p.display} ${p.login} ${p.text} ${p.ch} ${p.pinner || ""}`.toLowerCase().includes(w)));
    $("#pinCount").textContent = pins.length ? `${list.length} of ${pins.length}` : "";
    shown = list;
    $("#exportPins").disabled = !list.length;

    if (!list.length) {
      $("#pins").replaceChildren(h("div", { class: "empty" },
        h("div", { class: "empty-title" }, pins.length ? "No matching pins" : "No pinned messages yet"),
        h("div", {}, pins.length ? "Try another search or filter." : "Messages pinned in Twitch chat are saved here automatically. To pin one yourself, right-click it in chat and choose Pin this message.")));
      return;
    }
    $("#pins").replaceChildren(...list.map((p) => {
      const copy = h("button", { class: "icon-btn", title: "Copy the message", "aria-label": "Copy the message" }, "⧉");
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(p.text).then(() => { copy.textContent = "✓"; setTimeout(() => { copy.textContent = "⧉"; }, 1200); }).catch(() => {});
      });
      const unpin = h("button", { class: "icon-btn", title: "Remove from pins", "aria-label": "Remove from pins" }, "✕");
      unpin.addEventListener("click", (e) => { e.stopPropagation(); send("pins:remove", { id: p.id }); });
      const who = p.by === "you" ? "📌 you" : p.paid ? "📌 Hype Chat" : p.pinner ? `📌 ${p.pinner}` : "📌 chat";
      const status = p.by !== "twitch" ? null
        : p.endedAt ? h("div", { class: "pin-status" }, `Pinned for ${dur(p.endedAt - (p.pinnedAt || p.time))}`)
          : p.seenAt && Date.now() - p.seenAt < 12 * 60000 ? h("div", { class: "pin-status live" }, "Pinned now")
            : null;
      return h("div", {
        class: "card entry pin",
        style: { "--c": userColor(p.login) },
        title: p.msgId ? "Jump to this message (if its tab is still open)" : p.ch ? `Open #${p.ch}` : "",
        onclick: () => (p.msgId || p.tabId != null ? jumpTo({ ...p, channel: p.ch }) : openChannel(p.ch))
      },
        h("div", { class: "entry-head" },
          h("b", {}, p.display || p.login || "?"),
          h("span", { class: "ping-tag pin-tag", title: p.by === "you" ? "You pinned this" : p.pinner ? `Pinned in chat by ${p.pinner}` : "Pinned in Twitch chat" }, who),
          p.ch ? h("span", { class: "chan" }, "#" + p.ch) : null,
          h("span", { class: "time", title: new Date(p.pinnedAt || p.time).toLocaleString() }, ago(p.pinnedAt || p.time)),
          copy, unpin),
        h("div", { class: "text" }, p.text),
        status);
    }));
  }

  function load() {
    return browser.storage.local.get("pins").then((d) => {
      pins = Array.isArray(d.pins) ? d.pins : [];
      render();
    }).catch(() => {});
  }

  $("#pinFilter").addEventListener("input", render);
  $("#pinChannel").addEventListener("change", render);
  for (const b of $$("[data-pinby]")) {
    b.addEventListener("click", () => {
      by = b.dataset.pinby;
      for (const x of $$("[data-pinby]")) { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }
      render();
    });
  }
  armed($("#clearPins"), "Sure?", () => send("pins:clear"));
  $("#exportPins").addEventListener("click", () => {
    const lines = shown.map((p) => {
      const when = new Date(p.pinnedAt || p.time).toLocaleString();
      const who = p.by === "you" ? "pinned by you" : p.paid ? "Hype Chat" : p.pinner ? `pinned by ${p.pinner}` : "pinned in chat";
      return `[${when}] #${p.ch} ${p.display || p.login} (${who}): ${p.text}`;
    });
    const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/plain" }));
    const a = h("a", { href: url, download: `pinned-messages-${new Date().toISOString().slice(0, 10)}.txt` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  browser.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.pins) { pins = ch.pins.newValue || []; render(); }
  });
  setInterval(() => { if (!$("[data-panel='pins']").hidden) render(); }, 30000);
  load();
})();
