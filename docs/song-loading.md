# Song loading

`buildCrate({ langs, eras, sound, songs, minSongs, need, cooldown, categories, heardBy })` in `src/lib/crate.ts` assembles the game queue; it returns `{ queue, source }` or `{ error: "load" | "thin" | "safe", lang? }`.
`langs` are ids from `src/lib/languages.ts`, which are JioSaavn's language names (`hindi`, `telugu`, `tamil`, `english`).
The sound (`settings.difficulty`, `"easy" | "medium"`) picks only `sound`: both draw the same songs.
`songs` picks the songs: with `"hits"` (Big hits) the corpus tier keeps the popular songs, those whose `score` (the popularity percentile within the song's language and decade) is at least the language's `popularCut` (`src/lib/config.ts`: 0.5, so the top half, and 0.75 for English, whose long tail on JioSaavn is songs Indian listeners do not know); when they hold fewer than `minSongs` songs for the chosen languages, eras and categories the crate widens to every song before reporting `thin` (not in Music-only, where the shortage shows as `safe`).
With `"more"` (Less famous too) there is no cut.
`minSongs` is the caller's rounds times contestants (the code default is 10).
`need` is, per language, how many songs the contestants who chose it need (pass the phone: rounds times those contestants); a language that cannot bring them widens alone, and if it still cannot the crate returns `thin` (or `safe`) with that `lang`, which setup turns into "Not enough English songs for Erik".
The chosen languages split the queue evenly: the corpus tier draws each language's candidates separately, and the final queue takes turns between the languages' weighted shuffles (`interleave`).
The uncurated fallback tiers carry no score and ignore the cut.
`categories` is a list of corpus tags (`dance`, `romantic`, `sad`, `mass`, `item`, `hiphop`; `[]` means every song): a corpus song passes when it carries any of them, and the widening above happens inside that set.
The fallback tiers carry no tags, so with categories set they never run: an unreachable corpus returns `load` and too few tagged songs return `thin` (or `safe` in Music-only).
`setupCounts` in the same file counts, the way the corpus tier picks them, each category's songs and each popularity level's songs for the setup screen, and lists the categories the chosen languages have at all (the others are hidden).

## Source tiers

1. **Curated corpus** (`loadFromCorpus`) - `public/corpus.json`, the verified film-song pool built offline by `scripts/build-corpus.mjs` (below).
   The crate filters it by language, era, the popularity cut and the device blocklist, orders fresh songs before ones still cooling down, draws `CORPUS_DRAW` candidates and resolves them to streams with one batch request per `CORPUS_BATCH` ids (`GET /songs?ids=`, served by our Worker and by any saavn.dev-compatible mirror in `SAAVN_BASES`).
   The draw is weighted by popularity (`DRAW_WEIGHT` in `src/lib/config.ts`, per popularity level): a song's chance is proportional to `(score + floor) ^ power`, with `score` its percentile within its language and decade, so with Big hits the hits of a tier come up several times as often as its long tail without ever leaving it out; Less famous too uses power 0, a plain shuffle, so a regular's show is not mostly hits they already know. The final queue order is drawn the same way (`weightedShuffle`), and songs without a score (the fallback tiers) draw as if they sat in the middle.
   Tracks carry `album` = film (an English song's album), `year` = the film's verified year (an English song's first release) and `score`.
   If the corpus file is missing or the ids cannot be resolved (worker and mirror down), the tiers below take over; if the corpus loads but fewer than `minSongs` songs match the filters, the crate returns `{ error: "thin" }` rather than playing unverified songs.
2. **Saavn search** (`loadFromSaavn`) - JioSaavn search APIs listed in `SAAVN_BASES`; full songs, so snippets start at the intro.
   The first base is our own Cloudflare Worker (`worker/`, see docs/testing-and-deploy.md); the public nandanvarma mirror follows as a fallback.
   The first responding base is remembered for the session and tried first, but the others are still tried if it later fails.
   Search jobs are (query, page) pairs from `SAAVN_QUERIES` x `SAAVN_PAGES` in `src/lib/constants.js` (~120 queries: singers, composers, stars, years, moods; ~3,000 unique songs after filters).
   Each game samples 7 random jobs per language, so consecutive games draw from different slices of the corpus.
   Years here are whatever Saavn reports for the copy it returned (compilation copies carry re-release years), which is why this tier is only a fallback.
3. **Baked catalog** (`loadCatalog`) - the last tier: `public/catalog.json`, ~700 iTunes preview clips fetched by `scripts/build-catalog.mjs`, committed to the repo and served same-origin, so it needs no third-party host and is what keeps the game playing with the Worker and the mirror unreachable; refreshed weekly by CI because iTunes preview URLs rot.
   The client makes no live iTunes request; the catalog is the only thing it knows about iTunes.

Each tier only runs if the pool still has fewer than `minSongs` songs.
The snips scorer (`scripts/build-snips.mjs`) scores corpus recordings by Saavn ID.
Music-only draws only source IDs present in the current verified index; other tiers can contribute only if their exact ID has a valid index entry.
Dedupe is by canonical title key (`songKey(title)` in `src/lib/utils.js`, which strips bracketed qualifiers, dash suffixes like `- From "Movie"`, and punctuation): each tier dedupes internally, later tiers are filtered against earlier ones, and the assembled pool gets a final dedupe pass (first occurrence wins, so full Saavn songs beat hook clips).
Catalog tracks are 30-second mid-song "hook" clips and carry `hook: true`.

## The corpus (`public/corpus.json`)

Built by `node scripts/build-corpus.mjs` (weekly in CI, see docs/testing-and-deploy.md) from `scripts/corpus.config.json`, which holds everything that changes: playlist search queries, the editorial owner uid, Wikidata language ids, the year floor and tolerance, the play-count floor, score weights and tier cut-offs.
Its `languages` block lists the corpus languages: film languages (Hindi, Telugu, Tamil) carry a Wikidata language id, and a pop language (English, `film: false`) carries none.
The rule for a film language is film songs only, with the film's real release year:

1. **Seed** - JioSaavn's own editorial playlists (owner uid `phulki_user`, e.g. "Hindi 2000s", "Chartbusters 2019 - Telugu", "English 2010s") found through the configured playlist searches, plus the per-language charts.
   Only songs whose Saavn `language` is one of the configured languages are kept; titles matching `EXCLUDE_RX` (remixes, lofi, unplugged, ...) are dropped.
2. **Film match** - the album name is cleaned ("(Original Motion Picture Soundtrack)", language markers such as "- Telugu", `From "X"` clauses, brackets) and looked up in a Wikidata index of films by original language (labels and aliases, min publication year).
   A film of the song's language released within ±1 year of the copy's year verifies the song; the corpus stores Wikidata's canonical film label and year.
   An album marked as a dub ("Coolie (Telugu)", a marker anywhere on the album name) matches a film of any language instead, and an unmarked copy whose album is exactly the name of a film of another language in that window counts as a dub too; a dub keeps the album's own name, the one its audience knows, with the original film's year.
   Language markers on titles ("Monica (Telugu)") name the copy, not the song, and are dropped.
3. **Canonical copy** - when the album is a compilation ("Best Of Arijit Singh"), the script searches the title and treats copies with the same language and a play count within 1% as the same recording (Saavn shares one counter across copies), then applies step 2 to each copy, oldest year first, and keeps the original album's song id.
   A compilation copy without a matching original album copy is rejected.
   If only the name matches (a re-upload with a later year), Wikidata's year is taken anyway, which is what drops re-released pre-2000 songs; never for a dub-marked album, which would take an older same-named film of the song's language.
4. **Unverified fallback** - songs Saavn tags with a `starring` role whose film-like album has no dub marker and no same-named Wikidata film of another language within ±1 year are kept with `yearVerified: false` and the earliest year among the copies, unless any copy was released as a plain single (an album that is just the title; a film song's single names the film in a From clause), which is what keeps compilation re-uploads of singles ("Morning Chill Vibes") out.
   Everything else is rejected: singles, devotional and indie releases, dubs whose original film is not found, remixes, pre-2000 songs, and songs under the play-count floor.
5. **Difficulty** - within each language x decade (raw counts are not comparable: Hindi 2010s median ≈ 19M plays vs 2000s ≈ 6M) the score blends the play-count percentile (weight 0.8) with the editorial-playlist membership percentile (0.2).
   The top 30% by score is `easy`, the next 40% `medium`, the rest `hard` (cut-offs in the config, baked into the file's `tiers`).
   The client reads `score` and ignores `tier` (the popularity cut at the top of this doc).

6. **Categories** - see below.

An English song has no film, so steps 2 to 4 are replaced (`classifyPop`):

- **Who sings it** - JioSaavn tags some Indian acts' songs English (Badshah's "Voodoo"); a lead artist with more film-language songs than English ones in the seed is rejected (`indian-act`), while an English act with one film song (Akon) is kept.
- **Original release** - the song's copies (a title search, same play count within 1%) give the earliest JioSaavn year and the album: the earliest copy whose album is neither a compilation nor a bare single, so the hint names the real album.
  MusicBrainz's first release of a recording with that title by that artist (`recording` search, score at least `musicbrainz.minScore`, one request per `musicbrainz.gapMs`) gives the year when it is earlier; JioSaavn often carries only a later deluxe or "Best Of" copy ("Without Me" shows 2005, released 2002), and a remaster of a pre-2000 classic would otherwise pass as new.
  A song MusicBrainz does not find keeps JioSaavn's earliest year with `yearVerified: false`.
- The year floor and the play-count floor apply as for film songs; the `film` column holds the album (empty for a single).

The file is compact: `{ v, built, tiers, cols, songs: [[...], ...] }`, one row per song with columns `id, title, film, year, yearVerified, language, singers, composers, lyricists, starring, albumId, plays, score, tier, tags`; the client expands rows by `cols` and carries composers as `music` for the reveal.
Songs are deduped by language + `songKey(title)` (highest play count wins); snips are keyed separately by Saavn ID so similarly titled recordings cannot share an interval.
The script refuses to write a corpus with fewer than `minSongsPerLanguage` songs in any language.

## Song categories (`tags`)

Each song's `tags` column lists the categories it belongs to, set at build time from the `categories` block of `scripts/corpus.config.json` (queries, title regexes, thresholds) with no AI and no human step, so the weekly refresh keeps them current on its own.
Where a source is too noisy to trust, the rule drops the tag rather than guessing.

- **Moods, mass and hip hop** (`dance`, `romantic`, `sad`, `mass`, `hiphop`) come from JioSaavn's editorial theme playlists (owner `playlistOwner`), found with each category's `queries` and kept when the title matches its `titleRx` and not `playlistExcludeRx` (lofi, remixes, retro decades, ...).
  Playlist songs map to corpus songs by id or by language + `songKey(title)`.
  A song gets the tag when it is on one strong list or on `minLists` (2) lists of any kind.
  Weak lists are titles matching `weakTitleRx` (folk and city "beats" lists for `mass`) and artist lists ("Arijit Singh - Sad Songs", "Best Of Romance - Arijit Singh"): a list whose title contains the name of anyone credited on `artistListMinSongs` corpus songs picks songs by who is on them, not by mood.
  `unless` then removes overlaps: `dance` drops songs also tagged `sad`, and `romantic` drops `dance` and `sad`.
  A tag with `languages` only tags songs in those languages: `hiphop` is English only, since Hindi "desi hip hop" lists are a different scene.
  Tamil kuthu and gaana lists feed `mass` (kuthu, mass and folk barely overlap in Tamil, and two of three kuthu songs are also dance songs, so a separate chip would mostly repeat Dance).
  English has no `mass` or `item` songs, so those chips stay hidden for an English-only show.
  Occasion lists (wedding, Holi, rain) were measured and left out: they hold what gets played at a wedding, not songs about one.
- **Item songs** (`item`, film languages only) come from the film's English Wikipedia article (found by the usual "Film (2012 film)" title patterns, accepted only with a film infobox naming the film's year): a cast-list bullet line that names the song and matches `wikipediaRx` ("item number", "bar dancer", "special song", ...).
  Prose sentences are ignored because they often name two songs of which only one is the item number.
- **Overrides** - `scripts/category-overrides.json` is a fixed list of corrections applied last (`add` / `remove` per song, matched by id or by language + title).
  It was seeded once from the owner-decided item-song list (the Wikipedia set plus songs Wikipedia does not phrase as item numbers, minus "Besharam", where a choreographer is credited "as a dancer").
  It is not a review queue: nothing in the build proposes additions to it.

The build prints a per-language count table and refuses to write the corpus when a category has fewer than its `minTagged` songs, so a broken playlist search or Wikipedia outage leaves the last good corpus in place.
Hook step, wedding, festival, sufi, patriotic and rain were measured and left out of v1 (too few songs or no trustworthy source).

## Filters applied to every track

- https-only stream URL, via `sanitizeTrack`.
- Language must match the requested mix (Saavn `language` field; a catalog track's `lang` was set from the iTunes genre by `scripts/build-catalog.mjs`).
- Year ≥ 2000, plus the user's era selection (`settings.eras`, decade buckets from `eraOf`); for corpus songs the year is the film's verified year.
- `EXCLUDE_RX` drops remixes, covers, lofi, karaoke, instrumentals, background-score themes/OST/teasers, etc.
- Saavn-search songs with a reported play count below `SAAVN_MIN_PLAYS` (1M) are dropped (mostly dubs and obscure album cuts); a missing count means unknown and is kept. The corpus applies its own floor (`minPlays` in the config) at build time.
- Blocked artists are removed: a track is out if ANY of its comma-separated artists matches the device blocklist (`tt_blocked` in localStorage, managed in the reveal screen and setup screen).

If filters shrink the pool below 10 the crate returns `{ error: "thin" }` and the UI tells the user to widen filters, distinct from the connection error.

## Snips annotation and Music-only eligibility

Setup and crate builds share a valid `./snips.json` index for five minutes, while a resumed game fetches a fresh copy (no-cache).
A pooled track gets an interval only when its Saavn ID matches both the index key and entry, the interval is exactly `SNIP_WINDOW_SEC` (12) seconds inside the track, and it passes its index version's check in `SNIP_ACCEPTED` (see docs/audio.md for the contract).
The crate log entry records `snips: "ok"|"none"` and `snipped: <count>`.
In Music-only mode (`sound === "inst"`), the queue contains only annotated tracks and must cover the requested rounds and cast size.
If fewer safe songs survive, the crate returns `safe` and setup explains the shortage.
On resume, the remaining queue is checked against the current index again; stale entries are removed, and an inadequate queue cannot resume.

## Song cooldown (per device, or per group)

A song's history is a localStorage map of normalized title → timestamp, `tt_played`, for songs heard through to the reveal; a skip records nothing (docs/architecture.md, Skips).
A played song sits out for `COOLDOWN_DAYS` (7) in `src/lib/config.ts`.
Entries older than the cooldown are pruned.
A `tt_tired` map from the old "Heard it too much" skip may still sit in localStorage; nothing reads it.
`cooldownOf(...histories)` in `src/lib/storage.ts` turns histories (song key → last played, this device's from `loadHistory`, a group's, later a person's) into one map of song key → the time the song may come back, latest wins, and that map is `buildCrate`'s `cooldown`.
In a group, `startGame` passes the group's history merged with the device's (`groupCooldown`), so songs any phone in the group played or skipped sit out too; see docs/group-sync.md.
A buzz-in host also merges in every seated phone's history, which each phone brings to its seat, and passes `heardBy` (song key → how many of the people present heard it); see "No repeats" in docs/room-mode.md.
Songs still cooling down are excluded from the crate when at least `COOLDOWN_MIN_FRESH` (15, in `src/lib/config.ts`) fresh songs remain and they cover the show (rounds x contestants).
When fresh songs run low, they are appended AFTER all fresh ones, fewest people present first (`heardBy`, empty outside a room), then soonest-due, so repeats only appear when unavoidable.
Old installs stored `tt_played` as a plain array; `loadHistory` migrates that format transparently.
