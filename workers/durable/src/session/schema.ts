/**
 * UserSession SQLite schema. One database per user.
 * Append new migrations; never edit a shipped one.
 */
export const SESSION_MIGRATIONS: readonly string[] = [
  `
  -- Every event this user was sent, numbered, kept for resume.
  CREATE TABLE events (
    seq      INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,         -- set by the Server object; repeats are dropped
    t        TEXT NOT NULL,
    d        TEXT NOT NULL,
    at       INTEGER NOT NULL
  );
  CREATE INDEX events_at ON events (at);

  -- Servers this user belongs to, kept up to date by SERVER_CREATE and SERVER_DELETE.
  CREATE TABLE servers (
    server_id TEXT PRIMARY KEY,
    joined_at INTEGER NOT NULL
  );

  -- Retried server creation returns the server made the first time.
  CREATE TABLE created_servers (
    key        TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];
