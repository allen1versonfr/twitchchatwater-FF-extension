"use strict";

const D = TCW.DEFAULT_SETTINGS;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });

const isPopup = (() => {
  try { return browser.extension.getViews({ type: "popup" }).includes(window); } catch (e) { return false; }
})();
document.body.classList.add(isPopup ? "popup" : "full");

let state = { settings: { ...D }, users: [], log: [] };
const expanded = new Set();
let pendingRender = false;
let uiAudio = null;
let statusTimer = null;

// ---------- helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [prop, val] of Object.entries(v)) el.style.setProperty(prop, val);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

function ago(t) {
  if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const hr = Math.round(m / 60);
  if (hr < 24) return hr + "h ago";
  return Math.round(hr / 24) + "d ago";
}

function playLocal(type, volume) {
  if (!type || type === "none") return;
  try {
    uiAudio = uiAudio || new AudioContext();
    uiAudio.resume();
    TCW.playSound(uiAudio, type, volume);
  } catch (e) {
    console.warn(e);
  }
}

function openChannel(ch) {
  if (!ch) return;
  browser.tabs.create({ url: "https://www.twitch.tv/" + encodeURIComponent(ch) });
  if (isPopup) window.close();
}

async function jumpTo(e) {
  try {
    await send("jump", { target: { tabId: e.tabId, frameId: e.frameId, msgId: e.msgId, channel: e.channel } });
  } catch (err) {
    openChannel(e.channel);
  }
  if (isPopup) window.close();
}

function openFull(tab) {
  if (tab) {
    try { localStorage.setItem("tcw-tab", tab); } catch (e) { /* ignore */ }
  }
  browser.runtime.openOptionsPage();
  if (isPopup) window.close();
}

function switchEl(checked, onChange, opts = {}) {
  const input = h("input", { type: "checkbox", checked, disabled: opts.disabled, "aria-label": opts.label || "" });
  input.addEventListener("change", () => onChange(input.checked));
  return h("span", { class: "switch", title: opts.label || "" }, input, h("span"));
}

// A destructive button that needs a second click to confirm (popups can't show confirm()).
function armed(btn, label, action) {
  let timer = null;
  const original = btn.textContent;
  btn.addEventListener("click", async () => {
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed");
      btn.textContent = label;
      timer = setTimeout(() => { btn.classList.remove("armed"); btn.textContent = original; }, 3000);
      return;
    }
    clearTimeout(timer);
    btn.classList.remove("armed");
    btn.textContent = original;
    await action();
  });
}

function soundOptions(includeDefault) {
  const opts = [];
  if (includeDefault) opts.push(h("option", { value: "default" }, "Default sound"));
  for (const [k, s] of Object.entries(TCW.SOUNDS)) opts.push(h("option", { value: k }, s.label));
  if (includeDefault) opts.push(h("option", { value: "none" }, "Silent"));
  return opts;
}

function editing() {
  const a = document.activeElement;
  if (!a || !a.closest) return false;
  return !!a.closest("#people, #activity") && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
}

function userColor(login, fallback) {
  const u = state.users.find((x) => x.login === login);
  return u ? u.color : fallback || "#9147ff";
}

// ---------- people ----------

function metaText(u) {
  if (!u.hits || !u.lastSeen) return u.enabled ? "No messages seen yet" : "Paused";
  const where = u.lastSeen.channel ? ` in #${u.lastSeen.channel}` : "";
  return `${u.hits} msg${u.hits === 1 ? "" : "s"} · last ${ago(u.lastSeen.time)}${where}`;
}

