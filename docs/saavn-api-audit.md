# JioSaavn API audit - 27 September 2026

Live sample: 48 songs, eight per Hindi/Telugu x 2000s/2010s/2020s cell, matched to films in the prior Wikidata-backed classification.
Counts describe this selected set, not catalog-wide rates.
Raw requests/responses: `/Users/sathwik/.crew/tasks/tt-saavn-audit/scratch/` (`sample.json`, `songs.json`, `coverage.json`, endpoint-named JSON files).
The current Worker exposes search fields only; `worker.json` shows its response.

| Rank | Field or endpoint, real trimmed result | Coverage and game value |
| --- | --- | --- |
| 1 | `song.getDetails.more_info.artistMap.artists`: `Saathiya` has `Gulzar/lyricist`, `A.R. Rahman/music`, `Rani Mukerji/starring`. | Composer and lyricist 48/48, singer 44/48, starring 48/48. Use credits as graduated hints and post-answer reveal. Roles need review: `Aaj Ki Raat` (2024) lists an implausible singer. |
| 2 | `content.getAlbumDetails?albumid=1025648`: *Dil Maange More*, `song_count:8`, eight track IDs; `webapi.get?token=qhdx7jQSm-8_&type=album` resolves the same album. | Album details 48/48; album-level starring and `is_movie` 0/48. Verified same-film tracks make controlled multiple-choice distractors. `webapi.get` requires the URL token, not numeric album ID. |
| 3 | `lyrics.getLyrics?lyrics_id=0x5uNwi6`: lyrics HTML, snippet, copyright. | Lyrics 22/48 (Hindi 17/24; Telugu 5/24), despite `has_lyrics:"false"` in 48/48. A licensed lyric clue or finish-the-line mode is possible for an eligible subset; flag cannot select it. |
| 4 | `song.getDetails`: `release_date`, `label`, `copyright_text`, `duration`, `language`, `play_count`, image, `320kbps`, encrypted audio. | Label/copyright/duration/language/stream 48/48; release date 41/48. `year` matches verified film year 42/48; `Behti Hawa Sa Tha Who` says 2021 for a 2009 film. Use duration to pick clips, plays plus curated recognition tests for difficulty, credits/cover for reveal. Worker already emits 50/150/500px images and 320kbps URLs; sampled 500px image and 320kbps audio URLs returned HTTP 200. |
| 5 | `playlist.getDetails?listid=1164340768`: *Best Of 2010s - Hindi*, 43 tracks; `content.getCharts` returns *Hindi: India Superhits Top 50* (50); `content.getBrowseModules` exposes `new_trending`. | One playlist/chart/browse probe each. Editorial membership can seed era or current-hit packs, then verify film and freshness. `content.getTrending` mixed albums, songs and playlists, including non-film entries; locale test with `language=telugu` still yielded Hindi charts. `search.getResults` and `autocomplete.get` find IDs, but autocomplete mixes entity types. |

**Avoid:** `reco.getreco` and `webradio.createEntityStation` returned `[]` for both sampled and popular songs; `webradio.getSong` then had no station ID.
Album recommendations returned albums, not song alternatives.
`origin:"none"`, `is_dolby_content:false`, and `triller_available:false` were constant across 48 songs.
`vcode`/`vlink` appeared on 47/48, but `vlink` is an MP3 JioTune preview, not film video.
The API provides no separated drums, bass, melody, or vocals.
All 48 `rights` objects said `Unavailable` even while sampled CDN URLs returned HTTP 200, so neither flag proves playable rights.

**Feature ideas:** (1) actor/composer/lyricist hint ladder; (2) same-film multiple choice for Easy; (3) rights-cleared lyric challenge where available; (4) curated era/current-hit packs from editorial lists.
These internal endpoints and media/lyric reuse need a rights decision before shipping: [JioSaavn's Terms](https://corporate.saavn.com/terms/) prohibit automated or unofficial access without permission, and [music availability](https://corporate.saavn.com/music-rights) varies by license and region.
