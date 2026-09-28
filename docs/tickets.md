# Personal tickets

A ticket is a person, not a phone: an anonymous profile with a name, made on your own phone, whose song history and preferences follow you to any phone in your group and to any buzz-in show you join.
So nobody gets a song they have already heard, even when they play on a friend's phone or buzz in from their own.
There are still no accounts in the usual sense: no email, password or sign-in with a provider.
A ticket is a bearer secret plus a passkey, in the same family as a group invite.
Everything is optional: with no ticket, no group, or the Worker unreachable, the game runs on the phone's own history exactly as before.

Example: Asha makes a ticket on her phone and joins the Friday crew group.
On Ravi's phone the roster offers "Asha" as a chip with a ticket mark; every song of that show is recorded for her.
The next weekend she buzzes in from her own phone to a show on Meena's laptop; the laptop's crate leaves out everything Asha has heard, and each revealed song lands in her history.
When she loses her phone she taps "Already have a ticket?" on a new one and Face ID brings the ticket back.

## What a ticket holds

- A display name (24 characters).
- A 128-bit key, kept in `tt_me` in localStorage on the phones that hold the ticket; the Worker stores only its SHA-256.
- Song history: song keys with the time last heard, per kind (`played`, and `tired` for songs skipped as heard too often), within `PLAYED_TTL_DAYS`.
- Preferences: blocked artists and the setup screen's default filters (languages, eras, difficulty, song categories).
- Passkeys (WebAuthn credentials) for recovery.
- The groups the ticket has joined.

Never on the ticket: the game in progress, presentation settings, scores, room codes, audio or stream URLs.

## Making, moving, recovering, removing, deleting

- **Make** ("Your ticket" card on the home screen, shown once the phone has heard a song or is in a group; a fresh phone only sees "Already have a ticket?").
  `POST /api/people` with the name and, if the box is left ticked, this phone's recent history and blocked artists as a one-time import (the same clamping as the group import: within the played window, never in the future, at most 1,000 songs per kind).
  Right after, the phone asks for a passkey (`navigator.credentials.create` through `@simplewebauthn/browser`, resident key required so it is discoverable on recovery).
  A refused or unsupported prompt leaves a working ticket and offers "Create a passkey" later; the move link is the fallback for phones without passkeys.
  If the setup roster is still the untouched default, the ticket holder takes Player 1's place.
- **Move** by QR or link: `#me=<id>.<key>` in the fragment, stripped from the address bar at once, exactly like a group invite.
  The receiving phone shows "Carry Asha's ticket on this phone?" with the name read from `GET /api/me`; taking it replaces any ticket that phone held and writes the ticket's blocked artists over the phone's list.
  Both phones hold the ticket until one removes it.
- **Recover** with a passkey: `POST /api/people/recover/options` gives an authentication challenge with no allow-list (discoverable credentials), the browser signs it, and `POST /api/people/recover` verifies the assertion against the stored public key and counter.
  Recovery rotates the key: the recovering device gets a fresh `<id>.<key>` and every phone that held the old one sees "Ticket no longer valid" and is offered "Remove from this phone".
- **Remove from this phone** forgets `tt_me` and the outbox; the ticket lives on.
- **Delete** (`DELETE /api/me`, only with the key) removes the person, their history, passkeys, group memberships and pending challenges.

## Identity and security

- A ticket is `<personId>.<key>`, the group-invite shape (`^[a-z2-7]{12}\.[A-Za-z0-9_-]{22}$`), sent as `Authorization: Bearer`; missing or malformed gets 401, wrong, deleted, rotated or idle-expired gets 403.
  Comparison is constant-time on the hash.
- Only the key holder reads or edits preferences, reads the ticket's groups and passkey count, adds passkeys, joins or leaves groups, or deletes the ticket.
  There is no route that names another person's ticket for preferences.
- Plays can be recorded for a person by three callers: the key holder (`POST /api/me/rounds`), any phone in a group the ticket joined (`POST /api/group/rounds` with `people`, checked against `group_people`; ids that are not members are dropped, never rejected), and the host of a room the person is seated in (below).
  Histories are served the same way: to the key holder, to a group's members through `GET /api/group/played?people=` (only members' histories come back), and to a room's host for its seated tickets.
