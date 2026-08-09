/* Shared profanity screening.
 *
 * The word lists are NOT hardcoded here. They are loaded from
 * public/data/profanity.txt by the Pages Function and handed to the cloud at
 * init, so the file in the repo stays the single source of truth.
 *
 * An identical copy of normalise()/screen() runs client side in
 * public/js/profanity.js so somebody is warned while typing rather than
 * rejected at submit. Keep the two in step.
 */

export interface Blocklist {
  word: string[]; // matched as a whole word
  sub: string[];  // matched anywhere in the squashed string
}

/* Common substitutions used to slip past naive filters. */
const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a',
  '5': 's', '$': 's', '7': 't', '8': 'b', '9': 'g', '|': 'i',
};

function deleet(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) out += LEET[ch] ?? ch;
  return out;
}

/* Collapse runs of the same letter: "fuuuuck" -> "fuck". */
function squash(s: string): string {
  return s.replace(/([a-z])\1{2,}/g, '$1$1').replace(/([a-z])\1+/g, '$1');
}

export function parseBlocklist(text: string): Blocklist {
  const word: string[] = [];
  const sub: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('*')) {
      const t = deleet(line.slice(1).trim()).replace(/[^a-z]/g, '');
      if (t) sub.push(t);
    } else {
      const t = deleet(line).replace(/[^a-z]/g, '');
      if (t) word.push(t);
    }
  }
  return { word, sub };
}

/* True when `text` trips the blocklist. */
export function screen(text: string, list: Blocklist): boolean {
  if (!text) return false;
  const lower = deleet(text);

  // Whole-word pass: split on anything non-alphabetic, compare each token.
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  for (const tok of tokens) {
    if (list.word.includes(tok)) return true;
    if (list.word.includes(squash(tok))) return true;
  }

  // Substring pass: strip every separator so "f-u-c-k" and "f u c k" collapse.
  const flat = lower.replace(/[^a-z]/g, '');
  const flatSquashed = squash(flat);
  for (const frag of list.sub) {
    if (flat.includes(frag) || flatSquashed.includes(frag)) return true;
  }
  return false;
}
