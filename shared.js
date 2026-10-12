/* Shared by the background page, the content script and the popup/settings UI. */
var TCW = (() => {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    sound: true,
    soundType: "beep",
    volume: 0.5,
    cooldown: 0,
    notifications: false,
    flashTitle: true,
    highlightStyle: "both",   // both | bg | border | none
    highlightOpacity: 22,
    showStar: true,
    channels: "",              // blank = every channel
    backlogSeconds: 5,
    logLimit: 200,
    debug: false
  };

  // [frequency, start offset (s), duration (s), waveform]
  const SOUNDS = {
    beep:  { label: "Beep",  notes: [[880, 0, 0.12, "sine"], [1320, 0.15, 0.12, "sine"]] },
    chime: { label: "Chime", notes: [[1046.5, 0, 0.45, "triangle"], [1318.5, 0.12, 0.45, "triangle"], [1568, 0.24, 0.7, "triangle"]] },
    ping:  { label: "Ping",  notes: [[1760, 0, 0.35, "sine"]] },
    blip:  { label: "Blip",  notes: [[600, 0, 0.07, "square"], [900, 0.08, 0.07, "square"]] },
    alert: { label: "Alert", notes: [[988, 0, 0.1, "square"], [988, 0.16, 0.1, "square"], [988, 0.32, 0.1, "square"]] }
  };

  const PALETTE = ["#ffcc00", "#00e0ff", "#ff5fa2", "#7cff6b", "#ff8a3d", "#b18cff", "#ff4d4d", "#4dd2a6"];

  function normalize(name) {
    return String(name == null ? "" : name)
      .trim()
      .replace(/^@/, "")
      .replace(/:$/, "")
      .replace(/\s*\(.*\)\s*$/, "")
      .trim()
      .toLowerCase();
  }

  function pickColor(users) {
    const used = new Set((users || []).map((u) => u.color));
    return PALETTE.find((c) => !used.has(c)) || PALETTE[(users || []).length % PALETTE.length];
  }

  function newUser(name, users) {
    const clean = String(name).trim().replace(/^@/, "");
    return {
      name: clean,
      login: normalize(clean),
      color: pickColor(users),
      enabled: true,
      sound: "default",
      notify: true,
      note: "",
      hits: 0,
      lastSeen: null,
      added: Date.now()
    };
  }

  // Repairs a stored user record (also upgrades the v1 {name, color} format).
  function fixUser(u, i = 0) {
    if (typeof u === "string") u = { name: u };
    if (!u || typeof u !== "object") return null;
    const name = String(u.name || u.login || "").trim().replace(/^@/, "");
    const login = normalize(u.login || name);
    if (!login) return null;
    return {
      name: name || login,
      login,
      color: /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : PALETTE[i % PALETTE.length],
      enabled: u.enabled !== false,
      sound: u.sound === "none" || SOUNDS[u.sound] ? u.sound : "default",
      notify: u.notify !== false,
      note: typeof u.note === "string" ? u.note.slice(0, 200) : "",
      hits: Number.isFinite(u.hits) ? u.hits : 0,
      lastSeen: u.lastSeen && typeof u.lastSeen === "object" ? u.lastSeen : null,
      added: u.added || Date.now()
    };
  }

  function playSound(ctx, type, volume) {
    const def = SOUNDS[type] || SOUNDS.beep;
    const vol = Math.max(0, Math.min(1, Number(volume) || 0));
    if (vol <= 0) return;
    const t0 = ctx.currentTime + 0.02;
    for (const [freq, at, dur, wave] of def.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = wave;
      osc.frequency.value = freq;
      const peak = Math.max(0.0002, vol * (wave === "square" ? 0.35 : 1));
      const s = t0 + at;
      gain.gain.setValueAtTime(0.0001, s);
      gain.gain.exponentialRampToValueAtTime(peak, s + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(s);
      osc.stop(s + dur + 0.02);
    }
  }

  return { DEFAULT_SETTINGS, SOUNDS, PALETTE, normalize, pickColor, newUser, fixUser, playSound };
})();
