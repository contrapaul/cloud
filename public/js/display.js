/* The projector view. Read only: it opens a socket, draws, and sends nothing.

   Note it does not call /join, so the machine driving the projector never
   takes a seat and is never counted as a person or able to vote. */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const code = CloudNet.codeFromUrl();

  if (!/^[A-Z2-9]{6}$/.test(code)) {
    $('field').textContent = 'This link is missing a cloud code.';
    return;
  }

  $('code').textContent = code;
  $('host').textContent = location.host;

  let entries = 0;

  function counts(people, ideas) {
    $('counts').textContent = people + (people === 1 ? ' person' : ' people')
      + ', ' + ideas + (ideas === 1 ? ' idea' : ' ideas');
  }

  CloudNet.connect(code, {
    onState: function (msg) {
      document.title = msg.title;
      $('question').textContent = msg.question;
      entries = msg.entries.length;
      counts(msg.people, entries);
      $('field').textContent = entries ? '' : 'Nothing in the cloud yet.';
    },
    onDelta: function (msg) {
      if (msg.t === 'here') counts(msg.people, entries);
    },
    onStatus: function (s) {
      if (s === 'reconnecting') $('field').textContent = 'Reconnecting.';
    },
  });
})();
