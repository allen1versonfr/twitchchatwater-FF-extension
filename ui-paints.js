"use strict";
/* Paints tab: gallery, editor with live preview, publish/unpublish. Uses h(), $, send(), armed(), state from ui.js. */

const P = TCWPaint;
const paint = {
  lib: [],
  me: {},
  hidden: [],
  recent: [],
  cfg: { server: "", clientId: "", redirectUrl: "", canPublish: false },
  draft: null,      // entry being edited
  editingId: null,  // id of the saved paint being edited (null = new/copy)
  colorRow: 0       // which color row the swatches apply to
};

const KIND_LABELS = { solid: "Solid", linear: "Gradient", radial: "Radial", rainbow: "Rainbow" };
const WEIGHT_LABELS = { 0: "Twitch default", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black" };

function paintById(id) {
  return paint.lib.find((p) => p.id === id) || P.PRESETS.find((p) => p.id === id) || null;
}

function myName() {
  return paint.me.login || "YourName";
}

function paintMsg(text, kind) {
  const el = $("#paintMsg");
  el.textContent = text || "";
  el.className = "hint" + (kind ? " " + kind : "");
}

async function call(type, extra) {
  const r = await send(type, extra);
  if (r && r.ok === false) throw new Error(r.error);
  return r ? r.value : undefined;
}

// A painted name sample. Uses classes + CSS variables only (same as in chat).
function sample(entry, text, themeName) {
  const span = h("span", { class: "pv-name" }, text);
  if (entry) P.apply(span, entry, { theme: themeName || "dark", animate: state.settings.paintsAnimate !== false });
  return span;
}

// ---------- "your name" card ----------

function renderMe() {
  const box = $("#paintMe");
  const active = paintById(paint.me.activeId);
  const pub = paint.me.published;
  const busy = !!paint.me.busy;
  const rows = [];

  rows.push(h("div", { class: "me-preview chat-preview dark" },
    h("span", { class: "pv-badge", "aria-hidden": "true" }),
    active ? sample(active, myName()) : h("span", { class: "pv-name pv-plain" }, myName()),
    h("span", { class: "pv-colon" }, ": "),
    h("span", { class: "pv-text" }, active ? "how's my name look?" : "no paint yet")
  ));

  let status;
  const actions = [];
  if (!active) {
    status = "Pick a paint below and press Use.";
  } else if (!paint.cfg.canPublish) {
    status = "Only you can see this. Sharing isn't set up in this version yet.";
  } else if (busy) {
    status = "Waiting for Twitch sign-in…";
  } else if (!pub) {
    status = "Private: only you can see it.";
    actions.push(h("button", { class: "btn primary small", onclick: publish }, "Publish"));
  } else if (pub.key === P.key(active)) {
    status = `Published as ${paint.me.login}. Others using Chat Watcher can see it.`;
    actions.push(h("button", { class: "btn ghost small", onclick: unpublish }, "Unpublish"));
  } else {
    status = `Your published paint (${pub.name || "older version"}) is different from the one you're using.`;
    actions.push(h("button", { class: "btn primary small", onclick: publish }, "Publish this one"));
    actions.push(h("button", { class: "btn ghost small", onclick: unpublish }, "Unpublish"));
  }
  if (!active && pub && paint.cfg.canPublish && !busy) {
    status = `You still have a published paint as ${paint.me.login}.`;
    actions.push(h("button", { class: "btn ghost small", onclick: unpublish }, "Unpublish"));
  }
  if (active) actions.push(h("button", { class: "btn ghost small", onclick: () => setActive(null) }, "Stop using"));

  rows.push(h("div", { class: "me-status" },
    busy ? h("span", { class: "spinner", "aria-hidden": "true" }) : null,
    h("span", {}, status)
  ));
  if (paint.me.lastError && !busy) rows.push(h("div", { class: "hint err" }, paint.me.lastError));
  if (actions.length) rows.push(h("div", { class: "actions" }, actions));
  box.replaceChildren(...rows);

  $("#paintOptIn").hidden = !(paint.cfg.server && !state.settings.paintsOthers);
}

async function publish() {
  paintMsg("A Twitch window will open so you can confirm it's your account.");
  try {
    await call("paints:publish");
    paintMsg("Published! Other Chat Watcher users will see it within a few minutes.", "ok");
  } catch (e) {
    paintMsg(e.message, "err");
  }
}

async function unpublish() {
  paintMsg("A Twitch window will open so you can confirm it's your account.");
  try {
    await call("paints:unpublish");
    paintMsg("Unpublished. Others will stop seeing it within a few minutes.", "ok");
  } catch (e) {
    paintMsg(e.message, "err");
  }
}

async function setActive(id) {
  try {
    await call("paints:setActive", { id });
    paintMsg(id ? "Now using this paint on your name." : "Stopped using a paint.", "ok");
  } catch (e) {
    paintMsg(e.message, "err");
  }
}

// ---------- gallery ----------

function tile(entry, isPreset) {
  const inUse = paint.me.activeId === entry.id;
  const open = () => openEditor(entry, isPreset);
  return h("div", { class: "tile" + (inUse ? " in-use" : "") },
    h("button", {
      class: "tile-main", title: isPreset ? "Customize a copy" : "Edit",
      "aria-label": `${entry.name}, ${KIND_LABELS[entry.kind]}${entry.animate ? ", animated" : ""}. ${isPreset ? "Customize a copy" : "Edit"}`,
      onclick: open
    },
      h("span", { class: "tile-sample" }, sample(entry, entry.name)),
      h("span", { class: "tile-kind" }, KIND_LABELS[entry.kind] + (entry.animate ? " · animated" : ""))
    ),
    h("div", { class: "tile-foot" },
      inUse
        ? h("span", { class: "tile-using" }, "✓ In use")
        : h("button", { class: "btn ghost small", onclick: () => setActive(entry.id) }, "Use"),
      isPreset ? null : h("button", {
        class: "icon-btn fav" + (entry.fav ? " on" : ""),
        title: entry.fav ? "Remove from favorites" : "Add to favorites",
        "aria-pressed": String(!!entry.fav),
        onclick: () => call("paints:save", { entry: { ...entry, fav: !entry.fav } }).catch((e) => paintMsg(e.message, "err"))
      }, entry.fav ? "★" : "☆")
    )
  );
}

function renderGallery() {
  const mine = [...paint.lib].sort((a, b) => (b.fav - a.fav) || (b.updated - a.updated));
  $("#myPaints").replaceChildren(...(mine.length
    ? mine.map((e) => tile(e, false))
    : [h("div", { class: "empty small" },
        h("div", { class: "empty-title" }, "No paints of your own yet"),
        h("div", {}, "Start from a preset below or press New paint."))]));
  $("#presetPaints").replaceChildren(...P.PRESETS.map((e) => tile(e, true)));
}

function renderPaints() {
  if (!$("#paintGallery")) return;
  renderMe();
  if (!$("#paintGallery").hidden) renderGallery();
  const n = paint.hidden.length;
  $("#hiddenPaintsLbl").replaceChildren("Hidden paints", h("small", {}, n ? `You've hidden ${n} ${n === 1 ? "person's" : "people's"} paint` : "Hide someone's paint from their profile card in chat"));
  $("#clearHiddenPaints").disabled = !n;
  $("#redirectUrl").value = paint.cfg.redirectUrl || "";
}

// ---------- editor ----------

function openEditor(entry, isCopy) {
  const base = entry ? JSON.parse(JSON.stringify(entry)) : {
    ...P.sanitizeEntry({ kind: "linear", colors: [{ c: "#9147ff", p: 0 }, { c: "#00e5ff", p: 100 }], angle: 90, name: "My paint" })
  };
  if (isCopy) {
    base.name = (entry.name + " copy").slice(0, 40);
    delete base.preset;
  }
  paint.draft = P.sanitizeEntry(base);
  paint.draft.name = base.name;
  paint.editingId = entry && !isCopy ? entry.id : null;
  paint.colorRow = 0;
  $("#paintGallery").hidden = true;
  $("#paintEditor").hidden = false;
  renderEditor();
  const first = $("#paintEditor input, #paintEditor button");
  if (first) first.focus();
}

function closeEditor() {
  paint.draft = null;
  paint.editingId = null;
  $("#paintEditor").hidden = true;
  $("#paintEditor").replaceChildren();
  $("#paintGallery").hidden = false;
  renderPaints();
}

function draftChanged(full) {
  paint.draft = { ...paint.draft };
  if (full) renderEditor();
  else updatePreview();
}

function ensureColors(kind) {
  const [min, max] = P.LIMITS[kind];
  let list = paint.draft.colors.slice(0, max);
  const fill = ["#ff3b30", "#ffcc00", "#34c759", "#00c7ff", "#5856d6", "#af52de"];
  while (list.length < min) list.push({ c: fill[list.length % fill.length], p: 100 });
  if (kind === "linear" || kind === "radial") {
    // spread evenly when switching in, so stops make sense
    list = list.map((c, i) => ({ c: c.c, p: list.length > 1 ? Math.round((i / (list.length - 1)) * 100) : 0 }));
  }
  paint.draft.colors = list;
}

function seg(label, options, value, onPick) {
  return h("div", { class: "seg", role: "radiogroup", "aria-label": label },
    options.map(([v, text]) => h("button", {
      type: "button", role: "radio", "aria-checked": String(v === value),
      class: v === value ? "on" : "",
      onclick: () => onPick(v)
    }, text)));
}

function range(label, value, min, max, step, onInput, unit) {
  const out = h("output", {}, value + (unit || ""));
  const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": label });
  input.addEventListener("input", () => {
    out.textContent = input.value + (unit || "");
    onInput(Number(input.value));
  });
  return h("div", { class: "field" }, h("span", { class: "lbl" }, label), input, out);
}

function toggle(label, checked, onChange) {
  return h("div", { class: "field" }, h("span", { class: "lbl" }, label), switchEl(checked, onChange, { label }));
}

// Color picker + text box that accepts #hex, rgb() and hsl().
function colorControl(label, value, onPick, onFocus) {
  const picker = h("input", { type: "color", class: "swatch", value, "aria-label": label + " picker" });
  const text = h("input", { type: "text", class: "color-text", value, spellcheck: "false", "aria-label": label + " (hex, rgb or hsl)" });
  const set = (hexv) => {
    picker.value = hexv;
    text.value = hexv;
    text.classList.remove("bad");
    text.removeAttribute("aria-invalid");
    onPick(hexv);
  };
  picker.addEventListener("input", () => set(picker.value));
  text.addEventListener("change", () => {
    const c = P.parseColor(text.value);
    if (c) return set(c);
    text.classList.add("bad");
    text.setAttribute("aria-invalid", "true");
    paintMsgEditor("Use a color like #ff00aa, rgb(255, 0, 170) or hsl(320, 100%, 50%).");
  });
  if (onFocus) [picker, text].forEach((el) => el.addEventListener("focus", onFocus));
  return [picker, text];
}

function paintMsgEditor(text, kind) {
  const el = $("#editorMsg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "hint" + (kind ? " " + kind : "");
}

function swatchRow() {
  const colors = [...new Set(paint.recent.concat(P.SWATCHES))].slice(0, 20);
  return h("div", { class: "field col" },
    h("span", { class: "lbl" }, `Quick colors (applies to color ${paint.colorRow + 1})`),
    h("div", { class: "chips" }, colors.map((c) => h("button", {
      type: "button", class: "chip", title: c, "aria-label": "Use " + c,
      style: { "--chip": c },
      onclick: () => {
        const row = Math.min(paint.colorRow, paint.draft.colors.length - 1);
        paint.draft.colors[row] = { ...paint.draft.colors[row], c };
        draftChanged(true);
      }
    }))));
}

function colorRows() {
  const d = paint.draft;
  const [, max] = P.LIMITS[d.kind];
  const positioned = d.kind === "linear" || d.kind === "radial";
  const rows = d.colors.map((c, i) => {
    const [picker, text] = colorControl(`Color ${i + 1}`, c.c, (v) => {
      d.colors[i] = { ...d.colors[i], c: v };
      draftChanged(false);
    }, () => { paint.colorRow = i; const lbl = $("#paintEditor .chips")?.previousSibling; if (lbl) lbl.textContent = `Quick colors (applies to color ${i + 1})`; });
    const parts = [h("span", { class: "row-num" }, String(i + 1)), picker, text];
    if (positioned) {
      const pos = h("input", { type: "range", min: "0", max: "100", step: "1", value: String(c.p), class: "pos", "aria-label": `Color ${i + 1} position` });
      const out = h("output", {}, c.p + "%");
      pos.addEventListener("input", () => {
        out.textContent = pos.value + "%";
        d.colors[i] = { ...d.colors[i], p: Number(pos.value) };
        draftChanged(false);
      });
      pos.addEventListener("change", () => { d.colors.sort((a, b) => a.p - b.p); draftChanged(true); });
      parts.push(pos, out);
    }
    if (d.colors.length > P.LIMITS[d.kind][0]) {
      parts.push(h("button", {
        type: "button", class: "icon-btn", title: "Remove color", "aria-label": `Remove color ${i + 1}`,
        onclick: () => { d.colors.splice(i, 1); paint.colorRow = 0; draftChanged(true); }
      }, "✕"));
    }
    return h("div", { class: "color-row" + (i === paint.colorRow ? " sel" : "") }, parts);
  });
  if (d.kind !== "solid") {
    rows.push(h("button", {
      type: "button", class: "btn ghost small", disabled: d.colors.length >= max,
      onclick: () => {
        const last = d.colors[d.colors.length - 1];
        d.colors.push({ c: P.SWATCHES[d.colors.length % P.SWATCHES.length], p: 100 });
        if (positioned) {
          // squeeze the previous last stop to make room
          if (last && last.p === 100 && d.colors.length > 2) last.p = Math.max(0, 100 - Math.round(100 / d.colors.length));
        }
        paint.colorRow = d.colors.length - 1;
        draftChanged(true);
      }
    }, d.colors.length >= max ? `Up to ${max} colors` : "+ Add color"));
  }
  return rows;
}

function effectBlock(title, on, onToggle, body, onReset) {
  return h("div", { class: "effect" + (on ? " on" : "") },
    h("div", { class: "field" },
      h("span", { class: "lbl strong" }, title),
      h("button", { type: "button", class: "link", onclick: onReset }, "Reset"),
      switchEl(on, onToggle, { label: title })
    ),
    on ? body : null
  );
}

function updatePreview() {
  const d = P.sanitizeEntry(paint.draft);
  for (const el of document.querySelectorAll("#paintEditor .pv-target")) {
    if (d) P.apply(el, d, { theme: el.dataset.theme, animate: state.settings.paintsAnimate !== false });
  }
  const warn = $("#contrastWarn");
  if (warn && d) {
    const dark = P.readability(d, "#18181b").best < 2.2;
    const light = P.readability(d, "#ffffff").best < 2.2;
    warn.textContent = dark || light
      ? `Hard to read on ${dark && light ? "both themes" : dark ? "dark" : "light"} Twitch. A faint outline is added automatically there so the name stays readable.`
      : "";
    warn.hidden = !(dark || light);
  }
}

function renderEditor() {
  const d = paint.draft;
  const box = $("#paintEditor");
  const kinds = Object.entries(KIND_LABELS);
  const animatable = d.kind === "linear" || d.kind === "rainbow";
  const angled = d.kind === "linear" || (d.kind === "rainbow" && !d.animate);

  const nameInput = h("input", { type: "text", value: d.name, maxlength: "40", "aria-label": "Paint name", placeholder: "Paint name" });
  nameInput.addEventListener("input", () => { d.name = nameInput.value; });

  const preview = (themeName) => h("div", { class: "chat-preview " + themeName },
    h("span", { class: "pv-badge", "aria-hidden": "true" }),
    h("span", { class: "pv-name pv-target", "data-theme": themeName }, myName()),
    h("span", { class: "pv-colon" }, ": "),
    h("span", { class: "pv-text" }, "gg that was clean")
  );

  const sections = [
    h("div", { class: "editor-head" },
      h("button", { type: "button", class: "icon-btn", title: "Back to gallery", "aria-label": "Back to gallery", onclick: closeEditor }, "←"),
      nameInput
    ),
    h("div", { class: "previews", "aria-label": "Live preview" }, preview("dark"), preview("light")),
    h("div", { id: "contrastWarn", class: "hint warn", hidden: true }),
    h("div", { class: "group" },
      h("h2", {}, "Style"),
      seg("Paint style", kinds, d.kind, (k) => { d.kind = k; if (!(k === "linear" || k === "rainbow")) d.animate = false; ensureColors(k); paint.colorRow = 0; draftChanged(true); })
    ),
    h("div", { class: "group" },
      h("h2", {}, d.kind === "solid" ? "Color" : "Colors"),
      ...colorRows(),
      swatchRow()
    )
  ];

  const shape = [];
  if (angled) shape.push(range("Angle", d.angle, 0, 360, 1, (v) => { d.angle = v; draftChanged(false); }, "°"));
  if (d.kind === "radial") shape.push(h("div", { class: "field" }, h("span", { class: "lbl" }, "Shape"),
    seg("Shape", [["circle", "Circle"], ["ellipse", "Ellipse"]], d.shape, (v) => { d.shape = v; draftChanged(true); })));
  if (animatable) {
    shape.push(toggle("Animate", d.animate, (v) => { d.animate = v; draftChanged(true); }));
    if (d.animate) {
      shape.push(range("Loop time", d.speed, 1, 30, 0.5, (v) => { d.speed = v; draftChanged(false); }, "s"));
      shape.push(h("div", { class: "field" }, h("span", { class: "lbl" }, "Direction"),
        seg("Direction", [[false, "Left → right"], [true, "Right → left"]], d.reverse, (v) => { d.reverse = v; draftChanged(true); })));
      shape.push(h("p", { class: "hint" }, "Animated paints slide sideways and loop without a jump."));
    }
  }
  if (shape.length) sections.push(h("div", { class: "group" }, h("h2", {}, d.kind === "radial" ? "Shape" : "Direction & motion"), ...shape));

  const weightSel = h("select", { "aria-label": "Text weight" }, P.WEIGHTS.map((w) => h("option", { value: String(w) }, WEIGHT_LABELS[w])));
  weightSel.value = String(d.weight);
  weightSel.addEventListener("change", () => { d.weight = Number(weightSel.value); draftChanged(false); });

  const glowColor = colorControl("Glow color", d.glow.color, (v) => { d.glow = { ...d.glow, color: v }; draftChanged(false); });
  const outlineColor = colorControl("Outline color", d.outline.color, (v) => { d.outline = { ...d.outline, color: v }; draftChanged(false); });

  sections.push(h("div", { class: "group" },
    h("h2", {}, "Effects"),
    effectBlock("Glow / shadow", d.glow.on, (v) => { d.glow = { ...d.glow, on: v }; draftChanged(true); }, [
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Color"), ...glowColor),
      range("Blur", d.glow.size, 0, 10, 0.5, (v) => { d.glow = { ...d.glow, size: v }; draftChanged(false); }, "px"),
      range("Offset X", d.glow.x, -4, 4, 0.5, (v) => { d.glow = { ...d.glow, x: v }; draftChanged(false); }, "px"),
      range("Offset Y", d.glow.y, -4, 4, 0.5, (v) => { d.glow = { ...d.glow, y: v }; draftChanged(false); }, "px")
    ], () => { d.glow = { on: false, color: "#ffffff", size: 4, x: 0, y: 0 }; draftChanged(true); }),
    effectBlock("Outline", d.outline.on, (v) => { d.outline = { ...d.outline, on: v }; draftChanged(true); }, [
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Color"), ...outlineColor),
      range("Width", d.outline.size, 0.5, 2, 0.5, (v) => { d.outline = { ...d.outline, size: v }; draftChanged(false); }, "px")
    ], () => { d.outline = { on: false, color: "#000000", size: 1 }; draftChanged(true); }),
    h("div", { class: "field" }, h("span", { class: "lbl strong" }, "Text weight"), weightSel,
      h("button", { type: "button", class: "link", onclick: () => { d.weight = 0; draftChanged(true); } }, "Reset"))
  ));

  const actions = [
    h("button", { type: "button", class: "btn primary", onclick: () => saveDraft(true) }, "Save & use"),
    h("button", { type: "button", class: "btn ghost", onclick: () => saveDraft(false) }, "Save")
  ];
  if (paint.editingId) {
    actions.push(h("button", { type: "button", class: "btn ghost", onclick: () => openEditor(paintById(paint.editingId), true) }, "Duplicate"));
    const del = h("button", { type: "button", class: "btn danger" }, "Delete");
    armed(del, "Click again", async () => {
      try {
        await call("paints:delete", { id: paint.editingId });
        closeEditor();
        paintMsg("Paint deleted.", "ok");
      } catch (e) { paintMsgEditor(e.message, "err"); }
    });
    actions.push(del);
  }
  actions.push(h("button", { type: "button", class: "btn ghost", onclick: closeEditor }, "Cancel"));
  sections.push(h("div", { id: "editorMsg", class: "hint", role: "status" }));
  sections.push(h("div", { class: "editor-actions" }, actions));

  const keep = box.scrollTop;
  box.replaceChildren(...sections);
  box.scrollTop = keep;
  updatePreview();
}

async function saveDraft(use) {
  const d = paint.draft;
  const entry = { ...d, name: (d.name || "").trim() || "Untitled paint", id: paint.editingId || undefined };
  if (!P.sanitize(entry)) return paintMsgEditor("This paint isn't complete yet. Check its colors.", "err");
  try {
    const saved = await call("paints:save", { entry });
    if (use) await call("paints:setActive", { id: saved.id });
    closeEditor();
    paintMsg(use ? `Saved and now using “${saved.name}”.` : `Saved “${saved.name}”.`, "ok");
  } catch (e) {
    paintMsgEditor(e.message, "err");
  }
}

// ---------- import / export ----------

function exportPaints() {
  const data = { app: "twitch-chat-watcher-paints", version: 1, exported: new Date().toISOString(),
    paints: paint.lib.map(({ id, updated, ...rest }) => rest) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: `chat-watcher-paints-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  paintMsg(paint.lib.length ? `Exported ${paint.lib.length} paint${paint.lib.length === 1 ? "" : "s"}.` : "Exported an empty list (you have no saved paints yet).", "ok");
}

async function importPaintsFile(file) {
  try {
    if (file.size > 512 * 1024) throw new Error("That file is too big to be a paint export.");
    const data = JSON.parse(await file.text());
    const r = await call("paints:import", { data });
    paintMsg(`Imported ${r.added} paint${r.added === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} that weren't valid` : ""}.`, r.added ? "ok" : "err");
  } catch (e) {
    paintMsg("Couldn't import: " + (e.message || e), "err");
  }
}

// ---------- wiring ----------

function applyPaintData(d) {
  if ("paintLib" in d) paint.lib = (Array.isArray(d.paintLib) ? d.paintLib : []).map(P.sanitizeEntry).filter(Boolean);
  if ("paintMe" in d) paint.me = d.paintMe && typeof d.paintMe === "object" ? d.paintMe : {};
  if ("paintHidden" in d) paint.hidden = Array.isArray(d.paintHidden) ? d.paintHidden : [];
  if ("paintRecent" in d) paint.recent = (Array.isArray(d.paintRecent) ? d.paintRecent : []).map(P.hex).filter(Boolean);
}

async function refreshPaintConfig() {
  try { paint.cfg = (await send("paints:config")) || paint.cfg; } catch (e) { /* background starting */ }
}

async function initPaints() {
  const d = await browser.storage.local.get(["paintLib", "paintMe", "paintHidden", "paintRecent"]);
  applyPaintData({ paintLib: d.paintLib, paintMe: d.paintMe, paintHidden: d.paintHidden, paintRecent: d.paintRecent });
  await refreshPaintConfig();

  $("#newPaint").addEventListener("click", () => openEditor(null, false));
  $("#exportPaints").addEventListener("click", exportPaints);
  $("#importPaints").addEventListener("click", () => $("#importPaintsFile").click());
  $("#importPaintsFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) importPaintsFile(f);
  });
  $("#paintOptInBtn").addEventListener("click", () => send("setSettings", { patch: { paintsOthers: true } }));
  $("#clearHiddenPaints").addEventListener("click", () => browser.storage.local.set({ paintHidden: [] }));
  armed($("#resetPaints"), "Click again", async () => {
    await call("paints:reset");
    dataMsg("Your saved paints were deleted.", "ok");
  });
  $("#redirectUrl").addEventListener("focus", (e) => e.target.select());

  browser.storage.onChanged.addListener(async (ch, area) => {
    if (area !== "local") return;
    const d2 = {};
    for (const k of ["paintLib", "paintMe", "paintHidden", "paintRecent"]) if (ch[k]) d2[k] = ch[k].newValue;
    if (ch.settings) {
      const o = ch.settings.oldValue || {}, n = ch.settings.newValue || {};
      if (o.paintServer !== n.paintServer || o.twitchClientId !== n.twitchClientId) await refreshPaintConfig();
    }
    if (Object.keys(d2).length || ch.settings) {
      applyPaintData(d2);
      renderPaints();
    }
  });
  renderPaints();
}

initPaints();
