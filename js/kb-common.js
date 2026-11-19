// Shared by the admin site, the user site and the crawler. Plain ES module, no browser or Node specific code.

const STOP = new Set(
  ('the a an and or of to in on for with is are was were be been it its this that these those as at by from can how what when where why who which ' +
    'do does did your you we they he she not no if then than so such will would should could may might about into over under more most other some any all each also just only very ' +
    'है हैं था थी थे का की के को में से पर और या कि यह वह एक भी तो ही नहीं हो कर').split(' ')
);

/** Lower-case words (any language) without common filler words, most frequent first. Used to search the knowledge base. */
export function termsOf(text, max = 60) {
  const freq = new Map();
  for (const w of String(text).toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (w.length < 2 || w.length > 30 || STOP.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, max).map((e) => e[0]);
}

export function normalizeText(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split text into readable pieces of about `max` characters (paragraphs first, then sentences, then words). */
export function chunkText(text, { max = 900, min = 40 } = {}) {
  const out = [];
  let cur = '';
  const flush = () => {
    const t = cur.trim();
    if (t.length >= min) out.push(t);
    cur = '';
  };
  const add = (piece) => {
    if (cur && cur.length + piece.length + 1 > max) flush();
    cur = cur ? cur + '\n' + piece : piece;
  };
  for (const para of normalizeText(text).split(/\n+/)) {
    if (para.length <= max) {
      add(para);
      continue;
    }
    flush();
    const sentences = para.split(/(?<=[.!?।؟])\s+/);
    for (let s of sentences) {
      while (s.length > max) {
        let cut = s.lastIndexOf(' ', max);
        if (cut < max / 2) cut = max;
        add(s.slice(0, cut));
        flush();
        s = s.slice(cut).trim();
      }
      if (s) add(s);
    }
  }
  flush();
  return out;
}

/** Small fast hash (two 53-bit hashes joined) used to spot duplicate text. */
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export const hash2 = (s) => cyrb53(s, 1).toString(36) + cyrb53(s, 7).toString(36);

/** Stable id so the same text is never stored twice for one source. */
export const chunkId = (sourceId, text) => `${sourceId}_${hash2(normalizeText(text).toLowerCase())}`;

/** Build a Firestore chunk document. */
export function makeChunk(source, text, extra = {}) {
  const t = normalizeText(text);
  return {
    id: chunkId(source.id, t),
    data: {
      sourceId: source.id,
      sourceTitle: String(source.title || '').slice(0, 120),
      sourceType: source.type,
      pageUrl: extra.pageUrl || source.url || '',
      pageTitle: String(extra.pageTitle || '').slice(0, 160),
      text: t,
      terms: termsOf(t, 60),
      hash: hash2(t.toLowerCase()),
      updatedAt: Date.now(),
    },
  };
}
