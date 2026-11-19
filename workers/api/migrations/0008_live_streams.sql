-- Who is streaming right now, so one account has at most one live stream
-- across all servers. A lease, not a history: a row lives only while the
-- person's client keeps renewing it (every voice heartbeat), is deleted when
-- they stop, and lapses by itself if the client vanishes.
CREATE TABLE live_streams (
  user_id    TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL  -- unix ms
);
