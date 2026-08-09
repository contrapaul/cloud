/* Finding the idea somebody is about to duplicate, while they are still typing.

   Exact normalised matches are the server's job: it collapses them on submit
   and the UNIQUE index guarantees it. That only catches spellings that are
   unarguably the same. It does nothing for "warhammer 40k" against
   "Warhammer", or "board game" against "Board games", and those are exactly
   the cases that fragment a cloud in practice.

   So this runs on the client, where it can suggest rather than decide. The
   client already holds every entry, so there is nothing to fetch and no round
   trip: it can run on every keystroke. A person picking their own match is
   also far safer than a server guessing, because a wrong automatic merge is
   invisible and permanent while a wrong suggestion is just ignored. */
(function () {
  'use strict';

  /* MUST stay in step with normalise() in workers/cloud-live/src/index.ts.
     If these two disagree, the suggestion strip will offer a match that the
     server then treats as a brand new entry, which is the one outcome that
     would make this feature worse than not having it. */
  function normalise(text) {
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /* Levenshtein, abandoned as soon as it cannot come in under max. Bounding it
     is what keeps this cheap enough to run against every entry per keystroke. */
  function distance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      let best = curr[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        if (curr[j] < best) best = curr[j];
      }
      if (best > max) return max + 1;
      const swap = prev; prev = curr; curr = swap;
    }
    return prev[b.length];
  }

  /* Typos scale with length. One edit is a slip on a short word, but demanding
     only one edit on a long phrase would miss most real near misses. */
  function threshold(len) {
    if (len <= 4) return 1;
    if (len <= 9) return 2;
    return 3;
  }

  function tokens(norm) {
    return norm.split(' ').filter(function (t) { return t.length >= 4; });
  }

  /* Lower score is a better match. Returns null for no match at all. */
  function score(queryNorm, entryNorm) {
    if (!queryNorm || !entryNorm) return null;
    if (queryNorm === entryNorm) return 0;

    // One contains the other. This is the "warhammer 40k" case, and the reason
    // for the length floor is that a two letter query is inside half the
    // cloud and suggesting all of it is just noise.
    const shorter = queryNorm.length < entryNorm.length ? queryNorm : entryNorm;
    if (shorter.length >= 3
      && (entryNorm.indexOf(queryNorm) !== -1 || queryNorm.indexOf(entryNorm) !== -1)) {
      // Prefer matches where the two are close in length: "board game" against
      // "board games" is a near certain duplicate, "art" inside "martial arts"
      // is much weaker.
      const longer = queryNorm.length > entryNorm.length ? queryNorm : entryNorm;
      return 1 + (1 - shorter.length / longer.length);
    }

    const max = threshold(Math.max(queryNorm.length, entryNorm.length));
    const d = distance(queryNorm, entryNorm, max);
    if (d <= max) return 3 + d;

    // Last resort: a shared substantial word. "watching movies" against
    // "watching films" is worth offering, but it is a weaker signal than the
    // rest so it sorts to the bottom and is easy to ignore.
    const qt = tokens(queryNorm);
    const et = tokens(entryNorm);
    for (const t of qt) if (et.indexOf(t) !== -1) return 8;

    return null;
  }

  /* entries: array of {id, text, n, mine}. Returns the best few, best first. */
  function suggest(query, entries, limit) {
    const q = normalise(query);
    if (q.length < 2) return [];

    const hits = [];
    for (const e of entries) {
      const s = score(q, normalise(e.text));
      if (s !== null) hits.push({ entry: e, s: s });
    }
    hits.sort(function (a, b) {
      // Break ties towards the better supported idea: if two are equally close,
      // the one the room has already gathered behind is the one to join.
      return a.s - b.s || b.entry.n - a.entry.n;
    });
    return hits.slice(0, limit || 3).map(function (h) { return h.entry; });
  }

  window.Match = { normalise: normalise, distance: distance, score: score, suggest: suggest };
})();
