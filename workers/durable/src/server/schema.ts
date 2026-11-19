/**
 * Server object SQLite schema. One database per community server.
 * No IP addresses or client metadata are stored here.
 * Append new migrations; never edit a shipped one.
 */
export const SERVER_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE server (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- The @everyone role has the server's id and position 0.
  CREATE TABLE roles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    permissions TEXT NOT NULL,              -- 64-bit set as a decimal string
    position    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE members (
    user_id   TEXT PRIMARY KEY,
    nick      TEXT,
    joined_at INTEGER NOT NULL
  );

  CREATE TABLE member_roles (
    user_id TEXT NOT NULL REFERENCES members (user_id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  );

  CREATE TABLE channels (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE channel_overrides (
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('role', 'member')),
    target_id  TEXT NOT NULL,
    allow      TEXT NOT NULL,
    deny       TEXT NOT NULL,
    PRIMARY KEY (channel_id, kind, target_id)
  );
  CREATE INDEX channel_overrides_target ON channel_overrides (kind, target_id);

  -- Content is end-to-end encrypted ciphertext. Deleting a message deletes the row.
  CREATE TABLE messages (
    id         TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    epoch      INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at  INTEGER
  );
  CREATE INDEX messages_channel ON messages (channel_id, id);

  CREATE TABLE invites (
    code       TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    max_uses   INTEGER NOT NULL,            -- 0 means unlimited
    uses       INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,                     -- unix ms, NULL means never
    created_at INTEGER NOT NULL
  );

  CREATE TABLE bans (
    user_id    TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  -- Status the user chose; 'offline' when no client is connected.
  CREATE TABLE presence (
    user_id    TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Stored replies for retried writes, kept for a day.
  CREATE TABLE idempotency (
    user_id     TEXT NOT NULL,
    key         TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status      INTEGER NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  CREATE INDEX idempotency_created ON idempotency (created_at);

  -- Events waiting to be handed to each recipient's UserSession. Written in
  -- the same transaction as the change, so nothing is lost if delivery fails.
  CREATE TABLE outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    channel_id  TEXT,                       -- recipient must still see this channel
    member_only INTEGER NOT NULL,           -- recipient must still be a member
    event       TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_at     INTEGER NOT NULL
  );
  CREATE INDEX outbox_user ON outbox (user_id, id);
  `,
  `
  -- Moderation.
  ALTER TABLE channels ADD COLUMN slow_mode_seconds INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bans ADD COLUMN reason TEXT;
  ALTER TABLE bans ADD COLUMN created_by TEXT;

  -- Kept apart from members so leaving and rejoining does not end a timeout.
  CREATE TABLE timeouts (
    user_id TEXT PRIMARY KEY,
    until   INTEGER NOT NULL                -- unix ms
  );

  -- When each member last posted in a slow mode channel.
  CREATE TABLE slow_mode (
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    last_at    INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );

  -- The reporter is kept to stop duplicate reports and is never shown to
  -- moderators. Closed reports are deleted after the retention period.
  CREATE TABLE reports (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    reporter_id TEXT NOT NULL,
    category    TEXT NOT NULL,
    note        TEXT,
    status      TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
    handled_by  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX reports_status ON reports (status, updated_at);

  -- Plaintext the reporter's device chose to forward. Only these messages.
  CREATE TABLE report_messages (
    report_id  TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (report_id, message_id)
  );
  CREATE INDEX report_messages_message ON report_messages (message_id);

  CREATE TABLE audit_log (
    id         TEXT PRIMARY KEY,
    actor_id   TEXT NOT NULL,
    action     TEXT NOT NULL,
    target_id  TEXT,
    channel_id TEXT,
    reason     TEXT,
    data       TEXT NOT NULL,                -- JSON object
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_log_created ON audit_log (created_at);

  -- Recipient must still hold these permissions (in channel_id when set).
  ALTER TABLE outbox ADD COLUMN permission TEXT;
  `,
  `
  -- Batched delivery. A row is not sent before ready_at, unless a later row
  -- for the same recipient goes out first. A newer row with the same
  -- coalesce_key replaces an unsent one (presence keeps only the latest).
  ALTER TABLE outbox ADD COLUMN ready_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE outbox ADD COLUMN coalesce_key TEXT;
  CREATE INDEX outbox_coalesce ON outbox (coalesce_key);
  CREATE INDEX outbox_ready ON outbox (ready_at);
  `,
  `
  -- Voice. Only who is in a call right now: a row is deleted the moment the
  -- person leaves, is removed or lets their lease run out. No history.
  -- Rooms get a random id so LiveKit never sees a channel name.
  CREATE TABLE voice_rooms (
    channel_id TEXT PRIMARY KEY REFERENCES channels (id) ON DELETE CASCADE,
    room_id    TEXT NOT NULL UNIQUE           -- 128 random bits as hex
  );

  CREATE TABLE voice_states (
    user_id        TEXT PRIMARY KEY,
    channel_id     TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    participant_id TEXT NOT NULL UNIQUE,      -- random LiveKit identity, new for every join
    self_mute      INTEGER NOT NULL DEFAULT 0,
    self_deaf      INTEGER NOT NULL DEFAULT 0,
    streaming      INTEGER NOT NULL DEFAULT 0,
    stream_blocked INTEGER NOT NULL DEFAULT 0, -- a moderator ended their stream; lasts until they leave
    can_publish    INTEGER NOT NULL,           -- what their last token allowed
    can_share      INTEGER NOT NULL,
    plan           TEXT NOT NULL,
    expires_at     INTEGER NOT NULL            -- unix ms; clients renew about every 30 seconds
  );
  CREATE INDEX voice_states_channel ON voice_states (channel_id);
  CREATE INDEX voice_states_expiry ON voice_states (expires_at);
  `,
  `
  -- Safety groundwork: age label on channels, fixed reason codes on audit entries,
  -- and a hold that keeps a report from being deleted by the retention sweep.
  ALTER TABLE channels ADD COLUMN age_restricted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE audit_log ADD COLUMN reason_code TEXT;
  ALTER TABLE reports ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Users the platform has limited by age. They cannot see age restricted channels.
  CREATE TABLE member_age_limits (user_id TEXT PRIMARY KEY);
  `,
];
