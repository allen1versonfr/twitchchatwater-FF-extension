# Twitch Chat Watcher (Firefox)

Highlights a chat message and plays a sound when someone on your watchlist sends it.
Only their own messages count: if someone else @mentions or replies to them, nothing happens.

<img src="docs/profile-card.png" alt="Profile card next to Twitch chat" width="640">

## Install

**Normal install (recommended):** go to [Releases](../../releases/latest), click the `.xpi` file, and choose **Add** when Firefox asks.
It updates itself when a new release comes out. Needs Firefox 140 or newer.

**From source (for testing changes):**
1. Download this repo and unzip it.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick `manifest.json`.
4. Reload any Twitch tab that was already open.

## Features

- **Watchlist**: add usernames, pick a highlight color, pause or remove people. Each person can have their own sound and a note.
- **Alerts**: 5 sounds, volume, cooldown per person, desktop notifications, and a flashing tab title when Twitch is in the background.
- **Profile card**: click any name (or @mention) in chat to see their recent messages, then watch them, jump to a message, or open Twitch's own card.
- **Jump to message**: click a message in the Activity tab, a profile card, or a desktop notification to scroll chat to it.
- **Firefox Sync**: your watchlist and settings follow you to other computers signed in to Firefox (with **Add-ons** sync turned on).
  Message counts and activity history stay on each computer.
- **Activity log** of everything your watchlist said, newest first.
- **Status tab** showing whether each open Twitch tab's chat is being read, plus a test button.
- Right-click any chat message, then pick **Watch this chat user**.
- Backup and restore your watchlist as a file.
- **Watch time**: how long you've watched each streamer, shown next to the viewer count and in Activity → Watch time.
  See [Watch time](#watch-time).
- **Nametag paints** (free): give your name a solid color, gradient, radial or animated rainbow, with glow, outline and weight.
  See [Nametag paints](#nametag-paints).

<img src="docs/popup.png" alt="Toolbar popup" width="300">

## Watch time

<img src="docs/watch-time.png" alt="Watch time view" width="280">

While a stream is playing on a streamer's channel page, the add-on counts the time and shows your total (⏱) next to the
live viewer count. Hover it for today's time. **Activity → Watch time** lists every streamer you've watched, with today, last 7 days,
all-time totals and a small 7-day chart. Click a streamer to open their channel.

- Only counts while the video is actually playing (paused, ads-only pages, the directory and VOD/clip pages don't count).
- Two tabs on the same stream count once. Turn on **Only count while the tab is visible** if you don't want background tabs counted.
- Everything stays on this computer: it's never synced or sent anywhere. Export, import or reset it in **Settings → Watch time**.

Stored format, for anyone building on it (in `browser.storage.local`):
`watch = { v: 1, channels: { login: { display, total, liveTotal, first, last, sessions, days: { "YYYY-MM-DD": seconds } } } }`
and `watchSessions = [ { c: login, s: startMs, e: endMs, live } ]` (last 5,000 sessions).

## Nametag paints

<img src="docs/paints.png" alt="Paints tab" width="280"> <img src="docs/paint-editor.png" alt="Paint editor" width="280">

Open the **Paints** tab. Pick a preset or press **New paint**, adjust colors and effects while watching the live preview,
then **Save & use**. Your name in chat changes right away, but only on your screen.

To let others see it, press **Publish**. A Twitch window asks you to confirm it's your account (no permissions are requested).
After that, anyone using Chat Watcher with **Show other people's paints** turned on sees your paint, usually within a few minutes.

| Who | What they see |
|---|---|
| You | Your active paint on your own name, published or not. |
| Other Chat Watcher users | Your paint, once you publish it and if they turned on "Show other people's paints". |
| People without Chat Watcher | Your normal Twitch color. Paints aren't part of Twitch. |
| 7TV users (without Chat Watcher) | Your normal color or their 7TV paint. 7TV only shows paints it hands out itself, so it can't show these. |

Viewers can hide any one person's paint from that person's profile card, turn off animation, or turn paints off entirely
(Settings → Nametag paints). Names that 7TV already painted are left alone unless you change that.

Sharing needs the paint server in `server/` to be deployed. See [server/README.md](server/README.md).
Until then, paints only show on your own screen.

## Privacy

The add-on reads chat on twitch.tv pages and keeps everything in your browser. Things leave your computer only in these cases:

- **Firefox Sync** (if you're signed in to Firefox with Add-ons sync on): your watchlist and settings. You can turn it off in Settings.
- **Publishing a paint**: your Twitch user ID, username and that one paint go to the paint server. Unpublish any time.
- **Show other people's paints** (off until you turn it on): the usernames you see in chat are sent to the paint server so it can look up their paints. Nothing else is sent: no messages, cookies or account info.

Chat messages, your activity history and your watch time are never sent anywhere.

## If nothing happens

1. Open the **Status** tab. If it says "No Twitch chat detected", reload the Twitch tab.
2. Make sure the top switch is on and the person's switch is on.
3. If **Only these channels** has anything in it, the channel you're on must be listed.
4. Messages in the first few seconds after opening a channel are treated as history and don't beep
   (Settings → "Ignore old messages for").
5. Turn on **Debug logging** and check the Twitch tab's console (F12) for `[Chat Watcher]` lines.

## Making a release (maintainers)

1. Bump `version` in `manifest.json` and add a section to `CHANGELOG.md`.
2. Commit and push to `main`. A new version number in `manifest.json` publishes a release automatically.
3. The **Release** GitHub Action builds the add-on, has Mozilla sign it, and publishes the `.xpi` plus `updates.json`
   (which powers auto-updates) to a GitHub release.

Signing needs two repository secrets, `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Get them from
[addons.mozilla.org → Developer Hub → Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/).
Without them, the release only gets an unsigned zip. After adding the secrets, use **Actions → Release → Run workflow** to attach the signed file to the current version.
Signing is "unlisted": Mozilla signs the file, but it isn't listed publicly on addons.mozilla.org.
