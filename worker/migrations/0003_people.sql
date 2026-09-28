-- Personal tickets: an anonymous per-person profile (name + hashed key) whose
-- song history and preferences follow the person across phones, groups and
-- buzz-in rooms. Song keys, timestamps, a display name, blocked artists and
-- default filters only; never audio, stream URLs, room codes or scores.

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  active_at INTEGER NOT NULL
);
CREATE INDEX people_active ON people(active_at);

-- WebAuthn credentials for recovering a ticket on a new device.
CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX passkeys_person ON passkeys(person_id);

-- One-shot WebAuthn challenges, gone after a few minutes.
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  person_id TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges(expires_at);

CREATE TABLE group_people (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, person_id)
) WITHOUT ROWID;
CREATE INDEX group_people_person ON group_people(person_id);

CREATE TABLE person_played (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  song_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'played',
  last_played_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, song_key, kind)
) WITHOUT ROWID;
CREATE INDEX person_played_age ON person_played(last_played_at);

CREATE TABLE person_events (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  song_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'played',
  played_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, event_id)
) WITHOUT ROWID;
CREATE INDEX person_events_age ON person_events(played_at);
