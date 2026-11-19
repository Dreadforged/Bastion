/**
 * Conversation object SQLite schema. One database per encrypted
 * conversation. Holds membership and an ordered log of MLS ciphertext; no
 * keys and no plaintext. Append new migrations; never edit a shipped one.
 */
export const CONVERSATION_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE conversation (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('dm', 'group', 'channel')),
    server_id  TEXT,
    channel_id TEXT,
    epoch      INTEGER NOT NULL,             -- MLS epoch the next commit must be made in
    audited_at INTEGER NOT NULL DEFAULT 0,   -- last channel access check
    created_at INTEGER NOT NULL
  );

  -- pending_removal: lost access, waiting for a member to commit their
  -- removal. They can read nothing after cutoff_seq.
  CREATE TABLE members (
    user_id         TEXT PRIMARY KEY,
    role            TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    pending_removal INTEGER NOT NULL DEFAULT 0,
    cutoff_seq      INTEGER,
    added_at        INTEGER NOT NULL
  );

  -- Devices (MLS leaves). A device reads from its welcome (joined_seq) up to
  -- the commit that removed it (left_seq).
  CREATE TABLE devices (
    device_id  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    joined_seq INTEGER NOT NULL,
    left_seq   INTEGER
  );
  CREATE INDEX devices_user ON devices (user_id);

  CREATE TABLE log (
    seq              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT NOT NULL CHECK (kind IN ('commit', 'message', 'welcome')),
    sender_id        TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    epoch            INTEGER NOT NULL,
    data             TEXT NOT NULL,          -- base64 MLS message
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE idempotency (
    user_id     TEXT NOT NULL,
    key         TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    reply       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  `,
  `
  -- A signed-out device: cut off at revoked_seq until a commit removes its leaf.
  ALTER TABLE devices ADD COLUMN revoked_seq INTEGER;
  `,
  `
  -- Calls in a direct message, newest last. Only the latest one can be live.
  -- room_id and the participant ids are random and are the only things LiveKit sees.
  CREATE TABLE calls (
    id                 TEXT PRIMARY KEY,
    room_id            TEXT NOT NULL,
    caller_id          TEXT NOT NULL,
    callee_id          TEXT NOT NULL,
    group_id           TEXT NOT NULL,        -- the call's MLS group conversation
    caller_participant TEXT NOT NULL,
    callee_participant TEXT NOT NULL,
    caller_share       INTEGER NOT NULL,
    callee_share       INTEGER NOT NULL DEFAULT 0,
    caller_plan        TEXT NOT NULL,
    callee_plan        TEXT,
    answered_device    TEXT,                 -- the callee device that picked up
    state              TEXT NOT NULL CHECK (state IN ('ringing', 'active', 'ended')),
    end_reason         TEXT,
    ring_expires_at    INTEGER NOT NULL,
    lease_until        INTEGER NOT NULL,
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX calls_created ON calls (created_at);
  CREATE UNIQUE INDEX calls_group ON calls (group_id);
  `,
];
