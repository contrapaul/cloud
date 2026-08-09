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

  /* Your clouds */

  const list = CloudNet.mine();
  if (list.length) {
    const ul = $('mine');
    for (const c of list) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '/c/' + c.code;
      const title = document.createElement('span');
      title.textContent = c.title || 'Untitled cloud';
      const tag = document.createElement('span');
      tag.className = 'code-tag';
      tag.textContent = (c.role === 'host' ? 'host ' : '') + c.code;
      a.append(title, tag);
      li.append(a);
      ul.append(li);
    }
    $('mine-panel').classList.remove('hidden');
  }
})();
