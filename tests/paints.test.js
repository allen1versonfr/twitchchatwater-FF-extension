// Run with: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../paints.js");

test("parseColor accepts hex, rgb and hsl and rejects junk", () => {
  assert.equal(P.parseColor("#ABC"), "#aabbcc");
  assert.equal(P.parseColor("ff0000"), "#ff0000");
  assert.equal(P.parseColor("rgb(0, 128, 255)"), "#0080ff");
  assert.equal(P.parseColor("rgb(0 128 255 / 50%)"), "#0080ff");
  assert.equal(P.parseColor("hsl(120, 100%, 50%)"), "#00ff00");
  assert.equal(P.parseColor("hsl(0deg 0% 100%)"), "#ffffff");
  for (const bad of ["red", "rgb(300,0,0)", "hsl(10, 200%, 50%)", "#12345", "url(x)", "", null, 42]) {
    assert.equal(P.parseColor(bad), null, String(bad));
  }
});

test("hsl and rgb round trip", () => {
  const [h, s, l] = P.rgbToHsl(51, 153, 255);
  assert.equal(P.parseColor(`hsl(${h}, ${s}%, ${l}%)`), "#3399ff");
});

test("sanitize builds a clean paint and drops anything unexpected", () => {
  const dirty = {
    kind: "linear",
    colors: [{ c: "#00FF00", p: 120 }, { c: "javascript:alert(1)", p: 5 }, { c: "#000", p: -4 }, "#123456"],
    angle: 9999,
    speed: "fast",
    glow: { on: true, color: "red;}body{display:none", size: 50, x: 9, y: -9 },
    outline: { on: true, color: "#fff", size: 99 },
    weight: 650,
    style: "color:red",
    __proto__: { evil: true },
    extra: "<script>"
  };
  const p = P.sanitize(dirty);
  assert.deepEqual(Object.keys(p).sort(), ["angle", "animate", "colors", "glow", "kind", "outline", "reverse", "shape", "speed", "v", "weight"]);
  assert.deepEqual(p.colors.map((c) => c.c), ["#000000", "#00ff00", "#123456"]); // bad color dropped, sorted by position (ties keep order)
  assert.equal(p.colors[0].p, 0);
  assert.equal(p.colors[1].p, 100);
  assert.equal(p.colors[2].p, 100);
  assert.equal(p.angle, 360);
  assert.equal(p.speed, 6);
  assert.equal(p.glow.color, "#ffffff"); // invalid color replaced by default
  assert.equal(p.glow.size, 10);
  assert.equal(p.glow.x, 4);
  assert.equal(p.outline.size, 2);
  assert.equal(p.weight, 0);
  assert.equal(JSON.stringify(p).includes("script"), false);
});

test("sanitize enforces color counts per kind", () => {
  assert.equal(P.sanitize({ kind: "linear", colors: ["#ffffff"] }), null);
  assert.equal(P.sanitize({ kind: "solid", colors: [] }), null);
  assert.equal(P.sanitize({ kind: "nope", colors: ["#fff"] }), null);
  assert.equal(P.sanitize(null), null);
  assert.equal(P.sanitize({ kind: "rainbow", colors: Array(20).fill("#ff0000") }).colors.length, 12);
  assert.equal(P.sanitize({ kind: "solid", colors: ["#ff0000", "#00ff00"] }).colors.length, 1);
});

test("only linear and rainbow paints can animate", () => {
  assert.equal(P.sanitize({ kind: "radial", colors: ["#fff", "#000"], animate: true }).animate, false);
  assert.equal(P.sanitize({ kind: "solid", colors: ["#fff"], animate: true }).animate, false);
  assert.equal(P.sanitize({ kind: "rainbow", colors: ["#fff", "#000"], animate: true }).animate, true);
});

