import test from "node:test";
import assert from "node:assert/strict";
import worker, { recheck } from "../src/index.js";
import { makeD1, fakeTwitch, env as makeEnv, ctx } from "./helpers.js";

const BASE = "https://paints.test";
const PAINT = { kind: "linear", colors: [{ c: "#ff0000", p: 0 }, { c: "#0000ff", p: 100 }], angle: 45 };

function setup() {
  const db = makeD1();
  const tw = fakeTwitch({
    tokens: {
      tokenalice00: { user_id: "1001", login: "alice" },
      tokenbob0000: { user_id: "1002", login: "bob" },
      tokenother00: { user_id: "1003", login: "mallory", client_id: "someone-elses-app" },
      tokenalice02: { user_id: "1001", login: "alice_renamed" },
      tokennewalic: { user_id: "1009", login: "alice" }
    }
  });
  globalThis.fetch = tw.fetchImpl;
  const env = makeEnv(db);
  const call = (method, path, { token, body, headers = {} } = {}) =>
    worker.fetch(new Request(BASE + path, {
      method,
      headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
    }), env, ctx);
  const lookup = async (...logins) => (await (await call("GET", "/v1/paints?logins=" + logins.join(","))).json()).paints;
  return { db, tw, env, call, lookup };
}

const age = (db, userId) => db.raw.prepare("UPDATE paints SET updated = updated - 60000, checked = checked - 9e9 WHERE user_id = ?").run(userId);

test("CORS preflight and health", async () => {
  const { call } = setup();
  const r = await call("OPTIONS", "/v1/me/paint");
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(r.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.equal((await (await call("GET", "/health")).json()).ok, true);
});

test("lookup validates input", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/v1/paints")).status, 400);
  assert.equal((await call("GET", "/v1/paints?logins=" + Array.from({ length: 101 }, (_, i) => "u" + i).join(","))).status, 400);
  const r = await call("GET", "/v1/paints?logins=Alice,%3Cscript%3E,bob");
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).paints, {});
});

test("publishing needs a valid Twitch sign-in for our app", async () => {
  const { call, tw } = setup();
  assert.equal((await call("PUT", "/v1/me/paint", { body: { paint: PAINT } })).status, 401);
  assert.equal((await call("PUT", "/v1/me/paint", { token: "nottherealtoken", body: { paint: PAINT } })).status, 401);
  const other = await call("PUT", "/v1/me/paint", { token: "tokenother00", body: { paint: PAINT } });
  assert.equal(other.status, 403, "token from another Twitch app is refused");
  assert.equal(tw.calls.revoke.length, 0);
});

test("publish stores a sanitized paint under the token's account and revokes the token", async () => {
  const { call, lookup, tw, db } = setup();
  const dirty = { ...PAINT, colors: [...PAINT.colors, { c: "url(evil)", p: 50 }], css: "body{display:none}", login: "bob" };
  const r = await call("PUT", "/v1/me/paint", { token: "tokenalice00", body: { paint: dirty } });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.login, "alice", "account comes from Twitch, not the request body");
  assert.equal(out.user_id, "1001");
  assert.deepEqual(tw.calls.revoke, ["tokenalice00"]);
  const paints = await lookup("alice", "bob", "carol");
  assert.deepEqual(Object.keys(paints), ["alice"]);
  assert.equal(paints.alice.paint.colors.length, 2);
  assert.equal(JSON.stringify(paints).includes("evil"), false);
  assert.equal(JSON.stringify(paints).includes("display"), false);
  const row = db.raw.prepare("SELECT * FROM paints").all();
  assert.deepEqual(Object.keys(row[0]).sort(), ["checked", "login", "paint", "updated", "user_id"], "only these fields are stored");
});

test("invalid or oversized paints are refused", async () => {
  const { call } = setup();
  assert.equal((await call("PUT", "/v1/me/paint", { token: "tokenalice00", body: { paint: { kind: "linear", colors: ["#fff"] } } })).status, 422);
  assert.equal((await call("PUT", "/v1/me/paint", { token: "tokenalice00", body: "not json" })).status, 400);
  const big = { paint: PAINT, pad: "x".repeat(5000) };
  assert.equal((await call("PUT", "/v1/me/paint", { token: "tokenalice00", body: big })).status, 400);
});

