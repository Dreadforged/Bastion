-- Accounts: users, their passkey devices, and sessions.
-- No IP addresses or user agents are stored anywhere in this schema.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- ULID
  email         TEXT NOT NULL UNIQUE,       -- lowercased by the shared zod schema
  recovery_hash TEXT,                       -- argon2id of the one-time recovery code; NULL once used
  created_at    INTEGER NOT NULL            -- unix ms
);

-- One row per registered passkey. A "device" is a passkey the user can sign in with.
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,       -- base64url
  public_key    TEXT NOT NULL,              -- base64url COSE key
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                       -- JSON array
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE INDEX devices_user ON devices (user_id);

-- Tokens are only stored as SHA-256 hashes.
CREATE TABLE sessions (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id             TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  access_hash           TEXT NOT NULL UNIQUE,
  access_expires_at     INTEGER NOT NULL,
  refresh_hash          TEXT NOT NULL UNIQUE,
  previous_refresh_hash TEXT,               -- lets us detect reuse of a rotated refresh token
  refresh_expires_at    INTEGER NOT NULL,
  created_at            INTEGER NOT NULL
);
CREATE INDEX sessions_device ON sessions (device_id);
CREATE INDEX sessions_previous_refresh ON sessions (previous_refresh_hash);

-- Short-lived permission to register a passkey: a sign-up link, an add-device
-- link, an add-device request waiting for approval, or a redeemed recovery code.
CREATE TABLE enrollments (
  token_hash  TEXT PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,         -- public id, used to approve a device request
  purpose     TEXT NOT NULL CHECK (purpose IN ('signup', 'add_device', 'recovery')),
  email       TEXT NOT NULL,
  user_id     TEXT NOT NULL,                -- for signup, the id the new user will get
  approved    INTEGER NOT NULL,             -- 0 while a device request waits for approval
  device_name TEXT,
  code        TEXT,                         -- short code shown on both devices during approval
  challenge   TEXT,                         -- current WebAuthn registration challenge
  expires_at  INTEGER NOT NULL
);
CREATE INDEX enrollments_user ON enrollments (user_id);

-- WebAuthn sign-in challenges.
CREATE TABLE challenges (
  id         TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Per-account fixed-window counters. Keys are hashed so raw emails are never
-- kept here. Per-IP limits use the Workers rate limit binding and never touch D1.
CREATE TABLE rate_limits (
  key        TEXT PRIMARY KEY,
  window_end INTEGER NOT NULL,
  count      INTEGER NOT NULL
);
