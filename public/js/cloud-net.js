/* CloudNet: identity, REST calls, the room socket, and the local cloud list.

   Identity is anonymous and always will be. A random token in localStorage is
   the whole account. There is no name, nowhere to put one, and nothing is sent
   to the server that could identify a person. Re-posting the same token
   reclaims the same seat, which is what makes a refresh harmless and stops one
   person voting twice by reloading.

   The socket receives one full snapshot on connect and deltas after that. Every
   delta carries totals rather than increments, so a dropped or duplicated frame
   corrects itself on the next one instead of drifting. */
(function () {
  'use strict';

  const KEY = 'wc:me';
  const LIST = 'wc:clouds';

  /* ── Identity ── */

  function me() {
    let m = null;
    try { m = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* corrupt, replace */ }
    if (!m || !m.token || m.token.length < 16) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      m = { token: [...b].map((x) => x.toString(16).padStart(2, '0')).join('') };
      localStorage.setItem(KEY, JSON.stringify(m));
    }
    return m;
  }

  /* Where the cloud code comes from.

     The invite link is /c/ABCDEF, and _redirects rewrites that to the page
     without changing the address bar, which is the whole point: the link stays
     short and clean when it is pasted into a chat app. That means the code is
     in the path and NOT in the query string on exactly the route most people
     arrive through. Read the path first, then fall back to ?k= for the links
     the site generates for itself. */
  function codeFromUrl() {
    const inPath = location.pathname.match(/\/([A-Z2-9]{6})\/?$/i);
    if (inPath) return inPath[1].toUpperCase();
    const k = new URLSearchParams(location.search).get('k') || '';
    return k.toUpperCase();
  }

  /* Take over an identity from a host recovery link. This replaces the token
     on this device, which is the point: the host token IS the host, so
     carrying it to a second browser is what moves control there. */
  function adopt(token) {
    if (!token || token.length < 16) return false;
    localStorage.setItem(KEY, JSON.stringify({ token: token }));
    return true;
  }

  /* ── The local cloud list ──
     The server copy of a cloud is deleted after 30 days. This list, and the
     snapshot a host writes alongside it, is what survives that. */

  function mine() {
    try { return JSON.parse(localStorage.getItem(LIST) || '[]'); } catch (e) { return []; }
  }

  function remember(entry) {
    const list = mine().filter((c) => c.code !== entry.code);
    list.unshift(Object.assign({ seenAt: Date.now() }, entry));
    try { localStorage.setItem(LIST, JSON.stringify(list.slice(0, 50))); } catch (e) { /* full */ }
  }

  /* The saved copy of a cloud's results.

     Written by every participant, not only the host, because the results are
     meant to be yours to keep and the server copy is deleted after 30 days.
     This is what makes a cloud you took part in still readable months later,
     with no account and nothing held on our side. */
  function snapshot(code) {
    try { return JSON.parse(localStorage.getItem('wc:snap:' + code) || 'null'); }
    catch (e) { return null; }
  }

  function saveSnapshot(code, data) {
    try { localStorage.setItem('wc:snap:' + code, JSON.stringify(data)); return true; }
    catch (e) { return false; }   // a full quota must never break the live cloud
  }

  function forget(code) {
    try {
      localStorage.removeItem('wc:snap:' + code);
      localStorage.setItem(LIST, JSON.stringify(mine().filter((c) => c.code !== code)));
    } catch (e) { /* nothing to do */ }
  }

  /* ── REST ── */

  async function request(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ── Socket ── */

  let ws = null;
  let code = null;
  let retries = 0;
  let closing = false;
  let handlers = {};
  let heartbeat = null;

  function connect(roomCode, h) {
    code = roomCode;
    handlers = h || {};
    closing = false;
    open();
  }

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const t = encodeURIComponent(me().token);
    ws = new WebSocket(proto + '://' + location.host + '/api/' + code + '/ws?t=' + t);

    ws.onopen = function () {
      retries = 0;
      handlers.onStatus && handlers.onStatus('open');
      // Some mobile networks drop an idle socket inside a minute, and the
      // close event does not always arrive. A cheap ping keeps it alive.
      clearInterval(heartbeat);
      heartbeat = setInterval(function () { send({ t: 'ping' }); }, 25000);
    };

    ws.onmessage = function (ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'pong') return;
      if (msg.t === 'state') handlers.onState && handlers.onState(msg);
      else handlers.onDelta && handlers.onDelta(msg);
    };

    ws.onclose = function () {
      clearInterval(heartbeat);
      if (closing) return;
      retries += 1;
      handlers.onStatus && handlers.onStatus('reconnecting');
      // Backoff with jitter. A hall full of phones drops off the same wifi at
      // the same instant, and without the random term they all come back in
      // the same millisecond and each asks for a full snapshot.
      const base = Math.min(10000, 700 * retries);
      setTimeout(open, base + Math.random() * base);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function close() {
    closing = true;
    clearInterval(heartbeat);
    try { if (ws) ws.close(); } catch (e) { /* already gone */ }
  }

  window.CloudNet = {
    me: me,
    adopt: adopt,
    codeFromUrl: codeFromUrl,
    mine: mine,
    remember: remember,
    snapshot: snapshot,
    saveSnapshot: saveSnapshot,
    forget: forget,
    request: request,
    connect: connect,
    send: send,
    close: close,
  };
})();
