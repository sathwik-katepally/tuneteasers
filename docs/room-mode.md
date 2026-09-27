# Buzz-in rooms

A second way to play, next to pass-the-phone.
One screen (a laptop, a TV, or one phone) is the host: it plays every song and shows the room code.
Everyone else joins on their own phone, which becomes a buzzer and an answer pad.
It is the Kahoot or Jackbox model: no accounts, a four-letter code, and nothing kept after the party.

Example: the host picks "Buzz in" on the home screen and taps "Open a room"; the big screen shows `KFHB` and a QR code.
Asha scans it, types her name and sees "You're in".
When the clip starts her phone lights up BUZZ; she taps it, the song pauses on the big screen, and she has 15 seconds to type the title.
Autocomplete offers titles from the show plus decoys; if she is right she scores the rung's points, if not the next person who buzzed gets a turn.

## Who owns what

- The host screen (`src/room/Host.tsx`) builds the crate, plays audio through the engine, runs the clip ladder, the reveal, the box office and the podium, and tells the room what is playing.
  It reuses the pass-the-phone screens: `Countdown`, `Reveal`, `Scoreboard`, `Podium`, `Loading`, plus `Lobby` and `HostPlaying` in `src/room/`.
- The room (`worker/src/room.js`) is one Durable Object per room code, built on PartyServer with WebSocket hibernation.
  It is the referee: it orders buzzes as they arrive, runs the answer clock, judges answers and holds the scores.
- A phone (`src/room/Phone.tsx`) only joins, buzzes and types. It never plays audio.
- `src/lib/room.ts` is the client side: making a room, the `#room=` link, the PartySocket connection (`useRoom`) and what each device remembers.
- `src/lib/answer.js` folds titles for matching and ranks autocomplete suggestions; the phone and the Worker import the same file.

## Secrecy

- The host sends each song's title, film, year and singers to the room when its countdown starts; stream URLs never leave the host.
- A phone's view carries the answer only once the song is revealed (`song.answer` is null before that), and the results list only holds revealed songs.
- The autocomplete list is sent once per show: every title in the show (plus spares) shuffled with about three corpus decoys per song (`ROOM_DECOYS_PER_SONG`) from the same languages and eras, so it cannot be read as the song list or the order.
- `e2e/room.mjs` records every frame each phone receives and fails if any contains a URL, a stream, or the current title before its reveal.

## Flow of one song

1. Countdown: the host sends `song`; buzzing is shut (`cue`).
2. The clip starts playing: the host sends `clip { rung, points }`; buzzing opens (`live`) at that rung's points (`CLIP_POINTS`).
3. First buzz: the room makes that player the answerer (`answering`) with `ROOM_ANSWER_SECS` on the clock; the host pauses the audio. Others can keep buzzing to queue.
4. Answer:
   - right: the player scores the points of the rung they buzzed on, and the song is `revealed`;
   - wrong or out of time: that player is locked out for the song and the next in the queue answers;
   - queue empty: `missed`. After a short beat (`ROOM_WRONG_BEAT_MS`) the host plays the next rung for everyone, replays the last rung if a buzz cut it short, or reveals once the ladder is spent. Buzzes are still accepted during the beat.
5. When a clip ends with nobody buzzing, buzzing stays open for `ROOM_GRACE_SECS`, then the next rung plays. The host can also tap "Hear more" or "Reveal it".
6. If every player is locked out the song is revealed straight away.

A show is `rounds × ROOM_SONGS_PER_ROUND` songs, with the box office after every round.
"Same crowd again" on the podium starts a new show in the same room with scores reset; the phones stay in their seats.
All of these numbers live in `src/lib/config.ts`; the host passes the answer time to the room at `start`.

## Protocol

JSON over one WebSocket per device at `/parties/room/<CODE>`.
The first message must be a hello; anything else is refused until then, and a connection that says nothing for 10 seconds is closed.