function personCard(u) {
  const open = expanded.has(u.login);
  const update = (patch) => send("updateUser", { login: u.login, patch });

  const color = h("input", {
    type: "color", class: "swatch", value: u.color, title: "Highlight color",
    onchange: (e) => update({ color: e.target.value })
  });

  const row = h("div", { class: "row" },
    color,
    h("div", { class: "who" },
      h("div", { class: "name", title: u.name }, u.name),
      h("div", { class: "meta" }, metaText(u))
    ),
    switchEl(u.enabled, (v) => update({ enabled: v }), { label: "Watching" }),
    h("button", {
      class: "icon-btn", title: open ? "Hide options" : "More options",
      onclick: () => { open ? expanded.delete(u.login) : expanded.add(u.login); renderPeople(); }
    }, open ? "▴" : "▾")
  );

  const card = h("div", { class: "card" + (u.enabled ? "" : " off"), style: { "--c": u.color } }, row);
  if (!open) return card;

  const soundSel = h("select", { onchange: (e) => update({ sound: e.target.value }) }, soundOptions(true));
  soundSel.value = u.sound;

  const note = h("input", {
    type: "text", value: u.note, maxlength: "200", placeholder: "e.g. my friend, mod, the streamer",
    onchange: (e) => update({ note: e.target.value })
  });

  const removeBtn = h("button", { class: "btn danger small" }, "Remove");
  armed(removeBtn, "Click again", () => { expanded.delete(u.login); return send("removeUser", { login: u.login }); });

  const notifyOff = !state.settings.notifications;

  card.append(h("div", { class: "details" },
    h("div", { class: "field" },
      h("span", { class: "lbl" }, "Sound"),
      soundSel,
      h("button", {
        class: "icon-btn", title: "Preview",
        onclick: () => playLocal(soundSel.value === "default" ? state.settings.soundType : soundSel.value, state.settings.volume)
      }, "▶")
    ),
    h("div", { class: "field" },
      h("span", { class: "lbl" }, notifyOff ? "Desktop notification (turned off in Settings)" : "Desktop notification"),
      switchEl(u.notify, (v) => update({ notify: v }), { label: "Desktop notification" })
    ),
    h("div", { class: "field col" }, h("span", { class: "lbl" }, "Note"), note),
    u.lastSeen ? h("div", { class: "field col" },
      h("span", { class: "lbl" }, `Last message${u.lastSeen.channel ? " in #" + u.lastSeen.channel : ""} · ${ago(u.lastSeen.time)}`),
      h("div", { class: "quote" }, u.lastSeen.text || "—")
    ) : null,
    h("div", { class: "actions" },
      h("button", { class: "btn ghost small", onclick: () => openChannel(u.login) }, "Open their channel"),
      h("button", { class: "btn ghost small", onclick: () => update({ hits: 0, lastSeen: null }) }, "Reset count"),
      removeBtn
    )
  ));
  return card;
}

function renderPeople() {
  const q = $("#filter").value.trim().toLowerCase();
  const list = state.users.filter((u) => !q || u.login.includes(q) || u.name.toLowerCase().includes(q) || u.note.toLowerCase().includes(q));
  const on = state.users.filter((u) => u.enabled).length;
  $("#peopleCount").textContent = state.users.length ? `${on} of ${state.users.length} on` : "";

  if (!state.users.length) {
    $("#people").replaceChildren(h("div", { class: "empty" },
      h("div", { class: "empty-title" }, "Nobody on your watchlist yet"),
      h("div", {}, "Add a Twitch username above. Their messages get highlighted and you hear a beep.")
    ));
    return;
  }
  if (!list.length) {
    $("#people").replaceChildren(h("div", { class: "empty" }, `No one matches "${q}"`));
    return;
  }
  $("#people").replaceChildren(...list.map(personCard));
}

// ---------- activity ----------

function lastViewed() {
  try { return Number(localStorage.getItem("tcw-activity-seen")) || 0; } catch (e) { return 0; }
}

function markActivitySeen() {
  try { localStorage.setItem("tcw-activity-seen", String(Date.now())); } catch (e) { /* ignore */ }
  renderPill();
}

function renderPill() {
  const visible = !$("[data-panel='activity']").hidden;
  const n = visible ? 0 : state.log.filter((e) => e.time > lastViewed()).length;
  const pill = $("#activityPill");
  pill.hidden = n === 0;
  pill.textContent = n > 99 ? "99+" : String(n);
}

function renderActivity() {
  const sel = $("#activityUser");
  const keep = sel.value;
  const logins = [...new Set(state.log.map((e) => e.login))];
  sel.replaceChildren(
    h("option", { value: "" }, "Everyone"),
    ...logins.map((l) => {
      const e = state.log.find((x) => x.login === l);
      return h("option", { value: l }, e.display || l);
    })
  );
  sel.value = logins.includes(keep) ? keep : "";

  const entries = state.log.filter((e) => !sel.value || e.login === sel.value);
  if (!entries.length) {
    $("#activity").replaceChildren(h("div", { class: "empty" },
      h("div", { class: "empty-title" }, "No activity yet"),
      h("div", {}, "Messages from people on your watchlist will show up here.")
    ));
  } else {
    $("#activity").replaceChildren(...entries.map((e) => h("div", {
      class: "card entry",
      style: { "--c": userColor(e.login, e.color) },
      title: e.msgId ? "Jump to this message" : e.channel ? `Open #${e.channel}` : "",
      onclick: () => jumpTo(e)
    },
      h("div", { class: "entry-head" },
        h("b", {}, e.display || e.login),
        e.channel ? h("span", { class: "chan" }, "#" + e.channel) : null,
        h("span", { class: "time" }, ago(e.time))
      ),
      h("div", { class: "text" }, e.text || "—")
    )));
  }
  renderPill();
}

