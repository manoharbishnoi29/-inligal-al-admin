// Translation helper used by both the user site and the admin site.
// Provider options:
//   'mymemory' : free, no key. Small daily limit per device, quality is OK for short text.
//                Add your email in `email` to get a bigger free limit.
//   'google'   : Google Cloud Translation (needs a billing account). Put the key in `googleKey`
//                and restrict that key to your GitHub Pages domain in Google Cloud.
//   'none'     : turn translation off (UI still changes language, answers stay as the admin wrote them).
export const TRANSLATE = { provider: 'mymemory', email: '', googleKey: '' };

// Language the admin writes questions and answers in.
export const CONTENT_LANG = 'en';

export const LANGS = [
  { code: 'en', native: 'English' },
  { code: 'hi', native: 'हिन्दी' },
  { code: 'ur', native: 'اردو' },
  { code: 'bn', native: 'বাংলা' },
  { code: 'mr', native: 'मराठी' },
  { code: 'gu', native: 'ગુજરાતી' },
  { code: 'pa', native: 'ਪੰਜਾਬੀ' },
  { code: 'ta', native: 'தமிழ்' },
  { code: 'te', native: 'తెలుగు' },
  { code: 'kn', native: 'ಕನ್ನಡ' },
  { code: 'ml', native: 'മലയാളം' },
];
export const langName = (c) => LANGS.find((l) => l.code === c)?.native || c || '-';
export const isRTL = (c) => c === 'ur' || c === 'ar';

const SCRIPTS = [
  [/[\u0900-\u097F]/, 'hi'], [/[\u0600-\u06FF]/, 'ur'], [/[\u0980-\u09FF]/, 'bn'], [/[\u0A00-\u0A7F]/, 'pa'],
  [/[\u0A80-\u0AFF]/, 'gu'], [/[\u0B80-\u0BFF]/, 'ta'], [/[\u0C00-\u0C7F]/, 'te'], [/[\u0C80-\u0CFF]/, 'kn'], [/[\u0D00-\u0D7F]/, 'ml'],
];
/** Guess the language from the writing script. Returns null for Latin text (English / Hinglish). */
export function detectScriptLang(text) {
  for (const [re, code] of SCRIPTS) if (re.test(text)) return code;
  return null;
}

const mem = new Map();
const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

function chunk(text, max = 450) {
  const out = [];
  let cur = '';
  const push = (line) => {
    if ((cur ? cur.length + 1 : 0) + line.length > max && cur) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? cur + '\n' + line : line;
  };
  for (const line of text.split('\n')) {
    if (line.length <= max) push(line);
    else {
      let rest = line;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < 50) cut = max;
        push(rest.slice(0, cut));
        rest = rest.slice(cut).trim();
      }
      if (rest) push(rest);
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function viaMyMemory(q, from, to) {
  const pair = `${from === 'auto' ? 'Autodetect' : from}|${to}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(pair)}${TRANSLATE.email ? `&de=${encodeURIComponent(TRANSLATE.email)}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Translation service error ' + r.status);
  const d = await r.json();
  const out = d.responseData?.translatedText || '';
  if (Number(d.responseStatus) !== 200 || /^MYMEMORY WARNING/i.test(out)) throw new Error(d.responseDetails || 'Translation limit reached');
  return out;
}

async function viaGoogle(q, from, to) {
  const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(TRANSLATE.googleKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, target: to, format: 'text', ...(from === 'auto' ? {} : { source: from }) }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'Translation service error');
  return d.data.translations[0].translatedText;
}

/** Translate text. Throws if the service fails, so callers can fall back to the original text. */
export async function translateText(text, from, to) {
  text = String(text ?? '');
  if (!text.trim() || from === to || TRANSLATE.provider === 'none') return text;
  const key = hash(`${from}|${to}|${text}`);
  if (mem.has(key)) return mem.get(key);
  try {
    const hit = localStorage.getItem('tr1:' + key);
    if (hit !== null) {
      mem.set(key, hit);
      return hit;
    }
  } catch {}
  const useGoogle = TRANSLATE.provider === 'google' && TRANSLATE.googleKey;
  const parts = useGoogle ? [text] : chunk(text);
  const outs = [];
  for (const p of parts) outs.push(await (useGoogle ? viaGoogle : viaMyMemory)(p, from, to));
  const out = outs.join('\n').trim() || text;
  mem.set(key, out);
  try {
    localStorage.setItem('tr1:' + key, out);
  } catch {}
  return out;
}

/** Same as translateText but never throws. Returns { text, ok }. */
export async function safeTranslate(text, from, to) {
  try {
    return { text: await translateText(text, from, to), ok: true };
  } catch (e) {
    console.warn('translate failed', e.message);
    return { text, ok: false };
  }
}
