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

<img src="docs/popup.png" alt="Toolbar popup" width="300">

## If nothing happens

1. Open the **Status** tab. If it says "No Twitch chat detected", reload the Twitch tab.
2. Make sure the top switch is on and the person's switch is on.
3. If **Only these channels** has anything in it, the channel you're on must be listed.
4. Messages in the first few seconds after opening a channel are treated as history and don't beep
   (Settings → "Ignore old messages for").
5. Turn on **Debug logging** and check the Twitch tab's console (F12) for `[Chat Watcher]` lines.

## Making a release (maintainers)

1. Bump `version` in `manifest.json` and add a section to `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v2.1.0 && git push origin v2.1.0`.
3. The **Release** GitHub Action builds the add-on, has Mozilla sign it, and publishes the `.xpi` plus `updates.json`
   (which powers auto-updates) to a GitHub release.

Signing needs two repository secrets, `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Get them from
[addons.mozilla.org → Developer Hub → Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/).
Without them, the release only gets an unsigned zip. After adding the secrets, use **Actions → Release → Run workflow** with the tag to attach the signed file.
Signing is "unlisted": Mozilla signs the file, but it isn't listed publicly on addons.mozilla.org.
