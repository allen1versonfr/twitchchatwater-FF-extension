"use strict";
/* Emote providers: 7TV, BTTV and FFZ emotes for each open channel, plus their global emotes.
 * Loaded after bg-chat.js (uses load, getJson, roomIdFor, roomIds, L, CH_RE).
 *
 * Live updates: 7TV's event API (emote set changes, and personal emotes of 7TV subscribers who chat)
 * and BTTV's socket (channel emote changes) push changes as they happen. FFZ has no simple live feed,
 * so it's re-checked every 10 minutes while the channel is open. */

const EMOTE_TTL = 10 * 60 * 1000;
const emoteSubs = new Map(); // "tabId:frameId" -> { tabId, frameId, channel, t }
const chanEmotes = new Map(); // channel -> rec | Promise
let globalSets = null; // { seven, bttv, ffz, have: {seven, bttv, ffz}, t }
const personal = new Map(); // twitch login -> { ref, emotes, t }   (7TV personal emotes)
const personalSets = new Map(); // emote set id -> { emotes, t }

function providersWanted(s) {
  return { seven: !!s.emotes7tv, bttv: !!s.emotesBttv, ffz: !!s.emotesFfz };
}

function covers(have, want) {
  return (!want.seven || have.seven) && (!want.bttv || have.bttv) && (!want.ffz || have.ffz);
}

async function fetchGlobals(want) {
  if (globalSets && Date.now() - globalSets.t < 60 * 60 * 1000 && covers(globalSets.have, want)) return globalSets;
  const g = { seven: [], bttv: [], ffz: [], have: { ...want }, t: Date.now() };
  const jobs = [];
  if (want.seven) jobs.push(getJson("https://7tv.io/v3/emote-sets/global").then((d) => { g.seven = L.sevenTvSet(d && d.emotes); }));
  if (want.bttv) jobs.push(getJson("https://api.betterttv.net/3/cached/emotes/global").then((d) => { g.bttv = (Array.isArray(d) ? d : []).map(L.bttvEmote).filter(Boolean); }));
  if (want.ffz) jobs.push(getJson("https://api.frankerfacez.com/v1/set/global").then((d) => { g.ffz = L.ffzSets(d, d && d.default_sets); }));
  const results = await Promise.allSettled(jobs);
  if (results.some((r) => r.status === "rejected") && globalSets) {
    // keep what we had for a provider that failed this time
    for (const k of ["seven", "bttv", "ffz"]) if (want[k] && !g[k].length) g[k] = globalSets[k] || [];
  }
  globalSets = g;
  return g;
}

async function fetchChannel(channel, want) {
  const rec = { room: "", seven: [], sevenSet: "", sevenUser: "", bttv: [], ffz: [], have: { ...want }, t: Date.now() };
  rec.room = await roomIdFor(channel).catch(() => "");
  if (!rec.room) return rec;
  const jobs = [];
  if (want.seven) {
    jobs.push(getJson("https://7tv.io/v3/users/twitch/" + rec.room).then((d) => {
      const set = d && d.emote_set;
      rec.seven = L.sevenTvSet(set && set.emotes);
      rec.sevenSet = set && /^[0-9a-z]{1,40}$/i.test(set.id || "") ? set.id : "";
      rec.sevenUser = d && d.user && /^[0-9a-z]{1,40}$/i.test(d.user.id || "") ? d.user.id : "";
    }));
  }
  if (want.bttv) {
    jobs.push(getJson("https://api.betterttv.net/3/cached/users/twitch/" + rec.room).then((d) => {
      rec.bttv = [...(d && Array.isArray(d.channelEmotes) ? d.channelEmotes : []), ...(d && Array.isArray(d.sharedEmotes) ? d.sharedEmotes : [])]
        .map(L.bttvEmote).filter(Boolean);
    }));
  }
  if (want.ffz) jobs.push(getJson("https://api.frankerfacez.com/v1/room/id/" + rec.room).then((d) => { rec.ffz = L.ffzSets(d); }));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.warn("[Chat Watcher] emote lookup failed for", channel, r.reason);
  return rec;
}

const LABEL = { seven: "7TV", bttv: "BTTV", ffz: "FFZ" };

