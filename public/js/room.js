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
  const hints = Bubbles.field($('suggest-field'), { order: 'support', onTap: joinInstead });

  const hiddenEntries = new Map();
  const hiddenField = Bubbles.field($('hidden-field'), { order: 'stable', onTap: unhide });

  let voting = true;
  let votingOption = true;
  let seated = false;
  let locked = false;
  let isHost = false;
  let manage = false;
  let selected = null;      // entry id the host has picked
  let mergeFrom = null;     // set once they have chosen to merge it somewhere
  let people = 0;
  let live = 0;
  let toastTimer = null;

  const cloudInfo = { title: '', question: '' };

  function draw() {
    scheduleSave();
    const list = [...entries.values()];
    field.render(list);
    mini.render(list);
    $('mini').hidden = entries.size === 0;
    // Fade the preview only when it is genuinely holding more than it shows.
    $('mini').classList.toggle('faded', $('mini').scrollHeight > $('mini').clientHeight + 2);
    $('tap-hint').hidden = entries.size === 0 || !voting;
    $('field-empty').hidden = entries.size > 0;
    if (!entries.size) $('field-empty').textContent = 'Nothing in the cloud yet. Add the first idea.';
  }

  /* Tapping is optimistic. The server confirms with a 'mine' message and the
     room hears about it on the next coalesced frame, but waiting 150ms to
     redraw your own tap is exactly what would make this feel sluggish, and
     tapping fast through a long field is meant to be the fun part. */
  function tap(id) {
    // While the host is tidying, the same bubbles mean something else.
    if (manage) return select(id);

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
    showSuggestions();
    input.focus();
  }

  /* Tapping a suggestion: back the idea that is already there rather than
     adding a near duplicate beside it.

     This never toggles. Tapping a bubble in the field below means "change my
     mind about this", but tapping one up here means "yes, that is what I was
     typing", and having that quietly withdraw support because you already
     backed it would be the opposite of what you just asked for. */
  function joinInstead(id) {
    const e = entries.get(id);
    if (!e) return;
    if (!e.mine && voting) {
      e.mine = true;
      e.n += 1;
      CloudNet.send({ t: 'vote', id: id });
      toast('Joined "' + e.text + '" instead of adding a duplicate.', 'good');
    } else {
      toast('You already back "' + e.text + '".', '');
    }
    $('entry').value = '';
    showSuggestions();
    draw();
  }

  /* Runs on every keystroke. Matching is local and bounded, so there is no
     debounce: the whole point is that the warning arrives before somebody has
     finished typing the duplicate, not after. */
  function showSuggestions() {
    const text = $('entry').value;
    const box = $('suggest');
    if (!text.trim()) { box.hidden = true; hints.render([]); return; }

    const found = Match.suggest(text, [...entries.values()], 3);
    if (!found.length) { box.hidden = true; hints.render([]); return; }

    const exact = Match.normalise(found[0].text) === Match.normalise(text);
    $('suggest-hint').textContent = exact
      ? 'That is already up there. Tap it to add your support.'
      : 'Somebody may have said this already. Tap to join them, or add yours anyway.';
    hints.render(found);
    box.hidden = false;
  }

  $('add').addEventListener('click', submit);
  $('entry').addEventListener('input', showSuggestions);
  $('entry').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submit();
  });

  /* ── Receiving ── */

  function onState(msg) {
    document.title = msg.title;
    $('head-title').textContent = msg.title;
    $('question').textContent = msg.question;
    cloudInfo.title = msg.title;
    cloudInfo.question = msg.question;
    people = msg.people;
    live = msg.live;
    votingOption = msg.opts.voting;
    seated = msg.you.seated;
    locked = msg.locked;
    voting = votingOption && !locked;
    isHost = msg.you.isHost;

    entries.clear();
    for (const e of msg.entries) entries.set(e.id, e);
    hiddenEntries.clear();
    for (const e of msg.hiddenEntries || []) hiddenEntries.set(e.id, e);

    $('entry').maxLength = msg.opts.maxChars;
    $('compose').hidden = !seated || locked;
    $('host-panel').hidden = !isHost;
    $('toggle-lock').textContent = locked ? 'Reopen the cloud' : 'Close the cloud to new ideas';
    if (locked) toast('This cloud is closed for new ideas.', '');
    if (!isHost && manage) setManage(false);

    draw();
    drawHidden();
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
      // Somebody else may have just added the very thing being typed here.
      // Two people racing to submit the same idea is common in the first
      // minute, and catching it in that window is the whole value.
      if ($('entry').value.trim()) showSuggestions();
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

    if (msg.t === 'hide') {
      const e = entries.get(msg.id);
      if (e) {
        entries.delete(msg.id);
        // Only the host is told hidden ideas still exist, so only the host
        // has anywhere to put it.
        if (isHost) { hiddenEntries.set(msg.id, e); drawHidden(); }
        if (selected === msg.id) clearSelection();
        draw();
        counts();
      }
      return;
    }

    if (msg.t === 'unhide') {
      hiddenEntries.delete(msg.id);
      entries.set(msg.id, { id: msg.id, text: msg.text, n: msg.n, mine: false });
      drawHidden();
      draw();
      counts();
      return;
    }

    if (msg.t === 'merge') {
      // Read before deleting: backing either side before the merge means
      // backing the survivor after it. The server unioned the voters, and this
      // mirrors that locally so nobody has to reload to see it.
      const from = entries.get(msg.from);
      const wasMine = !!(from && from.mine);
      entries.delete(msg.from);
      const into = entries.get(msg.into);
      if (into) {
        into.n = msg.n;
        if (wasMine) into.mine = true;
      }
      if (selected === msg.from || mergeFrom === msg.from) clearSelection();
      draw();
      counts();
      return;
    }

    if (msg.t === 'lock') {
      setLocked(msg.locked);
      toast(msg.locked
        ? 'The host has closed this cloud.'
        : 'The cloud is open again.', '');
      return;
    }
  }

  /* ── Host controls ── */

  function paint(id, on) {
    const node = field.node(id);
    if (node) node.classList.toggle('picked', on);
  }

  function clearSelection() {
    if (selected !== null) paint(selected, false);
    selected = null;
    mergeFrom = null;
    $('manage-bar').hidden = true;
    $('manage-actions').hidden = false;
    $('do-hide').hidden = false;
    $('do-merge').hidden = false;
  }

  function select(id) {
    const e = entries.get(id);
    if (!e) return;

    // Second half of a merge: the first pick folds into this one.
    if (mergeFrom !== null && mergeFrom !== id) {
      const from = entries.get(mergeFrom);
      CloudNet.send({ t: 'merge', from: mergeFrom, into: id });
      toast('Folded "' + (from ? from.text : 'that') + '" into "' + e.text + '".', 'good');
      clearSelection();
      return;
    }

    if (selected !== null) paint(selected, false);
    selected = id;
    // Tapping the same idea again backs out of a half started fold, so the
    // full set of actions has to come back with it.
    mergeFrom = null;
    paint(id, true);
    $('manage-say').textContent = 'Selected "' + e.text + '"';
    $('manage-actions').hidden = false;
    $('do-hide').hidden = false;
    $('do-merge').hidden = false;
    $('manage-bar').hidden = false;
  }

  function setManage(on) {
    manage = on;
    clearSelection();
    document.body.classList.toggle('managing', on);
    $('toggle-manage').textContent = on ? 'Done tidying' : 'Tidy up the cloud';
    $('tap-hint').textContent = on
      ? 'Tap an idea to hide it or fold it into another'
      : 'Tap words submitted by other people to join them';
  }

  function unhide(id) {
    CloudNet.send({ t: 'unhide', id: id });
  }

  function drawHidden() {
    hiddenField.render([...hiddenEntries.values()]);
    $('hidden-box').hidden = hiddenEntries.size === 0;
  }

  function setLocked(on) {
    locked = on;
    voting = votingOption && !on;
    $('compose').hidden = on || !seated;
    $('toggle-lock').textContent = on ? 'Reopen the cloud' : 'Close the cloud to new ideas';
    draw();
  }

  /* The export is fetched rather than linked, so the host token travels in a
     POST body instead of a URL that would land in history and in logs. */
  async function download(format) {
    try {
      const res = await fetch('/api/' + code + '/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: CloudNet.me().token, format: format }),
      });
      if (!res.ok) {
        const err = await res.json().catch(function () { return {}; });
        throw new Error(err.error || 'Export failed (' + res.status + ')');
      }
      const blob = await res.blob();
      const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name ? name[1] : 'cloud.' + format;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Exported ' + format.toUpperCase() + '.', 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  /* The server copy is deleted after 30 days, so the host's own device keeps
     the record. Saved continuously rather than behind a button, because the
     one time somebody needs this is the time they forgot to press it.

     Debounced because it has to follow every change, including merges and
     hides, and a cloud mid burst redraws several times a second. Writing the
     whole record on each of those would be wasted work, but writing it only on
     connect would leave the saved copy describing a cloud that no longer
     exists: pre merge, pre moderation, and wrong in exactly the places the
     host has just corrected. */
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer !== null || !cloudInfo.title) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      CloudNet.saveSnapshot(code, {
        code: code,
        title: cloudInfo.title,
        question: cloudInfo.question,
        people: people,
        savedAt: Date.now(),
        results: [...entries.values()]
          .map(function (e) { return { text: e.text, supporters: e.n }; })
          .sort(function (x, y) { return y.supporters - x.supporters; }),
      });
    }, 1000);
  }

  $('toggle-manage').addEventListener('click', function () { setManage(!manage); });
  $('toggle-lock').addEventListener('click', function () {
    CloudNet.send({ t: 'lock', locked: !locked });
  });
  $('do-cancel').addEventListener('click', clearSelection);
  $('do-hide').addEventListener('click', function () {
    if (selected === null) return;
    CloudNet.send({ t: 'hide', id: selected });
    clearSelection();
  });
  $('do-merge').addEventListener('click', function () {
    if (selected === null) return;
    mergeFrom = selected;
    const e = entries.get(mergeFrom);
    $('manage-say').textContent = 'Now tap the idea to fold "' + (e ? e.text : '') + '" into';
    $('manage-actions').hidden = true;
    // Cancel has to stay reachable, or a half finished merge traps the host.
    $('do-cancel').hidden = false;
    $('manage-actions').hidden = false;
    $('do-hide').hidden = true;
    $('do-merge').hidden = true;
  });
  $('export-csv').addEventListener('click', function () { download('csv'); });
  $('export-json').addEventListener('click', function () { download('json'); });

  function onStatus(s) {
    $('status').className = 'status ' + s;
    $('status').textContent = s === 'open' ? 'live' : 'reconnecting';
  }

  /* ── The saved copy ──

     When the server has forgotten a cloud, the same link still works: it falls
     back to whatever this device kept. That is the point of saving locally.
     Nothing here talks to the network. */

  function showSaved(snap) {
    document.title = snap.title;
    $('head-title').textContent = snap.title;
    $('status').className = 'status';
    $('status').textContent = 'saved';
    $('question').textContent = '';
    $('counts').textContent = '';
    $('compose').hidden = true;
    $('mini').hidden = true;
    $('field-empty').hidden = true;
    $('tap-hint').hidden = true;

    $('saved-question').textContent = snap.question || snap.title;
    $('saved-when').textContent = 'Kept from ' + new Date(snap.savedAt).toLocaleDateString()
      + '.';
    $('saved-counts').textContent = snap.people + (snap.people === 1 ? ' person, ' : ' people, ')
      + snap.results.length + (snap.results.length === 1 ? ' idea' : ' ideas');

    const saved = Bubbles.field($('saved-field'), { order: 'support' });
    saved.render(snap.results.map(function (r, i) {
      return { id: i, text: r.text, n: r.supporters, mine: false };
    }));

    $('saved').hidden = false;

    $('saved-csv').addEventListener('click', function () { savedCsv(snap); });
    $('saved-forget').addEventListener('click', function () {
      CloudNet.forget(code);
      location.href = '/';
    });
  }

  /* Mirrors csvCell() in functions/api/[code]/export.ts. Quote everything, and
     neutralise a leading =, + or - so a typed answer cannot be executed as a
     formula when the file is opened in a spreadsheet. */
  function savedCsv(snap) {
    const cell = function (v) {
      const risky = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
      return '"' + String(risky).replace(/"/g, '""') + '"';
    };
    const rows = [['idea', 'supporters'].map(cell).join(',')];
    for (const r of snap.results) rows.push([cell(r.text), cell(String(r.supporters))].join(','));
    const blob = new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (snap.title || 'cloud').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '').slice(0, 40) + '-' + code + '.csv';
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  (async function start() {
    try {
      await CloudNet.request('POST', '/api/' + code + '/join', {
        token: CloudNet.me().token,
      });
    } catch (err) {
      const snap = CloudNet.snapshot(code);
      if (err.status === 404 && snap) { showSaved(snap); return; }
      fail(err.status === 404
        ? 'This cloud no longer exists, and this device has no saved copy of it.'
        : err.message);
      return;
    }
    CloudNet.connect(code, { onState: onState, onDelta: onDelta, onStatus: onStatus });
  })();
})();
