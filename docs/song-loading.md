# Song loading

`buildCrate(mix, eras)` in `src/lib/crate.js` assembles the game queue; it returns `{ queue, source }` or `{ error: "load" | "thin" }`.

## Source tiers

1. **Saavn mirror** (`loadFromSaavn`) - JioSaavn mirror APIs listed in `SAAVN_BASES`; full songs, so snippets start at the intro; the first responding base is remembered for the session.
2. **Baked catalog** (`loadCatalog`) - `public/catalog.json`, ~700 iTunes tracks committed to the repo and served same-origin, so it cannot be rate-limited or CORS-blocked; refreshed weekly by CI because iTunes preview URLs rot.
3. **Live iTunes search** (`loadFromItunes`) - last resort; deliberately throttled to few search terms because Apple rate-limits around 20 searches/min per IP (that rate limit caused the original "Couldn't load enough songs" production bug).

Each tier only runs if the pool still has fewer than 10 songs, and tiers are deduped against each other by normalized title (`stripParens(title).toLowerCase()`).
Tracks from tiers 2 and 3 are 30-second mid-song "hook" clips and carry `hook: true`.

## Filters applied to every track

- https-only stream URL, via `sanitizeTrack`.
- Language must match the requested mix (Saavn `language` field, iTunes genre via `ITUNES_LANG_OK`).
- Year ≥ 2000, plus the user's era selection (`settings.eras`, decade buckets from `eraOf`).
- `EXCLUDE_RX` drops remixes, covers, lofi, karaoke, instrumentals, etc.
- Blocked artists are removed: a track is out if ANY of its comma-separated artists matches the device blocklist (`tt_blocked` in localStorage, managed in the reveal screen and setup screen).

If filters shrink the pool below 10 the crate returns `{ error: "thin" }` and the UI tells the user to widen filters, distinct from the connection error.

## Played-song cooldown (per device)

`tt_played` in localStorage maps normalized title → last-played timestamp; entries older than 30 days are pruned.
Songs played within the last 7 days (`PLAY_COOLDOWN`) are excluded from the crate when at least 15 fresh songs remain.
When fresh songs run low, recently played songs are appended AFTER all fresh ones, ordered least-recently-played first, so repeats only appear when unavoidable.
Old installs stored `tt_played` as a plain array; `loadPlayed` migrates that format transparently.
