"use strict";
/* Settings, organized: every option lives in one Settings tab, sorted into categories. The tab opens on a list of
 * the categories (icon, name, what's inside); pick one to see just its options, with a back button. In a full tab the
 * categories stay in a sidebar. A search box finds any option across all categories ("/" jumps to it).
 * Groups declare their category with data-cat in ui.html. Loaded after ui.js (uses $, $$, h, showTab). */
(() => {
  const NEW_KEY = "tcw-whatsnew-seen";
  const CAT_KEY = "tcw-set-cat";
  const version = browser.runtime.getManifest().version;

  // icons: static SVG paths from this file only
  const svg = (d) => {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`, "image/svg+xml");
    return document.importNode(doc.documentElement, true);
  };
  const CATS = [
    { id: "alerts", title: "Alerts & read aloud", desc: "Sounds, notifications, mentions, text-to-speech",
      icon: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>' },
    { id: "chat", title: "Chat", desc: "Appearance, profile cards, deleted messages",
      icon: '<path d="M4 5h16v11H9l-5 4z"/>' },
    { id: "emotes", title: "Emotes", desc: "7TV / BTTV / FFZ, suggestions, emote spam",
      icon: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1.8 2 5.2 2 7 0"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>' },
    { id: "highlights", title: "Highlights & filters", desc: "Words, badges, hiding messages",
      icon: '<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M13 7l3 3"/>' },
    { id: "player", title: "Player & audio", desc: "Stable volume, compressor, VOD unmute",
      icon: '<path d="M4 10h3l5-4v12l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>' },
    { id: "mod", title: "Moderation", desc: "Mod tools, logs, chatter marks",
      icon: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>' },
    { id: "claim", title: "Auto-claim", desc: "Bonus points, Moments, Drops",
      icon: '<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M12 9v11M4 13h16"/><path d="M12 9c-2-4-6-3-5 0M12 9c2-4 6-3 5 0"/>' },
    { id: "paints", title: "Nametag paints", desc: "Show paints, paint server",
      icon: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2s-.8-1.5-.8-2.5S14 15 15.5 15H18a3 3 0 0 0 3-3c0-5-4-9-9-9z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>' },
    { id: "watch", title: "Watch time", desc: "Tracking, badge, export",
      icon: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/>' },
    { id: "data", title: "Sync & data", desc: "Firefox Sync, backup, reset",
      icon: '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>' }
  ];

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  const panel = $("[data-panel='settings']");
  if (!panel) return;
  const full = document.body.classList.contains("full");
  const content = h("div", { class: "set-content" });
  const groups = () => $$(":scope > .group", content);
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const slug = (t) => t.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const catOf = (id) => CATS.find((c) => c.id === id);
  let current = "";

  // what a search looks at: label, hint, select options, setting key and the group's name
  function rowText(row, groupTitle) {
    const bits = [row.textContent, groupTitle];
    for (const o of row.querySelectorAll("option")) bits.push(o.textContent);
    for (const i of row.querySelectorAll("[data-setting]")) bits.push(i.dataset.setting);
    return norm(bits.join(" "));
  }

  // ---------- building ----------

  const tools = h("div", { class: "set-tools" });
  const search = h("input", { type: "search", class: "set-search", placeholder: "Search all settings…", "aria-label": "Search all settings", spellcheck: "false" });
  tools.append(search);
  const status = h("div", { class: "set-status", role: "status" });

  const nav = h("nav", { class: "set-cats", "aria-label": "Settings categories" });
  const head = h("div", { class: "set-head" });

  for (const g of $$(":scope > .group", panel)) {
    const title = ($(":scope > h2", g) || {}).textContent || "";
    if (!g.id) g.id = "grp-" + slug(title);
    for (const row of $$(".opt", g)) row.dataset.search = rowText(row, title);
    content.append(g);
  }

  for (const c of CATS) {
    const inCat = groups().filter((g) => g.dataset.cat === c.id);
    if (!inCat.length) continue;
    const isNew = inCat.some((g) => $(".new", g));
    const btn = h("button", { type: "button", class: "set-cat", "data-cat": c.id },
      h("span", { class: "set-cat-icon" }, svg(c.icon)),
      h("span", { class: "set-cat-text" }, h("b", {}, c.title), h("small", {}, c.desc)),
      isNew ? h("span", { class: "dot-new", title: "Something new in here" }) : null,
      h("span", { class: "set-cat-chev", "aria-hidden": "true" }, "›"));
    btn.addEventListener("click", () => openCat(c.id, true));
    nav.append(btn);
  }

  const back = h("button", { type: "button", class: "set-back" }, "‹ All settings");
  back.addEventListener("click", () => openCat("", true));
  const headTitle = h("h2", { class: "set-title" });
  head.append(back, headTitle);

  const card = $("#whatsNew");
  const body = h("div", { class: "set-body" }, head, status, content);
  panel.replaceChildren(tools, ...(card ? [card] : []), h("div", { class: "set-layout" }, nav, body));

  // ---------- showing a category ----------

  function openCat(id, user) {
    current = catOf(id) ? id : full ? CATS[0].id : "";
    store.set(CAT_KEY, current);
    if (search.value) { search.value = ""; filter(""); }
    render();
    if (user) (full ? body : panel).scrollIntoView({ block: "start" });
    if (user && !full) panel.closest("main").scrollTop = 0;
  }

  function render() {
    const searching = !!norm(search.value);
    panel.classList.toggle("searching", searching);
    panel.classList.toggle("home", !current && !searching);
    const c = catOf(current);
    headTitle.textContent = c ? c.title : "";
    head.hidden = searching || !c;
    for (const b of $$(".set-cat", nav)) {
      const on = b.dataset.cat === current && !searching;
      b.classList.toggle("on", on);
      b.setAttribute("aria-current", on ? "page" : "false");
    }
    for (const g of groups()) {
      g.hidden = searching ? g.classList.contains("no-match") : g.dataset.cat !== current;
      // no divider under the last option that's showing
      const rows = $$(".opt", g);
      rows.forEach((r) => r.classList.remove("last-visible"));
      const lastShown = rows.filter((r) => !r.classList.contains("no-match") && !r.closest("details:not([open])")).pop();
      if (lastShown) lastShown.classList.add("last-visible");
      // a group named like its category doesn't need its own heading
      const h2 = $(":scope > h2", g);
      const ownCat = catOf(g.dataset.cat);
      if (h2) h2.hidden = !!ownCat && norm(h2.textContent) === norm(ownCat.title) && (searching || !!c);
    }
  }

  // ---------- search ----------

  function filter(query) {
    const words = norm(query).split(" ").filter(Boolean);
    let count = 0;
    for (const g of groups()) {
      let inGroup = 0;
      for (const row of $$(".opt", g)) {
        const hit = !words.length || words.every((w) => row.dataset.search.includes(w));
        row.classList.toggle("no-match", !hit);
        if (hit) inGroup++;
      }
      for (const d of $$("details", g)) if (words.length && $$(".opt:not(.no-match)", d).length) d.open = true;
      g.classList.toggle("no-match", !!words.length && !inGroup);
      // say which category a result is in
      let tag = $(":scope > .set-cat-tag", g);
      if (words.length && inGroup) {
        if (!tag) { tag = h("div", { class: "set-cat-tag" }); g.prepend(tag); }
        tag.textContent = (catOf(g.dataset.cat) || {}).title || "";
      } else if (tag) tag.remove();
      count += inGroup;
    }
    status.textContent = words.length ? (count ? `${count} matching option${count === 1 ? "" : "s"}` : "No matching options. Try another word.") : "";
    render();
  }

  search.addEventListener("input", () => filter(search.value));
  search.addEventListener("keydown", (e) => { if (e.key === "Escape" && search.value) { e.preventDefault(); search.value = ""; filter(""); } });

  // ---------- jumping to an option (What's new links) ----------

  function jump(name, id) {
    showTab(name);
    if (name !== "settings" || !id) return;
    const g = document.getElementById(id);
    if (!g) return;
    openCat(g.dataset.cat, false);
    g.scrollIntoView({ behavior: "smooth", block: "start" });
    g.classList.remove("flash");
    void g.offsetWidth;
    g.classList.add("flash");
  }

  if (card) {
    card.hidden = store.get(NEW_KEY, "") === version;
    $("#whatsNewClose").addEventListener("click", () => { card.hidden = true; store.set(NEW_KEY, version); });
  }
  for (const b of $$("[data-jump]")) {
    b.addEventListener("click", () => {
      const [tab, id] = b.dataset.jump.split(":");
      jump(tab, id);
    });
  }

  // "/" focuses the search box on the Settings tab
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || panel.hidden) return;
    const t = e.target;
    if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
    search.focus();
  });

  openCat(store.get(CAT_KEY, ""), false);
})();
