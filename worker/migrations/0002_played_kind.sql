-- A song skipped as "heard it too much" (kind 'tired') sits out longer than
-- one played through ('played'), so the group keeps one row per song and kind.
-- SQLite cannot change a primary key in place: rebuild played, keeping every row as 'played'.

ALTER TABLE round_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'played';

CREATE TABLE played_by_kind (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  song_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'played',
  last_played_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, song_key, kind)
) WITHOUT ROWID;
INSERT INTO played_by_kind (group_id, song_key, kind, last_played_at)
  SELECT group_id, song_key, 'played', last_played_at FROM played;
DROP TABLE played;
ALTER TABLE played_by_kind RENAME TO played;
CREATE INDEX played_age ON played(last_played_at);
