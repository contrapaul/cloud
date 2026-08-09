/* The projector view. Read only: it opens a socket, draws, and sends nothing.

   Note it does not call /join, so the machine driving the projector never
   takes a seat and is never counted as a person or able to vote. */
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
  const field = Bubbles.field($('field'), {});
  let people = 0;

  function draw() {
    field.render([...entries.values()]);
    $('field-empty').hidden = entries.size > 0;
  }

  function counts() {
    $('counts').textContent = people + (people === 1 ? ' person' : ' people')
      + ', ' + entries.size + (entries.size === 1 ? ' idea' : ' ideas');
  }

  CloudNet.connect(code, {
    onState: function (msg) {
      document.title = msg.title;
      $('question').textContent = msg.question;
      people = msg.people;
      entries.clear();
      for (const e of msg.entries) entries.set(e.id, e);
      // Nothing on the wall belongs to anybody, so the "mine" highlight is
      // meaningless here and would just read as an arbitrary colour.
      for (const e of entries.values()) e.mine = false;
      draw();
      counts();
    },
    onDelta: function (msg) {
      if (msg.t === 'here') { people = msg.people; counts(); return; }
      if (msg.t === 'add') {
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
    },
    onStatus: function (s) {
      if (s === 'reconnecting' && !entries.size) {
        $('field-empty').textContent = 'Reconnecting.';
      }
    },
  });
})();