| From | Message | Does |
| --- | --- | --- |
| host | `host { token }` | Authenticates with the host secret from `POST /api/rooms` |
| host | `start { titles, total, perRound, answerSecs }` | Lobby (or a finished show) to a new show; scores reset |
| host | `song { n, title, film, year, artist }` | Arms song `n` (buzzing shut) |
| host | `clip { rung, points }` | A clip is playing; buzzing open at these points |
| host | `reveal` / `end` / `kick { id }` | Nobody got it / show over / remove a player (lobby only) |
| phone | `join { key, name }` | Takes a seat, or gets its seat back when the key is known |
| phone | `buzz` / `answer { text }` / `leave` | |
| room | `welcome`, `state`, `titles`, `error { code }`, `kicked` | `state` is the full view for that device, sent after every change |

`POST /api/rooms` (no body, so no CORS preflight) draws a free code and returns `{ code, host }`; only the SHA-256 of the host secret is stored.
Codes are four letters from `BCDFGHJKLMNPQRSTVWXZ` (no vowels, so no words).

## Reconnects

- A phone makes a random seat key per room and keeps it in `localStorage` (`tt_room_seat`); the room stores only its hash.
  Every reconnect (PartySocket retries on its own) says hello with the key, so a dropped, reloaded or reopened phone keeps its seat and score.
- The room link `#room=CODE` stays in the address bar while a phone is in the room, so a reload goes straight back in.
- The host keeps its show (code, host secret, queue and position) in `tt_room_host`. After a reload the home screen offers "Resume"; the interrupted song starts over and the room keeps the scores.
- Close codes 4404 (no such room), 4403 (not the host, or removed) and 4410 (room expired) stop the retries and send the device home with a message.

## Limits and expiry

- Nothing goes to D1. Room state lives in the Durable Object's own storage and is wiped by an alarm after 3 idle hours.
- Origin must be the Pages origin or localhost, for both `POST /api/rooms` and the WebSocket.
- Rate limits (Workers rate limiting, per IP): 10 new rooms a minute, 240 room connections a minute (a whole party shares one IP behind the Wi-Fi).
- Per connection: a burst of 12 messages refilled at 6 a second; a connection that keeps flooding is closed.
  Buzzes that change nothing (repeated, late, locked out) do not write storage or broadcast.
- Validation: 16 players, 48 connections, names 24 characters, guesses 80, titles 120, 600 autocomplete titles, 200 songs, 64 KB host messages and 1 KB player messages, answer time 5 to 60 seconds.
- Free tier: WebSocket messages count 20:1 against Durable Object requests, and a hibernating room with idle sockets costs nothing.

## Answer matching

`fold()` lowercases, strips the `(From "…")` qualifiers and punctuation, removes accents, and folds romanised spelling variants: aspirated consonants (`dh` to `d`), `w`/`v`, `z`/`j`, `q`/`k`, long vowels (`aa`, `ee`, `oo`), `ai`/`ei` to `e`, and doubled letters.
A guess is right when its folded form equals the title's, or is within a small edit distance of it (0 for four letters or fewer, then 1, 2, 3 as the title grows), unless it is exactly another title on the show's list.
So "Main Hu Na" matches "Main Hoon Na" and "kesaria" matches "Kesariya", while "Kesari" does not.

## Testing

`npm run e2e:room` (`e2e/room.mjs`) starts a local `wrangler dev` and proxies the room WebSockets to it from Playwright, recording every frame.
Desktop Chromium hosts (or a WebKit iPhone with `--host=phone`) and three WebKit iPhones in separate contexts play a full 12-song show: join by typed code and by link, a buzz race in arrival order, wrong answer to the next buzzer, right answer at the rung's points, "Hear more" and the automatic ladder after a miss, a typed misspelling, a reload and a leave-and-return keeping the seat, the answer clock running out, everyone locked out, the box office, podium totals against the room's results, each phone's final place, and "Same crowd again".
`--worker=<origin>` runs it against a deployed Worker (the preview one) instead.
