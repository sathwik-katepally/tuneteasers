-- Finished games from the game night hub (Film charades, Forehead), kept apart
-- from `results` so that a TuneTeasers client, however old, never reads one as
-- a show. One game is one row; saving it again replaces the row.
CREATE TABLE game_results (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  result_id TEXT NOT NULL,
  game TEXT NOT NULL,
  mode TEXT NOT NULL,
  finished_at INTEGER NOT NULL,
  cast_json TEXT NOT NULL,
  PRIMARY KEY (group_id, result_id)
) WITHOUT ROWID;
CREATE INDEX game_results_by_group ON game_results(group_id, finished_at);
CREATE INDEX game_results_age ON game_results(finished_at);
