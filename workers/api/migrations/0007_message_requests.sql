-- Message requests and teen DM defaults.
--
-- A DM between people who share no server can start as a request that the
-- recipient accepts or declines. The server never sees message content; it
-- only limits how much the requester can send before the recipient accepts.
-- A declined pair cannot be started again.

ALTER TABLE dm_pairs ADD COLUMN status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'request', 'declined'));
ALTER TABLE dm_pairs ADD COLUMN requested_by  TEXT;                          -- the person who started a request
ALTER TABLE dm_pairs ADD COLUMN request_sends INTEGER NOT NULL DEFAULT 0;    -- messages sent while still a request

-- A new dm_policy value ('requests'). SQLite cannot change a CHECK, so the table is rebuilt.
CREATE TABLE privacy_settings_new (
  user_id           TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  dm_policy         TEXT NOT NULL DEFAULT 'everyone' CHECK (dm_policy IN ('everyone', 'requests', 'nobody')),
  typing_indicators INTEGER NOT NULL DEFAULT 1 CHECK (typing_indicators IN (0, 1)),
  updated_at        INTEGER NOT NULL
);
INSERT INTO privacy_settings_new (user_id, dm_policy, typing_indicators, updated_at)
  SELECT user_id, dm_policy, typing_indicators, updated_at FROM privacy_settings;
DROP TABLE privacy_settings;
ALTER TABLE privacy_settings_new RENAME TO privacy_settings;
