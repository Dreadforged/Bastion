-- One row per user, created the first time they change a setting. No row means the defaults.
CREATE TABLE privacy_settings (
  user_id           TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  dm_policy         TEXT NOT NULL DEFAULT 'everyone' CHECK (dm_policy IN ('everyone', 'nobody')),
  typing_indicators INTEGER NOT NULL DEFAULT 1 CHECK (typing_indicators IN (0, 1)),
  updated_at        INTEGER NOT NULL
);
