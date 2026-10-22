"use strict";
/* Watch time view (Activity tab) and its settings. Uses h(), $, $$, send(), armed(), isPopup, openFull from ui.js. */

const watchUI = { data: null, view: "messages" };

function lastDays(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(TCW.dayKey(Date.now() - i * 86400000));
  return out;
}

function sumDays(c, days) {
  return days.reduce((s, d) => s + ((c.days && c.days[d]) || 0), 0);
}

function watchRows() {
  const chans = watchUI.data && watchUI.data.channels ? watchUI.data.channels : {};
  const today = TCW.dayKey();
  const week = lastDays(7);
  return Object.entries(chans).map(([login, c]) => ({
    login,
    display: c.display || login,
    total: c.total || 0,
    today: (c.days && c.days[today]) || 0,
    week: sumDays(c, week),
    last: c.last || 0,
    sessions: c.sessions || 0,
    daily: week.slice().reverse().map((d) => (c.days && c.days[d]) || 0)
  }));
}

function renderWatch() {
  if (!$("#watchList")) return;
  const rows = watchRows();
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  $("#watchSummary").replaceChildren(
    ...[["Today", sum("today")], ["Last 7 days", sum("week")], ["All time", sum("total")]].map(([label, v]) =>
      h("div", { class: "stat" }, h("div", { class: "stat-val" }, rows.length ? TCW.duration(v) : "—"), h("div", { class: "stat-lbl" }, label)))
  );

  const q = $("#watchFilter").value.trim().toLowerCase();
  const sort = $("#watchSort").value;
  const list = rows
    .filter((r) => !q || r.login.includes(q) || r.display.toLowerCase().includes(q))
    .sort((a, b) => (sort === "last" ? b.last - a.last : b[sort] - a[sort]) || b.total - a.total);

  if (!rows.length) {
    $("#watchList").replaceChildren(h("div", { class: "empty" },
      h("div", { class: "empty-title" }, state.settings.watchTrack ? "No watch time yet" : "Watch time tracking is off"),
      h("div", {}, state.settings.watchTrack
        ? "Watch a stream on its channel page and your time shows up here (and next to the viewer count)."
        : "Turn it on in Settings → Watch time.")));
    return;
  }
  if (!list.length) {
    $("#watchList").replaceChildren(h("div", { class: "empty" }, `No streamer matches "${q}"`));
    return;
  }
  const max = Math.max(...list.map((r) => r[sort === "last" ? "total" : sort]), 1);
  $("#watchList").replaceChildren(...list.map((r) => {
    const peak = Math.max(...r.daily, 1);
    return h("div", {
      class: "card watch-row", tabindex: "0", role: "button",
      title: `Open ${r.display}'s channel${r.last ? " · last watched " + TCW.ago(r.last) : ""}`,
      onclick: () => openChannel(r.login),
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openChannel(r.login); } }
    },
      h("div", { class: "row" },
        h("div", { class: "who" },
          h("div", { class: "name" }, r.display),
          h("div", { class: "meta" }, `${TCW.duration(r.today)} today · ${TCW.duration(r.week)} this week`)
        ),
        h("div", { class: "watch-total" }, TCW.duration(r.total)),
      ),
      h("div", { class: "watch-bars", "aria-label": "Last 7 days" },
        r.daily.map((v, i) => h("span", {
          class: "bar",
          title: `${TCW.dayKey(Date.now() - (6 - i) * 86400000)}: ${TCW.duration(v)}`,
          style: { height: Math.max(2, Math.round((v / peak) * 18)) + "px", opacity: v ? "1" : ".25" }
        }))),
      h("div", { class: "watch-share" }, h("span", { style: { width: Math.max(2, Math.round((r[sort === "last" ? "total" : sort] / max) * 100)) + "%" } }))
    );
  }));
}

function setWatchView(view) {
  watchUI.view = view;
  $$(".view-switch [data-view]").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  $$("[data-subview]").forEach((el) => { el.hidden = el.dataset.subview !== view; });
  try { localStorage.setItem("tcw-activity-view", view); } catch (e) { /* ignore */ }
  if (view === "watch") refreshWatch();
  if (view === "modlog" && typeof renderModlog === "function") renderModlog();
}

async function refreshWatch() {
  try {
    const r = await send("watch:all");
    watchUI.data = r && r.data ? r.data : null;
  } catch (e) {
    const d = await browser.storage.local.get("watch");
    watchUI.data = d.watch || null;
  }
  renderWatch();
}

function watchMsg(text, kind) {
  const el = $("#watchMsg");
  el.textContent = text;
  el.className = "hint" + (kind ? " " + kind : "");
}

async function exportWatch() {
  const r = await send("watch:all");
  const data = { app: "twitch-chat-watcher-watchtime", version: 1, exported: new Date().toISOString(), watch: r.data, sessions: r.sessions };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: `chat-watcher-watchtime-${TCW.dayKey()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  watchMsg("Watch time exported.", "ok");
}

function initWatch() {
  $$(".view-switch [data-view]").forEach((b) => b.addEventListener("click", () => setWatchView(b.dataset.view)));
  $("#watchFilter").addEventListener("input", renderWatch);
  $("#watchSort").addEventListener("change", renderWatch);
  $("#watchExport").addEventListener("click", () => (isPopup ? openFull("settings") : exportWatch()));
  $("#watchImport").addEventListener("click", () => (isPopup ? openFull("settings") : $("#watchImportFile").click()));
  $("#watchImportFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const r = await send("watch:import", { data });
      if (!r.ok) throw new Error(r.error);
      watchMsg(`Merged watch time for ${r.value.channels} streamer${r.value.channels === 1 ? "" : "s"}.`, "ok");
      refreshWatch();
    } catch (err) {
      watchMsg("Couldn't import: " + (err.message || err), "err");
    }
  });
  armed($("#watchReset"), "Click again", async () => {
    await send("watch:reset");
    watchMsg("Watch time reset.", "ok");
    refreshWatch();
  });

  browser.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.watch) {
      watchUI.data = ch.watch.newValue || null;
      if (watchUI.view === "watch" && !$("[data-panel='activity']").hidden) renderWatch();
    }
  });
  // live numbers while the view is open
  setInterval(() => {
    if (watchUI.view === "watch" && !$("[data-panel='activity']").hidden && !document.hidden) refreshWatch();
  }, 15000);

  let start = "messages";
  try { start = localStorage.getItem("tcw-activity-view") || "messages"; } catch (e) { /* ignore */ }
  if (location.hash === "#modlog") start = "modlog";
  setWatchView(["watch", "modlog"].includes(start) ? start : "messages");
}

initWatch();
