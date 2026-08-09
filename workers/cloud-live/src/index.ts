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
    // Intents (add / vote / hide / merge / lock) arrive in phase 2 onward.
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
