"use strict";
/* Chat tab extras (emote stats, auto-claim counts) and Activity → Mod log. Uses h(), $, send(), armed(), ago() from ui.js. */

const chatUI = { modLog: [], emoteStats: {}, emoteFavs: [], claimStats: {} };

function modText(e) {
  if (e.k === "ban") return e.permanent ? "banned" : `timed out for ${TCWChatLib.fmtDuration(e.duration)}`;
  if (e.k === "del") return "message deleted";
  return "chat cleared by a moderator";
}

function renderModlog() {
  const box = $("#modlog");
  if (!box) return;
  const sel = $("#modlogChannel");
  const keep = sel.value;
  const chans = [...new Set(chatUI.modLog.map((e) => e.ch))].sort();
  sel.replaceChildren(h("option", { value: "" }, "All channels"), ...chans.map((c) => h("option", { value: c }, "#" + c)));
  sel.value = chans.includes(keep) ? keep : "";
  const q = $("#modlogFilter").value.trim().toLowerCase();
  const list = chatUI.modLog.filter((e) =>
    (!sel.value || e.ch === sel.value) &&
    (!q || (e.login || "").includes(q) || (e.text || "").toLowerCase().includes(q))).slice(0, 300);
  if (!chatUI.modLog.length) {
    box.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "empty-title" }, "No moderation events yet"),
      h("div", {}, state.settings.modLogOn && state.settings.ircOn
        ? "Bans, timeouts, deleted messages and chat clears show up here while you have a channel open."
        : "Turn on Chat → Keep a moderation log and Connect to chat directly.")));
    return;
  }
  if (!list.length) {
    box.replaceChildren(h("div", { class: "empty" }, "Nothing matches."));
    return;
  }
  const color = { ban: "#ff5f5f", del: "#ffb300", clear: "#adadb8" };
  box.replaceChildren(...list.map((e) => h("div", { class: "card entry modlog", style: { "--c": color[e.k] || "#adadb8" } },
    h("div", { class: "entry-head" },
      h("b", {}, e.login || "Chat"),
      h("span", { class: "chan" }, modText(e)),
      h("span", { class: "chan" }, "#" + e.ch),
      h("span", { class: "time", title: new Date(e.time).toLocaleString() }, ago(e.time))),
    e.text ? h("div", { class: "text" }, e.text) : null)));
}

function renderEmoteStats() {
  const top = TCWChatLib.topEmotes(chatUI.emoteStats, 12);
  const total = Object.values(chatUI.emoteStats).reduce((s, x) => s + (x.n || 0), 0);
  $("#emoteSummary").textContent = total
    ? `${total} emote${total === 1 ? "" : "s"} sent · ${chatUI.emoteFavs.length} favorite${chatUI.emoteFavs.length === 1 ? "" : "s"}`
    : `Your most used emotes show up here once you chat · ${chatUI.emoteFavs.length} favorite${chatUI.emoteFavs.length === 1 ? "" : "s"}`;
  $("#emoteTop").replaceChildren(...top.map((e) => h("span", { class: "emote-chip", title: `${e.name} · used ${e.n}×` },
    /^https:\/\/(static-cdn\.jtvnw\.net|cdn\.7tv\.app)\//.test(e.src || "") ? h("img", { src: e.src, alt: "", referrerpolicy: "no-referrer" }) : null,
    h("span", {}, e.name), h("small", {}, String(e.n)))));
}

function renderClaims() {
  const c = chatUI.claimStats || {};
  const parts = [];
  if (c.points) parts.push(`${c.points} bonus chest${c.points === 1 ? "" : "s"}`);
  if (c.moments) parts.push(`${c.moments} Moment${c.moments === 1 ? "" : "s"}`);
  if (c.drops) parts.push(`${c.drops} Drop${c.drops === 1 ? "" : "s"}`);
  const last = c.last ? ` · last ${ago(c.last.time)}${c.last.channel ? " in #" + c.last.channel : ""}` : "";
  $("#claimSummary").textContent = parts.length ? "Claimed " + parts.join(", ") + last : "Nothing claimed yet";
}

async function initChatUI() {
  const d = await browser.storage.local.get(["modLog", "emoteStats", "emoteFavs", "claimStats"]);
  chatUI.modLog = Array.isArray(d.modLog) ? d.modLog : [];
  chatUI.emoteStats = d.emoteStats && typeof d.emoteStats === "object" ? d.emoteStats : {};
  chatUI.emoteFavs = Array.isArray(d.emoteFavs) ? d.emoteFavs : [];
  chatUI.claimStats = d.claimStats || {};

  $("#modlogChannel").addEventListener("change", renderModlog);
  $("#modlogFilter").addEventListener("input", renderModlog);
  $("#clearModlog").addEventListener("click", () => send("modlog:clear"));
  armed($("#resetEmotes"), "Click again", () => send("emotes:resetStats"));
  $("#dropsNow").addEventListener("click", async () => {
    const r = await send("drops:checkNow").catch((e) => ({ error: String(e) }));
    $("#claimSummary").textContent = r && r.error ? "Couldn't check: " + r.error
      : state.settings.autoDrops && state.settings.autoDropsBg ? "Checking your Drops inventory in a background tab…"
        : "Turn on Drops and Check Drops in the background first";
  });

  browser.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.modLog) { chatUI.modLog = ch.modLog.newValue || []; renderModlog(); }
    if (ch.emoteStats || ch.emoteFavs) {
      if (ch.emoteStats) chatUI.emoteStats = ch.emoteStats.newValue || {};
      if (ch.emoteFavs) chatUI.emoteFavs = ch.emoteFavs.newValue || [];
      renderEmoteStats();
    }
    if (ch.claimStats) { chatUI.claimStats = ch.claimStats.newValue || {}; renderClaims(); }
  });

  renderModlog();
  renderEmoteStats();
  renderClaims();
}

initChatUI();
