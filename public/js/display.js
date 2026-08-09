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
  $('back').href = '/c/' + code;

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

  /* ── Sizing the cloud to the screen ──

     An earlier version maximised: it grew the type until the cloud exactly
     filled the stage, every time anything changed. On a finished cloud that
     looks right, but while one is being built it is awful. The first idea
     became enormous, the second halved it, the third moved it again, and every
     few votes shoved the whole wall around. Nobody can read a screen that is
     rescaling itself in front of them.

     So the baseline is a fixed, comfortable size, and the search only departs
     from it when it has to:

       - it shrinks whenever the cloud would overflow, which is the only case
         where doing nothing loses information off the screen;
       - it grows only up to a modest cap, so a cloud with three ideas in it
         looks like a cloud with three ideas in it rather than three billboards;
       - it ignores changes too small to be worth a reflow, so a vote arriving
         does not nudge every word on the wall.
  */
  const BASE_FIT = 1;
  /* The cap is what stops a nearly empty cloud becoming a billboard, so it
     has to be low enough that one idea is just a large word. It also has to
     be high enough that a real cloud on a real projector fills the wall: at
     1.5 a 29 idea cloud used only 58 percent of the height at 1920x1080,
     which is a lot of wasted legibility in a hall. */
  const MAX_FIT = 2.2;
  const MIN_FIT = 0.25;      // a very full one stays on screen
  const HYSTERESIS = 0.08;   // ignore adjustments under 8 percent

  let currentFit = BASE_FIT;

  /* Measured from layout boxes, never from scrollWidth or scrollHeight.

     CSS transforms contribute to a scroll container's overflow area, and this
     page transforms bubbles constantly: FLIP slides them when the field
     reflows, and pop() scales them when a count changes. Measuring scroll
     dimensions therefore picked up whichever animations happened to be mid
     flight and reported overflow that did not exist, so the search shrank the
     cloud for no reason and grew it back a moment later. offsetWidth and
     offsetHeight are layout only and ignore transforms entirely. */
  function fitsAt(value) {
    const stage = $('stage');
    const inner = $('stage-inner');
    const el = $('field');
    el.style.setProperty('--fit', value);

    /* Against the stage's CONTENT box, not clientHeight, which includes the
       padding that holds the controls clear. Measuring against clientHeight
       allowed a cloud exactly one padding taller than the space available, and
       because the stage centres its content that overspill was split top and
       bottom: the question slid under the controls and the last row slid under
       the footer. A hair spare on top of that, so rounding cannot clip a row. */
    const box = getComputedStyle(stage);
    const available = stage.clientHeight
      - parseFloat(box.paddingTop) - parseFloat(box.paddingBottom);
    if (inner.offsetHeight > available - 4) return false;

    // Entries never wrap mid phrase here, so one long idea has to be able to
    // push the whole cloud smaller.
    const room = el.clientWidth;
    for (const node of el.children) {
      if (node.offsetWidth > room) return false;
    }
    return true;
  }

  function fit() {
    const el = $('field');
    if (!entries.size) {
      currentFit = BASE_FIT;
      el.style.setProperty('--fit', BASE_FIT);
      return;
    }

    let target;
    if (!fitsAt(BASE_FIT)) {
      // Too much to show at the baseline. Search downward for the largest
      // size that still fits.
      let lo = MIN_FIT, hi = BASE_FIT;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (fitsAt(mid)) lo = mid; else hi = mid;
      }
      target = lo;
    } else if (fitsAt(MAX_FIT)) {
      // Plenty of room even at the cap, so take the cap and stop. No point
      // searching for a size we would not use.
      target = MAX_FIT;
    } else {
      let lo = BASE_FIT, hi = MAX_FIT;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (fitsAt(mid)) lo = mid; else hi = mid;
      }
      target = lo;
    }

    // Only actually move if it is a change worth seeing. Without this the wall
    // twitches on every vote.
    const drift = Math.abs(target - currentFit) / currentFit;
    if (drift > HYSTERESIS || !fitsAt(currentFit)) currentFit = target;
    el.style.setProperty('--fit', currentFit);
  }

  /* Fitting is deferred to the next frame, and several requests inside one
     frame collapse into a single run.

     Measuring synchronously inside draw() read the layout mid update and
     produced nonsense: the cloud would settle smaller after an idea was added
     and then larger after the next one, because a stale measurement had it
     searching the wrong half of the range. Waiting for the frame means the
     numbers being measured are the ones on screen. It also stops a burst of
     vote frames forcing a dozen synchronous layout passes each. */
  let fitQueued = false;
  function scheduleFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(function () {
      fitQueued = false;
      fit();
    });
  }

  function draw() {
    field.render([...entries.values()]);
    $('field-empty').hidden = entries.size > 0;
    scheduleFit();
  }

  function counts() {
    $('tally-people').textContent = people;
    $('tally-people-word').textContent = people === 1 ? 'person' : 'people';
    $('tally-ideas').textContent = entries.size;
    $('tally-ideas-word').textContent = entries.size === 1 ? 'idea' : 'ideas';
  }

  /* ── Bubbles or words ── */

  const SKIN = 'wc:display-skin';
  function setSkin(words) {
    $('field').classList.toggle('words', words);
    $('skin').textContent = words ? 'Bubbles' : 'Words';
    try { localStorage.setItem(SKIN, words ? 'words' : 'bubbles'); } catch (e) { /* private mode */ }
    scheduleFit();
  }
  let words = false;
  try { words = localStorage.getItem(SKIN) === 'words'; } catch (e) { /* private mode */ }
  setSkin(words);
  $('skin').addEventListener('click', function () {
    setSkin(!$('field').classList.contains('words'));
  });

  /* ── Big cloud ──

     Moves the join details to the top of the screen and enlarges them, for a
     room deep enough that the back row cannot read a normal join code. The
     cloud takes whatever height is left, so the fit has to run again. */

  const BIG = 'wc:display-big';
  function setBig(on) {
    document.body.classList.toggle('big', on);
    // Labelled with what pressing it will do, matching the skin toggle.
    $('big').textContent = on ? 'Normal cloud' : 'Big cloud';
    $('big').setAttribute('aria-pressed', String(on));
    try { localStorage.setItem(BIG, on ? 'big' : 'normal'); } catch (e) { /* private mode */ }
    scheduleFit();
  }
  let big = false;
  try { big = localStorage.getItem(BIG) === 'big'; } catch (e) { /* private mode */ }
  setBig(big);
  $('big').addEventListener('click', function () {
    setBig(!document.body.classList.contains('big'));
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
  addEventListener('resize', scheduleFit);
})();
