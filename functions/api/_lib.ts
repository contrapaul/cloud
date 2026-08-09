/* Shared helpers for /api/*: HTTP plumbing, talking to the WordCloudRoom
   Durable Object, and loading the blocklist that lives as a plain text file
   under public/data/. */

/* ── HTTP ── */

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/* ── Identity ──
   There are no accounts. A participant is a random token generated in their
   browser and kept in localStorage, and nothing else. This function is the
   single place that decides whether one is well formed. */

export function readToken(request: Request, body?: any): string {
  const token = String(body?.token ?? '');
  if (token.length < 16) throw new HttpError(400, 'Missing participant token.');
  return token;
}

/* ── Room ── */

export function roomStub(env: any, code: string) {
  const id = env.CLOUD_ROOM.idFromName(code.toUpperCase());
  return env.CLOUD_ROOM.get(id);
}

// Unambiguous alphabet (no 0/O/1/I) for share codes, because these get read
// off a projector at the back of a hall and typed by hand.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export function validCode(code: string): boolean {
  return /^[A-Z2-9]{6}$/.test(code);
}

/* Every call to the DO goes through here, and every one of them carries the
   token this Function verified. The DO trusts X-Cloud-Token absolutely, so it
   must never be possible for a client to set it. */
export async function doCall(
  env: any,
  code: string,
  path: string,
  token: string,
  body?: unknown
): Promise<Response> {
  const res = await roomStub(env, code).fetch(`https://do/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cloud-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ── Static data files ──
   Source of truth is the repo, not a database: editing the blocklist is a text
   file change and a push. Cached per isolate so a busy Function is not
   re-reading it on every create. */

let _cache: Record<string, string> = {};

export async function readData(env: any, request: Request, file: string): Promise<string> {
  if (_cache[file]) return _cache[file];
  const url = new URL(`/data/${file}`, request.url).toString();
  // env.ASSETS is the Pages static asset binding. Plain fetch is the fallback
  // for contexts where it is not provided.
  const res = env.ASSETS ? await env.ASSETS.fetch(url) : await fetch(url);
  if (!res.ok) throw new Error(`Could not read ${file} (${res.status})`);
  const text = await res.text();
  _cache[file] = text;
  return text;
}
