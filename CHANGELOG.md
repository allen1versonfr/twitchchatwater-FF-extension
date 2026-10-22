# Changelog

## 3.2.1

- Fix: the stream delay didn't show. It's now also shown in the player's control bar (next to 🎚), so it appears even when
  Twitch's viewer count isn't found, and the delay is read from Twitch's player more reliably (with Twitch's own Video Stats
  and the buffer size as fallbacks).

## 3.2.0

- **BTTV and FFZ emotes** in chat, the emote menu, `:` suggestions and Tab completion, next to 7TV's
  (channel emotes win over global ones on a name clash: 7TV, then BTTV, then FFZ).
- **7TV personal emotes**: 7TV subscribers' personal emotes show on their messages.
- **Live emote updates**: added, removed and renamed 7TV and BTTV emotes change right away (FFZ within 10 minutes),
  with a line in chat saying what changed. Removed emotes turn back into text.
- Each provider can be switched on or off without reloading.

## 3.1.0

- **Stream delay** (⏳) next to the viewer count and watch time, colored by how far behind live you are. Click it to catch up.
- **Audio compressor** with light / medium (like 7TV's) / strong presets, makeup gain, a limiter against clipping and a live meter.
- **Volume boost** up to 400% and **mono**, from a new 🎚 button in the player or the Chat tab.
- **Better volume control**: scroll over the video (Shift for fine steps), middle-click to mute, on-screen volume, and each channel
  remembers its own volume.
- **No reloads needed**: Twitch tabs that were already open start working right after installing, updating or re-enabling
  the add-on (Status → Connect open tabs does it by hand), and turning 7TV emotes off takes them out of chat immediately.

## 3.0.0

- **7TV emotes** in chat (channel + global, zero-width emotes stack), with a big preview on hover. No 7TV extension needed.
- **Emote menu** (☺ next to the chat box): favorites, recently used, your most used, popular in this chat, 7TV, with search.
  Right-click any emote to favorite it. Your emote usage is counted on this computer and shown in the Chat tab.
- **`:` emote suggestions** and a **Tab completion carousel** while typing.
- **Join in on emote spam**: a button that sends the emote chat is spamming (only when you click it).
- **Message history**: ↑/↓ in an empty chat box.
- **Highlight words** (with color, sound, title flashing, optional notification; shown in Activity) and **highlight by badge**.
- **Filters** for words and people, **timestamps**, text size, alternating backgrounds, separators,
  **message details** on hover + Shift, and **hide shared chat**.
- **Deleted-message and deleted-link recovery**: see what a deleted or timed-out message said (links stay clickable),
  crossed out or hidden if you prefer.
- **Moderation**: ban/timeout lines in chat, a 🛡 moderation panel, Activity → Mod log, first-time / returning /
  timed-out-before marks, a copy of chat when it's cleared, and for moderators: hover purge/timeout/ban buttons and bulk removal
  (sent as Twitch's own chat commands). With "Twitch's mod tools first", moderators get Twitch's own card on name clicks.
- **Auto-claim** the channel-points bonus, Moments and Drops (plus an optional background Drops check every 30 minutes).
- The add-on now keeps a logged-out, read-only connection to Twitch chat for the channels you have open (can be turned off).
- Removed the active chatters counter next to the viewer count.

## 2.5.0

- **Active chatters** next to the viewer count (💬): how many different people chatted in the last 10 minutes
  (or 5 / 30 / 60 minutes, or since you opened the channel). Hover for both numbers. Twitch doesn't show who's
  connected to chat, so this counts people who actually sent a message in the chat your tab shows.
- Fix: dropdown settings that hold numbers (Activity history size, chatter window) were saved incorrectly;
  changing Activity history could clear the Activity log.

## 2.4.0

- **Mention & reply alerts**: a sound (Chime by default, your choice) when someone @mentions you or replies to you in chat,
  plus an optional desktop notification. They show in Activity with an "@ you" / "replied to you" tag and can be filtered.
- Your Twitch username is detected automatically from twitch.tv (or type it in Settings → Mentions & replies to you).
- Doesn't fire for your own messages, chat history, look-alike names (@alison ≠ @ali), or replies to other people;
  a burst of pings plays one sound.

## 2.3.0

- **Watch time**: tracks how long you watch each streamer (only while their stream is actually playing on their channel page)
  and shows it next to the live viewer count. Activity → Watch time lists every streamer with today / 7 days / all-time
  totals and a 7-day chart. The profile card shows your watch time on that streamer.
- Stored only on this computer (never synced or sent anywhere), with daily totals and viewing sessions kept for future features.
  Export, import (merges without double-counting) and reset in Settings → Watch time.
- Several tabs on the same stream count once; a sleeping computer doesn't add time; optional "only while the tab is visible".
- Paint and watch-time import/export open in the full page, because Firefox closes the toolbar popup for file pickers.

## 2.2.0

- **Nametag paints**: free custom name styles — solid colors, multi-stop and radial gradients, static or animated rainbows,
  glow/shadow, outline and weight — with a live Twitch-style preview, 12 presets, favorites, import/export.
- **Share paints**: publish your paint (verified with Twitch sign-in) so other Chat Watcher users see it. Needs the paint
  server in `server/` to be deployed. Viewers opt in to seeing others' paints.
- Hide any one person's paint from their profile card; turn animation or paints off; reduced-motion respected;
  7TV-painted names left alone by default.
- Profile card now uses the extension's own stylesheet, so it renders even on pages with strict style policies.

## 2.1.1

- Security hardening: the add-on now asks only for access to twitch.tv instead of all browser tabs.
- Badge images shown in the profile card are copied without any page attributes.
- Release workflow: Mozilla signing keys are only visible to the signing step, actions are pinned to exact versions.

## 2.1.0

- **Profile card**: click a name or @mention in chat to see that person's recent messages, watch or unwatch them, change their color, or open Twitch's own card. Configurable in Settings (click, Ctrl+click, or off).
- **Jump to message**: Activity entries, profile-card messages and desktop notifications scroll chat to the exact message and flash it.
- **Firefox Sync**: the watchlist and settings sync across computers signed in to Firefox. Message counts and activity stay local.
- Installable signed releases with automatic updates.
- Requires Firefox 140 or newer.

## 2.0.0

- Popup and settings page with People, Activity, Settings and Status tabs.
- Per-person colors, sounds, notes and pause switch; message counts and last-seen.
- Sound choices, volume, cooldown, desktop notifications, tab-title flashing.
- Highlight styles, channel filter, backlog skipping, backup import/export.
- Right-click "Watch this chat user".
- Sturdier chat detection (live, VOD, 7TV, FrankerFaceZ) that ignores mentions and replies.
