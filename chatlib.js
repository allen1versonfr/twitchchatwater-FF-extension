/* Pure helpers for the chat tools, shared by the background page and the content scripts (and the tests).
 * Nothing here touches the DOM or the browser APIs. */
(function (root) {
  "use strict";

  // ---------- Twitch IRC ----------

  const TAG_ESC = { ":": ";", s: " ", "\\": "\\", r: "\r", n: "\n" };

  function unescapeTag(v) {
    return String(v).replace(/\\(.?)/g, (m, c) => (c in TAG_ESC ? TAG_ESC[c] : c));
  }

  // "@a=1;b=2 :nick!user@host CMD #chan :trailing" -> { tags, prefix, nick, command, params[] }
  function parseIrc(line) {
    let s = String(line || "").replace(/[\r\n]+$/, "");
    if (!s) return null;
    const msg = { tags: {}, prefix: "", nick: "", command: "", params: [] };
    if (s[0] === "@") {
      const sp = s.indexOf(" ");
      if (sp < 0) return null;
      for (const part of s.slice(1, sp).split(";")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        if (eq < 0) msg.tags[part] = "";
        else msg.tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
      }
      s = s.slice(sp + 1).replace(/^ +/, "");
    }
    if (s[0] === ":") {
      const sp = s.indexOf(" ");
      if (sp < 0) return null;
      msg.prefix = s.slice(1, sp);
      msg.nick = msg.prefix.split("!")[0].toLowerCase();
      s = s.slice(sp + 1).replace(/^ +/, "");
    }
    const trail = s.indexOf(" :");
    let head = s;
    let tail = null;
    if (trail >= 0) {
      head = s.slice(0, trail);
      tail = s.slice(trail + 2);
    }
    const parts = head.split(" ").filter(Boolean);
    msg.command = (parts.shift() || "").toUpperCase();
    msg.params = parts;
    if (tail !== null) msg.params.push(tail);
    return msg.command ? msg : null;
  }

  // "moderator/1,subscriber/12" -> { moderator: "1", subscriber: "12" }
  function parseBadges(v) {
    const out = {};
    for (const b of String(v || "").split(",")) {
      const i = b.indexOf("/");
      if (i > 0) out[b.slice(0, i)] = b.slice(i + 1);
    }
    return out;
  }

  // Turns a parsed IRC line into the small event the content script needs, or null.
  function ircEvent(m) {
    if (!m) return null;
    const chan = String(m.params[0] || "").replace(/^#/, "").toLowerCase();
    const t = m.tags;
    const time = Number(t["tmi-sent-ts"]) || Date.now();
    if (m.command === "PRIVMSG") {
      let text = m.params[1] || "";
      let action = false;
      const me = /^\x01ACTION (.*)\x01?$/.exec(text);
      if (me) { text = me[1].replace(/\x01$/, ""); action = true; }
      return {
        k: "msg", ch: chan, id: t.id || "", login: (t.login || m.nick || "").toLowerCase(),
        display: t["display-name"] || m.nick, text, action, time,
        badges: parseBadges(t.badges), color: /^#[0-9a-f]{6}$/i.test(t.color || "") ? t.color : "",
        first: t["first-msg"] === "1", returning: t["returning-chatter"] === "1",
        room: t["room-id"] || "", source: t["source-room-id"] || "",
        reply: t["reply-parent-user-login"] || ""
      };
    }
    if (m.command === "CLEARMSG") {
      return { k: "del", ch: chan, id: t["target-msg-id"] || "", login: (t.login || "").toLowerCase(), text: m.params[1] || "", time };
    }
    if (m.command === "CLEARCHAT") {
      const target = (m.params[1] || "").toLowerCase();
      if (!target) return { k: "clear", ch: chan, time };
      const d = t["ban-duration"];
      return { k: "ban", ch: chan, login: target, duration: d ? Number(d) || 0 : 0, permanent: !d, time };
    }
    if (m.command === "ROOMSTATE" && t["room-id"]) {
      return { k: "room", ch: chan, room: t["room-id"] };
    }
    return null;
  }

  // ---------- 7TV ----------

  // One 7TV emote-set entry -> { n, id, u (base url), a (animated), z (zero-width), w, h } or null.
  function sevenTvEmote(e) {
    if (!e || typeof e !== "object") return null;
    const name = String(e.name || (e.data && e.data.name) || "");
    const data = e.data || {};
    const id = String(data.id || e.id || "");
    if (!name || name.length > 100 || /\s/.test(name) || !/^[0-9a-z]{1,40}$/i.test(id)) return null;
    let base = String((data.host && data.host.url) || "");
    if (base.startsWith("//")) base = "https:" + base;
    if (!/^https:\/\/cdn\.7tv\.app\/emote\/[0-9a-z]{1,40}$/i.test(base)) base = "https://cdn.7tv.app/emote/" + id;
    const files = (data.host && Array.isArray(data.host.files) ? data.host.files : []);
    const one = files.find((f) => f && f.name === "1x.webp") || files[0] || {};
    const w = Number(one.width) > 0 && Number(one.width) < 1000 ? Number(one.width) : 28;
    const h = Number(one.height) > 0 && Number(one.height) < 1000 ? Number(one.height) : 28;
    const zero = ((Number(e.flags) || 0) & 1) !== 0 || ((Number(data.flags) || 0) & 256) !== 0;
    return { n: name, id, p: "7tv", u: base, s: [base + "/1x.webp", base + "/2x.webp", base + "/4x.webp"], a: !!data.animated, z: zero, w, h };
  }

  function sevenTvSet(list) {
    const out = [];
    const seen = new Set();
    for (const e of Array.isArray(list) ? list : []) {
      const x = sevenTvEmote(e);
      if (x && !seen.has(x.n)) { seen.add(x.n); out.push(x); }
    }
    return out;
  }

  // ---------- BTTV ----------

  // BTTV's global overlay emotes (drawn on top of the emote before them)
  const BTTV_ZERO_WIDTH = new Set(["SoSnowy", "IceCold", "SantaHat", "TopHat", "ReinDeer", "CandyCane", "cvMask", "cvHazmat"]);

  function bttvEmote(e) {
    if (!e || typeof e !== "object") return null;
    const id = String(e.id || "");
    const name = String(e.code || "");
    if (!/^[0-9a-f]{24}$/i.test(id) || !name || name.length > 100 || /\s/.test(name)) return null;
    const base = "https://cdn.betterttv.net/emote/" + id;
    const num = (v) => (Number(v) > 0 && Number(v) < 1000 ? Number(v) : 0);
    return {
      n: name, id, p: "bttv", s: [base + "/1x.webp", base + "/2x.webp", base + "/3x.webp"],
      a: !!e.animated || e.imageType === "gif", z: BTTV_ZERO_WIDTH.has(name), w: num(e.width) || 28, h: num(e.height) || 28
    };
  }

  // ---------- FFZ ----------

  function ffzEmote(e) {
    if (!e || typeof e !== "object" || e.modifier) return null; // modifiers change other emotes; not shown on their own
    const id = String(e.id == null ? "" : e.id);
    const name = String(e.name || "");
    if (!/^\d{1,12}$/.test(id) || !name || name.length > 100 || /\s/.test(name)) return null;
    const urls = e.urls && typeof e.urls === "object" ? e.urls : {};
    const base = "https://cdn.frankerfacez.com/emote/" + id + "/";
    const size = (n) => base + (urls[n] ? n : urls["2"] ? "2" : "1");
    const num = (v) => (Number(v) > 0 && Number(v) < 1000 ? Number(v) : 0);
    return { n: name, id, p: "ffz", s: [base + "1", size("2"), urls["4"] ? base + "4" : size("2")], a: false, z: false, w: num(e.width) || 28, h: num(e.height) || 28 };
  }

  // FFZ answers with { sets: { id: { emoticons: [...] } } }; only the given set ids are used when listed.
  function ffzSets(data, onlyIds) {
    const out = [];
    const sets = data && data.sets && typeof data.sets === "object" ? data.sets : {};
    for (const [id, set] of Object.entries(sets)) {
      if (onlyIds && !onlyIds.map(String).includes(String(id))) continue;
      for (const e of (set && Array.isArray(set.emoticons) ? set.emoticons : [])) {
        const x = ffzEmote(e);
        if (x) out.push(x);
      }
    }
    return out;
  }

  // ---------- merging and live updates ----------

  // Lists in priority order -> one list, first one wins on a name clash.
  function mergeEmotes(...lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const e of list || []) {
        if (e && !seen.has(e.n)) { seen.add(e.n); out.push(e); }
      }
    }
    return out;
  }

  // Applies a 7TV EventAPI "emote_set.update" body to a list -> { list, added: [names], removed: [names] }.
  function apply7tvChange(list, body) {
    let next = (list || []).slice();
    const added = [];
    const removed = [];
    const items = (k) => (Array.isArray(body && body[k]) ? body[k] : []).filter((x) => x && x.key === "emotes");
    for (const x of items("pulled")) {
      const old = x.old_value;
      if (!old) continue;
      const before = next.length;
      next = next.filter((e) => e.id !== String((old.data && old.data.id) || old.id) && e.n !== old.name);
      if (next.length < before) removed.push(old.name);
    }
    for (const x of items("updated")) {
      const e = sevenTvEmote(x.value);
      const old = x.old_value || {};
      if (!e) continue;
      next = next.filter((y) => y.n !== old.name && y.id !== e.id);
      next.push(e);
      if (old.name && old.name !== e.n) { removed.push(old.name); added.push(e.n); }
    }
    for (const x of items("pushed")) {
      const e = sevenTvEmote(x.value);
      if (!e) continue;
      next = next.filter((y) => y.n !== e.n);
      next.push(e);
      added.push(e.n);
    }
    return { list: next, added, removed };
  }

  // 7TV entitlement event -> { kind, ref, login } (who owns which personal emote set), or null.
  function sevenEntitlement(body) {
    const o = body && (body.object || body);
    if (!o || typeof o !== "object") return null;
    const user = o.user || {};
    const conn = (Array.isArray(user.connections) ? user.connections : []).find((c) => c && String(c.platform).toUpperCase() === "TWITCH");
    const login = conn ? String(conn.username || "").toLowerCase() : "";
    const ref = String(o.ref_id || "");
    if (!/^[a-z0-9_]{1,25}$/.test(login) || !/^[0-9a-z]{1,40}$/i.test(ref)) return null;
    return { kind: String(o.kind || "").toUpperCase(), ref, login };
  }

  // ---------- text matching ----------

  function splitList(v) {
    return String(v || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  }

  // Lines of "word", "two words" or "/regex/flags" -> [{ label, re }]. Invalid regexes are skipped.
  function compileTerms(v) {
    const out = [];
    for (const raw of splitList(v).slice(0, 200)) {
      const rx = /^\/(.+)\/([a-z]*)$/i.exec(raw);
      try {
        if (rx) {
          const flags = [...new Set((rx[2] + "i").replace(/[^imsu]/g, ""))].join("");
          out.push({ label: raw, re: new RegExp(rx[1], flags) });
        } else {
          const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          out.push({ label: raw, re: new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, "iu") });
        }
      } catch (e) { /* bad regex: ignore */ }
    }
    return out;
  }

  function matchTerms(terms, text) {
    for (const t of terms) if (t.re.test(text)) return t.label;
    return null;
  }

  function loginSet(v) {
    return new Set(splitList(v).map((s) => s.replace(/^@/, "").toLowerCase()).filter((s) => /^[a-z0-9_]{1,25}$/.test(s)));
  }

  // Comparable form of a chat message, used to pair a chat row on screen with its IRC message.
  function msgKey(text) {
    return String(text || "")
      .replace(/[​-‍﻿\u{E0000}]/gu, "")
      .replace(/^@[a-z0-9_]{1,25}\s+/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, 120);
  }

  // ---------- emote spam detection ----------

  // Tracks rolling activity per emote. "add" returns newly-triggered suggestions;
  // "active" returns all emotes still meeting the live threshold for UI refreshes.
  function spamDetector(opts) {
    const o = { windowMs: 10000, minMessages: 6, minUsers: 4, cooldownMs: 60000, ...opts };
    const hits = new Map();
    const prompted = new Map();

    function trim(t) {
      for (const [name, arr] of hits) {
        while (arr.length && t - arr[0].t > o.windowMs) arr.shift();
        if (!arr.length) hits.delete(name);
      }
      for (const [name, at] of prompted) if (t - at >= o.cooldownMs) prompted.delete(name);
    }

    function snapshot(t = Date.now()) {
      trim(t);
      const out = [];
      for (const [name, arr] of hits) {
        if (arr.length < o.minMessages) continue;
        const users = new Set(arr.map((x) => x.login).filter(Boolean)).size;
        if (users < o.minUsers) continue;
        const last = arr[arr.length - 1].t;
        const score = arr.length * (1 + Math.min(users, 12) / 12);
        out.push({ name, count: arr.length, users, last, score });
      }
      return out.sort((a, b) => b.score - a.score || b.last - a.last || a.name.localeCompare(b.name));
    }

    return {
      opts: o,
      add(emotes, login, t = Date.now()) {
        trim(t);
        const user = String(login || "").toLowerCase();
        for (const name of new Set(emotes)) {
          if (!name) continue;
          let arr = hits.get(name);
          if (!arr) hits.set(name, (arr = []));
          arr.push({ t, login: user });
          if (arr.length > 500) arr.splice(0, arr.length - 500);
        }
        const fired = snapshot(t).find((x) => !prompted.has(x.name));
        if (fired) prompted.set(fired.name, t);
        if (hits.size > 500) {
          for (const [name, arr] of hits) if (!arr.length || t - arr[arr.length - 1].t > o.windowMs) hits.delete(name);
        }
        return fired ? { ...fired } : null;
      },
      active(t = Date.now()) { return snapshot(t); },
      reset() { hits.clear(); prompted.clear(); }
    };
  }

  // ---------- emote usage stats ----------

  // stats: { name: { n, last, src, p } } -> top names by count (ties: most recent first)
  function topEmotes(stats, limit = 24) {
    return Object.entries(stats || {})
      .filter(([, s]) => s && s.n > 0)
      .sort((a, b) => b[1].n - a[1].n || (b[1].last || 0) - (a[1].last || 0))
      .slice(0, limit)
      .map(([name, s]) => ({ name, ...s }));
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.round(sec / 60) + "m";
    if (sec < 86400) return Math.round(sec / 3600) + "h";
    return Math.round(sec / 86400) + "d";
  }

  const API = {
    parseIrc, parseBadges, ircEvent, unescapeTag, sevenTvEmote, sevenTvSet,
    bttvEmote, ffzEmote, ffzSets, mergeEmotes, apply7tvChange, sevenEntitlement,
    splitList, compileTerms, matchTerms, loginSet, msgKey, spamDetector, topEmotes, fmtDuration
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.TCWChatLib = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
