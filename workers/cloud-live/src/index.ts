/* cloud-live: a Durable Object hosting one word cloud per share code.
 *
 * The DO is authoritative for everything: the entry list, the vote tallies and
 * who has voted for what. Clients send small intents (add / vote / hide) and
 * receive small deltas back. Unlike a per-recipient redacted view, everyone in
 * a word cloud sees the same thing, so there is exactly one payload per frame
 * and it can be serialised once and fanned out.
 *
 * That matters here in a way it did not in blurt. This has to hold 100+
 * participants, so the rule is: full state on connect only, deltas forever
 * after, and vote deltas coalesced into one frame per flush window.
 *
 * Identity is anonymous. A person is a random token and nothing else. There is
 * no name column anywhere in this file, deliberately.
 *
 * All access arrives through Pages Functions (/api/*), which inject the
 * caller's token as X-Cloud-Token. The DO talks to nothing else: no database,
 * no other service.
 */

import { Blocklist, parseBlocklist, screen } from './profanity';

interface Opts {
  maxEntries: number;      // 0 means unlimited
  voting: boolean;
  maxChars: number;
  filterOn: boolean;
}

interface Cloud {
  code: string;
  title: string;
  question: string;
  hostToken: string;       // secret, never leaves the DO
  opts: Opts;
  locked: boolean;
  blocklist: Blocklist;
  createdAt: number;
}

/* A cloud sticks around for 30 days, then deletes itself. The durable copy is
   the snapshot written to the host's own device, not this. */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/* One submission per person per 500ms. Not a security control, just enough to
   stop a stuck key or an impatient double tap turning into ten rows. */
const ADD_EVERY_MS = 500;

/* Tapping is rate limited as a token bucket rather than a minimum gap, because
   the intended behaviour IS a burst: you scan the field and tap the six things
   you are also into, as fast as you can read them. A minimum gap between taps
   would throw most of that away.

   A vote is a toggle bounded by the primary key on votes, so no amount of
   tapping can corrupt a total. This only exists to cap the cost of a script. */
const VOTE_BURST = 12;
const VOTE_REFILL_MS = 100;

/* How long vote changes accumulate before one merged frame goes out.

   This is the number that makes 100+ participants viable. Broadcasting each
   tap separately means every tap costs one send per socket, so a room where
   everyone is scanning and tapping at once produces a fan out storm. Buffering
   for 150ms turns a burst of 200 taps into roughly 7 frames a second, and
   150ms is short enough that a tap still feels immediate, helped by the client
   updating its own bubble optimistically rather than waiting for this. */
const FLUSH_MS = 150;