// ---------- settings ----------

function fillSettings() {
  for (const el of $$("[data-setting]")) {
    if (el === document.activeElement && el.tagName !== "SELECT" && el.type !== "checkbox") continue;
    const v = state.settings[el.dataset.setting];
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = String(v);
  }
  updateOutputs();
  $("#offTag").hidden = state.settings.enabled;
  renderSync();
}

function renderSync() {
  const s = state.syncState;
  const el = $("#syncStatus");
  $("#syncNow").disabled = !state.settings.syncEnabled;
  if (!state.settings.syncEnabled) el.textContent = "Sync is off on this computer";
  else if (!s) el.textContent = "Waiting for first sync…";
  else if (!s.ok) el.textContent = "Sync problem: " + (s.error || "unknown error");
  else el.textContent = `Up to date · ${s.people || 0} ${s.people === 1 ? "person" : "people"} · ${ago(s.time)}`;
}

function updateOutputs() {
  for (const out of $$("output[data-for]")) {
    const input = $(`[data-setting='${out.dataset.for}']`);
    const v = Number(input.value);
    out.textContent = out.dataset.for === "volume" ? Math.round(v * 100) + "%" : v + "%";
  }
}

function readSetting(el) {
  const key = el.dataset.setting;
  if (el.type === "checkbox") return el.checked;
  if (el.type === "range" || el.type === "number" || typeof D[key] === "number") {
    let v = Number(el.value);
    if (!Number.isFinite(v)) v = D[key];
    if (el.min !== "") v = Math.max(Number(el.min), v);
    if (el.max !== "") v = Math.min(Number(el.max), v);
    return v;
  }
  return el.value;
}

function bindSettings() {
  $("#soundType").replaceChildren(...soundOptions(false));
  for (const el of $$("[data-setting]")) {
    if (el.type === "range") el.addEventListener("input", updateOutputs);
    el.addEventListener("change", () => {
      const key = el.dataset.setting;
      const v = readSetting(el);
      state.settings[key] = v;
      if (el.type === "number") el.value = String(v);
      updateOutputs();
      $("#offTag").hidden = state.settings.enabled;
      send("setSettings", { patch: { [key]: v } });
      if (key === "soundType" || key === "volume") playLocal(state.settings.soundType, state.settings.volume);
    });
  }
  $("#previewSound").addEventListener("click", () => playLocal(state.settings.soundType, state.settings.volume));
}

function dataMsg(text, kind) {
  const el = $("#dataMsg");
  el.textContent = text;
  el.className = "hint" + (kind ? " " + kind : "");
}

