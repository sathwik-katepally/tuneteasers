# Group sync

Phones that share a group share one song cooldown and one list of finished shows ("Past shows").
There are no accounts: a group is an invite secret that one phone creates and shares by link, QR code or pasted code.
Everything is optional; with no group, or with the Worker unreachable, the game runs on the phone's own history exactly as before.

## What syncs and what does not

- Synced: every played song and every song skipped as heard too much (as its `songKey` and kind, `played` or `tired`) with a server timestamp, and each finished pass-the-phone show (date, mode, difficulty, language mix, rounds, songs played, each player or team's name, members and score).
- Not synced: the game in progress (it stays on the phone it started on), blocked artists, presentation settings, rosters, and a buzz-in room's result (its played songs sync like any other, but the host records no show).
- Never stored server-side: audio, stems, stream URLs or anything else from the song sources.

## Identity and security

- `POST /api/groups` makes a group and returns two secrets once: the member invite `<groupId>.<secret>` and the owner secret, which only the creating phone keeps.
  Only SHA-256 hashes of the secrets are stored in D1; both are 128 random bits, so a fast hash is enough.
- The invite travels as `#join=<invite>` in the link, so it never reaches GitHub Pages logs; the app strips it from the address bar at once.
- Every group request sends `Authorization: Bearer <invite>`; a missing or malformed invite gets 401, a wrong one (or a deleted group) 403.
  A group idle past `GROUP_IDLE_TTL_DAYS` also gets 403 at authentication, before any write could refresh `active_at` and revive it.
- A link whose `#join=` part is not a valid invite (cut short, mangled by a chat app) is stripped from the address bar and opens the join form with a message asking for the whole link.
- The owner secret is the only thing that can delete the group (`DELETE /api/group`); member invites cannot.
- Group responses are `cache-control: no-store` and never go through the edge cache the Saavn proxy uses.
- CORS on group routes allows only `ALLOWED_ORIGINS` (the Pages origin) and `http://localhost` / `http://127.0.0.1` on any port; a request with any other `Origin` gets 403.
  The public Saavn proxy routes keep `*`.
- Rate limits (Workers rate limiting bindings in `worker/wrangler.jsonc`, approximate and per Cloudflare location): 120 group requests a minute per IP, 60 writes a minute per group, 5 new groups a minute per IP.
- Input validation in `worker/src/group.js`: body size (16 KB, 64 KB for import), song key shape, id shape, name lengths (24, group 32), cast and member counts, score and round ranges, enums.

## API

| Route | Auth | Does |
| --- | --- | --- |
| `POST /api/groups` `{ name }` | none | Makes a group, returns `{ group, invite, owner }` |
| `GET /api/group` | invite | `{ group: { id, name, createdAt }, role }` (used to preview and join) |
| `GET /api/group/played` | invite | `{ played: { songKey: ms }, tired: { songKey: ms } }` within the played window |
| `POST /api/group/rounds` `{ rounds: [{ id, key, kind? }] }` | invite | Records up to 50 plays; `kind` is `played` (default) or `tired` |
| `GET /api/group/results?before=&limit=` | invite | `{ results, more }`, newest first, 20 per page |
| `POST /api/group/results` `{ id, finishedAt, mode, difficulty, mix, rounds, songs, cast }` | invite | Records a finished show once |
| `POST /api/group/import` `{ played, tired? }` | invite | One-time import of a phone's own history (at most 1,000 songs across both kinds) |
| `DELETE /api/group` | owner | Deletes the group and all its rows |

Each round is an event with a client-made id; the server stamps the time.
In one D1 batch the event is inserted once (`INSERT OR IGNORE`) and its song's time in `played` or `tired` (by kind) is upserted to `MAX(existing, event time)` from the stored event, so a retried request keeps its first timestamp and a late one cannot shorten the cooldown.
An older client that sends no `kind` records plays, and one that reads only `played` still gets every played song.
Results are idempotent by the game's id.
The import is the one place client timestamps are accepted, clamped to the played window and never in the future.

## Data and retention

Schema: `worker/migrations/` (D1 migrations, applied by CI).
Tables: `groups`, `played` (group, song key, last played), `tired` (group, song key, last skipped as heard too much), `round_events` (idempotency log, with the kind), `results`.
Migrations stay additive: `0002_tired.sql` added `tired` and `round_events.kind` (default `played`) without touching `played`, so a Worker from before it, mid-deploy or after a rollback, keeps recording plays.
Windows are Worker vars: `PLAYED_TTL_DAYS` (30, for `played`, `tired` and `round_events`; it must stay at least the longest client `COOLDOWN_DAYS`, the 30-day tired cooldown), `RESULT_TTL_DAYS` (365), `GROUP_IDLE_TTL_DAYS` (365 without writes).
Reads filter by these windows, and authentication refuses an idle-expired group, so an expired row is never served.
Deletion runs from group writes, at most hourly per Worker isolate, because this account's five free cron triggers are all taken; a group nobody writes to is still hidden by the read filters and swept on the next write from any group.

## Client

`src/lib/group.ts` holds the group (`tt_group` in localStorage: name, invite, owner secret on the creating phone) and an outbox (`tt_group_outbox`).
- `recordPlay(title, kind)` is called next to every `markPlayed(title, kind)`; `recordResult` runs once when a game becomes finished (keyed by `game.id`).
  Both write to the outbox first, then flush; a failed flush keeps the entries, and the next write, an `online` event or a page load sends them.
  The outbox holds only the current group's queue: an answer for a group the phone has since left never rewrites it, and the new group's queue is flushed once the old request settles.
  A 400/413 drops the entry so one bad entry cannot block the rest; 401/403 marks the group as revoked and the home card offers to leave.
- Before building a crate, `groupCooldown` flushes, fetches the group's history (`groupHistory`, 5 s timeout) and merges it with this phone's through `cooldownOf` (latest wins, each kind on its own cooldown); if the group is unreachable the crate uses the phone's history alone.
  Every crate asks again: only a failure of this call's own flush skips the read, never an "offline" left over from an earlier one.
  The `crate` log line reports how many songs were in the cooldown map as `cooldown`.
- `tt_played` and `tt_tired` stay the phone's own history; the group's is merged at crate time only.
- UI: `src/components/GroupPanel.tsx` (make, join, invite with QR, leave, owner delete) on its own screen (`src/screens/GroupScreen.tsx`, `screen: "group"`), reached only from "Phone group" in the home menu, and `src/screens/PastGames.tsx` (`screen: "past"`).
  Groups are never prompted: no home-screen card and no offer after a show; no-repeat within one phone needs no setup at all.
  A `#join=` link opens the group screen with the invite card.

## Environments

- Production: Worker `tuneteasers-saavn`, D1 `tuneteasers`, deployed by Cloudflare Workers Builds on push to main (see docs/testing-and-deploy.md).
- Preview: `--env preview`, Worker `tuneteasers-saavn-preview`, D1 `tuneteasers-preview`, deployed by hand for testing a branch:
  `cd worker && npx wrangler d1 migrations apply DB --env preview --remote && npx wrangler deploy --env preview`.
- Local: `npx wrangler d1 migrations apply DB --local && npx wrangler dev`.
