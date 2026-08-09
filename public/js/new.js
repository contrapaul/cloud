/* Create a cloud, then show the code and the links to share it. */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const errBox = $('err');

  function fail(msg) {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
    errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function copier(btn, getText, done) {
    btn.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(getText());
        btn.textContent = done;
        setTimeout(function () { btn.textContent = btn.dataset.label; }, 1800);
      } catch (e) {
        // Clipboard access is refused in some in app browsers. The text is on
        // screen either way, so say so rather than failing silently.
        fail('Could not reach the clipboard. Select the link and copy it by hand.');
      }
    });
  }

  $('create').addEventListener('click', async function (e) {
    errBox.classList.add('hidden');
    const title = $('title').value.trim();
    if (!title) {
      fail('Give the cloud a title. It is what you will recognise it by later.');
      $('title').focus();
      return;
    }

    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      const res = await CloudNet.request('POST', '/api/create', {
        token: CloudNet.me().token,
        title: title,
        question: $('question').value.trim(),
        maxEntries: Number($('maxEntries').value),
        maxChars: Number($('maxChars').value),
        voting: $('voting').value === 'on',
        filterOn: $('filterOn').value === 'on',
      });

      CloudNet.remember({ code: res.code, title: title, role: 'host' });

      const base = location.origin;
      const link = base + '/c/' + res.code;
      $('out-code').textContent = res.code;
      $('out-link').textContent = link;
      $('out-host').textContent = base + '/c/?k=' + res.code
        + '&h=' + encodeURIComponent(CloudNet.me().token);
      $('go-room').href = '/c/' + res.code;
      $('go-display').href = '/display/' + res.code;

      copier($('copy'), function () { return link; }, 'Copied');
      copier($('copy-host'), function () { return $('out-host').textContent; }, 'Copied');

      $('setup').classList.add('hidden');
      $('share').classList.remove('hidden');
      window.scrollTo(0, 0);
    } catch (err) {
      fail(err.message);
      btn.disabled = false;
      btn.textContent = 'Create the cloud';
    }
  });

  $('copy').dataset.label = 'Copy the link';
  $('copy-host').dataset.label = 'Copy the recovery link';

  $('title').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('create').click();
  });
})();
