-- One row per Twitch account that published a paint.
CREATE TABLE IF NOT EXISTS paints (
  user_id TEXT PRIMARY KEY,          -- numeric Twitch user ID (never changes)
  login   TEXT NOT NULL UNIQUE,      -- current Twitch login, lowercase (kept fresh by the daily re-check)
  paint   TEXT NOT NULL,             -- sanitized paint JSON
  updated INTEGER NOT NULL,          -- last publish, ms since epoch
  checked INTEGER NOT NULL           -- last time the login was confirmed with Twitch
);
CREATE INDEX IF NOT EXISTS paints_checked ON paints (checked);
