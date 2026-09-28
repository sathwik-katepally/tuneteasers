# Song loading

`buildCrate(mix, eras, sound, difficulty, minSongs, played, categories)` in `src/lib/crate.js` assembles the game queue; it returns `{ queue, source }` or `{ error: "load" | "thin" | "safe" }`.
`difficulty` is `"easy" | "medium" | "hard" | "mixed"` (default `"mixed"`, also `settings.difficulty`).
It maps to corpus tiers through `DIFFICULTY_TIERS` in `src/lib/constants.js` (easy → easy; medium → easy + medium; hard → medium + hard; mixed → all); when the mapped tiers hold fewer than 10 songs for the chosen languages and eras the crate widens to all tiers before reporting `thin`.
The uncurated fallback tiers carry no tier and ignore it.
`categories` is a list of corpus tags (`dance`, `romantic`, `sad`, `item`, `mass`; `[]` means every song): a corpus song passes when it carries any of them, and the difficulty widening above happens inside that set.
The fallback tiers carry no tags, so with categories set they never run: an unreachable corpus returns `load` and too few tagged songs return `thin` (or `safe` in Music-only).
`categoryCounts` in the same file counts each category's songs the way the corpus tier picks them, for the setup screen's chips.

## Source tiers

1. **Curated corpus** (`loadFromCorpus`) - `public/corpus.json`, the verified film-song pool built offline by `scripts/build-corpus.mjs` (below).
   The crate filters it by language, era, difficulty tier and the device blocklist, orders fresh songs before recently played ones, draws `CORPUS_DRAW` candidates and resolves them to streams with one batch request per `CORPUS_BATCH` ids (`GET /songs?ids=`, served by our Worker and by any saavn.dev-compatible mirror in `SAAVN_BASES`).
   Tracks carry `album` = film, `year` = the film's verified year and `tier`.
   If the corpus file is missing or the ids cannot be resolved (worker and mirror down), the tiers below take over; if the corpus loads but fewer than 10 songs match the filters, the crate returns `{ error: "thin" }` rather than playing unverified songs.
2. **Saavn search** (`loadFromSaavn`) - JioSaavn search APIs listed in `SAAVN_BASES`; full songs, so snippets start at the intro.
   The first base is our own Cloudflare Worker (`worker/`, see docs/testing-and-deploy.md); the public nandanvarma mirror follows as a fallback.
   The first responding base is remembered for the session and tried first, but the others are still tried if it later fails.
   Search jobs are (query, page) pairs from `SAAVN_QUERIES` x `SAAVN_PAGES` in `src/lib/constants.js` (~120 queries: singers, composers, stars, years, moods; ~3,000 unique songs after filters).
   Each game samples 7 random jobs per language, so consecutive games draw from different slices of the corpus.
   Years here are whatever Saavn reports for the copy it returned (compilation copies carry re-release years), which is why this tier is only a fallback.
3. **Baked catalog** (`loadCatalog`) - `public/catalog.json`, ~700 iTunes tracks committed to the repo and served same-origin, so it cannot be rate-limited or CORS-blocked; refreshed weekly by CI because iTunes preview URLs rot.
4. **Live iTunes search** (`loadFromItunes`) - last resort; deliberately throttled to few search terms because Apple rate-limits around 20 searches/min per IP (that rate limit caused the original "Couldn't load enough songs" production bug).

Each tier only runs if the pool still has fewer than 10 songs.
The snips scorer (`scripts/build-snips.mjs`) scores corpus recordings by Saavn ID.
Music-only draws only source IDs present in the current verified index; other tiers can contribute only if their exact ID has a valid index entry.
Dedupe is by canonical title key (`songKey(title)` in `src/lib/utils.js`, which strips bracketed qualifiers, dash suffixes like `- From "Movie"`, and punctuation): each tier dedupes internally, later tiers are filtered against earlier ones, and the assembled pool gets a final dedupe pass (first occurrence wins, so full Saavn songs beat hook clips).
Tracks from tiers 2 and 3 are 30-second mid-song "hook" clips and carry `hook: true`.

