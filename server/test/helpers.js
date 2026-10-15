// Test helpers: a D1-compatible wrapper over Node's built-in SQLite, and a fake Twitch.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        for (const s of stmts) await s.run();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  };
}

// Fake id.twitch.tv + api.twitch.tv. tokens: { token: { user_id, login, client_id } }
export function fakeTwitch({ tokens = {}, users = {}, clientId = "our-client" } = {}) {
  const calls = { validate: 0, revoke: [], appToken: 0, helix: 0 };
  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const headers = new Headers(init.headers || {});
    if (url.pathname === "/oauth2/validate") {
      calls.validate++;
      const t = (headers.get("Authorization") || "").replace(/^OAuth /, "");
      const info = tokens[t];
      if (!info) return new Response(JSON.stringify({ status: 401 }), { status: 401 });
      return Response.json({ client_id: info.client_id || clientId, login: info.login, user_id: info.user_id, scopes: [], expires_in: 5000 });
    }
    if (url.pathname === "/oauth2/revoke") {
      calls.revoke.push(new URLSearchParams(String(init.body)).get("token"));
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/oauth2/token") {
      calls.appToken++;
      return Response.json({ access_token: "app-token", expires_in: 5000 });
    }
    if (url.pathname === "/helix/users") {
      calls.helix++;
      const ids = url.searchParams.getAll("id");
      return Response.json({ data: ids.filter((id) => users[id]).map((id) => ({ id, login: users[id] })) });
    }
    throw new Error("unexpected fetch " + url);
  }
  return { fetchImpl, calls, tokens, users };
}

export function env(db, extra = {}) {
  return {
    DB: db,
    TWITCH_CLIENT_ID: "our-client",
    TWITCH_ID_BASE: "https://id.fake",
    TWITCH_API_BASE: "https://api.fake",
    ...extra
  };
}

export const ctx = { waitUntil() {} };
