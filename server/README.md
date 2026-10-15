# Paint server

A tiny service that lets Chat Watcher users see each other's nametag paints. It runs on
Cloudflare Workers with a D1 (SQLite) database. Both have free tiers that comfortably cover a
small or medium user base.

Until it's deployed and the extension is pointed at it, paints only show on your own screen.

## What it does

| Endpoint | Who | What |
|---|---|---|
| `GET /v1/paints?logins=a,b,c` | anyone | Returns published paints for up to 100 Twitch logins. Cached at the edge for 2 minutes. |
| `PUT /v1/me/paint` | signed-in user | Publishes or replaces **your own** paint. |
| `DELETE /v1/me/paint` | signed-in user | Unpublishes your paint. |
| daily cron | — | Re-checks logins with Twitch: renamed accounts keep their paint under the new name, deleted accounts lose it. |

**How it knows who you are:** the extension signs you in with Twitch, asking for no permissions
(identity only). The server checks the token with Twitch's documented
`id.twitch.tv/oauth2/validate` endpoint and only accepts tokens issued to *your* Twitch app. The
account always comes from Twitch, never from the request body, so nobody can publish a paint for
someone else. The token is revoked right after use and never stored.

**What's stored per account:** numeric Twitch user ID, current login, the paint (a small validated
JSON object), when it was published and when the login was last confirmed. Nothing else: no IP
addresses, no chat, no viewer lists. Every paint is validated against a strict schema
(`paints.js`) on the way in *and* on the way out; there is no free-form CSS/HTML anywhere.

**Privacy for viewers:** viewers who turn on "Show other people's paints" send the usernames
they see in chat to `GET /v1/paints` (in batches, cached, with no cookies or account info).
Cloudflare can see the requester's IP as with any website; the Worker doesn't log or store it,
and Worker logs are turned off in `wrangler.toml`.

## Costs and limits

- Cloudflare Workers Free and D1 Free were enough for this at the time of writing
  (Workers: 100,000 requests/day; D1: millions of row reads/day, 5 GB). Check Cloudflare's
  current pricing pages before relying on this.
- Each browser makes at most one lookup request per second, 100 names per request, and caches
  results (15 min for paints, 30 min for "no paint"). After a failure it backs off for up to
  10 minutes.
- Publishing is limited to once every 10 seconds per account.
- For extra protection against abuse, add a Cloudflare **Rate limiting rule** on
  `/v1/paints` (for example 60 requests/minute per IP) in the Cloudflare dashboard.

## Deploy (about 15 minutes)

You need: a free Cloudflare account, a Twitch account with two-factor auth on, and Node.js 18+.

1. **Create the Twitch app.** Go to <https://dev.twitch.tv/console/apps> → *Register Your Application*.
   - Name: anything (e.g. "Chat Watcher Paints").
   - OAuth Redirect URL: in the extension go to **Settings → Nametag paints → Advanced** and copy
     **Sign-in redirect URL** (looks like `https://<random>.extensions.allizom.org/`).
   - Category: *Browser Extension*. Client type: *Confidential*.
   - Copy the **Client ID**. Click *New Secret* and copy the **Client Secret** (keep it private).
2. **Set up Cloudflare** (in this `server` folder):
   ```sh
   npx wrangler login
   npx wrangler d1 create tcw-paints
   ```
   Paste the printed `database_id` into `wrangler.toml`, and put your Client ID in
   `TWITCH_CLIENT_ID` there (the Client ID is public, that's fine).
3. **Create the table and add the secret:**
   ```sh
   npx wrangler d1 execute tcw-paints --remote --file=schema.sql
   npx wrangler secret put TWITCH_CLIENT_SECRET
   ```
4. **Deploy:**
   ```sh
   npx wrangler deploy
   ```
   It prints your URL, like `https://tcw-paints.<you>.workers.dev`. Opening `/health` should show
   `{"ok":true,...}`.
5. **Point the extension at it.** Either:
   - for everyone: put the URL and Client ID in `config.js`, bump the version in `manifest.json`
     and push (a release is built automatically), **or**
   - just for testing: paste them into **Settings → Nametag paints → Advanced**.

   Before shipping a build with sharing turned on, update `data_collection_permissions` in
   `manifest.json`. Usernames from chat and your Twitch identity are sent to your server, so the
   `"none"` declaration no longer applies. Check Mozilla's current guidance for the right
   categories.

## Tests

```sh
node --test test/*.test.js
```

The tests run the real Worker code against Node's built-in SQLite with a fake Twitch.