test("rapid republishing is rate limited", async () => {
  const { call } = setup();
  assert.equal((await call("PUT", "/v1/me/paint", { token: "tokenalice00", body: { paint: PAINT } })).status, 200);
  assert.equal((await call("PUT", "/v1/me/paint", { token: "tokenalice00", body: { paint: PAINT } })).status, 429);
});

test("republishing after a rename moves the paint to the new name", async () => {
  const { call, lookup, db } = setup();
  await call("PUT", "/v1/me/paint", { token: "tokenalice00", body: { paint: PAINT } });
  age(db, "1001");
  await call("PUT", "/v1/me/paint", { token: "tokenalice02", body: { paint: PAINT } });
  const paints = await lookup("alice", "alice_renamed");
  assert.deepEqual(Object.keys(paints), ["alice_renamed"]);
});

test("a new owner of a login replaces the old owner's stale row", async () => {
  const { call, lookup, db } = setup();
  await call("PUT", "/v1/me/paint", { token: "tokenalice00", body: { paint: PAINT } });
  const newPaint = { kind: "solid", colors: ["#00ff00"] };
  const r = await call("PUT", "/v1/me/paint", { token: "tokennewalic", body: { paint: newPaint } });
  assert.equal(r.status, 200);
  const paints = await lookup("alice");
  assert.equal(paints.alice.paint.kind, "solid");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM paints").get().n, 1);
});

test("unpublish removes the paint", async () => {
  const { call, lookup, tw } = setup();
  await call("PUT", "/v1/me/paint", { token: "tokenbob0000", body: { paint: PAINT } });
  assert.ok((await lookup("bob")).bob);
  const r = await call("DELETE", "/v1/me/paint", { token: "tokenbob0000" });
  assert.equal(r.status, 200);
  assert.deepEqual(await lookup("bob"), {});
  assert.equal(tw.calls.revoke.filter((t) => t === "tokenbob0000").length, 2);
});

test("corrupted rows in the database are dropped instead of served", async () => {
  const { lookup, db } = setup();
  db.raw.prepare("INSERT INTO paints VALUES ('5','eve','{\"kind\":\"solid\",\"colors\":[\"javascript:x\"]}',1,1)").run();
  db.raw.prepare("INSERT INTO paints VALUES ('6','zed','not json',1,1)").run();
  assert.deepEqual(await lookup("eve", "zed"), {});
});

test("daily re-check follows renames and removes deleted accounts", async () => {
  const { call, lookup, db, env, tw } = setup();
  await call("PUT", "/v1/me/paint", { token: "tokenalice00", body: { paint: PAINT } });
  await call("PUT", "/v1/me/paint", { token: "tokenbob0000", body: { paint: PAINT } });
  age(db, "1001");
  age(db, "1002");
  assert.deepEqual(await recheck(env), { skipped: "no TWITCH_CLIENT_SECRET" });
  tw.users["1001"] = "alice_v2"; // renamed
  // 1002 (bob) no longer exists
  const r = await recheck({ ...env, TWITCH_CLIENT_SECRET: "s" });
  assert.deepEqual(r, { checked: 2, renamed: 1, removed: 1 });
  const paints = await lookup("alice", "alice_v2", "bob");
  assert.deepEqual(Object.keys(paints), ["alice_v2"]);
  assert.deepEqual(await recheck({ ...env, TWITCH_CLIENT_SECRET: "s" }), { checked: 0 }, "fresh rows aren't re-checked");
});

test("unknown routes 404, server errors don't leak details", async () => {
  const { call, env } = setup();
  assert.equal((await call("GET", "/v1/nope")).status, 404);
  env.DB = { prepare() { throw new Error("db secret path /var/x"); } };
  const r = await call("GET", "/v1/paints?logins=a");
  assert.equal(r.status, 500);
  assert.equal((await r.text()).includes("secret"), false);
});
