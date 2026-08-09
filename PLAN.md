# Word cloud: build plan

A live, collaborative word cloud. One person opens a cloud and puts the code on
a projector. Everyone else joins on their phone, types what they are into, and
taps the bubbles other people added that they also match with. The bubbles grow
as support accumulates, so a single idea gets one big visual representation
instead of six fragmented spellings scattered across the screen.

First use: a school staff orientation, question "What are your hobbies or
interests?", running on a live display. Later use: a classroom tool.

**Target scale: 100+ concurrent participants.** This is the constraint that
shapes most of the technical decisions below.

## Non-negotiables

1. **No accounts.** Identity is an anonymous random token in `localStorage`.
2. **Fully anonymous.** No names anywhere, at all, in this version. Entries are
   never attributed in the UI or in the export. A named mode may come later but
   nothing is built for it now.
3. **No Google Fonts.** Every face is self-hosted from `public/fonts/`. A
   blocking stylesheet request to `fonts.googleapis.com` stalls first paint in
   China and can stop the page loading entirely. Nothing may be fetched from an
   external host, fonts included.
4. **No em dash characters anywhere.** Not in the UI, not in comments, not in
   docs. Use a comma, a full stop, or a colon.

## Architecture

Cloudflare Pages for the static site and the API, plus a separate Worker holding
one Durable Object per cloud. This mirrors the `blurt` repo, which is the
working precedent for the same pattern.

```
cloud.contrapaul.com          Pages project "cloud"     public/ + functions/
                          +   Worker "cloud-live"       WordCloudRoom DO
```

Why a separate repo rather than a directory inside `make/tools/`: the subdomain
would need a rewrite hack on a Pages project whose root is already
`make.contrapaul.com`, deploys would be coupled to the Blood Bowl auth stack in
the same Functions bundle, and everything currently in `tools/` is static with
no backend. A link card in `make/tools/index.html` keeps it discoverable.

```
public/
  index.html            main menu: New cloud, Join cloud, My clouds
  new/index.html        title, question, options, then the code and invite link
  c/index.html          participant view
  display/index.html    big screen projector view
  css/tokens.css        design tokens and @font-face, self hosted
  css/cloud.css
  js/cloud-net.js       identity, REST, WebSocket with reconnect
  js/profanity.js       client mirror of the server screen()
  fonts/                woff2, self hosted
  data/profanity.txt    single source of truth for the blocklist
  _redirects            /c/:code  ->  /c/?k=:code
functions/api/
  _lib.ts               HTTP helpers, code generation, DO plumbing
  _middleware.ts        error to JSON
  create.ts             POST, creates a cloud
  [code]/index.ts       GET, meta for the join screen
  [code]/join.ts        POST, claims an anonymous seat
  [code]/ws.ts          GET, WebSocket upgrade, injects the verified token
  [code]/export.ts      GET, CSV or JSON, host token required
workers/cloud-live/
  src/index.ts          WordCloudRoom
  src/profanity.ts      shared with the client mirror
```

The Pages Function is the only thing that talks to the DO, and it injects the
caller's token as `X-Cloud-Token` after deleting any client supplied copy. The
DO therefore trusts that header absolutely and talks to nothing else: no
database, no other service.

## The three things that differ from blurt, and why

Blurt is capped at 12 players. This is not. Copying its realtime layer verbatim
would fall over at 100.

### 1. Delta broadcasts, not whole state

`blurt-live` re-serialises the entire room for every open socket on every
change. At 100 participants all tapping bubbles that is O(n) full serialisations
per tap, so O(n squared) work for the room. Instead:

```
{t:'add',   id, text, n}
{t:'bumps', v:[[id,n], ...]}     // n is the new total, never an increment
{t:'hide',  id}
{t:'merge', from, into, n}
{t:'lock',  locked}
```

Full state is sent once on connect and once on reconnect, never otherwise.
Sending totals rather than increments means a dropped or duplicated frame
self-corrects on the next one.

### 2. Coalesced bumps

Vote changes accumulate in an in-memory map and flush as one merged frame every
150 ms. The scan-and-tap phase is exactly the burst this is built for: 200 taps
in a second becomes about 7 frames per second, not 200 broadcasts.

### 3. SQLite storage, not one JSON blob

Blurt does `storage.put('room', room)` on every write, rewriting the whole
object each time. With hundreds of entries and thousands of votes that is
wasteful and eventually slow. Use the SQLite storage API with real tables. Votes
in particular have to be rows so distinct voters can be counted.

## Data model

```sql
meta    (k TEXT PRIMARY KEY, v TEXT)
people  (id INTEGER PRIMARY KEY, token TEXT UNIQUE, joinedAt INTEGER)
entries (id INTEGER PRIMARY KEY, text TEXT, norm TEXT UNIQUE,
         authorId INTEGER, hidden INTEGER, mergedInto INTEGER, createdAt INTEGER)
votes   (entryId INTEGER, personId INTEGER, PRIMARY KEY (entryId, personId))
```

The primary key on `votes` buys the two things that matter most:

- **One vote per person per entry.** Tapping toggles. Without this one bored
  participant holding down a bubble makes the display meaningless and the export
  a lie.
- **An honest export.** "How many people chose this" is
  `COUNT(DISTINCT personId)`. The author is auto-voted on submit, so the number
  reads as "N people are into this".

`people.token` is the only identity that exists. No name column, by design.

## Anti-fragmentation

This is the actual point of the project, so it gets real work.

1. **Normalise on submit**: lowercase, trim, strip punctuation, collapse
   whitespace. An exact normalised match turns the submit into a vote for the
   existing entry, with a toast reading "Already up there, added your +1".