function diff(oldRec, newRec) {
  const changes = [];
  if (!oldRec) return changes;
  for (const k of ["seven", "bttv", "ffz"]) {
    if (!oldRec.have[k] || !newRec.have[k]) continue;
    const before = new Set(oldRec[k].map((e) => e.n));
    const after = new Set(newRec[k].map((e) => e.n));
    const added = [...after].filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !after.has(n));
    if (added.length || removed.length) changes.push({ p: LABEL[k], added, removed });
  }
  return changes;
}

async function ensureEmotes(channel, force) {
  const { settings } = await load();
  const want = providersWanted(settings);
  if (!want.seven && !want.bttv && !want.ffz) return null;
  const cur = chanEmotes.get(channel);
  if (cur && cur.then) return cur;
  if (!force && cur && Date.now() - cur.t < EMOTE_TTL && covers(cur.have, want)) return cur;
  const job = (async () => {
    const [rec] = await Promise.all([fetchChannel(channel, want), fetchGlobals(want)]);
    chanEmotes.set(channel, rec);
    if (chanEmotes.size > 50) chanEmotes.delete(chanEmotes.keys().next().value);
    const changes = diff(cur && !cur.then ? cur : null, rec);
    if (!cur || cur.then || changes.length || !covers(cur.have, want)) pushEmotes(channel, changes);
    syncLive();
    return rec;
  })();
  chanEmotes.set(channel, job);
  job.catch(() => { if (chanEmotes.get(channel) === job) chanEmotes.delete(channel); });
  return job;
}

async function emoteView(channel) {
  const { settings } = await load();
  const rec = chanEmotes.get(channel);
  if (!rec || rec.then) return null;
  const want = providersWanted(settings);
  const g = globalSets || { seven: [], bttv: [], ffz: [] };
  const pick = (src) => [want.seven ? src.seven : [], want.bttv ? src.bttv : [], want.ffz ? src.ffz : []];
  const view = {
    room: rec.room,
    emotes: L.mergeEmotes(...pick(rec)), // channel emotes: 7TV, then BTTV, then FFZ
    global: L.mergeEmotes(...pick(g)),
    personal: {}
  };
  if (want.seven && settings.emotesPersonal) {
    for (const [login, p] of [...personal].slice(-300)) view.personal[login] = p.emotes;
  }
  return view;
}

function subsFor(channel) {
  return [...emoteSubs.values()].filter((s) => !channel || s.channel === channel);
}

async function pushEmotes(channel, changes) {
  const view = await emoteView(channel);
  if (!view) return;
  for (const s of subsFor(channel)) {
    browser.tabs.sendMessage(s.tabId, { type: "emotes:set", channel, ...view, changes: changes || [] }, { frameId: s.frameId }).catch(() => {});
  }
}

function pushPersonal(login, emotes) {
  for (const s of subsFor(null)) {
    browser.tabs.sendMessage(s.tabId, { type: "emotes:personal", login, emotes }, { frameId: s.frameId }).catch(() => {});
  }
}

function channelByRoom(room) {
  for (const [ch, rec] of chanEmotes) if (!rec.then && rec.room === room) return ch;
  return "";
}

function channelBySet(id) {
  for (const [ch, rec] of chanEmotes) if (!rec.then && rec.sevenSet === id) return ch;
  return "";
}

// ---------- 7TV personal emotes ----------

let personalQueue = Promise.resolve();

function personalAdd(ent) {
  personalQueue = personalQueue.then(async () => {
    const { settings } = await load();
    if (!settings.emotes7tv || !settings.emotesPersonal) return;
    let set = personalSets.get(ent.ref);
    if (!set || Date.now() - set.t > 30 * 60000) {
      const d = await getJson("https://7tv.io/v3/emote-sets/" + ent.ref).catch(() => null);
      set = { emotes: L.sevenTvSet(d && d.emotes), t: Date.now() };
      personalSets.set(ent.ref, set);
      if (personalSets.size > 1000) personalSets.delete(personalSets.keys().next().value);
    }
    personal.delete(ent.login);
    personal.set(ent.login, { ref: ent.ref, emotes: set.emotes, t: Date.now() });
    if (personal.size > 1000) personal.delete(personal.keys().next().value);
    pushPersonal(ent.login, set.emotes);
  }).catch(() => {});
}

function personalRemove(ent) {
  const cur = personal.get(ent.login);
  if (!cur || cur.ref !== ent.ref) return;
  personal.delete(ent.login);
  pushPersonal(ent.login, []);
}

// ---------- 7TV event API ----------