- WebAuthn: the relying party is the site the request came from (`sathwik-katepally.github.io` in production, `localhost` in tests), taken from the allowed `Origin`; a request without one cannot register or recover.
  Challenges live in D1 for five minutes under a random id the client hands back and are deleted on use; a wrong, reused or expired challenge, or an assertion that fails verification, gets 400 on registration and 403 on recovery.
  Attestation is `none`; user verification is `preferred`, so a phone's lock counts and a security key without a PIN still works.
  A ticket holds at most 10 passkeys.
- CORS and origins as the group routes: only the Pages origin and localhost.
- Rate limits: new tickets and recovery attempts share the per-IP group-creation budget (5 a minute, keyed `people:<ip>`); ticket writes are 60 a minute per ticket; every request counts against the 120-a-minute per-IP budget.
- Input caps (`worker/src/people.js`): body 16 KB (64 KB for creation with an import and for WebAuthn responses), name 24, 50 blocked artists of 120 characters, filters from fixed enums, 50 rounds a batch, 16 people a request, 1,000 imported songs per kind.
- Nothing secret in URLs: tickets travel only in `Authorization` headers and the `#me=` fragment; `?people=` carries person ids, which are not secrets.
  `e2e/tickets.mjs` records every Worker URL a device requests and fails on anything shaped like a ticket.

## Worker API

| Route | Auth | Does |
| --- | --- | --- |
| `POST /api/people` `{ name, history?: { played, tired }, prefs?: { blocked } }` | none | Makes a ticket, returns `{ person, prefs, passkeys, groups, ticket, imported }` |
| `POST /api/people/recover/options` | none | WebAuthn authentication options and a `challengeId` |
| `POST /api/people/recover` `{ challengeId, response }` | none | Verifies the assertion, rotates the key, returns the ticket like `GET /api/me` plus `ticket` |
| `GET /api/me` | ticket | `{ person: { id, name, createdAt }, prefs, passkeys, groups: [{ id, name }] }` |
| `PATCH /api/me` `{ name?, prefs?: { blocked?, filters? } }` | ticket | Merges preferences |
| `DELETE /api/me` | ticket | Deletes the ticket and everything under it |
| `GET /api/me/played` | ticket | `{ played: { key: ms }, tired: { key: ms } }` within the window |
| `POST /api/me/rounds` `{ rounds: [{ id, key, kind? }] }` | ticket | Records up to 50 plays for the holder |
| `POST /api/me/groups` `{ invite }` | ticket | The ticket joins the group the invite opens |
| `DELETE /api/me/groups/<groupId>` | ticket | Leaves it |
| `POST /api/me/passkey/options` | ticket | WebAuthn registration options and a `challengeId` |
| `POST /api/me/passkey` `{ challengeId, response }` | ticket | Stores the credential, returns the passkey count |
| `GET /api/group/people` | invite | `{ people: [{ id, name }] }`, the tickets in the group |
| `GET /api/group/played?people=a,b` | invite | Adds `people: { id: { played, tired } }` for the named members |
| `POST /api/group/rounds` | invite | Each round may carry `kind` and `people: [id]` |
| `POST /api/rooms/<CODE>/history` | host secret | `{ people: { id: { played, tired } } }` for the seated tickets |
| `POST /api/rooms/<CODE>/rounds` `{ rounds }` | host secret | Records the plays for every seated ticket |

Plays are idempotent the way group rounds are: each round is an event with a client id and a server timestamp, inserted once, and `person_played.last_played_at` only ever moves forward.

## Data and retention

New tables in `worker/migrations/0003_people.sql`, all additive: `people`, `passkeys`, `webauthn_challenges`, `group_people`, `person_played` (person, song key, kind, last played), `person_events` (idempotency log).
Windows are the group's: `PLAYED_TTL_DAYS` for `person_played` and `person_events`, `GROUP_IDLE_TTL_DAYS` for a ticket nobody writes to (its `active_at` moves on every write), five minutes for challenges.
The hourly sweep that runs off group and ticket writes deletes expired rows and idle people with everything under them; reads filter by the same windows and authentication refuses an idle ticket, so an expired row is never served.
Deleting a group deletes its `group_people` rows; deleting a ticket deletes its memberships, passkeys, history and challenges.