## The corpus (`public/corpus.json`)

Built by `node scripts/build-corpus.mjs` (weekly in CI, see docs/testing-and-deploy.md) from `scripts/corpus.config.json`, which holds everything that changes: playlist search queries, the editorial owner uid, Wikidata language ids, the year floor and tolerance, the play-count floor, score weights and tier cut-offs.
The rule is film songs only, with the film's real release year:

1. **Seed** - JioSaavn's own editorial playlists (owner uid `phulki_user`, e.g. "Hindi 2000s", "Chartbusters 2019 - Telugu") found through the configured playlist searches, plus the per-language charts.
   Only songs whose Saavn `language` is hindi or telugu are kept; titles matching `EXCLUDE_RX` (remixes, lofi, unplugged, ...) are dropped.
2. **Film match** - the album name is cleaned ("(Original Motion Picture Soundtrack)", language markers such as "- Telugu", `From "X"` clauses, brackets) and looked up in a Wikidata index of films by original language (labels and aliases, min publication year).
   A film of the song's language released within ±1 year of the copy's year verifies the song; the corpus stores Wikidata's canonical film label and year.
3. **Canonical copy** - when the album is a compilation ("Best Of Arijit Singh"), the script searches the title and treats copies with the same language and a play count within 1% as the same recording (Saavn shares one counter across copies), then applies step 2 to each copy, oldest year first, and keeps the original album's song id.
   A compilation copy without a matching original album copy is rejected.
   If only the name matches (a re-upload with a later year), Wikidata's year is taken anyway, which is what drops re-released pre-2000 songs.
4. **Unverified fallback** - songs Saavn tags with a `starring` role whose film-like album has no dub marker and no same-named Wikidata film of another language within ±1 year are kept with `yearVerified: false` and the earliest year among the copies.
   Everything else is rejected: singles, devotional and indie releases, dubs of Tamil/Kannada/Malayalam films, remixes, pre-2000 songs, and songs under the play-count floor.
5. **Difficulty** - within each language x decade (raw counts are not comparable: Hindi 2010s median ≈ 19M plays vs 2000s ≈ 6M) the score blends the play-count percentile (weight 0.8) with the editorial-playlist membership percentile (0.2).
   The top 30% by score is `easy`, the next 40% `medium`, the rest `hard` (cut-offs in the config, baked into the file's `tiers`).

6. **Categories** - see below.

The file is compact: `{ v, built, tiers, cols, songs: [[...], ...] }`, one row per song with columns `id, title, film, year, yearVerified, language, singers, composers, lyricists, starring, albumId, plays, score, tier, tags`; the client expands rows by `cols` and carries composers as `music` for the reveal.
Songs are deduped by language + `songKey(title)` (highest play count wins); snips are keyed separately by Saavn ID so similarly titled recordings cannot share an interval.
The script refuses to write a corpus with fewer than `minSongsPerLanguage` songs in either language.

## Song categories (`tags`)

Each song's `tags` column lists the categories it belongs to, set at build time from the `categories` block of `scripts/corpus.config.json` (queries, title regexes, thresholds) with no AI and no human step, so the weekly refresh keeps them current on its own.
Where a source is too noisy to trust, the rule drops the tag rather than guessing.

- **Moods and mass** (`dance`, `romantic`, `sad`, `mass`) come from JioSaavn's editorial theme playlists (owner `playlistOwner`), found with each category's `queries` and kept when the title matches its `titleRx` and not `playlistExcludeRx` (lofi, remixes, retro decades, ...).
  Playlist songs map to corpus songs by id or by language + `songKey(title)`.
  A song gets the tag when it is on one strong list or on `minLists` (2) lists of any kind.
  Weak lists are titles matching `weakTitleRx` (folk and city "beats" lists for `mass`) and artist lists ("Arijit Singh - Sad Songs", "Best Of Romance - Arijit Singh"): a list whose title contains the name of anyone credited on `artistListMinSongs` corpus songs picks songs by who is on them, not by mood.
  `unless` then removes overlaps: `dance` drops songs also tagged `sad`, and `romantic` drops `dance` and `sad`.
  Occasion lists (wedding, Holi, rain) were measured and left out: they hold what gets played at a wedding, not songs about one.
- **Item songs** (`item`) come from the film's English Wikipedia article (found by the usual "Film (2012 film)" title patterns, accepted only with a film infobox naming the film's year): a cast-list bullet line that names the song and matches `wikipediaRx` ("item number", "bar dancer", "special song", ...).
  Prose sentences are ignored because they often name two songs of which only one is the item number.