test("style output only contains safe characters", () => {
  for (const preset of P.PRESETS) {
    for (const theme of ["dark", "light"]) {
      const st = P.style(preset, { theme });
      for (const v of [st.bg, st.size, st.filter, st.stroke, st.weight, st.duration]) {
        assert.match(v, /^[a-z0-9#%.,() \-]*$/i, `${preset.name}: ${v}`);
        assert.equal(/[;{}<>"'\\]|url|expression|var\(/i.test(v), false);
      }
    }
  }
});

test("solid, gradient, radial and rainbow produce the right CSS", () => {
  assert.equal(P.style({ kind: "solid", colors: ["#ff0000"] }).bg, "linear-gradient(#ff0000, #ff0000)");
  assert.equal(
    P.style({ kind: "linear", colors: [{ c: "#ff0000", p: 0 }, { c: "#00ff00", p: 30 }, { c: "#0000ff", p: 100 }], angle: 45 }).bg,
    "linear-gradient(45deg, #ff0000 0%, #00ff00 30%, #0000ff 100%)"
  );
  assert.equal(
    P.style({ kind: "radial", colors: ["#ffffff", "#000000"], shape: "ellipse" }).bg,
    "radial-gradient(ellipse at 50% 50%, #ffffff 0%, #000000 100%)"
  );
  const st = P.style({ kind: "rainbow", colors: ["#ff0000", "#00ff00", "#0000ff"], animate: true, speed: 4, reverse: true });
  assert.equal(st.size, "200% 100%");
  assert.equal(st.animate, true);
  assert.equal(st.reverse, true);
  assert.equal(st.duration, "4s");
});

test("animated loop starts and ends on the same color so it never jumps", () => {
  const st = P.style({ kind: "linear", colors: ["#ff0000", "#00ff00", "#0000ff"], animate: true });
  const stops = st.bg.replace(/^linear-gradient\(90deg, /, "").replace(/\)$/, "").split(", ");
  assert.equal(stops[0], "#ff0000 0%");
  assert.equal(stops.at(-1), "#ff0000 100%");
  // the second half is the first half shifted by exactly 50%
  const half = stops.find((s) => s.endsWith(" 50%"));
  assert.equal(half, "#ff0000 50%");
  assert.equal(stops.length, 7);
});

test("animation can be turned off by the viewer", () => {
  const p = { kind: "rainbow", colors: ["#ff0000", "#00ff00"], animate: true };
  const st = P.style(p, { animate: false });
  assert.equal(st.animate, false);
  assert.equal(st.size, "100% 100%");
});

test("effects map to drop-shadow, stroke and weight", () => {
  const st = P.style({
    kind: "solid", colors: ["#ffffff"],
    glow: { on: true, color: "#9147ff", size: 3, x: 1, y: -1 },
    outline: { on: true, color: "#000000", size: 1.5 },
    weight: 800
  });
  assert.equal(st.filter, "drop-shadow(1px -1px 3px #9147ff)");
  assert.equal(st.stroke, "1.5px #000000");
  assert.equal(st.weight, "800");
});

test("hard-to-read paints get a readability backing", () => {
  const dark = P.style({ kind: "solid", colors: ["#1a1a1a"] }, { theme: "dark" });
  assert.equal(dark.lowContrast, true);
  assert.match(dark.filter, /#ffffff/);
  const fine = P.style({ kind: "solid", colors: ["#ffcc00"] }, { theme: "dark" });
  assert.equal(fine.lowContrast, false);
  assert.equal(fine.filter, "none");
  const light = P.style({ kind: "solid", colors: ["#f5f5f5"] }, { theme: "light" });
  assert.match(light.filter, /#000000/);
});

test("sanitizeEntry keeps name/id/fav safely", () => {
  const e = P.sanitizeEntry({ kind: "solid", colors: ["#fff"], name: "  My\u0000 <b>paint</b> that has a really long name over forty chars  ", id: "../../x", fav: "yes" });
  assert.equal(e.name.length <= 40, true);
  assert.equal(e.name.includes("\u0000"), false);
  assert.match(e.id, /^p-/);
  assert.equal(e.fav, false);
});

test("key() ignores metadata and spots real changes", () => {
  const a = { kind: "solid", colors: ["#ff0000"], name: "A" };
  const b = { kind: "solid", colors: ["#FF0000"], name: "B", fav: true };
  assert.equal(P.key(a), P.key(b));
  assert.notEqual(P.key(a), P.key({ kind: "solid", colors: ["#ff0001"] }));
});

test("all presets are valid", () => {
  assert.ok(P.PRESETS.length >= 10);
  for (const p of P.PRESETS) assert.ok(P.sanitize(p), p.name);
});