const sevenLive = {
  ws: null,
  ready: false,
  subs: new Map(), // key -> { type, condition }
  retry: 0,
  timer: 0,
  lastBeat: 0,
  beatMs: 45000,

  key(type, condition) { return type + "|" + JSON.stringify(condition); },

  want(list) {
    const next = new Map(list.map((x) => [this.key(x.type, x.condition), x]));
    for (const [k, x] of this.subs) if (!next.has(k)) { this.subs.delete(k); this.send(36, x); }
    for (const [k, x] of next) if (!this.subs.has(k)) { this.subs.set(k, x); this.send(35, x); }
    if (this.subs.size && !this.ws) this.connect();
    if (!this.subs.size && this.ws) this.close();
  },

  send(op, d) {
    if (this.ws && this.ready && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op, d }));
  },

  connect() {
    clearTimeout(this.timer);
    let ws;
    try { ws = new WebSocket("wss://events.7tv.io/v3"); } catch (e) { return this.later(); }
    this.ws = ws;
    this.ready = false;
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      this.lastBeat = Date.now();
      if (m.op === 1) { // hello
        this.ready = true;
        this.retry = 0;
        if (m.d && Number(m.d.heartbeat_interval) > 0) this.beatMs = Number(m.d.heartbeat_interval);
        for (const x of this.subs.values()) this.send(35, x);
      } else if (m.op === 0 && m.d) {
        this.dispatch(String(m.d.type || ""), m.d.body || {});
      } else if (m.op === 4 || m.op === 7) {
        try { ws.close(); } catch (err) { /* ignore */ }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      if (this.subs.size) this.later();
    };
    ws.onerror = () => { try { ws.close(); } catch (err) { /* ignore */ } };
  },

  later() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.ws && this.subs.size) this.connect(); }, Math.min(120000, 2000 * 2 ** Math.min(this.retry++, 6)));
  },

  close() {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
  },

  dispatch(type, body) {
    if (type === "emote_set.update") {
      const id = String(body.id || "");
      const ch = channelBySet(id);
      if (ch) {
        const rec = chanEmotes.get(ch);
        const r = L.apply7tvChange(rec.seven, body);
        rec.seven = r.list;
        if (r.added.length || r.removed.length) pushEmotes(ch, [{ p: "7TV", added: r.added, removed: r.removed }]);
      }
      for (const [login, p] of personal) {
        if (p.ref === id) {
          p.emotes = L.apply7tvChange(p.emotes, body).list;
          personalSets.set(id, { emotes: p.emotes, t: Date.now() });
          pushPersonal(login, p.emotes);
        }
      }
    } else if (type === "user.update") {
      for (const [ch, rec] of chanEmotes) if (!rec.then && rec.sevenUser === body.id) ensureEmotes(ch, true);
    } else if (type === "entitlement.create" || type === "entitlement.delete") {
      const ent = L.sevenEntitlement(body);
      if (!ent || ent.kind !== "EMOTE_SET") return;
      if (type === "entitlement.create") personalAdd(ent);
      else personalRemove(ent);
    }
  }
};

// a silent 7TV connection gets replaced
setInterval(() => {
  if (sevenLive.ws && sevenLive.ready && Date.now() - sevenLive.lastBeat > sevenLive.beatMs * 3) {
    try { sevenLive.ws.close(); } catch (e) { /* ignore */ }
  }
}, 30000);

// ---------- BTTV socket ----------

