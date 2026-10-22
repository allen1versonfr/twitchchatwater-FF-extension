// Run with: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../chatlib.js");

test("parseIrc reads tags, prefix, command and trailing text", () => {
  const m = L.parseIrc("@badge-info=;badges=moderator/1,subscriber/12;display-name=Some\\sOne;id=abc;first-msg=1 :someone!someone@someone.tmi.twitch.tv PRIVMSG #chan :hello there: friend\r\n");
  assert.equal(m.command, "PRIVMSG");
  assert.equal(m.nick, "someone");
  assert.deepEqual(m.params, ["#chan", "hello there: friend"]);
  assert.equal(m.tags["display-name"], "Some One");
  assert.equal(m.tags["badge-info"], "");
  assert.equal(L.parseIrc("PING :tmi.twitch.tv").params[0], "tmi.twitch.tv");
  assert.equal(L.parseIrc(""), null);
  assert.equal(L.parseIrc("@only-tags"), null);
});

test("unescapeTag handles Twitch's escapes", () => {
  assert.equal(L.unescapeTag("a\\sb\\:c\\\\d\\n"), "a b;c\\d\n");
});

test("ircEvent turns PRIVMSG into a chat message", () => {
  const ev = L.ircEvent(L.parseIrc("@badges=vip/1;color=#FF0000;display-name=Bob;id=m1;login=bob;room-id=1;source-room-id=2;tmi-sent-ts=1700000000000;returning-chatter=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #Chan :\x01ACTION waves\x01"));
  assert.equal(ev.k, "msg");
  assert.equal(ev.ch, "chan");
  assert.equal(ev.login, "bob");
  assert.equal(ev.text, "waves");
  assert.equal(ev.action, true);
  assert.equal(ev.time, 1700000000000);
  assert.deepEqual(ev.badges, { vip: "1" });
  assert.equal(ev.returning, true);
  assert.equal(ev.first, false);
  assert.equal(ev.source, "2");
  assert.equal(ev.color, "#FF0000");
});

test("ircEvent reads deletes, bans, timeouts, clears and room state", () => {
  const del = L.ircEvent(L.parseIrc("@login=bob;target-msg-id=m1;tmi-sent-ts=5 :tmi.twitch.tv CLEARMSG #chan :bad link https://x.y"));
  assert.deepEqual(del, { k: "del", ch: "chan", id: "m1", login: "bob", text: "bad link https://x.y", time: 5 });
  const to = L.ircEvent(L.parseIrc("@ban-duration=600;tmi-sent-ts=6 :tmi.twitch.tv CLEARCHAT #chan :Bob"));
  assert.equal(to.k, "ban");
  assert.equal(to.login, "bob");
  assert.equal(to.duration, 600);
  assert.equal(to.permanent, false);
  const ban = L.ircEvent(L.parseIrc("@tmi-sent-ts=7 :tmi.twitch.tv CLEARCHAT #chan :bob"));
  assert.equal(ban.permanent, true);
  assert.equal(L.ircEvent(L.parseIrc("@tmi-sent-ts=8 :tmi.twitch.tv CLEARCHAT #chan")).k, "clear");
  assert.deepEqual(L.ircEvent(L.parseIrc("@room-id=123;slow=0 :tmi.twitch.tv ROOMSTATE #chan")), { k: "room", ch: "chan", room: "123" });
  assert.equal(L.ircEvent(L.parseIrc(":tmi.twitch.tv 001 justinfan1 :Welcome")), null);
});

