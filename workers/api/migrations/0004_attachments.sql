-- File attachments. Bytes live in R2; this table says who may use them.
-- No IP addresses, file names or user agents are stored. Message content is
-- end-to-end encrypted, so a message refers to a file from inside its
-- ciphertext and the server keeps no link between the two.

CREATE TABLE attachments (
  id              TEXT PRIMARY KEY,         -- ULID; the R2 key is files/<id> (pending/<id> until complete)
  uploader_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  server_id       TEXT,                     -- set for files in a server channel
  channel_id      TEXT,
  conversation_id TEXT,                     -- set for files in an encrypted conversation (DMs, groups)
  visibility      TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'blocked')),
  size            INTEGER NOT NULL,         -- declared size while pending, stored size once ready
  content_type    TEXT NOT NULL,            -- declared while pending, detected once ready; octet-stream if private
  sha256          TEXT,                     -- of the stored bytes, public files only
  created_at      INTEGER NOT NULL,         -- unix ms
  completed_at    INTEGER,
  expires_at      INTEGER NOT NULL,         -- a pending upload is cleaned up after this
  CHECK ((channel_id IS NOT NULL AND server_id IS NOT NULL AND conversation_id IS NULL)
      OR (channel_id IS NULL AND server_id IS NULL AND conversation_id IS NOT NULL))
);
CREATE INDEX attachments_uploader ON attachments (uploader_id, status);
CREATE INDEX attachments_pending ON attachments (status, expires_at);
CREATE INDEX attachments_channel ON attachments (channel_id);
CREATE INDEX attachments_conversation ON attachments (conversation_id);