const bttvLive = {
  ws: null,
  joined: new Set(),
  want: new Set(),
  retry: 0,
  timer: 0,

  sync(rooms) {
    this.want = new Set(rooms);
    if (!this.want.size) { this.close(); return; }
    if (!this.ws) return this.connect();
    if (this.ws.readyState !== 1) return;
    for (const r of this.want) if (!this.joined.has(r)) this.send("join_channel", r);
    for (const r of [...this.joined]) if (!this.want.has(r)) this.send("part_channel", r);
  },

  send(name, room) {
    this.ws.send(JSON.stringify({ name, data: { name: "twitch:" + room } }));
    if (name === "join_channel") this.joined.add(room);
    else this.joined.delete(room);
  },

  connect() {
    clearTimeout(this.timer);
    let ws;
    try { ws = new WebSocket("wss://sockets.betterttv.net/ws"); } catch (e) { return this.later(); }
    this.ws = ws;
    this.joined = new Set();
    ws.onopen = () => {
      this.retry = 0;
      for (const r of this.want) this.send("join_channel", r);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      const d = m && m.data;
      const room = d && typeof d.channel === "string" ? d.channel.replace(/^twitch:/, "") : "";
      const ch = room ? channelByRoom(room) : "";
      const rec = ch ? chanEmotes.get(ch) : null;
      if (!rec) return;
      const added = [];
      const removed = [];
      if (m.name === "emote_create") {
        const x = L.bttvEmote(d.emote);
        if (x) { rec.bttv = rec.bttv.filter((y) => y.id !== x.id).concat(x); added.push(x.n); }
      } else if (m.name === "emote_delete") {
        const old = rec.bttv.find((y) => y.id === d.emoteId);
        if (old) { rec.bttv = rec.bttv.filter((y) => y !== old); removed.push(old.n); }
      } else if (m.name === "emote_update" && d.emote) {
        const old = rec.bttv.find((y) => y.id === d.emote.id);
        if (old && d.emote.code && old.n !== d.emote.code) {
          const x = L.bttvEmote({ ...d.emote, animated: old.a });
          if (x) { rec.bttv = rec.bttv.filter((y) => y !== old).concat(x); removed.push(old.n); added.push(x.n); }
        }
      }
      if (added.length || removed.length) pushEmotes(ch, [{ p: "BTTV", added, removed }]);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.joined.clear();
      if (this.want.size) this.later();
    };
    ws.onerror = () => { try { ws.close(); } catch (err) { /* ignore */ } };
  },

  later() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.ws && this.want.size) this.connect(); }, Math.min(120000, 2000 * 2 ** Math.min(this.retry++, 6)));
  },

  close() {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    this.joined.clear();
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
  }
};

// ---------- which live feeds to keep open ----------

async function syncLive() {
  const { settings } = await load();
  const now = Date.now();
  const channels = new Set();
  for (const [k, s] of emoteSubs) {
    if (now - s.t > 150000) emoteSubs.delete(k);
    else channels.add(s.channel);
  }
  const seven = [];
  const bttv = [];
  for (const ch of channels) {
    const rec = chanEmotes.get(ch);
    if (!rec || rec.then || !rec.room) continue;
    if (settings.emotes7tv && settings.emoteLive && rec.sevenSet) seven.push({ type: "emote_set.update", condition: { object_id: rec.sevenSet } });
    if (settings.emotes7tv && settings.emoteLive && rec.sevenUser) seven.push({ type: "user.update", condition: { object_id: rec.sevenUser } });
    if (settings.emotes7tv && settings.emotesPersonal) {
      const cond = { ctx: "channel", id: rec.room, platform: "TWITCH" };
      seven.push({ type: "entitlement.create", condition: cond }, { type: "entitlement.delete", condition: cond });
    }
    if (settings.emotesBttv && settings.emoteLive) bttv.push(rec.room);
  }
  // personal sets in use can change too
  if (settings.emotes7tv && settings.emotesPersonal) {
    for (const ref of new Set([...personal.values()].map((p) => p.ref))) seven.push({ type: "emote_set.update", condition: { object_id: ref } });
  }
  sevenLive.want(seven.slice(0, 400));
  bttvLive.sync(bttv);
  if (!channels.size) personal.clear();
}

setInterval(() => syncLive().catch(() => {}), 60000);

// ---------- messaging ----------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "emotes:get") return;
  const channel = String(msg.channel || "").toLowerCase();
  if (!CH_RE.test(channel) || !sender.tab) return Promise.resolve(null);
  emoteSubs.set(`${sender.tab.id}:${sender.frameId || 0}`, { tabId: sender.tab.id, frameId: sender.frameId || 0, channel, t: Date.now() });
  return ensureEmotes(channel).then(() => emoteView(channel)).catch(() => null);
});

browser.tabs.onRemoved.addListener((tabId) => {
  for (const k of [...emoteSubs.keys()]) if (k.startsWith(tabId + ":")) emoteSubs.delete(k);
  syncLive().catch(() => {});
});

browser.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.settings) return;
  const a = ch.settings.oldValue || {};
  const b = ch.settings.newValue || {};
  if (["emotes7tv", "emotesBttv", "emotesFfz", "emotesPersonal", "emoteLive"].some((k) => a[k] !== b[k])) {
    if (!b.emotesPersonal || !b.emotes7tv) personal.clear();
    syncLive().catch(() => {});
  }
});
