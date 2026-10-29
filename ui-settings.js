"use strict";
/* Makes the Chat and Settings tabs easier to get around: a search box that filters every option (and points to
 * matches on the other tab), section chips to jump straight to a section, collapsible sections (remembered on
 * this computer) and a dismissible "new in this version" card. Loaded after ui.js (uses $, $$, h, showTab). */
(() => {
  const PANELS = ["chat", "settings"];
  const COLLAPSE_KEY = "tcw-collapsed";
  const NEW_KEY = "tcw-whatsnew-seen";
  const version = browser.runtime.getManifest().version;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  const collapsed = new Set(store.get(COLLAPSE_KEY, []));

  const panel = (name) => $(`[data-panel='${name}']`);
  const groups = (name) => $$(":scope > .group", panel(name));
  const slug = (t) => t.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();

  // Each option row's searchable text: its label, hint, select options and setting key.
  function rowText(row) {
    const bits = [row.textContent];
    for (const o of row.querySelectorAll("option")) bits.push(o.textContent);
    for (const i of row.querySelectorAll("[data-setting]")) bits.push(i.dataset.setting);
    return norm(bits.join(" "));
  }

  function setCollapsed(g, on) {
    g.classList.toggle("collapsed", on);
    const btn = $(".grp-toggle", g);
    if (btn) btn.setAttribute("aria-expanded", String(!on));
    if (on) collapsed.add(g.id); else collapsed.delete(g.id);
    store.set(COLLAPSE_KEY, [...collapsed]);
  }

  function setup(name) {
    const p = panel(name);
    if (!p) return;
    const tools = h("div", { class: "set-tools" });
    const search = h("input", { type: "search", class: "set-search", placeholder: "Search settings…", "aria-label": "Search settings", spellcheck: "false" });
    const nav = h("nav", { class: "set-nav", "aria-label": "Sections" });
    const toggleAll = h("button", { type: "button", class: "set-link set-all" }, "Collapse all");
    const status = h("div", { class: "set-status", role: "status" });
    tools.append(h("div", { class: "set-row" }, search, toggleAll), nav);

    for (const g of groups(name)) {
      const head = $(":scope > h2", g);
      if (!head) continue;
      const title = head.textContent.trim();
      if (!g.id) g.id = "grp-" + slug(title);
      // the heading becomes a button that folds the section
      const btn = h("button", { type: "button", class: "grp-toggle", "aria-expanded": "true", "aria-controls": g.id + "-body" },
        h("span", {}, title), h("span", { class: "chev", "aria-hidden": "true" }, "▾"));
      head.replaceChildren(btn);
      const body = h("div", { class: "grp-body", id: g.id + "-body" });
      while (head.nextSibling) body.append(head.nextSibling);
      g.append(body);
      btn.addEventListener("click", () => setCollapsed(g, !g.classList.contains("collapsed")));
      if (collapsed.has(g.id)) setCollapsed(g, true);
      for (const row of $$(".opt", body)) row.dataset.search = rowText(row);
      const badge = $(".new", g) ? h("span", { class: "dot-new", title: "Something new here" }) : null;
      nav.append(h("button", { type: "button", class: "sec-chip", "data-target": g.id }, title, badge));
    }

    nav.addEventListener("click", (e) => {
      const chip = e.target.closest(".sec-chip");
      if (chip) jump(name, chip.dataset.target);
    });
    toggleAll.addEventListener("click", () => {
      const all = groups(name);
      const fold = all.some((g) => !g.classList.contains("collapsed"));
      for (const g of all) setCollapsed(g, fold);
      updateToggleAll(name);
    });
    search.addEventListener("input", () => filter(name, search.value));
    search.addEventListener("keydown", (e) => { if (e.key === "Escape" && search.value) { e.preventDefault(); search.value = ""; filter(name, ""); } });

    p.prepend(tools, status);
    p._tools = { search, status, toggleAll };
    updateToggleAll(name);
  }

  function updateToggleAll(name) {
    const p = panel(name);
    if (!p || !p._tools) return;
    const anyOpen = groups(name).some((g) => !g.classList.contains("collapsed"));
    p._tools.toggleAll.textContent = anyOpen ? "Collapse all" : "Expand all";
  }

  // Shows only the rows matching every word typed; returns how many matched.
  function filter(name, query) {
    const p = panel(name);
    const words = norm(query).split(" ").filter(Boolean);
    let count = 0;
    p.classList.toggle("searching", !!words.length);
    for (const g of groups(name)) {
      const titleHit = words.length && words.every((w) => norm($(".grp-toggle", g).textContent).includes(w));
      let inGroup = 0;
      for (const row of $$(".opt", g)) {
        const hit = !words.length || titleHit || words.every((w) => row.dataset.search.includes(w));
        row.classList.toggle("no-match", !hit);
        if (hit) inGroup++;
      }
      for (const d of $$("details", g)) if (words.length && $$(".opt:not(.no-match)", d).length) d.open = true;
      g.classList.toggle("no-match", !!words.length && !inGroup);
      count += inGroup;
    }
    for (const chip of $$(".sec-chip", p)) {
      const g = document.getElementById(chip.dataset.target);
      chip.hidden = !!words.length && g.classList.contains("no-match");
    }
    renderStatus(name, words, count);
    return count;
  }

  function countIn(name, words) {
    let n = 0;
    for (const g of groups(name)) {
      const titleHit = words.every((w) => norm($(".grp-toggle", g).textContent).includes(w));
      for (const row of $$(".opt", g)) if (titleHit || words.every((w) => row.dataset.search.includes(w))) n++;
    }
    return n;
  }

  function renderStatus(name, words, count) {
    const p = panel(name);
    const st = p._tools.status;
    st.replaceChildren();
    if (!words.length) return;
    const other = PANELS.find((x) => x !== name);
    const elsewhere = countIn(other, words);
    const label = other === "chat" ? "Chat" : "Settings";
    st.append(count ? `${count} matching option${count === 1 ? "" : "s"}` : "No matching options here");
    if (elsewhere) {
      const go = h("button", { type: "button", class: "set-link" }, `${elsewhere} more in the ${label} tab →`);
      go.addEventListener("click", () => {
        const q = p._tools.search.value;
        showTab(other);
        const op = panel(other);
        op._tools.search.value = q;
        filter(other, q);
        op._tools.search.focus();
      });
      st.append(" · ", go);
    }
  }

  function jump(name, id) {
    showTab(name);
    const p = panel(name);
    if (p._tools.search.value) { p._tools.search.value = ""; filter(name, ""); }
    const g = document.getElementById(id);
    if (!g) return;
    setCollapsed(g, false);
    updateToggleAll(name);
    g.scrollIntoView({ behavior: "smooth", block: "start" });
    g.classList.remove("flash");
    void g.offsetWidth;
    g.classList.add("flash");
  }

  function setupWhatsNew() {
    const card = $("#whatsNew");
    if (!card) return;
    card.hidden = store.get(NEW_KEY, "") === version;
    $("#whatsNewClose").addEventListener("click", () => { card.hidden = true; store.set(NEW_KEY, version); });
    for (const b of $$("[data-jump]")) {
      b.addEventListener("click", () => {
        const [tab, id] = b.dataset.jump.split(":");
        jump(tab, id);
      });
    }
  }

  PANELS.forEach(setup);
  setupWhatsNew();
  // "/" focuses the search box on the Chat and Settings tabs
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
    const open = PANELS.map(panel).find((p) => p && !p.hidden);
    if (!open) return;
    e.preventDefault();
    open._tools.search.focus();
  });
})();