- **Overrides** - `scripts/category-overrides.json` is a fixed list of corrections applied last (`add` / `remove` per song, matched by id or by language + title).
  It was seeded once from the owner-decided item-song list (the Wikipedia set plus songs Wikipedia does not phrase as item numbers, minus "Besharam", where a choreographer is credited "as a dancer").
  It is not a review queue: nothing in the build proposes additions to it.

The build prints a per-language count table and refuses to write the corpus when a category has fewer than its `minTagged` songs, so a broken playlist search or Wikipedia outage leaves the last good corpus in place.
Hook step, wedding, festival, sufi, patriotic and rain were measured and left out of v1 (too few songs or no trustworthy source).

## Filters applied to every track

- https-only stream URL, via `sanitizeTrack`.
- Language must match the requested mix (Saavn `language` field, iTunes genre via `ITUNES_LANG_OK`).
- Year ≥ 2000, plus the user's era selection (`settings.eras`, decade buckets from `eraOf`); for corpus songs the year is the film's verified year.
- `EXCLUDE_RX` drops remixes, covers, lofi, karaoke, instrumentals, background-score themes/OST/teasers, etc.
- Saavn-search songs with a reported play count below `SAAVN_MIN_PLAYS` (1M) are dropped (mostly dubs and obscure album cuts); a missing count means unknown and is kept. The corpus applies its own floor (`minPlays` in the config) at build time.
- Blocked artists are removed: a track is out if ANY of its comma-separated artists matches the device blocklist (`tt_blocked` in localStorage, managed in the reveal screen and setup screen).

If filters shrink the pool below 10 the crate returns `{ error: "thin" }` and the UI tells the user to widen filters, distinct from the connection error.

## Snips annotation and Music-only eligibility

Setup and crate builds share a valid `./snips.json` index for five minutes, while a resumed game fetches a fresh copy (no-cache).
A pooled track gets an interval only when its Saavn ID matches both the index key and entry, the interval is exactly `SNIP_WINDOW_SEC` (12) seconds inside the track, and its maximum patch voice score is below `SNIP_CLEAN_MAX` (see docs/audio.md for the contract).
The crate log entry records `snips: "ok"|"none"` and `snipped: <count>`.
In Music-only mode (`sound === "inst"`), the queue contains only annotated tracks and must cover the requested rounds and cast size.
If fewer safe songs survive, the crate returns `safe` and setup explains the shortage.
On resume, the remaining queue is checked against the current index again; stale entries are removed, and an inadequate queue cannot resume.

## Played-song cooldown (per device, or per group)

`tt_played` in localStorage maps normalized title → last-played timestamp; entries older than 30 days are pruned.
In a group, `startGame` passes `buildCrate` the group's map merged with `tt_played` (latest wins), so songs any phone in the group played recently sit out too; see docs/group-sync.md.
Songs played within the last 7 days (`PLAY_COOLDOWN`) are excluded from the crate when at least 15 fresh songs remain.
When fresh songs run low, recently played songs are appended AFTER all fresh ones, ordered least-recently-played first, so repeats only appear when unavoidable.
Old installs stored `tt_played` as a plain array; `loadPlayed` migrates that format transparently.