function bindData() {
  $("#openFullData").addEventListener("click", () => openFull("settings"));

  $("#exportBtn").addEventListener("click", () => {
    const data = { app: "twitch-chat-watcher", version: 2, exported: new Date().toISOString(), settings: state.settings, users: state.users };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: `chat-watcher-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    dataMsg("Backup downloaded.", "ok");
  });

  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await send("import", { data });
      dataMsg(`Imported ${r.users} ${r.users === 1 ? "person" : "people"} and your settings.`, "ok");
    } catch (err) {
      dataMsg("Couldn't import that file: " + (err.message || err), "err");
    }
  });

  armed($("#resetStats"), "Click again", async () => {
    await send("resetStats");
    dataMsg("Message counts reset.", "ok");
  });
  armed($("#resetAll"), "Click again", async () => {
    await send("resetAll");
    expanded.clear();
    dataMsg("Everything erased.", "ok");
  });
}

// ---------- status ----------

async function renderStatus() {
  let list = [];
  try { list = await send("getStatus"); } catch (e) { /* background starting */ }
  const box = $("#status");
  if (!list || !list.length) {
    box.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "empty-title" }, "No Twitch chat detected"),
      h("div", {}, "Open a Twitch channel with the chat visible. If one is already open, reload that tab.")
    ));
    return;
  }
  box.replaceChildren(...list.map((s) => {
    let line;
    if (!s.enabled) line = "Watcher is paused";
    else if (!s.allowed) line = "Not in your channel list, so ignored";
    else if (s.chatFound) line = `Reading chat · ${s.linesSeen} messages · ${s.hits} from your list`;
    else if (s.containerFound) line = "Chat is open, waiting for the first message";
    else line = "No chat on this page. Open a channel with chat showing.";
    const good = s.chatFound && s.enabled && s.allowed;
    return h("div", { class: "card" },
      h("div", { class: "row" },
        h("span", { class: "dot " + (good ? "ok" : "bad") }),
        h("div", { class: "who" },
          h("div", { class: "name" }, s.channel ? "#" + s.channel : s.title || "Twitch"),
          h("div", { class: "meta" }, line)
        )
      ),
      s.lastAuthor ? h("div", { class: "meta pad" }, `Last message by ${s.lastAuthor}`) : null
    );
  }));
}

function startStatus() {
  renderStatus();
  clearInterval(statusTimer);
  statusTimer = setInterval(renderStatus, 2000);
}

function stopStatus() {
  clearInterval(statusTimer);
  statusTimer = null;
}

function bindStatus() {
  $("#testAlert").addEventListener("click", async () => {
    if (state.settings.sound) playLocal(state.settings.soundType, state.settings.volume);
    let r = {};
    try { r = await send("test"); } catch (e) { /* ignore */ }
    const parts = [state.settings.sound ? "Sound played" : "Sound is off"];
    parts.push(r && r.notifications ? "notification sent" : "notifications are off");
    $("#testMsg").textContent = parts.join(", ") + ".";
  });
}

// ---------- tabs + wiring ----------

function showTab(name) {
  if (!$(`[data-panel='${name}']`)) name = "people";
  $$("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  try { localStorage.setItem("tcw-tab", name); } catch (e) { /* ignore */ }
  if (name === "status") startStatus(); else stopStatus();
  if (name === "activity") markActivitySeen(); else renderPill();
}

function renderAll() {
  renderPeople();
  renderActivity();
  fillSettings();
}

function scheduleRender() {
  if (editing()) {
    pendingRender = true;
    fillSettings();
    return;
  }
  pendingRender = false;
  renderAll();
}

function applyData(d) {
  if (d.settings !== undefined) state.settings = { ...D, ...(d.settings || {}) };
  if (d.users !== undefined) state.users = (Array.isArray(d.users) ? d.users : []).map((u, i) => TCW.fixUser(u, i)).filter(Boolean);
  if (d.log !== undefined) state.log = Array.isArray(d.log) ? d.log : [];
  if (d.syncState !== undefined) state.syncState = d.syncState || null;
}

async function init() {
  const d = await browser.storage.local.get(["settings", "users", "log", "syncState"]);
  applyData({ settings: d.settings || null, users: d.users || [], log: d.log || [], syncState: d.syncState || null });

  $("#openFull").hidden = !isPopup;
  $("#openFull").addEventListener("click", () => openFull());
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  $("#addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const names = $("#addInput").value.split(/[\s,;]+/).map((n) => n.trim()).filter(Boolean);
    if (!names.length) return;
    const r = await send("addUsers", { names });
    $("#addInput").value = "";
    const msg = $("#addMsg");
    const parts = [];
    if (r.added.length) parts.push(`Added ${r.added.join(", ")}`);
    if (r.existing.length) parts.push(`already watching ${r.existing.join(", ")}`);
    msg.textContent = parts.join(" · ") || "Nothing to add.";
    msg.className = "hint" + (r.added.length ? " ok" : "");
  });
  $("#filter").addEventListener("input", renderPeople);
  $("#activityUser").addEventListener("change", renderActivity);
  $("#clearLog").addEventListener("click", () => send("clearLog"));
  $("#syncNow").addEventListener("click", () => send("syncNow"));

  bindSettings();
  bindData();
  bindStatus();

  browser.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    const patch = {};
    for (const k of ["settings", "users", "log", "syncState"]) if (ch[k]) patch[k] = ch[k].newValue;
    applyData(patch);
    scheduleRender();
  });
  document.addEventListener("focusout", () => setTimeout(() => { if (pendingRender && !editing()) scheduleRender(); }, 0));
  setInterval(() => { if (!editing()) renderAll(); }, 30000);

  renderAll();
  let start = location.hash.slice(1);
  if (!start) { try { start = localStorage.getItem("tcw-tab") || "people"; } catch (e) { start = "people"; } }
  showTab(start);
  send("clearBadge").catch(() => {});
  if (isPopup) $("#addInput").focus();
}

init();
