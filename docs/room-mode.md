# Buzz-in rooms

A second way to play, next to pass-the-phone.
One screen (a laptop, a TV, or one phone) is the host: it plays every song and shows the room code.
Everyone else joins on their own phone, which becomes a buzzer and an answer pad.
It is the Kahoot or Jackbox model: no accounts, a four-letter code, and nothing kept after the party.

Example: the host taps "Buzz in from every phone" on the landing (or picks "Buzz in" on setup) and taps "Open a room"; the big screen shows `KFHB` and a QR code.
Asha scans it; her phone shows the code as fixed text with her name field focused, she types her name and sees "You're in".
When the clip starts her phone lights up BUZZ; she taps it, the song pauses on the big screen, and she has 15 seconds to type the title.
Autocomplete offers every known title in the show's languages; if she is right she scores the rung's points, if not the next person who buzzed gets a turn.

## Who owns what

- The host screen (`src/room/Host.tsx`) builds the crate (honouring the home screen's languages, eras, difficulty and song categories), plays audio through the engine, runs the clip ladder, the reveal, the box office and the podium, and tells the room what is playing.
  It reuses the pass-the-phone screens: `Countdown`, `Reveal`, `Scoreboard`, `Podium`, `Loading`, plus `Lobby` and `HostPlaying` in `src/room/`.
  From 900px wide the host screen is laid out for a laptop or TV: the lobby spreads over the whole stage with code tiles and a QR sized from the screen (up to 260px), and during the show a small join tag (QR and code) stays in the corner, since latecomers can still take a seat.
- The room (`worker/src/room.js`) is one Durable Object per room code, built on PartyServer with WebSocket hibernation.
  It is the referee: it orders buzzes as they arrive, runs the answer clock, judges answers and holds the scores.
- A phone (`src/room/Phone.tsx`) only joins, buzzes and types. It never plays audio.
- `src/lib/room.ts` is the client side: making a room, the `#room=` link, the PartySocket connection (`useRoom`) and what each device remembers.
- `src/lib/answer.js` folds titles for matching and ranks autocomplete suggestions; the phone and the Worker import the same file.

## Secrecy

- The host sends each song's title, film, year and singers to the room when its countdown starts; stream URLs never leave the host.
- A phone's view carries the answer only once the song is revealed (`song.answer` is null before that), and the results list only holds revealed songs.
- No title of the show reaches a phone before that song's reveal, in any frame, autocomplete included.
  A phone builds its autocomplete itself from the site's public `corpus.json` and `catalog.json` for the show's languages (`answerTitles` in `src/lib/crate.js`; the room tells phones only the language mix).
  The list is the same for every show in those languages, so it says nothing about which songs are coming. Songs from the live-search tiers may be missing from it; those are typed in full.
- Judging needs the titles that fold close to the answer (so a guess that is exactly another song is wrong even when it is a typo away). The host picks them from the same public list (`nearTitles`) and sends them with each `song`; the room keeps them for judging and never puts them in a view.
- A phone's song history (below) goes to the room and on to the host only, merged with the other seats'; no phone ever receives another phone's history or the merged list.
- `e2e/room.mjs` and `e2e/room-norepeat.mjs` record every frame each phone receives, including welcomes, errors and the snapshots after a reload, and fail on any title list, any URL or stream, any title of the show before its reveal (a skipped song's key before its skip), or any other phone's history.

## Flow of one song

1. Countdown: the host sends `song`; buzzing is shut (`cue`).
2. The clip starts playing: the host sends `clip { rung, points }`; buzzing opens (`live`) at that rung's points (the show's ladder in `CLIP_LADDERS`: Easy has three rungs, Music-only two).
3. First buzz: the room makes that player the answerer (`answering`) with `ROOM_ANSWER_SECS` on the clock; the host pauses the audio. Others can keep buzzing to queue.
4. Answer:
   - right: the player scores the points of the rung they buzzed on, and the song is `revealed`;
   - wrong or out of time: that player is locked out for the song and the next in the queue answers;
   - queue empty: `missed`. After a short beat (`ROOM_WRONG_BEAT_MS`) the host plays the next rung for everyone (the ladder's "Hear more": only the new stretch, `playRung` in `src/lib/ladder.ts`), or reveals once the ladder is spent. If a buzz cut the clip short, the next play starts from the top of the window instead, and on the last rung it replays. Buzzes are still accepted during the beat.
5. When a clip ends with nobody buzzing, buzzing stays open for `ROOM_GRACE_SECS`, then the next rung plays. The host can also tap "Hear more" or "Reveal it".
6. If every player is locked out the song is revealed straight away.

## Skipping a song ("Heard it too much")

Once a song's clip is playing (a cued song hasn't been heard yet), and until anyone buzzes, each phone shows "Heard it too much".
A tap sends `vote`; the room counts votes itself and skips once more than `ROOM_SKIP_VOTE_SHARE` (0.5) of the seated players have voted, so 2 of 3 or 3 of 4.
Seated means every player with a seat, online or not; the host can always skip on its own ("Heard it too much" under the song, which sends `skip`).
A show has `ROOM_SKIPS_PER_SHOW` (3) skips in all, votes and host skips together; "Same crowd again" gives them back.
Both numbers are Worker vars in `worker/wrangler.jsonc`, because the room is what enforces them; the view carries `skips { used, max }` and each song's `votes` and `votesNeeded` for the screens.

Every `song` the room accepts gets a new `cue` id, a re-cue of the same `n` included, and `vote` and `skip` name the cue they are for; one that arrives after a re-cue is stale and ignored, so a late vote or a replayed skip can't skip the replacement or spend the cap.
A skip puts the song in state `skipped` without a result, a reveal or its answer; phones only get its song key afterwards, in `skipped`, for their own history (below), and the title never.
The host acts on the room's skip count rather than on a tap, so each skip happens exactly once, a reload included (`skipsSeen` in the saved show): it stops the audio, records the song as `tired` for this device and the group (docs/song-loading.md), and cues song `n` again with the next queued song from the same corpus tier, falling back to the next song when that tier has run out.
Its countdown shows "Skipped: <title>" on the big screen only.
Fishing for an easier song gains nothing here, since a skip changes the song for everyone and takes a majority or the host.
A stream error keeps its own free "Skip this song" on the host, which re-cues `n` without touching the skip count or any history.

A show is `rounds × ROOM_SONGS_PER_ROUND` songs, with the box office after every round.
"Same crowd again" on the podium starts a new show in the same room with scores reset; the phones stay in their seats.
All of these numbers live in `src/lib/config.ts`; the host passes the answer time to the room at `start`.

## No repeats

Nobody sets anything up for this and nothing on screen mentions it.
Every phone already keeps its own song history from playing (`tt_played` and `tt_tired`, docs/song-loading.md).
When a phone takes its seat, and on every reconnect, its `join` carries the songs it is still sitting out, as song key to hours until the song may come back (`heardPayload` in `src/lib/room.ts`).
Hours rather than a time, so the phone's, the room's and the host's clocks never need to agree.
A phone with more than `ROOM_HEARD.songs` (300) such songs sends the ones sitting out longest.

The room keeps each seat's songs in its own storage key (`heard:<seat>`), replaced by every hello that carries them, so a phone that reloads or drops offline keeps its songs in the room while it has a seat.
A seat that leaves the lobby or is removed takes its songs with it.
Only the host gets them: `heard { songs: { key: [hours, seats] } }`, every seat's songs merged, on the host's hello and whenever a seat's songs change.

Example: Asha played "Kesariya" at home last night and Ravi skipped "Tum Hi Ho" as heard too much two weeks ago.
When they sit down, the host's `heard` holds both, each with one seat, and the crate for the show leaves both out.

The host merges that into its own cooldown map (this screen's history, and its group's, docs/group-sync.md) with `withRoomHeard` and builds the crate from it at Start, so the whole party's recent songs sit out.
When fresh songs run short, the repeats that come back first are the ones the fewest people present have heard (the host's own history counts as one), then the soonest due.
A phone that sits down after the show started is caught when the next song is picked: if it has heard that song, the host swaps in the first later song of the same tier it has not (`withFreshAt`, and `withSameTierNext` prefers such a song for a skip's replacement).

Phones record what the room played in their own history (`useRecordHeard`), so the next room, or a pass-the-phone game on that phone, leaves it out too.
Every revealed song (the view's `results`) is recorded as played.
A skipped song arrives in the view's `skipped` list as `{ key, tired }` after its skip: tired for a phone that voted to skip it, played for the others, who heard the clip but did not ask for it gone.
A phone that joins mid-show records the songs revealed before it arrived as well; it was in the room while they played.

## Protocol

JSON over one WebSocket per device at `/parties/room/<CODE>`.
Admission happens at the upgrade, before a socket joins the room: an unclaimed code gets a socket closed with 4404, and a room with 48 open sockets closes new ones with 4429.
The first message must be a hello; anything else is refused until then, and a connection that says nothing for 10 seconds is closed with 4401 (an alarm, so it works while the room hibernates).

| From | Message | Does |
| --- | --- | --- |
| host | `host { token }` | Authenticates with the host secret from `POST /api/rooms` |
| host | `start { mix, total, perRound, answerSecs }` | Lobby (or a finished show) to a new show; scores reset |
| host | `song { n, title, film, year, artist, near }` | Arms song `n` (buzzing shut). `n` must be one past the number of results and at most `total`, so a re-cue can restart an unfinished song but never replay a scored one |
| host | `clip { rung, points }` | A clip is playing; buzzing open at these points |
| host | `reveal` / `end` / `kick { id }` | Nobody got it / show over / remove a player (lobby only) |
| host | `skip { cue }` | Skips the song straight away (clip live, nobody has buzzed, a skip left) |
| phone | `join { key, name, heard? }` | Takes a seat, or gets its seat back when the key is known; `heard` is the phone's songs sitting out, `{ key: hours }` (No repeats) |
| phone | `buzz` / `answer { text }` / `leave` | |
| phone | `vote { cue }` | "Heard it too much" for the current song; a majority skips it |
| room | `welcome`, `state`, `error { code }`, `kicked` | `state` is the full view for that device, sent after every change |
| room | `heard { songs }` | Host only: every seat's songs merged, `{ key: [hours, seats] }` |

`POST /api/rooms` (no body, so no CORS preflight) draws a free code and returns `{ code, host }`; only the SHA-256 of the host secret is stored.
Codes are four letters from `BCDFGHJKLMNPQRSTVWXZ` (no vowels, so no words).

## Reconnects

- A phone makes a random seat key per room and keeps it in `localStorage` (`tt_room_seat`); the room stores only its hash.
  Every reconnect (PartySocket retries on its own) says hello with the key, so a dropped, reloaded or reopened phone keeps its seat and score.
- A device coming back from the background (more than 2 seconds hidden, or restored from the back-forward cache) reconnects straight away.
  iOS suspends a backgrounded page and can drop its socket without a close event, so it would look open and receive nothing: a host that left Safari to send the code would never see who joined meanwhile.
- The room link `#room=CODE` stays in the address bar while a phone is in the room, so a reload goes straight back in.
- The host keeps its show (code, host secret, queue and position) in `tt_room_host`. After a reload the home screen offers "Resume", and the host reconciles with the room rather than its saved counters: a song the room finished while the host was away (someone answered during the reload) counts as played and comes back on its reveal, a reload on the final reveal returns to that reveal and the end of the show, and only an unfinished song starts over.
- Close codes 4404 (no such room), 4403 (not the host, or removed) and 4410 (room expired) stop the retries and send the device home with a message.

## Limits and expiry

- Nothing goes to D1. Room state lives in the Durable Object's own storage and is wiped by an alarm after 3 idle hours.
  The host's `recordPlay` for a skipped song is the host device's own group sync, the same as for a played one.
- Origin must be the Pages origin or localhost, for both `POST /api/rooms` and the WebSocket.
- Rate limits (Workers rate limiting, per IP): 10 new rooms a minute, 240 room connections a minute (a whole party shares one IP behind the Wi-Fi).
- Per connection: every frame is charged to a bucket of 12 refilled at 6 a second, before anything else; 40 refused frames close the socket (4429), and any frame over the size limit, or binary, closes it at once (1009).
  The bucket lives in memory, so it restarts when the room wakes from hibernation.
  Buzzes that change nothing (repeated, late, locked out) do not write storage or broadcast.
- An answer after the answer clock has run out counts as a timeout even if the alarm has not fired yet.
- Claiming a code closes any socket left from an expired room with the same code.
- Validation: 16 players, 48 connections, names 24 characters, guesses 80, titles 120, 60 near titles per song, 200 songs, 64 KB host messages, 32 KB for a phone's `join` and 1 KB for its other messages, answer time 5 to 60 seconds.
  A seat's songs (`ROOM_HEARD` in `src/lib/constants.js`, shared by the phone and the room): at most 300 kept, keys of 1 to 80 characters without control characters, whole hours from 1 to a year and a day; anything else is dropped, and a `heard` that is not a map is ignored.
- Free tier: WebSocket messages count 20:1 against Durable Object requests, and a hibernating room with idle sockets costs nothing.

## Answer matching

`fold()` lowercases, strips the `(From "…")` qualifiers and punctuation, removes accents, and folds romanised spelling variants: aspirated consonants (`dh` to `d`), `w`/`v`, `z`/`j`, `q`/`k`, long vowels (`aa`, `ee`, `oo`), `ai`/`ei` to `e`, and doubled letters.
A guess is right when its folded form equals the title's, or is within a small edit distance of it (0 for four letters or fewer, then 1, 2, 3 as the title grows), unless it is exactly one of the near titles the host sent with the song.
So "Main Hu Na" matches "Main Hoon Na" and "kesaria" matches "Kesariya", while "Kesari" does not.

## Testing

`npm run e2e:room` (`e2e/room.mjs`) starts a local `wrangler dev` and proxies the room WebSockets to it from Playwright, recording every frame.
Desktop Chromium hosts (or a WebKit iPhone with `--host=phone`; `--difficulty=medium` plays a Music-only show on the shorter ladder) and three WebKit iPhones in separate contexts play a full 12-song show: join by typed code and by link, a buzz race in arrival order, wrong answer to the next buzzer, right answer at the rung's points, "Hear more" and the automatic ladder after a miss, a typed misspelling, a reload and a leave-and-return keeping the seat, the answer clock running out, everyone locked out, the box office, "Heard it too much" (one vote of three does not skip, two do, the host skips until the cap, the room refuses a skip past the cap or after a buzz, the same-tier replacement and the tired history on the host, and the skipped title on the big screen only), the host reloading while a phone answers (the room scores it once and the host resumes on its reveal), the host reloading on the final reveal, podium totals against the room's results, each phone's final place, and "Same crowd again".
It then probes the room directly: a foreign origin, an unclaimed code, a wrong host token, silent sockets up to the cap and their 4401 timeout (in a browser page with its own context: Node's WebSocket reports a close the server starts late or never, and the game contexts route the Worker's host through the script's Node proxy, which matters when `--worker` is production), frames before a hello, a host command from a phone, an oversized frame, a flood, and song numbers out of order.
`--worker=<origin>` runs it against a deployed Worker (the preview one) instead, and `--categories=romantic,...` checks that every song in the show carries one of those tags.

`npm run e2e:room-norepeat` (`e2e/room-norepeat.mjs`) seeds three WebKit phones' histories (one over the cap, one with tired songs, one with songs back from their cooldown), then checks what each phone sends, the hours and seat counts the host gets, the room's caps from raw sockets (an oversized join, 400 songs, malformed entries, a history that is not a map, seats leaving the lobby), a crate with none of those songs, a revealed song as played on every phone, a vote-skipped song as tired on the voters and played on the other phone, a reload and an offline seat keeping their songs, a phone joining mid-show having heard the next song (swapped out), and a second room with a new host screen that leaves out what the first room played.
Its secrecy scan is the one above, plus every other phone's seeded songs.
