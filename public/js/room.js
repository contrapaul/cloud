/* The participant view.

   Phase 1 opens the pipe and nothing more: join, connect, render the question
   and the live counts. The typing interface and the bubble field arrive in
   phase 2, and they hang off onState and onDelta below. */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const params = new URLSearchParams(location.search);
  const code = CloudNet.codeFromUrl();

  function fail(msg) {
    $('err').textContent = msg;
    $('err').classList.remove('hidden');
  }

  if (!/^[A-Z2-9]{6}$/.test(code)) {
    fail('That link is missing a cloud code. Go back and join with a code.');
    return;
  }

  /* A host recovery link carries the host token. Adopt it, then strip it from
     the URL: this page gets shown on projectors and shared as a screenshot,
     and the token in the address bar is the one secret in the system. */
  if (params.get('h')) {
    CloudNet.adopt(params.get('h'));
    history.replaceState(null, '', '/c/' + code);
  }

  /* State the render will read once there is something to draw. */
  const state = { entries: new Map(), opts: null, isHost: false, locked: false };

  function counts(live, people, entries) {
    $('counts').textContent = people + (people === 1 ? ' person' : ' people')
      + ', ' + entries + (entries === 1 ? ' idea' : ' ideas')
      + ', ' + live + ' here now';
  }

  function onState(msg) {
    document.title = msg.title;
    $('head-title').textContent = msg.title;
    $('question').textContent = msg.question;
    state.opts = msg.opts;
    state.isHost = msg.you.isHost;
    state.locked = msg.locked;
    state.entries = new Map(msg.entries.map(function (e) { return [e.id, e]; }));
    counts(msg.live, msg.people, state.entries.size);
    $('field').textContent = state.entries.size
      ? 'Ideas arrive here in phase 2.'
      : 'Nothing in the cloud yet.';

    // Recorded here rather than at join, so the local list only ever holds
    // clouds that actually answered.
    CloudNet.remember({
      code: code,
      title: msg.title,
      role: msg.you.isHost ? 'host' : 'guest',
    });
  }

  function onDelta(msg) {
    if (msg.t === 'here') counts(msg.live, msg.people, state.entries.size);
  }

  function onStatus(s) {
    $('status').className = 'status ' + s;
    $('status').textContent = s === 'open' ? 'live' : 'reconnecting';
  }

  (async function start() {
    try {
      await CloudNet.request('POST', '/api/' + code + '/join', {
        token: CloudNet.me().token,
      });
    } catch (err) {
      fail(err.status === 404 ? 'This cloud no longer exists.' : err.message);
      return;
    }
    CloudNet.connect(code, { onState: onState, onDelta: onDelta, onStatus: onStatus });
  })();
})();
