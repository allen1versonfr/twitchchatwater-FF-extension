/* Nametag paint engine, shared by the extension (content, background, UI) and the paint server.
 *
 * A paint is a small, strict JSON object. It never contains CSS, HTML or script: every value is a
 * number from a fixed range, a #rrggbb color, or one of a few fixed words. sanitize() rebuilds a
 * paint from scratch out of those parts, so anything else in the input is dropped.
 * style() turns a clean paint into CSS custom-property values that content.css uses.
 */
(function (root) {
  "use strict";

  const VERSION = 1;
  const KINDS = ["solid", "linear", "radial", "rainbow"];
  const LIMITS = {
    solid: [1, 1],
    linear: [2, 8],
    radial: [2, 8],
    rainbow: [2, 12]
  };
  const WEIGHTS = [0, 400, 500, 600, 700, 800, 900]; // 0 = keep Twitch's weight
  const DARK_BG = "#18181b";
  const LIGHT_BG = "#ffffff";

  // ---------- small helpers ----------

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  function num(v, lo, hi, dflt, step) {
    let n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    n = clamp(n, lo, hi);
    if (step) n = Math.round(n / step) * step;
    return Math.round(n * 100) / 100;
  }
  const bool = (v) => v === true;

  // ---------- colors ----------

  const HEX6 = /^#[0-9a-f]{6}$/;

  function hex(v) {
    if (typeof v !== "string") return null;
    const s = v.trim().toLowerCase();
    if (HEX6.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return null;
  }

  function toHex(r, g, b) {
    return "#" + [r, g, b].map((x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, "0")).join("");
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = clamp(s, 0, 100) / 100;
    l = clamp(l, 0, 100) / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }

  function hexToRgb(h) {
    const c = hex(h);
    if (!c) return null;
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  }

  // Accepts #rgb, #rrggbb, rgb(r, g, b), hsl(h, s%, l%). Returns #rrggbb or null.
  function parseColor(input) {
    if (typeof input !== "string") return null;
    const s = input.trim().toLowerCase();
    const h = hex(s) || hex("#" + s);
    if (h) return h;
    let m = s.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/);
    if (m) {
      const v = m.slice(1, 4).map(Number);
      if (v.some((x) => x > 255)) return null;
      return toHex(...v);
    }
    m = s.match(/^hsla?\(\s*(-?\d{1,3}(?:\.\d+)?)(?:deg)?\s*[, ]\s*(\d{1,3}(?:\.\d+)?)%\s*[, ]\s*(\d{1,3}(?:\.\d+)?)%\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/);
    if (m) {
      const [hh, ss, ll] = m.slice(1, 4).map(Number);
      if (ss > 100 || ll > 100) return null;
      return toHex(...hslToRgb(hh, ss, ll));
    }
    return null;
  }

  function luminance(h) {
    const rgb = hexToRgb(h);
    if (!rgb) return 0;
    const [r, g, b] = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // ---------- schema ----------

  function cleanEffect(e, defaults) {
    e = e && typeof e === "object" ? e : {};
    return {
      on: bool(e.on),
      color: hex(e.color) || defaults.color,
      size: num(e.size, 0, 10, defaults.size, 0.5),
      x: num(e.x, -4, 4, 0, 0.5),
      y: num(e.y, -4, 4, 0, 0.5)
    };
  }

  // Returns a brand-new, valid paint, or null if the input can't be made into one.
  function sanitize(p) {
    if (!p || typeof p !== "object") return null;
    const kind = KINDS.includes(p.kind) ? p.kind : null;
    if (!kind) return null;
    const [minC, maxC] = LIMITS[kind];
    const raw = Array.isArray(p.colors) ? p.colors.slice(0, maxC) : [];
    const colors = [];
    raw.forEach((c, i) => {
      const color = hex(c && typeof c === "object" ? c.c : c);
      if (!color) return;
      const dflt = raw.length > 1 ? (i / (raw.length - 1)) * 100 : 0;
      colors.push({ c: color, p: num(c && typeof c === "object" ? c.p : undefined, 0, 100, Math.round(dflt), 1) });
    });
    if (colors.length < minC) return null;
    if (kind !== "rainbow") colors.sort((a, b) => a.p - b.p);
    const glow = cleanEffect(p.glow, { color: "#ffffff", size: 4 });
    const outline = cleanEffect(p.outline, { color: "#000000", size: 1 });
    outline.size = num(p.outline && p.outline.size, 0.5, 2, 1, 0.5);
    const out = {
      v: VERSION,
      kind,
      colors,
      angle: num(p.angle, 0, 360, 90, 1),
      shape: p.shape === "ellipse" ? "ellipse" : "circle",
      animate: (kind === "linear" || kind === "rainbow") && bool(p.animate),
      speed: num(p.speed, 1, 30, 6, 0.5),
      reverse: bool(p.reverse),
      glow,
      outline,
      weight: WEIGHTS.includes(Number(p.weight)) ? Number(p.weight) : 0
    };
    return out;
  }

  // Library entry = paint + local-only metadata (name, id, favorite).
  function sanitizeEntry(e) {
    const paint = sanitize(e);
    if (!paint) return null;
    const id = typeof e.id === "string" && /^[a-z0-9-]{1,40}$/.test(e.id) ? e.id : newId();
    const name = typeof e.name === "string" ? e.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) : "";
    return { ...paint, id, name: name || "Untitled paint", fav: bool(e.fav), updated: Number.isFinite(e.updated) ? e.updated : Date.now() };
  }

  function newId() {
    return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  // Stable string for comparing two paints (ignores name/id/fav).
  function key(p) {
    const s = sanitize(p);
    return s ? JSON.stringify(s) : "";
  }

  // ---------- rendering ----------

  function stops(colors) {
    return colors.map((c) => `${c.c} ${c.p}%`).join(", ");
  }

  // Colors laid out twice across a 200%-wide image so sliding it by one width loops seamlessly.
  function loopStops(list) {
    const seq = list.concat(list[0]);
    const n = seq.length - 1;
    const out = [];
    for (let copy = 0; copy < 2; copy++) {
      seq.forEach((c, i) => {
        if (copy === 1 && i === 0) return;
        out.push(`${c} ${Math.round((copy * 50 + (i * 50) / n) * 100) / 100}%`);
      });
    }
    return out.join(", ");
  }

  function evenStops(list) {
    const n = list.length - 1;
    return list.map((c, i) => `${c} ${Math.round(((i * 100) / n) * 100) / 100}%`).join(", ");
  }

  // Worst-case readability of the paint's colors against a background.
  function readability(p, bg) {
    const best = Math.max(...p.colors.map((c) => contrast(c.c, bg)));
    const avg = p.colors.reduce((s, c) => s + contrast(c.c, bg), 0) / p.colors.length;
    return { best, avg };
  }

  /* Build the values for content.css. Every string is assembled here from validated parts.
   * theme: "dark" | "light" — adds a faint backing shadow if the paint would be hard to read. */
  function style(paintIn, opts) {
    const p = sanitize(paintIn);
    if (!p) return null;
    opts = opts || {};
    const animate = p.animate && opts.animate !== false;
    const list = p.colors.map((c) => c.c);
    let bg;
    let size = "100% 100%";
    if (p.kind === "solid") {
      bg = `linear-gradient(${list[0]}, ${list[0]})`;
    } else if (p.kind === "radial") {
      bg = `radial-gradient(${p.shape} at 50% 50%, ${stops(p.colors)})`;
    } else if (animate) {
      bg = `linear-gradient(90deg, ${loopStops(list)})`;
      size = "200% 100%";
    } else if (p.kind === "rainbow") {
      bg = `linear-gradient(${p.angle}deg, ${evenStops(list)})`;
    } else {
      bg = `linear-gradient(${p.angle}deg, ${stops(p.colors)})`;
    }

    const filters = [];
    if (p.glow.on && (p.glow.size > 0 || p.glow.x || p.glow.y)) {
      filters.push(`drop-shadow(${p.glow.x}px ${p.glow.y}px ${p.glow.size}px ${p.glow.color})`);
    }
    const theme = opts.theme === "light" ? "light" : "dark";
    const r = readability(p, theme === "light" ? LIGHT_BG : DARK_BG);
    const lowContrast = r.best < 2.2;
    if (lowContrast) {
      filters.push(theme === "light" ? "drop-shadow(0 0 1px #000000)" : "drop-shadow(0 0 1px #ffffff)");
    }

    return {
      bg,
      size,
      filter: filters.length ? filters.join(" ") : "none",
      stroke: p.outline.on ? `${p.outline.size}px ${p.outline.color}` : "",
      weight: p.weight ? String(p.weight) : "",
      duration: p.speed + "s",
      animate,
      reverse: p.reverse,
      lowContrast
    };
  }

  const CLASSES = ["tcw-paint", "tcw-paint-anim", "tcw-paint-rev", "tcw-paint-w", "tcw-paint-s"];
  const VARS = ["--tcw-paint-bg", "--tcw-paint-size", "--tcw-paint-filter", "--tcw-paint-stroke", "--tcw-paint-weight", "--tcw-paint-dur"];

  // Apply to / remove from an element using only classes and CSS custom properties (CSSOM, not markup).
  function apply(el, paint, opts) {
    const st = style(paint, opts);
    if (!st) return clear(el);
    el.style.setProperty("--tcw-paint-bg", st.bg);
    el.style.setProperty("--tcw-paint-size", st.size);
    el.style.setProperty("--tcw-paint-filter", st.filter);
    el.style.setProperty("--tcw-paint-dur", st.duration);
    el.classList.add("tcw-paint");
    el.classList.toggle("tcw-paint-anim", st.animate);
    el.classList.toggle("tcw-paint-rev", st.animate && st.reverse);
    if (st.stroke) {
      el.style.setProperty("--tcw-paint-stroke", st.stroke);
      el.classList.add("tcw-paint-s");
    } else {
      el.style.removeProperty("--tcw-paint-stroke");
      el.classList.remove("tcw-paint-s");
    }
    if (st.weight) {
      el.style.setProperty("--tcw-paint-weight", st.weight);
      el.classList.add("tcw-paint-w");
    } else {
      el.style.removeProperty("--tcw-paint-weight");
      el.classList.remove("tcw-paint-w");
    }
    return true;
  }

  function clear(el) {
    if (!el.classList.contains("tcw-paint")) return false;
    el.classList.remove(...CLASSES);
    for (const v of VARS) el.style.removeProperty(v);
    return false;
  }

  // ---------- presets ----------

  const fx = (o) => ({ glow: { on: false, color: "#ffffff", size: 4, x: 0, y: 0 }, outline: { on: false, color: "#000000", size: 1 }, weight: 0, ...o });
  const C = (...list) => list.map((c, i) => ({ c, p: list.length > 1 ? Math.round((i / (list.length - 1)) * 100) : 0 }));

  const PRESETS = [
    { id: "preset-sunset", name: "Sunset", kind: "linear", colors: C("#ff7e5f", "#feb47b", "#ff5f9e"), angle: 90, ...fx({}) },
    { id: "preset-ocean", name: "Ocean", kind: "linear", colors: C("#00c6ff", "#0072ff"), angle: 90, ...fx({}) },
    { id: "preset-rainbow", name: "Rainbow", kind: "rainbow", colors: C("#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7ff", "#5856d6", "#af52de"), animate: true, speed: 5, angle: 90, ...fx({}) },
    { id: "preset-pastel", name: "Pastel", kind: "rainbow", colors: C("#ffb3ba", "#ffdfba", "#ffffba", "#baffc9", "#bae1ff"), animate: false, angle: 90, ...fx({}) },
    { id: "preset-fire", name: "Fire", kind: "linear", colors: C("#ff3d00", "#ff9100", "#ffea00"), animate: true, speed: 3, ...fx({ glow: { on: true, color: "#ff6d00", size: 3, x: 0, y: 0 } }) },
    { id: "preset-gold", name: "Gold", kind: "linear", colors: [{ c: "#b8860b", p: 0 }, { c: "#ffd700", p: 45 }, { c: "#fff8dc", p: 55 }, { c: "#daa520", p: 100 }], angle: 100, ...fx({ weight: 800 }) },
    { id: "preset-neon", name: "Neon Mint", kind: "solid", colors: C("#39ff14"), ...fx({ glow: { on: true, color: "#39ff14", size: 5, x: 0, y: 0 } }) },
    { id: "preset-ice", name: "Ice", kind: "solid", colors: C("#bdf6ff"), ...fx({ glow: { on: true, color: "#00b7ff", size: 4, x: 0, y: 0 } }) },
    { id: "preset-galaxy", name: "Galaxy", kind: "radial", colors: [{ c: "#ffffff", p: 0 }, { c: "#c77dff", p: 35 }, { c: "#5a189a", p: 100 }], shape: "ellipse", ...fx({}) },
    { id: "preset-candy", name: "Cotton Candy", kind: "linear", colors: C("#ff9ff3", "#a0e9ff"), animate: true, speed: 8, ...fx({}) },
    { id: "preset-shadow", name: "Shadow Pop", kind: "solid", colors: C("#ffffff"), ...fx({ glow: { on: true, color: "#9147ff", size: 0, x: 1.5, y: 1.5 }, weight: 800 }) },
    { id: "preset-outline", name: "Outlined Lime", kind: "solid", colors: C("#c6ff00"), ...fx({ outline: { on: true, color: "#1b5e20", size: 0.5 } }) }
  ].map((p) => ({ ...sanitizeEntry(p), id: p.id, name: p.name, preset: true }));

  const SWATCHES = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7ff", "#0a84ff", "#5856d6", "#af52de",
    "#ff2d55", "#ffffff", "#9147ff", "#00e5ff", "#ffd700", "#ff6ec7", "#7cff6b", "#1f1f23"];

  const API = {
    VERSION, KINDS, LIMITS, WEIGHTS, PRESETS, SWATCHES, CLASSES,
    hex, parseColor, hexToRgb, rgbToHsl, hslToRgb, toHex, contrast,
    sanitize, sanitizeEntry, newId, key, style, apply, clear, readability
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.TCWPaint = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
