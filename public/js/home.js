/* Home page: join by code, and list the clouds this device has seen. */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const errBox = $('err');

  function fail(msg) {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  }

  $('join').addEventListener('click', async function () {
    errBox.classList.add('hidden');
    const code = $('code').value.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      fail('That code does not look right. Six letters and numbers, no O or I.');
      return;
    }
    // Check the cloud is real before navigating, so a typo fails here with a
    // clear message rather than on a half loaded room screen.
    try {
      await CloudNet.request('GET', '/api/' + code);
    } catch (err) {
      fail(err.status === 404 ? 'No cloud with that code. Check it and try again.' : err.message);
      return;
    }
    location.href = '/c/' + code;
  });

  $('code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('join').click();
  });

  /* Your clouds.

     Held on this device only. There is no account, so this list and the saved
     results beside it are the entire history of what you took part in. */

  function when(ms) {
    const days = Math.floor((Date.now() - ms) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    return new Date(ms).toLocaleDateString();
  }

  function render() {
    const list = CloudNet.mine();
    const ul = $('mine');
    ul.textContent = '';

    if (!list.length) {
      $('mine-panel').classList.add('hidden');
      return;
    }

    for (const c of list) {
      const li = document.createElement('li');

      const a = document.createElement('a');
      a.href = '/c/' + c.code;

      const left = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = c.title || 'Untitled cloud';
      const sub = document.createElement('span');
      sub.className = 'muted tiny';
      sub.style.display = 'block';
      const snap = CloudNet.snapshot(c.code);
      sub.textContent = [
        c.role === 'host' ? 'you hosted' : 'you joined',
        when(c.seenAt),
        snap ? snap.results.length + ' ideas saved' : null,
      ].filter(Boolean).join(', ');
      left.append(title, sub);

      const tag = document.createElement('span');
      tag.className = 'code-tag';
      tag.textContent = c.code;

      a.append(left, tag);

      // Deliberately separate from the link, so opening a cloud and deleting
      // your only copy of it can never be the same tap.
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'forget';
      forget.title = 'Forget this cloud';
      forget.setAttribute('aria-label', 'Forget ' + (c.title || c.code));
      forget.textContent = '×';
      forget.addEventListener('click', function () {
        CloudNet.forget(c.code);
        render();
      });

      li.append(a, forget);
      ul.append(li);
    }
    $('mine-panel').classList.remove('hidden');
  }

  render();
})();
