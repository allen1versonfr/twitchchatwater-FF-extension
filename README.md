# Twitch Chat Watcher (Firefox)

Highlights a chat message and plays a sound when someone on your watchlist sends it.
Only their own messages count: if someone else @mentions or replies to them, nothing happens.

## Install

1. Unzip this folder somewhere you'll keep it.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose `manifest.json` in this folder.
4. Reload any Twitch tab that was already open.

Temporary add-ons are removed when Firefox closes. To keep it permanently, sign it for free at
addons.mozilla.org (Developer Hub → Submit a New Add-on → "On your own"), then open the signed `.xpi` in Firefox.

## Using it

- **People**: add usernames (comma separated), pick a color, pause someone with their switch.
  The ▾ button gives per-person sound, desktop-notification toggle, a note, their last message, and Remove.
- **Activity**: every message from your list, newest first. Click one to open that channel.
- **Settings**: sound type, volume, per-person cooldown, desktop notifications, tab-title flashing,
  highlight style and strength, which channels to run on, backup/import.
- **Status**: shows each open Twitch tab and whether chat is being read. Use **Test alert** to check sound.
- Right-click any chat message on Twitch → **Watch this chat user** to add its author.
- The ⤢ button opens everything in a full tab.

## If nothing happens

1. Open the **Status** tab. If it says "No Twitch chat detected", reload the Twitch tab.
2. Make sure the top switch is on and the person's switch is on.
3. If **Only these channels** has anything in it, the channel you're on must be listed.
4. Messages in the first few seconds after opening a channel are treated as history and don't beep
   (Settings → "Ignore old messages for").
5. Turn on **Debug logging** and check the Twitch tab's console (F12) for `[Chat Watcher]` lines.
