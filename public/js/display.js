/* The projector view. Read only: it opens a socket, draws, and sends nothing.

   It does not call /join, so the machine driving the projector never takes a
   seat, is never counted as a person, and cannot vote.

   Two things matter here that do not matter on a phone. The cloud has to fill
   the screen, because a hall reads it from thirty feet away and dead space is
   wasted legibility. And the join code has to stay on screen for the whole
   session, because people arrive late and the wall is the only instruction
   they will get. */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const code = CloudNet.codeFromUrl();

  if (!/^[A-Z2-9]{6}$/.test(code)) {
    $('field-empty').textContent = 'This link is missing a cloud code.';
    return;
  }

  $('code').textContent = code;
  $('host').textContent = location.host;

  const entries = new Map();
  const field = Bubbles.field($('field'), { order: 'support' });
  let people = 0;

  /* ── Join code ── */

  const inviteUrl = location.origin + '/c/' + code;
  try {
    const qr = qrcode(0, 'M');       // 0 picks the smallest version that fits
    qr.addData(inviteUrl);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 1, margin: 1, scalable: true });
  } catch (err) {
    // A missing QR is a smaller problem than a blank display, and the code
    // beside it is readable on its own.
    $('qr').remove();
  }

  /* ── Filling the screen ──

     Binary search on a scale multiplier. Nine passes lands within a fraction
     of a percent, and each pass is one layout read, so this is cheap enough to
     run on every change. Doing it in JS rather than with vw units is what lets
     the type respond to how MUCH is in the cloud: five ideas should be huge,
     eighty should shrink to fit rather than scroll away. */
  function fit() {
    const stage = $('stage');
    const inner = $('stage-inner');
    const el = $('field');
    if (!entries.size) { el.style.setProperty('--fit', 1); return; }

    let lo = 0.25, hi = 6;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      el.style.setProperty('--fit', mid);
      // A hair under the stage box, so a rounding difference cannot leave the
      // last row clipped. Width matters too: entries never wrap mid phrase
      // here, so one long idea has to be able to push the whole cloud smaller.
      const fits = inner.scrollHeight <= stage.clientHeight - 4
        && el.scrollWidth <= el.clientWidth + 1;
      if (fits) lo = mid;
      else hi = mid;
    }
    el.style.setProperty('--fit', lo);
  }

  function draw() {
    field.render([...entries.values()]);
    $('field-empty').hidden = entries.size > 0;
    fit();
  }

  function counts() {
    $('tally-people').textContent = people;
    $('tally-label').textContent = (people === 1 ? 'person, ' : 'people, ')
      + entries.size + (entries.size === 1 ? ' idea' : ' ideas');
  }

  /* ── Bubbles or words ── */

  const SKIN = 'wc:display-skin';
  function setSkin(words) {
    $('field').classList.toggle('words', words);
    $('skin').textContent = words ? 'Bubbles' : 'Words';
    try { localStorage.setItem(SKIN, words ? 'words' : 'bubbles'); } catch (e) { /* private mode */ }
    fit();
  }
  let words = false;
  try { words = localStorage.getItem(SKIN) === 'words'; } catch (e) { /* private mode */ }
  setSkin(words);
  $('skin').addEventListener('click', function () {
    setSkin(!$('field').classList.contains('words'));
  });

  /* ── Live ── */

  CloudNet.connect(code, {
    onState: function (msg) {
      document.title = msg.title;
      $('question').textContent = msg.question;
      people = msg.people;
      entries.clear();
      // Nothing on the wall belongs to anybody, so the "mine" highlight is
      // meaningless here and would read as an arbitrary colour.
      for (const e of msg.entries) entries.set(e.id, { id: e.id, text: e.text, n: e.n, mine: false });
      draw();
      counts();
    },
    onDelta: function (msg) {
      if (msg.t === 'here') { people = msg.people; counts(); return; }

      if (msg.t === 'add' || msg.t === 'unhide') {
        entries.set(msg.id, { id: msg.id, text: msg.text, n: msg.n, mine: false });
        draw();
        counts();
        field.pop(msg.id);
        return;
      }

      if (msg.t === 'bumps') {
        for (const pair of msg.v) {
          const e = entries.get(pair[0]);
          if (e) e.n = pair[1];
        }
        draw();
        for (const pair of msg.v) field.pop(pair[0]);
        return;
      }

      // Moderation has to reach the wall at once. This is the screen the host
      // is looking at when they decide something has to come down.
      if (msg.t === 'hide') {
        entries.delete(msg.id);
        draw();
        counts();
        return;
      }

      if (msg.t === 'merge') {
        entries.delete(msg.from);
        const into = entries.get(msg.into);
        if (into) into.n = msg.n;
        draw();
        counts();
        return;
      }
    },
    onStatus: function (s) {
      if (s === 'reconnecting' && !entries.size) {
        $('field-empty').textContent = 'Reconnecting.';
      }
    },
  });

  // Projectors get plugged in and resolutions change mid session.
  addEventListener('resize', fit);
})();
