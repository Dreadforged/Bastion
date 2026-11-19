-- Index from invite code to server, so an invite link can find its Server
-- object. The Server object is the source of truth for uses and expiry.
CREATE TABLE invite_codes (
  code       TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL,
  expires_at INTEGER                        -- unix ms, NULL means never
);
CREATE INDEX invite_codes_expiry ON invite_codes (expires_at);
