-- Safety groundwork. See docs/safety-and-compliance-plan.md.
-- No birth dates, no IP addresses, no message content in any table here.

-- Age band, country and account state live on the user. The band expires: the
-- person gave a birth month once, we kept only the band and the first day of
-- the month it stops being right.
ALTER TABLE users ADD COLUMN age_band       TEXT NOT NULL DEFAULT 'unknown' CHECK (age_band IN ('unknown', '13to15', '16to17', '18plus'));
ALTER TABLE users ADD COLUMN age_method     TEXT CHECK (age_method IN ('declared', 'estimated', 'verified', 'store_signal'));
ALTER TABLE users ADD COLUMN age_band_until INTEGER;           -- unix ms; NULL when unknown or 18plus
ALTER TABLE users ADD COLUMN age_checked_at INTEGER;
ALTER TABLE users ADD COLUMN country        TEXT;              -- ISO 3166-1 alpha-2, upper case
ALTER TABLE users ADD COLUMN account_state  TEXT NOT NULL DEFAULT 'active'
  CHECK (account_state IN ('active', 'restricted', 'pending_age_review', 'suspended', 'underage_removed'));
ALTER TABLE users ADD COLUMN state_reason   TEXT;              -- a reason code
ALTER TABLE users ADD COLUMN state_changed_at INTEGER;

-- Why an age might be wrong. Weights add up; at the threshold the account goes
-- to age review. Rows expire so an old report does not count forever.
CREATE TABLE age_signals (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  weight     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX age_signals_user ON age_signals (user_id, expires_at);

-- Which version of each document a person accepted, and when.
CREATE TABLE terms_acceptances (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  document    TEXT NOT NULL CHECK (document IN ('terms', 'privacy', 'aup')),
  version     TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, document, version)
);

-- Region flags. The most specific region wins; 'default' is the fallback.
CREATE TABLE safety_flags (
  module     TEXT NOT NULL,
  region     TEXT NOT NULL,
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  config     TEXT NOT NULL DEFAULT '{}',                       -- JSON, validated before it is written
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (module, region)
);

-- Append only history of every flag change.
CREATE TABLE safety_flag_log (
  id         TEXT PRIMARY KEY,
  module     TEXT NOT NULL,
  region     TEXT NOT NULL,
  enabled    INTEGER NOT NULL,
  config     TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX safety_flag_log_module ON safety_flag_log (module, region, changed_at);

-- A hold stops normal deletion and expiry of the subject until it is released.
CREATE TABLE legal_holds (
  id           TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('account', 'server', 'file', 'report')),
  subject_id   TEXT NOT NULL,
  reason_code  TEXT NOT NULL,
  reference    TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  released_at  INTEGER,
  released_by  TEXT
);
CREATE INDEX legal_holds_subject ON legal_holds (subject_type, subject_id) WHERE released_at IS NULL;

-- Every staff view of a report, evidence item or account, and every staff
-- action. Append only. Staff are people with admin access, not server moderators.
CREATE TABLE staff_access_log (
  id           TEXT PRIMARY KEY,
  staff_id     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('view', 'change')),
  action       TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  reason_code  TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX staff_access_log_subject ON staff_access_log (subject_type, subject_id, at);
CREATE INDEX staff_access_log_staff ON staff_access_log (staff_id, at);
