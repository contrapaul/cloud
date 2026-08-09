/* The bubble field. Shared by the participant view and the projector view, so
   the thing on the wall and the thing in your hand are laid out by the same
   code and cannot drift apart.

   Rendering is incremental. Wiping the field and rebuilding it on every delta
   would throw away the DOM under somebody's thumb at the exact moment they are
   tapping, and at 100 participants deltas arrive constantly. */
(function () {
  'use strict';

  const HUES = ['--wc-b1', '--wc-b2', '--wc-b3', '--wc-b4', '--wc-b5', '--wc-b6'];

  /* Support to size, as a unitless 0 to 1 scale.

     JS decides the proportion, CSS decides what that proportion means in
     pixels, via --bubble-min and --bubble-max on the field. That split is what
     lets a phone keep a dozen bubbles on screen at once while the projector
     runs the same numbers out to something readable from the back of a hall.

     Square root rather than linear so a runaway winner cannot eat the screen,
     and normalised against the current leader so the whole field rescales as
     things grow and always fits. */
  function scaleFor(n, top) {
    if (top <= 1) return 0;
    return Math.sqrt(n / top);
  }

  function Field(el, opts) {
    this.el = el;
    this.opts = opts || {};
    this.nodes = new Map();
  }

  Field.prototype.make = function (entry) {
    const tag = this.opts.onTap ? 'button' : 'div';
    const b = document.createElement(tag);
    b.className = 'bubble';
    b.style.setProperty('--hue', 'var(' + HUES[entry.id % HUES.length] + ')');
    if (tag === 'button') {
      b.type = 'button';
      b.addEventListener('click', () => this.opts.onTap(entry.id));
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.text;
    const count = document.createElement('span');
    count.className = 'n';
    b.append(label, count);
    this.nodes.set(entry.id, b);
    return b;
  };

  /* entries: array of {id, text, n, mine}, any order. */
  Field.prototype.render = function (entries) {
    const el = this.el;

    // FLIP, first half: where is everything right now.
    const before = new Map();
    for (const [id, node] of this.nodes) before.set(id, node.getBoundingClientRect());

    /* Two orderings, for two jobs.

       'support' puts the most backed first, which is what you want on the wall
       and in the preview: the shape of the room's answer at a glance.

       'stable' is creation order, and it is the right choice for a field
       people are tapping. Re-sorting by support would mean every tap anybody
       makes reshuffles the list under everybody's thumb, so you would lose
       your place mid scan and mistap something you did not mean. Nothing ever
       moves in this one: new ideas append at the end. */
    const list = entries.slice();
    if (this.opts.order === 'stable') list.sort(function (a, b) { return a.id - b.id; });
    else list.sort(function (a, b) { return b.n - a.n || a.id - b.id; });

    const top = entries.reduce(function (m, e) { return e.n > m ? e.n : m; }, 1);
    const sorted = list;

    const seen = new Set();
    for (const entry of sorted) {
      let node = this.nodes.get(entry.id);
      if (!node) node = this.make(entry);
      seen.add(entry.id);

      node.style.setProperty('--s', scaleFor(entry.n, top).toFixed(3));
      node.classList.toggle('mine', !!entry.mine);
      const count = node.querySelector('.n');
      if (count.textContent !== String(entry.n)) count.textContent = entry.n;
      if (this.opts.onTap) {
        node.setAttribute('aria-pressed', String(!!entry.mine));
        node.setAttribute('aria-label', entry.text + ', ' + entry.n
          + (entry.n === 1 ? ' person' : ' people') + (entry.mine ? ', including you' : ''));
      }
      // appendChild on an existing child moves it, which is what reordering
      // needs. Order here is already sorted, so this settles into place.
      el.appendChild(node);
    }

    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue;
      node.remove();
      this.nodes.delete(id);
    }

    // FLIP, second half: start each moved bubble at its old position and let
    // it travel to the new one, so a reflow glides instead of snapping.
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const [id, node] of this.nodes) {
        const old = before.get(id);
        if (!old) continue;
        const now = node.getBoundingClientRect();
        const dx = old.left - now.left;
        const dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        node.animate(
          [{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }],
          { duration: 260, easing: 'cubic-bezier(0.2, 0, 0.2, 1)' }
        );
      }
    }
  };

  /* The element for an entry, so a caller can decorate it (the host's merge
     selection) without this module needing to know what the decoration means. */
  Field.prototype.node = function (id) {
    return this.nodes.get(id);
  };

  /* A brief pop, so growth is noticed on a field somebody is scanning. */
  Field.prototype.pop = function (id) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.classList.add('pop');
    setTimeout(function () { node.classList.remove('pop'); }, 180);
  };

  window.Bubbles = {
    field: function (el, opts) { return new Field(el, opts); },
  };
})();