## Client

`src/lib/me.ts` holds the ticket (`tt_me`), an outbox (`tt_me_outbox`: the holder's own plays and pending preference edits), passkey ceremonies and the merged cooldown.

- `recordPlays(title, kind, people)` is called wherever `markPlayed` is, with every ticket in the cast: the group outbox carries `people`, and the holder's own outbox takes the play only when no group covers it.
- `presentCooldown(people)` fetches the group's history with `?people=` and the holder's own history where the group does not cover it, then folds this phone's, the group's and each present person's history through `cooldownOf` (docs/song-loading.md) into the crate's until-map, plus `heardBy`, how many of the people present heard each song.
- Blocked artists: a ticket's list is written to `tt_blocked` on adoption and on every load, and edits on the reveal or setup screen go back through the outbox (`PATCH /api/me`).
  Default filters (`mix`, `eras`, `difficulty`, `categories`) sync the same way, debounced, and are applied to the settings when the ticket is read.
- Group membership: making or taking a ticket while in a group, or joining a group while holding one, calls `POST /api/me/groups`; leaving the group on the phone leaves it for the ticket too.
  `fetchGroupPeople` refreshes the group's ticket list whenever the home screen is on view (and when it becomes visible again) and keeps it in `tt_group_people` for the roster chips.
- Roster: `RosterEntry.people` lists the ticket ids playing as that entry; the setup screen offers the group's tickets (and this phone's own when it is in no group) as "With a ticket" chips, marks linked entries with a ticket icon, and a team member added from a chip carries the ticket on the team.
- A 401 or 403 on any ticket call marks the ticket `revoked`; the card explains and offers "Remove from this phone".
- UI: `src/components/TicketPanel.tsx`, styled from the group card's classes with the cinema's vermilion frame.

## Rooms

- A phone with a ticket sends it in its hello (`join { key, name, ticket }`); the Durable Object checks the key against D1 (`worker/src/tickets.js`) and keeps only the person id on the seat.
  An invalid or unreachable ticket is a seat without one, never a refused join.
  The host's lobby marks such seats with a ticket icon (`players[].ticket`); phones see the same boolean and nothing else.
- At Start the host calls `POST /api/rooms/<CODE>/history` with its host secret; the Worker asks the object for the seated ids (`seated(hostHash)`) and returns their histories, which `roomCooldown` folds with the host's own and its group's.
- After every reveal or skip the host records the song for all seated tickets through `POST /api/rooms/<CODE>/rounds`, queued in `tt_room_outbox` so a reload loses nothing, next to the group's outbox as before.
- This is the one thing a room writes outside its Durable Object: song keys, kinds and times for the seated tickets, with the ticket's retention.
  The room's code, names, scores, buzzes and results never reach D1.

## Testing

`npm run e2e:tickets` (`e2e/tickets.mjs`) runs against a local `wrangler dev` with a fresh D1 (or `--worker=<origin>`).
WebKit has no virtual authenticator, so Asha's phone is Chromium at iPhone size with a CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`, resident keys, user verified); Ravi's phone and the phone the ticket moves to are WebKit, the group maker and the room host are desktop Chromium.
It checks the whole journey: making the ticket with the import and the passkey, the ticket taking Player 1's place, joining the group, Ravi's roster chip and every song of his show landing in Asha's history, the maker's crate and a room host's crate leaving all of it out, a revealed room song reaching the ticket, recovery on a fresh browser with the same credential (copied between virtual authenticators with `WebAuthn.getCredentials` and `addCredential`) and the old phone's ticket dying, the move link, playing with the Worker unreachable and the outbox draining afterwards, deletion, and the Worker's guards (401/403 for missing and wrong keys, forged assertions, foreign origins, input caps, rate limits, no ticket in any URL).
