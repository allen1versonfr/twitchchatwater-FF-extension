/* Player tools: stream delay next to the watch time, an audio compressor (with presets, makeup gain and a
 * safety limiter), volume boost, mono, scroll-wheel volume, middle-click mute and per-channel volume memory.
 *
 * Volume goes through Twitch's own player when we can reach it (so its slider stays in sync), otherwise the
 * <video> element. Audio processing uses Web Audio; a video is only routed through it once you actually turn
 * on the compressor, boost or mono, and only after the page is allowed to play sound (a click or key press),
 * so it can never leave the stream silent. */
(() => {
  "use strict";
  const C = globalThis.TCWChat;
  if (!C || C.player || !C.isTop) return;
  const S = () => C.settings;
  const el = (...a) => C.el(...a);

  const VIEWERS_SEL = "[data-a-target='animated-channel-viewers-count'], [data-a-target='channel-viewers-count']";
  const PLAYER_SEL = "[data-a-target='video-player'], .video-player";
  const CONTROLS_SEL = ".player-controls__right-control-group, [data-a-target='player-controls'] .player-controls__right-control-group";

  // threshold dB, knee dB, ratio, attack s, release s, makeup gain
  const PRESETS = {
    light: [-24, 30, 3, 0.01, 0.25, 1.4],
    medium: [-40, 30, 8, 0.005, 0.25, 2.2],
    strong: [-50, 40, 15, 0.003, 0.3, 3.0]
  };

  // ---------- Twitch's player ----------

  function mainVideo() {
    let best = null;
    let bestArea = 200 * 110;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width * r.height >= bestArea) { best = v; bestArea = r.width * r.height; }
    }
    return best;
  }

  // The page's media player object, found through React's internals (read-only lookups, like 7TV and FFZ do).
  let instCache = null;
  function playerInstance() {
    const root = document.querySelector(PLAYER_SEL);
    if (!root) return null;
    if (instCache && instCache.root === root) return instCache.inst;
    let inst = null;
    try {
      const page = root.wrappedJSObject || root;
      const key = Object.keys(page).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      let f = key ? page[key] : null;
      for (let i = 0; f && i < 80 && !inst; i++, f = f.return) {
        const p = f.memoizedProps;
        const cand = p && (p.mediaPlayerInstance || (p.player && p.player.getLiveLatency ? p.player : null));
        if (cand && typeof cand.getVolume === "function") inst = cand;
      }
    } catch (e) {
      C.debug("player lookup failed", e);
    }
    instCache = { root, inst };
    return inst;
  }

  function call(inst, fn, ...args) {
    try { return inst && typeof inst[fn] === "function" ? inst[fn](...args) : undefined; } catch (e) { return undefined; }
  }

  function getVolume() {
    const inst = playerInstance();
    const v = call(inst, "getVolume");
    const muted = call(inst, "isMuted");
    const vid = mainVideo();
    return {
      volume: typeof v === "number" ? v : vid ? vid.volume : 1,
      muted: typeof muted === "boolean" ? muted : vid ? vid.muted : false
    };
  }

  function setVolume(v, muted) {
    v = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
    const inst = playerInstance();
    if (inst && typeof inst.setVolume === "function") {
      call(inst, "setVolume", v);
      if (muted != null) call(inst, "setMuted", muted);
    } else {
      const vid = mainVideo();
      if (!vid) return;
      vid.volume = v;
      if (muted != null) vid.muted = muted;
    }
  }

  // ---------- stream delay ----------

  function delayInfo() {
    const vid = mainVideo();
    if (!vid) return null;
    let buffer = null;
    try {
      if (vid.buffered.length) buffer = Math.max(0, vid.buffered.end(vid.buffered.length - 1) - vid.currentTime);
    } catch (e) { /* no buffer yet */ }
    const lat = call(playerInstance(), "getLiveLatency");
    return { latency: typeof lat === "number" && lat > 0 && lat < 600 ? lat : null, buffer, vid };
  }

  function catchUp() {
    const d = delayInfo();
    if (!d || !d.vid || !d.vid.buffered.length) return;
    const end = d.vid.buffered.end(d.vid.buffered.length - 1);
    if (end - d.vid.currentTime > 1.5) {
      d.vid.currentTime = end - 1;
      C.toast("Jumped closer to live");
    } else {
      C.toast("Already as close to live as the player allows");
    }
  }

  function updateDelayBadge() {
    let badge = document.getElementById("tcw-delay-badge");
    const anchor = S().delayBadge ? document.querySelector(VIEWERS_SEL) : null;
    const d = anchor ? delayInfo() : null;
    const shown = d && (d.latency != null || d.buffer != null) && !d.vid.paused;
    if (!shown) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = el("span", { id: "tcw-delay-badge", class: "tcw-watch tcw-delay", role: "button", tabindex: "0" });
      badge.addEventListener("click", catchUp);
      badge.addEventListener("keydown", (e) => { if (e.key === "Enter") catchUp(); });
    }
    const main = d.latency != null ? d.latency : d.buffer;
    badge.textContent = "⏳ " + main.toFixed(1) + "s";
    badge.classList.toggle("tcw-delay-mid", main >= 4 && main < 8);
    badge.classList.toggle("tcw-delay-high", main >= 8);
    const parts = [];
    if (d.latency != null) parts.push(`Delay to the streamer: ${d.latency.toFixed(1)} s`);
    if (d.buffer != null) parts.push(`buffered: ${d.buffer.toFixed(1)} s`);
    badge.title = parts.join(" · ") + (d.latency == null ? " (Twitch's player didn't report the full delay; this is the buffer)" : "") + ". Click to jump closer to live.";
    badge.setAttribute("aria-label", badge.title);
    const watch = document.getElementById("tcw-watch-badge");
    const after = watch && watch.isConnected && watch.parentElement === anchor.parentElement ? watch : anchor;
    if (after.nextElementSibling !== badge) after.after(badge);
  }

  // ---------- audio processing ----------

  let ctx = null;
  const graphs = new WeakMap(); // video -> { src, comp, makeup, boost, mono, limiter }
  let gestured = false;

  function wantProcessing() {
    const s = S();
    return s.audioComp !== "off" || Number(s.audioBoost) > 100 || s.audioMono;
  }

  function graphFor(vid) {
    let g = graphs.get(vid);
    if (g) return g;
    if (!ctx) ctx = new AudioContext();
    if (ctx.state !== "running") return null; // never route audio into a context that can't play
    let src;
    try {
      src = ctx.createMediaElementSource(vid);
    } catch (e) {
      return null; // already routed by an earlier copy of the add-on; Twitch gives the next stream a fresh video
    }
    const mono = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    const boost = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    g = { src, mono, comp, makeup, boost, limiter };
    graphs.set(vid, g);
    wire(g);
    return g;
  }

  // Connects only the stages that are in use, so "off" really is the untouched sound.
  function wire(g) {
    const s = S();
    const nodes = Object.values(g);
    for (const n of nodes) try { n.disconnect(); } catch (e) { /* not connected */ }
    const chain = [g.src];
    if (s.audioMono) {
      g.mono.channelCount = 1;
      g.mono.channelCountMode = "explicit";
      g.mono.channelInterpretation = "speakers";
      chain.push(g.mono);
    }
    const p = PRESETS[s.audioComp];
    if (p) {
      const [th, knee, ratio, attack, release, gain] = p;
      g.comp.threshold.value = th;
      g.comp.knee.value = knee;
      g.comp.ratio.value = ratio;
      g.comp.attack.value = attack;
      g.comp.release.value = release;
      g.makeup.gain.value = gain;
      chain.push(g.comp, g.makeup);
    }
    const boost = Math.max(100, Math.min(400, Number(s.audioBoost) || 100)) / 100;
    if (boost > 1) {
      g.boost.gain.value = boost;
      chain.push(g.boost);
    }
    if (p || boost > 1) chain.push(g.limiter); // keep loud parts from clipping
    chain.push(ctx.destination);
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  }

  async function applyAudio() {
    const vid = mainVideo();
    if (!vid) return;
    const g = graphs.get(vid);
    if (g) return wire(g);
    if (!wantProcessing() || !gestured) return;
    try {
      if (!ctx) ctx = new AudioContext();
      if (ctx.state !== "running") await ctx.resume().catch(() => {});
      graphFor(vid);
    } catch (e) {
      C.debug("audio processing unavailable", e);
    }
  }

  function onGesture() {
    gestured = true;
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    applyAudio();
  }
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);

  // ---------- volume: wheel, middle click, OSD, memory ----------

  let osdTimer = 0;
  function osd(text) {
    const root = document.querySelector(PLAYER_SEL);
    if (!root) return;
    let box = document.getElementById("tcw-osd");
    if (!box) box = el("div", { id: "tcw-osd", class: "tcw-osd" });
    if (box.parentElement !== root) root.append(box);
    box.textContent = text;
    box.hidden = false;
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => { box.hidden = true; }, 900);
  }

  function volumeText(v, muted) {
    const boost = Number(S().audioBoost) > 100 && graphs.get(mainVideo()) ? ` (+${S().audioBoost - 100}% boost)` : "";
    return muted ? "🔇 Muted" : `🔊 ${Math.round(v * 100)}%${boost}`;
  }

  function overVideo(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !t.closest(PLAYER_SEL)) return false;
    // leave Twitch's menus and the chat overlay alone
    return !t.closest("[role='menu'], [role='dialog'], .tcw-audio, input, select, textarea, .chat-shell");
  }

  window.addEventListener("wheel", (e) => {
    if (!S().wheelVolume || e.ctrlKey || !overVideo(e)) return;
    const vid = mainVideo();
    if (!vid) return;
    e.preventDefault();
    e.stopPropagation();
    const step = Math.max(1, Math.min(25, Number(S().volumeStep) || 5)) / 100 * (e.shiftKey ? 0.2 : 1);
    const cur = getVolume();
    const next = cur.volume + (e.deltaY < 0 ? step : -step);
    setVolume(next, next <= 0 ? null : false);
    osd(volumeText(Math.max(0, Math.min(1, next)), false));
  }, { capture: true, passive: false });

  window.addEventListener("mousedown", (e) => {
    if (e.button !== 1 || !S().wheelVolume || !overVideo(e)) return;
    e.preventDefault();
    const cur = getVolume();
    setVolume(cur.volume, !cur.muted);
    osd(volumeText(cur.volume, !cur.muted));
  }, true);

  // per-channel volume memory
  let volChannel = "";
  let saveTimer = 0;
  let restoring = 0;

  function channelNow() {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.length === 1 && /^[a-z0-9_]{1,25}$/i.test(parts[0]) ? parts[0].toLowerCase() : "";
  }

  async function restoreVolume(ch) {
    if (!S().rememberVolume || !ch) return;
    const d = await browser.storage.local.get("channelVolumes").catch(() => ({}));
    const v = d.channelVolumes && d.channelVolumes[ch];
    if (!v || typeof v.v !== "number") return;
    restoring = Date.now();
    setVolume(v.v, !!v.m);
  }

  function rememberVolume() {
    if (!S().rememberVolume || !volChannel || Date.now() - restoring < 3000) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const { volume, muted } = getVolume();
      const d = await browser.storage.local.get("channelVolumes").catch(() => ({}));
      const all = d.channelVolumes && typeof d.channelVolumes === "object" ? d.channelVolumes : {};
      delete all[volChannel];
      all[volChannel] = { v: Math.round(volume * 100) / 100, m: muted };
      const keys = Object.keys(all);
      if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete all[k];
      browser.storage.local.set({ channelVolumes: all }).catch(() => {});
    }, 1500);
  }

  let watchedVideo = null;
  function trackVideo() {
    const vid = mainVideo();
    if (vid === watchedVideo) return;
    watchedVideo = vid;
    if (vid) vid.addEventListener("volumechange", rememberVolume);
    applyAudio();
  }

  // ---------- audio panel (button in the player controls) ----------

  let panel = null;

  function ensureButton() {
    const group = S().audioButton ? document.querySelector(CONTROLS_SEL) : null;
    const old = document.getElementById("tcw-audio-btn");
    if (!group) { if (old && !S().audioButton) old.remove(); return; }
    if (old && group.contains(old)) return;
    const b = el("button", { id: "tcw-audio-btn", class: "tcw-player-btn", title: "Audio (Chat Watcher)", "aria-label": "Audio settings (Chat Watcher)" }, "🎚");
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(b); });
    group.prepend(b);
  }

  function save(patch) {
    browser.runtime.sendMessage({ type: "setSettings", patch }).catch(() => {});
  }

  function togglePanel(btn) {
    if (panel) return closePanel();
    const box = el("div", { class: "tcw-audio", role: "dialog", "aria-label": "Audio" });
    (document.body || document.documentElement).append(box);
    panel = { box, btn, meter: null };
    renderPanel();
  }

  function closePanel() {
    if (!panel) return;
    panel.box.remove();
    panel = null;
  }

  function renderPanel() {
    if (!panel) return;
    const s = S();
    const comp = el("select", { "aria-label": "Compressor" },
      [["off", "Off"], ["light", "Light"], ["medium", "Medium (like 7TV)"], ["strong", "Strong (night mode)"]]
        .map(([v, t]) => el("option", { value: v }, t)));
    comp.value = s.audioComp;
    comp.addEventListener("change", () => save({ audioComp: comp.value }));
    const boost = el("input", { type: "range", min: "100", max: "400", step: "10", value: String(s.audioBoost), "aria-label": "Volume boost" });
    const boostOut = el("output", {}, s.audioBoost + "%");
    boost.addEventListener("input", () => { boostOut.textContent = boost.value + "%"; });
    boost.addEventListener("change", () => save({ audioBoost: Number(boost.value) }));
    const mono = el("input", { type: "checkbox", checked: s.audioMono ? "" : null, "aria-label": "Mono" });
    mono.checked = !!s.audioMono;
    mono.addEventListener("change", () => save({ audioMono: mono.checked }));
    const meter = el("div", { class: "tcw-audio-meter" }, el("span"));
    const active = !!graphs.get(mainVideo());
    panel.meter = meter;
    panel.box.replaceChildren(
      el("div", { class: "tcw-audio-head" }, el("b", {}, "Audio"), el("button", { class: "tcw-btn tcw-icon", "aria-label": "Close", onclick: closePanel }, "✕")),
      el("label", { class: "tcw-audio-row" }, el("span", {}, "Compressor"), comp),
      el("label", { class: "tcw-audio-row" }, el("span", {}, "Boost"), boost, boostOut),
      el("label", { class: "tcw-audio-row" }, el("span", {}, "Mono"), mono),
      el("div", { class: "tcw-audio-row" }, el("span", {}, "Compression"), meter),
      el("div", { class: "tcw-audio-note" }, wantProcessing() && !active
        ? "Click the page once to start (browsers only allow sound processing after a click)."
        : "Scroll over the video to change volume, Shift for fine steps, middle-click to mute."));
    const r = panel.btn.getBoundingClientRect();
    const w = 280;
    panel.box.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
    panel.box.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + "px";
  }

  function updateMeter() {
    if (!panel || !panel.meter) return;
    const g = graphs.get(mainVideo());
    const red = g && PRESETS[S().audioComp] ? Math.max(0, -g.comp.reduction) : 0;
    panel.meter.firstChild.style.width = Math.min(100, red * 4) + "%";
    panel.meter.title = red ? `${red.toFixed(1)} dB of compression right now` : "No compression right now";
  }

  document.addEventListener("mousedown", (e) => {
    if (panel && !e.composedPath().includes(panel.box) && !e.composedPath().includes(panel.btn)) closePanel();
  }, true);

  // ---------- wiring ----------

  C.attach({
    settings: (s, keys) => {
      if (!keys) return;
      if (["audioComp", "audioBoost", "audioMono"].some((k) => keys.has(k))) {
        applyAudio();
        if (panel) renderPanel();
      }
      if (keys.has("audioButton")) ensureButton();
      if (keys.has("delayBadge")) updateDelayBadge();
    }
  });

  setInterval(() => {
    const ch = channelNow();
    if (ch !== volChannel) {
      volChannel = ch;
      instCache = null;
      setTimeout(() => restoreVolume(ch), 1500); // after Twitch has set up its player
    }
    trackVideo();
    ensureButton();
    updateDelayBadge();
  }, 2000);
  setInterval(updateMeter, 200);

  C.player = { delayInfo, getVolume, setVolume, PRESETS };
})();
