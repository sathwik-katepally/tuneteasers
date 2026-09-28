-- Songs skipped as "heard it too much" sit out longer than played ones, so
-- the group keeps them apart. Additive only: `played` is untouched, so a
-- Worker from before this migration (mid-deploy, or after a rollback) keeps
-- writing plays; an event without a kind is a play.

ALTER TABLE round_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'played';

CREATE TABLE tired (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  song_key TEXT NOT NULL,
  last_tired_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, song_key)
) WITHOUT ROWID;
CREATE INDEX tired_age ON tired(last_tired_at);
