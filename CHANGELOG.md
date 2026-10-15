# Changelog

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