/* The key that decides whether two submissions are the same idea.

   This is the whole point of the project. "Warhammer", "warhammer" and
   "Warhammer!" have to collapse to one bubble, because a cloud that splits a
   single idea across three entries defeats the exercise. Fuzzier matching
   ("warhammer 40k" against "Warhammer") is a phase 4 job and belongs on the
   client, where it can suggest rather than decide. This function only ever
   collapses things that are unarguably identical. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // strip accents, so cafe matches the accented spelling
    .replace(/[^\p{L}\p{N}]+/gu, ' ')  // punctuation and emoji become spaces
    .trim()
    .replace(/\s+/g, ' ');
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class WordCloudRoom {
  ctx: DurableObjectState;
  sql: SqlStorage;
  cached: Cloud | null = null;
  /* Submission throttle, per person. In memory on purpose: it is worth
     nothing after a restart and costs nothing to lose. */
  lastAdd = new Map<number, number>();
  voteBucket = new Map<number, { tokens: number; ts: number }>();

  /* Vote totals waiting to go out as one merged frame. Holding the total
     rather than a delta means repeated taps on the same entry inside a window
     collapse to a single number, and a frame that never arrives is corrected
     by the next one rather than leaving a client counting wrong. */
  pending = new Map<number, number>();
  flushTimer: any = null;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    // Idempotent, so it is safe on every wake rather than only at init.
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        token    TEXT UNIQUE NOT NULL,
        joinedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        text       TEXT NOT NULL,
        norm       TEXT UNIQUE NOT NULL,
        authorId   INTEGER NOT NULL,
        hidden     INTEGER NOT NULL DEFAULT 0,
        mergedInto INTEGER,
        createdAt  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS votes (
        entryId  INTEGER NOT NULL,
        personId INTEGER NOT NULL,
        PRIMARY KEY (entryId, personId)
      );
      CREATE INDEX IF NOT EXISTS votes_by_entry ON votes (entryId);
    `);
  }

  async cloud(): Promise<Cloud | undefined> {
    if (this.cached) return this.cached;
    const c: Cloud | undefined = await this.ctx.storage.get('cloud');
    this.cached = c ?? null;
    return c;
  }

  async saveCloud(c: Cloud): Promise<void> {
    this.cached = c;
    await this.ctx.storage.put('cloud', c);
  }

  /* ────────────────────────────── HTTP ────────────────────────────── */

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const token = request.headers.get('X-Cloud-Token') || '';

    if (path.endsWith('/init') && request.method === 'POST') {
      if (await this.cloud()) return json({ error: 'This cloud already exists.' }, 409);
      const b: any = await request.json();
      const cloud: Cloud = {
        code: b.code,
        title: b.title,
        question: b.question,
        hostToken: b.hostToken,
        opts: b.opts,
        locked: false,
        // The Function ships the raw file. Parsing here keeps one copy of the
        // parser and lets the client reuse the same parsed lists.
        blocklist: parseBlocklist(b.blocklistText ?? ''),
        createdAt: Date.now(),
      };
      await this.saveCloud(cloud);
      this.person(b.hostToken);           // the host holds seat 1
      await this.ctx.storage.setAlarm(Date.now() + RETAIN_MS);
      return json({ ok: true });
    }

    const cloud = await this.cloud();
    if (!cloud) return json({ error: 'Cloud not found.' }, 404);

    if (path.endsWith('/ws')) return this.handleWs(request, cloud, token);

    if (path.endsWith('/join') && request.method === 'POST') {
      if (token.length < 16) return json({ error: 'Missing token.' }, 400);
      const id = this.person(token);
      return json({ ok: true, personId: id, isHost: token === cloud.hostToken });
    }

    /* Meta for the join screen, before a socket is opened. Nothing here is
       secret: it is what somebody typing a code needs in order to decide
       whether they are in the right place. */
    if (path.endsWith('/meta') && request.method === 'GET') {
      return json({
        code: cloud.code,
        title: cloud.title,
        question: cloud.question,
        locked: cloud.locked,
        people: this.countPeople(),
        entries: this.countEntries(),
      });
    }

    return json({ error: 'Not found.' }, 404);
  }

  /* Anonymous seat. The token is the whole account, so returning to a cloud
     on the same device silently reclaims the same seat and therefore the same
     votes. Returns the person id. */
  person(token: string): number {
    const found = [...this.sql.exec('SELECT id FROM people WHERE token = ?', token)];
    if (found.length) return Number(found[0].id);
    this.sql.exec(
      'INSERT INTO people (token, joinedAt) VALUES (?, ?)',
      token,
      Date.now()
    );
    return Number(this.sql.exec('SELECT last_insert_rowid() AS id').one().id);
  }

  findPerson(token: string): number | null {
    if (!token || token.length < 16) return null;
    const found = [...this.sql.exec('SELECT id FROM people WHERE token = ?', token)];
    return found.length ? Number(found[0].id) : null;
  }

  countPeople(): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM people').one().n);
  }

  countEntries(): number {
    return Number(
      this.sql.exec(
        'SELECT COUNT(*) AS n FROM entries WHERE hidden = 0 AND mergedInto IS NULL'
      ).one().n
    );
  }

  /* ─────────────────────────── WebSocket ──────────────────────────── */

  async handleWs(request: Request, cloud: Cloud, token: string): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'Expected a WebSocket.' }, 426);
    }

    // Lookup, never insert. POST /join is the only thing that creates a seat,
    // so a socket whose token has not joined is a viewer: it receives
    // everything and can send nothing. That is exactly what the display view
    // wants, and it keeps the machine driving the projector out of the
    // participant count.
    const personId = this.findPerson(token);
    const isHost = !!token && token === cloud.hostToken;

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // Only the person id and the host flag ride along. The secret token stays
    // in storage, so a hibernated socket cannot leak it.
    server.serializeAttachment({ personId, isHost });

    server.send(JSON.stringify(this.snapshot(cloud, personId, isHost)));
    // Somebody arriving changes the live count that everyone else is showing.
    this.broadcast({ t: 'here', live: this.liveCount(), people: this.countPeople() }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.t === 'ping') { ws.send(JSON.stringify({ t: 'pong' })); return; }

    const att = (ws as any).deserializeAttachment?.() || {};
    const personId: number | null = att.personId ?? null;
    if (personId === null) return;        // viewers are read only

    const cloud = await this.cloud();
    if (!cloud) return;

    if (msg.t === 'add') await this.add(ws, cloud, personId, msg);
    else if (msg.t === 'vote') this.vote(ws, cloud, personId, msg);
    // hide / merge / lock arrive in phase 5.
  }

  /* Tapping a bubble to say "I am into that too".

     Toggles, so a mistaken tap can be taken back. The primary key on votes is
     what makes the count trustworthy: one person contributes at most one to
     any entry no matter how many times they tap it, which is what lets the
     export claim to be a count of people rather than a count of taps. */
  vote(ws: WebSocket, cloud: Cloud, personId: number, msg: any) {
    const id = Number(msg.id);
    if (!Number.isInteger(id)) return;

    /* Whenever a tap is not going to be applied, the tapper is sent the real
       state of that entry instead of nothing at all.

       The client updates its own bubble optimistically so tapping feels
       instant, which means a silently dropped tap would leave that device
       showing an idea as supported when the server disagrees, with nothing to
       correct it until a reconnect. Somebody would walk away believing they
       had backed something they had not. */
    const correct = () => {
      const mine = Number(this.sql.exec(
        'SELECT COUNT(*) AS n FROM votes WHERE entryId = ? AND personId = ?', id, personId
      ).one().n) > 0;
      ws.send(JSON.stringify({ t: 'mine', id, mine, n: this.voteCount(id) }));
    };

    const row = [...this.sql.exec(
      'SELECT id FROM entries WHERE id = ? AND hidden = 0 AND mergedInto IS NULL', id
    )];
    if (!row.length) return;

    if (!cloud.opts.voting || cloud.locked) return correct();

    const now = Date.now();
    const bucket = this.voteBucket.get(personId) ?? { tokens: VOTE_BURST, ts: now };
    const gained = Math.floor((now - bucket.ts) / VOTE_REFILL_MS);
    if (gained > 0) {
      bucket.tokens = Math.min(VOTE_BURST, bucket.tokens + gained);
      bucket.ts = now;
    }
    if (bucket.tokens <= 0) {
      this.voteBucket.set(personId, bucket);
      return correct();
    }
    bucket.tokens -= 1;
    this.voteBucket.set(personId, bucket);

    const had = Number(this.sql.exec(
      'SELECT COUNT(*) AS n FROM votes WHERE entryId = ? AND personId = ?', id, personId
    ).one().n) > 0;

    if (had) {
      this.sql.exec('DELETE FROM votes WHERE entryId = ? AND personId = ?', id, personId);
    } else {
      this.sql.exec('INSERT OR IGNORE INTO votes (entryId, personId) VALUES (?, ?)', id, personId);
    }

    const n = this.voteCount(id);
    // The tapper is told directly and immediately. Only they need to know
    // whether the bubble is now theirs, and waiting for the coalescing window
    // to confirm their own tap is what would make it feel laggy.
    ws.send(JSON.stringify({ t: 'mine', id, mine: !had, n }));
    this.queueBump(id, n);
  }

  /* Buffer a new total for broadcast. See FLUSH_MS. */
  queueBump(entryId: number, n: number) {
    this.pending.set(entryId, n);
    if (this.flushTimer !== null) return;
    // A pending timer keeps the object awake, so the buffer cannot be lost to
    // hibernation: an idle room has nothing buffered by definition.
    this.flushTimer = setTimeout(() => this.flushBumps(), FLUSH_MS);
  }

  flushBumps() {
    this.flushTimer = null;
    if (!this.pending.size) return;
    const v = [...this.pending.entries()];
    this.pending.clear();
    this.broadcast({ t: 'bumps', v });
  }

  /* Somebody submits an idea.

     The interesting case is not the happy path, it is the duplicate. An exact
     normalised match does not create a second bubble and does not fail either:
     it turns into support for the entry that is already there. That is the
     behaviour the whole project exists for, and the UNIQUE index on norm means
     the database enforces it rather than trusting this function to remember. */
  async add(ws: WebSocket, cloud: Cloud, personId: number, msg: any) {
    const reject = (why: string, message: string) =>
      ws.send(JSON.stringify({ t: 'reject', why, message }));

    if (cloud.locked) {
      return reject('locked', 'This cloud is closed for new ideas.');
    }

    /* Throttle reads here but is only stamped once we are about to write, at
       the bottom. A rejected submission changes nothing, so charging it to the
       throttle would mean somebody who trips the filter and immediately fixes
       their wording gets silently ignored. A genuine double tap still gets
       nothing back, which is right: their first tap already worked. */
    const last = this.lastAdd.get(personId) ?? 0;
    if (Date.now() - last < ADD_EVERY_MS) return;

    const text = String(msg.text ?? '').trim().replace(/\s+/g, ' ').slice(0, cloud.opts.maxChars);
    if (!text) return;

    const norm = normalise(text);
    // Nothing but punctuation or emoji. There is no idea in here to record.
    if (!norm) return reject('empty', 'Type a word or a short phrase.');

    if (cloud.opts.filterOn && screen(text, cloud.blocklist)) {
      return reject('filter', 'That one will not fly. Try another.');
    }

    const existing = [...this.sql.exec(
      'SELECT id, hidden, mergedInto FROM entries WHERE norm = ?', norm
    )];

    if (existing.length) {
      const row = existing[0];
      // The host struck this one. Silently re-adding it would undo a
      // moderation decision, so say no rather than resurrecting it.
      if (Number(row.hidden) === 1) {
        return reject('removed', 'That one was removed by the host.');
      }
      // Follow a merge, so supporting a folded entry supports its new home.
      const target = row.mergedInto === null ? Number(row.id) : Number(row.mergedInto);
      this.lastAdd.set(personId, Date.now());
      const added = this.castVote(target, personId);
      const n = this.voteCount(target);
      ws.send(JSON.stringify({
        t: 'dupe',
        id: target,
        n,
        message: added
          ? 'Already up there, so we added your support instead.'
          : 'You are already backing that one.',
      }));
      if (added) this.queueBump(target, n);
      return;
    }

    // The per person cap counts what you authored, never what you supported.
    // Tapping other people's bubbles has to stay unlimited: the scanning and
    // tapping is the part that makes the cloud worth looking at.
    if (cloud.opts.maxEntries > 0) {
      const authored = Number(this.sql.exec(
        'SELECT COUNT(*) AS n FROM entries WHERE authorId = ? AND hidden = 0', personId
      ).one().n);
      if (authored >= cloud.opts.maxEntries) {
        return reject('limit', 'You have added all your ideas. Support other people\'s instead.');
      }
    }

    this.lastAdd.set(personId, Date.now());
    this.sql.exec(
      'INSERT INTO entries (text, norm, authorId, hidden, mergedInto, createdAt) VALUES (?, ?, ?, 0, NULL, ?)',
      text, norm, personId, Date.now()
    );
    const id = Number(this.sql.exec('SELECT last_insert_rowid() AS id').one().id);
    // Adding an idea is itself a vote for it, so the count reads as the number
    // of people who are into this rather than the number who tapped it.
    this.castVote(id, personId);

    // The author is told separately so the shared frame stays one string for
    // every other socket. Building a per recipient payload to carry a "mine"
    // flag would put us back to N serialisations per event.
    ws.send(JSON.stringify({ t: 'added', id, text, n: 1 }));
    this.broadcast({ t: 'add', id, text, n: 1 }, ws);
  }

  /* Returns true when this was a new vote, false when the person already had
     one. The primary key on votes is what makes a second tap a no op, so one
     person can never inflate an entry by holding it down. */
  castVote(entryId: number, personId: number): boolean {
    const before = this.voteCount(entryId);
    this.sql.exec(
      'INSERT OR IGNORE INTO votes (entryId, personId) VALUES (?, ?)', entryId, personId
    );
    return this.voteCount(entryId) > before;
  }

  voteCount(entryId: number): number {
    return Number(this.sql.exec(
      'SELECT COUNT(*) AS n FROM votes WHERE entryId = ?', entryId
    ).one().n);
  }

  async webSocketClose(ws: WebSocket) {
    this.broadcast({ t: 'here', live: this.liveCount(ws), people: this.countPeople() }, ws);
  }

  /* ───────────────────────────── Views ────────────────────────────── */

  /* The full picture. Sent on connect and on reconnect, never otherwise: at
     100+ participants this is the one message that does not scale for free. */
  snapshot(cloud: Cloud, personId: number | null, isHost: boolean): any {
    const mine = new Set<number>();
    if (personId !== null) {
      for (const r of this.sql.exec('SELECT entryId FROM votes WHERE personId = ?', personId)) {
        mine.add(Number(r.entryId));
      }
    }

    const rows = this.sql.exec(`
      SELECT e.id, e.text, COUNT(v.personId) AS n
      FROM entries e
      LEFT JOIN votes v ON v.entryId = e.id
      WHERE e.hidden = 0 AND e.mergedInto IS NULL
      GROUP BY e.id
      ORDER BY n DESC, e.id ASC
    `);

    return {
      t: 'state',
      code: cloud.code,
      title: cloud.title,
      question: cloud.question,
      opts: cloud.opts,
      locked: cloud.locked,
      you: { isHost, seated: personId !== null },
      live: this.liveCount(),
      people: this.countPeople(),
      entries: [...rows].map((r) => ({
        id: Number(r.id),
        text: String(r.text),
        n: Number(r.n),
        mine: mine.has(Number(r.id)),
      })),
    };
  }

  /* Ground truth for who is here is the set of open sockets. A persisted
     "connected" flag goes stale the moment a socket dies without a close event
     (a crash, a phone going into a tunnel) and then never recovers. */
  liveCount(except?: WebSocket): number {
    let n = 0;
    for (const sock of this.ctx.getWebSockets()) if (sock !== except) n += 1;
    return n;
  }

  /* One payload, serialised once, fanned out. Never build the message per
     recipient: at 100 sockets that turns every tap into 100 serialisations. */
  broadcast(msg: unknown, except?: WebSocket) {
    const text = JSON.stringify(msg);
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === except) continue;
      try { sock.send(text); } catch { /* socket closing, ignore */ }
    }
  }

  async alarm() {
    const cloud = await this.cloud();
    if (!cloud) return;
    if (Date.now() - cloud.createdAt >= RETAIN_MS) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(cloud.createdAt + RETAIN_MS);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('cloud-live: access via /api/*', { status: 404 });
  },
};
