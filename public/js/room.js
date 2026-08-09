/* The participant view: type an idea, watch everyone else's arrive.

   The client holds the whole entry list in a Map and the server sends deltas
   into it. Every delta carries the new total rather than an increment, so a
   dropped or duplicated frame corrects itself on the next one instead of
   leaving this device counting differently from the projector.

   Tapping a bubble to support it lands in phase 3. */
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

  const entries = new Map();

  /* Two views of the same data, which is the whole design of this screen.

     The field below the input is a list to work through: uniform bubbles in a
     fixed order, so tapping is aiming at something that does not move. The
     preview above the input is the cloud itself, sized by support and sorted
     by it, so you can watch the room's answer take shape while you type. */
  const field = Bubbles.field($('field'), { order: 'stable', onTap: tap });
  const mini = Bubbles.field($('mini'), { order: 'support' });

  let voting = true;
  let people = 0;
  let live = 0;
  let toastTimer = null;

  function draw() {
    const list = [...entries.values()];
    field.render(list);
    mini.render(list);
    $('mini').hidden = entries.size === 0;
    $('tap-hint').hidden = entries.size === 0 || !voting;
    $('field-empty').hidden = entries.size > 0;
    if (!entries.size) $('field-empty').textContent = 'Nothing in the cloud yet. Add the first idea.';
  }

  /* Tapping is optimistic. The server confirms with a 'mine' message and the
     room hears about it on the next coalesced frame, but waiting 150ms to
     redraw your own tap is exactly what would make this feel sluggish, and
     tapping fast through a long field is meant to be the fun part. */
  function tap(id) {
    const e = entries.get(id);
    if (!e || !voting) return;
    e.mine = !e.mine;
    e.n += e.mine ? 1 : -1;
    draw();
    field.pop(id);
    CloudNet.send({ t: 'vote', id: id });
  }

  function counts() {
    $('counts').textContent = people + (people === 1 ? ' person' : ' people')
      + ', ' + entries.size + (entries.size === 1 ? ' idea' : ' ideas')
      + ', ' + live + ' here now';
  }

  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast hidden'; }, 4000);
  }

  /* ── Sending ── */

  function submit() {
    const input = $('entry');
    const text = input.value.trim();
    if (!text) return;
    CloudNet.send({ t: 'add', text: text });
    // Cleared optimistically. The server answers with 'added' or 'dupe' either
    // way, and leaving the text sitting there invites a second tap on Add.
    input.value = '';
    input.focus();
  }

  $('add').addEventListener('click', submit);
  $('entry').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submit();
  });

  /* ── Receiving ── */

  function onState(msg) {
    document.title = msg.title;
    $('head-title').textContent = msg.title;
    $('question').textContent = msg.question;
    people = msg.people;
    live = msg.live;
    voting = msg.opts.voting && !msg.locked;

    entries.clear();
    for (const e of msg.entries) entries.set(e.id, e);

    $('entry').maxLength = msg.opts.maxChars;
    $('compose').hidden = !msg.you.seated || msg.locked;
    if (msg.locked) toast('This cloud is closed for new ideas.', '');

    draw();
    counts();

    // Recorded here rather than at join, so the local list only ever holds
    // clouds that actually answered.
    CloudNet.remember({
      code: code,
      title: msg.title,
      role: msg.you.isHost ? 'host' : 'guest',
    });
  }

  function onDelta(msg) {
    if (msg.t === 'here') {
      live = msg.live;
      people = msg.people;
      counts();
      return;
    }

    // Somebody else added an idea.
    if (msg.t === 'add') {
      entries.set(msg.id, { id: msg.id, text: msg.text, n: msg.n, mine: false });
      draw();
      counts();
      return;
    }

    // Your own idea came back. Same shape, but it is yours.
    if (msg.t === 'added') {
      entries.set(msg.id, { id: msg.id, text: msg.text, n: msg.n, mine: true });
      draw();
      counts();
      field.pop(msg.id);
      return;
    }

    // You typed something that was already up there, so it became support.
    if (msg.t === 'dupe') {
      const e = entries.get(msg.id);
      if (e) { e.n = msg.n; e.mine = true; draw(); field.pop(msg.id); }
      toast(msg.message, 'good');
      return;
    }

    // Your own tap, confirmed. The count here is authoritative and overwrites
    // whatever the optimistic update guessed, so a tap that raced somebody
    // else's, or was refused outright, settles on the truth.
    if (msg.t === 'mine') {
      const e = entries.get(msg.id);
      if (e) { e.mine = msg.mine; e.n = msg.n; draw(); }
      return;
    }

    if (msg.t === 'bumps') {
      for (const pair of msg.v) {
        const e = entries.get(pair[0]);
        if (e) e.n = pair[1];
      }
      draw();
      // Only the preview pulses. Popping bubbles in the field somebody is
      // aiming at, every time anybody in the room taps anything, would be
      // both distracting and a moving target.
      for (const pair of msg.v) mini.pop(pair[0]);
      return;
    }

    if (msg.t === 'reject') {
      toast(msg.message, 'bad');
      return;
    }
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