test("sevenTvSet keeps valid emotes, builds safe URLs and flags zero-width", () => {
  const set = L.sevenTvSet([
    { id: "a1", name: "KEKW", flags: 0, data: { id: "60ae", animated: false, flags: 0, host: { url: "//cdn.7tv.app/emote/60ae", files: [{ name: "1x.webp", width: 32, height: 32 }] } } },
    { id: "a2", name: "RainTime", flags: 1, data: { id: "60af", animated: true, flags: 256, host: { url: "//cdn.7tv.app/emote/60af", files: [] } } },
    { id: "a3", name: "Evil", data: { id: "60b0", host: { url: "https://evil.example/emote/60b0" } } },
    { id: "a4", name: "has space", data: { id: "60b1" } },
    { id: "a5", name: "KEKW", data: { id: "60b2" } },
    { name: "NoId", data: { id: "../../x" } },
    null
  ]);
  assert.deepEqual(set.map((e) => e.n), ["KEKW", "RainTime", "Evil"]);
  assert.equal(set[0].u, "https://cdn.7tv.app/emote/60ae");
  assert.equal(set[0].w, 32);
  assert.equal(set[0].z, false);
  assert.equal(set[1].z, true);
  assert.equal(set[1].a, true);
  assert.equal(set[2].u, "https://cdn.7tv.app/emote/60b0"); // foreign host replaced
});

test("compileTerms matches whole words, phrases and regexes, case-insensitively", () => {
  const t = L.compileTerms("gg\nmy clip, /^!giveaway\\b/\n/[invalid/\n");
  assert.equal(t.length, 3);
  assert.equal(L.matchTerms(t, "GG wp"), "gg");
  assert.equal(L.matchTerms(t, "eggs"), null);
  assert.equal(L.matchTerms(t, "watch My Clip now"), "my clip");
  assert.equal(L.matchTerms(t, "!giveaway enter"), "/^!giveaway\\b/");
  assert.equal(L.matchTerms(t, "no !giveaway"), null);
  assert.equal(L.matchTerms(L.compileTerms("c++"), "i like c++ a lot"), "c++");
  assert.equal(L.matchTerms(L.compileTerms("pokémon"), "Pokémon time"), "pokémon");
});

test("loginSet keeps valid usernames", () => {
  assert.deepEqual([...L.loginSet("Nightbot, @StreamElements\nnot valid!, x")], ["nightbot", "streamelements", "x"]);
});

test("msgKey pairs the on-screen text with the IRC text", () => {
  assert.equal(L.msgKey("  Hello   WORLD ​"), "hello world");
  assert.equal(L.msgKey("@someone hi there"), L.msgKey("hi there"));
  assert.equal(L.msgKey("x".repeat(500)).length, 120);
});

test("spamDetector fires once per emote when enough people spam it", () => {
  const d = L.spamDetector({ windowMs: 10000, minMessages: 4, minUsers: 3, cooldownMs: 60000 });
  let t = 1000;
  assert.equal(d.add(["KEKW"], "a", t), null);
  assert.equal(d.add(["KEKW"], "a", (t += 100)), null);
  assert.equal(d.add(["KEKW", "KEKW"], "b", (t += 100)), null); // same emote twice in one message counts once
  const hit = d.add(["KEKW"], "c", (t += 100));
  assert.deepEqual(hit, { name: "KEKW", count: 4, users: 3 });
  assert.equal(d.add(["KEKW"], "d", (t += 100)), null); // cooldown
  assert.equal(d.add(["OMEGALUL"], "a", 50000), null);
  // old messages fall out of the window
  const d2 = L.spamDetector({ windowMs: 1000, minMessages: 3, minUsers: 1 });
  d2.add(["x"], "a", 0);
  d2.add(["x"], "a", 500);
  assert.equal(d2.add(["x"], "a", 2000), null);
});

test("topEmotes sorts by count, then most recent", () => {
  const top = L.topEmotes({ a: { n: 2, last: 1 }, b: { n: 5, last: 1 }, c: { n: 2, last: 9 }, d: { n: 0 } }, 3);
  assert.deepEqual(top.map((e) => e.name), ["b", "c", "a"]);
});

test("fmtDuration", () => {
  assert.equal(L.fmtDuration(1), "1s");
  assert.equal(L.fmtDuration(600), "10m");
  assert.equal(L.fmtDuration(7200), "2h");
  assert.equal(L.fmtDuration(1209600), "14d");
});
