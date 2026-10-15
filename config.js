/* Build-time defaults for paint sharing. Both values are public (no secrets belong in this file).
 * Leave them empty to ship without sharing: paints then only show on your own screen.
 * Users can override both in Settings → Nametag paints → Advanced. */
var TCW_CONFIG = {
  // Base URL of the deployed paint server, e.g. "https://tcw-paints.example.workers.dev"
  paintServer: "",
  // Client ID of the Twitch app used for "Sign in with Twitch" (dev.twitch.tv/console)
  twitchClientId: ""
};
