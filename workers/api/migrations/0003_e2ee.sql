-- End-to-end encryption: per-device MLS keys and the conversation index.
-- Conversation contents live in Conversation objects as ciphertext only.

-- Each device's MLS identity (Ed25519 signature) key, for safety codes.
CREATE TABLE device_identity_keys (
  device_id    TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL,              -- base64
  created_at   INTEGER NOT NULL
);
CREATE INDEX device_identity_keys_user ON device_identity_keys (user_id);

-- Single-use MLS key packages. Claiming one deletes it.
CREATE TABLE key_packages (
  id          TEXT PRIMARY KEY,            -- ULID, so the oldest is claimed first
  device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_package TEXT NOT NULL                -- base64 TLS-encoded KeyPackage
);
CREATE INDEX key_packages_device ON key_packages (device_id, id);
CREATE INDEX key_packages_user ON key_packages (user_id);

-- Which conversations a user is in, so clients can list them. The
-- Conversation object is the source of truth for membership.
CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL,           -- 16 random bytes, base64url
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, conversation_id)
);
CREATE INDEX conversation_members_conversation ON conversation_members (conversation_id);

-- At most one DM per pair of users. user_a sorts before user_b.
CREATE TABLE dm_pairs (
  user_a          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_b          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (user_a, user_b)
);

-- At most one encrypted conversation per channel.
CREATE TABLE channel_conversations (
  channel_id      TEXT PRIMARY KEY,
  server_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX channel_conversations_server ON channel_conversations (server_id);
