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
    cardTrigger: "click",      // click | ctrl | off  (profile card when clicking a name in chat)
    syncEnabled: true,         // Firefox Sync for watchlist + settings
    paintsOn: true,            // show nametag paints at all
    paintsOthers: false,       // opt-in: look up other people's published paints (sends chat usernames to the paint server)
    paintsAnimate: true,       // allow animated paints (reduced-motion always wins)
    paints7tvWins: true,       // leave names that 7TV already painted alone
    mentionAlert: true,        // sound when someone @mentions you or replies to you
    mentionSound: "chime",
    mentionNotify: false,      // desktop notification for mentions/replies
    mentionName: "",           // your Twitch username; blank = detect from twitch.tv
    watchTrack: true,          // track your own watch time per streamer (stored only on this computer)
    watchBadge: true,          // show it next to the live viewer count
    watchVisibleOnly: false,   // only count while the Twitch tab is visible
    delayBadge: true,          // stream delay next to the viewer count (click to catch up)
    audioComp: "off",          // off | light | medium | strong  (audio compressor)
    audioBoost: 100,           // % volume, up to 400
    audioMono: false,
    audioButton: true,         // 🎚 button in the player controls
    refreshButton: true,       // ⟳ button in the player controls (reloads the stream without reloading the page)
    wheelVolume: true,         // scroll over the video for volume, middle-click to mute
    volumeStep: 5,             // % per scroll step
    rememberVolume: true,      // remember the volume for each channel
    // chat tools
    ircOn: true,               // read-only, anonymous connection to Twitch chat (deleted messages, bans, first-time chatters)
    emotes7tv: true,           // show 7TV emotes (channel + global) in chat
    emotesBttv: true,          // show BTTV emotes
    emotesFfz: true,           // show FFZ emotes
    emotesPersonal: true,      // show 7TV subscribers' personal emotes on their messages
    emoteLive: true,           // live emote updates (7TV, BTTV; FFZ every 10 min) with a line in chat
    emoteMenu: true,           // emote button next to the chat box (favorites, recent, most used, 7TV)
    emoteColon: true,          // ":kek" suggestions while typing
    emoteTab: true,            // Tab cycles through matching emotes
    emoteSpam: true,           // offer a button to join in when an emote is being spammed
    spamMin: 6,                // messages with the same emote within 10 s ...
    spamUsers: 4,              // ... from at least this many people
    inputHistory: true,        // Up/Down in an empty chat box recalls what you sent
    hlWords: "",               // highlight messages containing these words (one per line, /regex/ allowed)
    hlColor: "#ff9f1a",
    hlSound: "ping",           // sound for highlighted words; "none" = silent
    hlFlash: true,             // flash the tab title for highlighted words
    hlNotify: false,
    hlBadgeBroadcaster: false, // highlight messages by badge
    hlBadgeMod: false,
    hlBadgeVip: false,
    hlBadgeStaff: false,
    hlBadgeSub: false,
    hlBadgeVerified: false,
    filterWords: "",           // hide messages containing these words
    filterUsers: "",           // hide messages from these people (bots etc.)
    filterMode: "hide",        // hide | dim
    timestamps: "off",         // off | 12 | 24 | 24s
    chatFontSize: 0,           // 0 = Twitch's size
    chatAltBg: false,          // alternating message backgrounds
    chatSeparators: false,     // thin line between messages
    hoverDetails: "shift",     // off | hover | shift  (message details popup)
    hideShared: false,         // hide messages from the other channels in a shared chat
    deletedMode: "show",       // twitch | show | strike | hide
    modNotices: true,          // show bans and timeouts in chat
    modLogOn: true,            // keep a moderation log (Activity → Mod log)
    modIcons: true,            // quick timeout / ban buttons when you're a moderator
    modCompat: true,           // when you're a moderator, clicking a name opens Twitch's card (with its mod tools)
    indFirst: true,            // mark first-time chatters
    indReturning: false,       // mark returning chatters
    indRepeat: true,           // mark people who were timed out or banned earlier in this session
    clearMode: "keep",         // twitch | keep  (what happens to messages when a moderator clears chat)
    autoBonus: true,           // claim the channel-points bonus chest
    autoMoments: true,         // claim Moments
    autoDrops: true,           // claim Drops (in chat and on the inventory page)
    autoDropsBg: false,        // check the Drops inventory every 30 minutes in a background tab
    paintServer: "",           // override of TCW_CONFIG.paintServer
    twitchClientId: "",        // override of TCW_CONFIG.twitchClientId
    debug: false
  };

  // What travels through Firefox Sync. Message counts and the activity log stay on each computer.
  const SYNC_USER_FIELDS = ["name", "color", "enabled", "sound", "notify", "note", "added"];
  const LOCAL_ONLY_SETTINGS = ["syncEnabled", "debug"];

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

  // 4521 s -> "1h 15m"; 40 s -> "<1m"
  function duration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    if (sec === 0) return "0m";
    if (sec < 60) return "<1m";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // Local calendar day, e.g. "2026-10-15"
  function dayKey(t) {
    const d = new Date(t == null ? Date.now() : t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  return {
    DEFAULT_SETTINGS, SOUNDS, PALETTE, SYNC_USER_FIELDS, LOCAL_ONLY_SETTINGS,
    normalize, pickColor, newUser, fixUser, playSound, ago, duration, dayKey
  };
})();