2. **Live suggestions while typing.** The client already holds every entry, so
   fuzzy match locally (substring plus Levenshtein distance 2) and show matching
   bubbles under the input: "Someone already added Warhammer, tap to join them".
   This catches "warhammer 40k" against "Warhammer", which normalisation alone
   will not.
3. **Host merge.** On the host panel, drag one bubble onto another to merge
   them. Votes are unioned by distinct person, so merging never double counts
   somebody who had tapped both. This is the safety net for when 40k and
   Warhammer both get in anyway, and it is the feature that makes this usable as
   a classroom discussion tool rather than just a display.

## Bubbles

**There are two fields on the participant screen, showing the same data for
two different jobs.** Below the input sits the tap field: every bubble the same
small size, in fixed creation order. It is a list to work through, so it has to
be dense enough to scan a lot of ideas at once and it must never move under a
thumb. Sizing it by support would bury new ideas and reshuffle the layout every
time anybody in the room tapped anything.

Growth is shown in two other places: a small height capped preview above the
input, sorted and sized by support, and the host's display view at full size.
Nobody is aiming at either of those, so they are free to move.

**Layout is a wrapping field of pills, not a spiral word cloud.** A spiral
layout re-solves itself whenever anything is added or resized, so during live
use it would thrash and jump under a thumb mid-tap. A flex-wrap field reflows
gracefully, works on a phone, and stays reliably tappable. FLIP animation makes
reflows glide rather than snap. A true cloud layout can be offered as a toggle
on the display view only, where nobody is tapping.

**Sizing**: `size = min + (max - min) * sqrt(votes / topVotes)`. The square root
stops a runaway winner eating the screen, and normalising against the current
leader means the whole field rescales as things grow, so it always fits.

**Feedback**: the bubble pops in scale on tap, the count ticks, and your own
votes stay visually marked, filled versus outline, so scanning and tapping has
the collect-them-all feel. You can see at a glance what you have already
claimed.

## Options at creation

| Option | Default | Note |
|---|---|---|
| Title | required | |
| Question | "What are your hobbies or interests?" | shown above the input |
| Entries per person | **unlimited** | deliberately open for the first run |
| Voting | on | |
| Max characters per entry | 40 | |
| Profanity filter | on | |

No name option. See non-negotiables.

## Saving and retention

Two layers, and the distinction matters.

- **Server**: the DO keeps a cloud for 30 days, then self deletes on an alarm
  sweep. This is the live copy.
- **Local**: every device stores a list of clouds it created or joined in
  `localStorage`. On the host device a full snapshot of entries and counts is
  written whenever the host opens the results panel, so **the data survives the
  server side cleanup**. "My clouds" lists them and can reopen a saved snapshot
  read only after the room is gone.

Host identity is a token in `localStorage`, same as everything else. Clearing
site data loses host control, so the create screen shows a one time host
recovery link (`/c/?k=CODE&h=<hostToken>`) with a prompt to bookmark it.

**Export**: CSV and JSON from the host panel. Columns `text, supporters,
added_at`. Sorted by supporters descending. No author column: anonymous means
anonymous.

## Reuse from blurt

| Copied | Change |
|---|---|
| `functions/api/_lib.ts` | drop the schedule builders, keep `newCode`, `validCode`, `roomStub`, `doCall`, `json`, `readJson`, `readData` |
| `functions/api/[code]/ws.ts` | rename the header to `X-Cloud-Token`, otherwise verbatim |
| `src/profanity.ts` and `data/profanity.txt` | verbatim apart from the header comment |
| `js/blurt-net.js` to `js/cloud-net.js` | drop clock skew, add delta dispatch |
| DO scaffold: `idFromName(code)`, `acceptWebSocket`, `serializeAttachment`, alarm cleanup | keep the shapes, replace the bodies |
| wrangler config pair, Pages plus Worker with `new_sqlite_classes` | rename |
| `css/tokens.css` and the self hosted fonts | verbatim, keeps the visual family |

## Phases

1. **Scaffold and vertical slice.** Both wrangler configs, copied files, home
   page, create page, `POST /api/create`, DO init with the schema, join, meta,
   and a WebSocket that delivers an empty snapshot.
   *Verify: create a cloud, open the invite link on a second browser, both
   sockets connect and report the same participant count.*
2. **Core loop.** Add entry, delta broadcast, bubble field render.
   *Verify: two browsers, typing in one shows a bubble in the other inside a
   second.*
3. **Voting.** Tap to toggle, distinct vote counting, sqrt sizing, coalesced
   bumps. *Verify: a script firing 100 concurrent toggles produces exact counts
   and batched frames.*
4. **Anti-fragmentation.** Normalisation, submit becomes vote, live suggestion
   strip.
5. **Host tools.** Hide, lock, merge, results panel, CSV and JSON export.
6. **Display view.** Big screen typography, QR code, live counts, join code
   always visible so latecomers can join off the projector.
7. **Local persistence.** My clouds, host snapshot, recovery link.
8. **Load test.** A script opening 80 to 120 sockets and firing random taps for
   two minutes. Do this for real before orientation day. Discovering the fan out
   problem in front of the whole staff is the one outcome worth an afternoon to
   avoid.

Phases 1 to 3 are a working demo. Phases 1 to 6 are everything orientation day
needs.

## Open risks

- **Reconnect storms.** 100 phones on one school wifi will drop together. The
  reconnect backoff needs jitter or they all come back in the same millisecond
  and each asks for a full snapshot.
- **Full snapshot size.** With 300 entries a snapshot is still only a few tens
  of KB, which is fine, but it is the one message that does not scale for free.
  Worth measuring at phase 8.
- **Moderation latency.** Hide has to reach the display view immediately, not on
  the next coalescing tick. Send it uncoalesced.
