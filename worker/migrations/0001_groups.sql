-- Group sync: shared song cooldown and finished-show results for phones that
-- share an invite. No audio, stream URLs or accounts: song keys, timestamps,
-- display names and scores only.

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  member_hash TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active_at INTEGER NOT NULL
);
CREATE INDEX groups_active ON groups(active_at);

CREATE TABLE played (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  song_key TEXT NOT NULL,
  last_played_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, song_key)
) WITHOUT ROWID;
CREATE INDEX played_age ON played(last_played_at);

CREATE TABLE round_events (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  song_key TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, event_id)
) WITHOUT ROWID;
CREATE INDEX round_events_age ON round_events(played_at);

CREATE TABLE results (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  result_id TEXT NOT NULL,
  finished_at INTEGER NOT NULL,
  mode TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  mix TEXT NOT NULL,
  rounds INTEGER NOT NULL,
  songs INTEGER NOT NULL,
  cast_json TEXT NOT NULL,
  PRIMARY KEY (group_id, result_id)
) WITHOUT ROWID;
CREATE INDEX results_by_group ON results(group_id, finished_at);
CREATE INDEX results_age ON results(finished_at);
