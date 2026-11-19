// Knowledge crawler core. No third-party packages: only Node built-ins.
// It only reads PUBLIC pages, obeys robots.txt, refuses private / internal addresses (SSRF protection),
// never logs in, never sends cookies, and stops at the page limit you set in the admin panel.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { makeChunk, chunkText, normalizeText } from '../js/kb-common.js';

export const UA = 'IllegalAIBot/1.0 (knowledge crawler; respects robots.txt)';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|bmp|pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|mp3|mp4|avi|mov|wmv|webm|apk|exe|dmg|iso|css|js|json|xml|woff2?|ttf|eot)$/i;

/* ------------------------------------------------------------------ SSRF protection */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('2001:db8') || x.startsWith('64:ff9b');
  }
  return true;
}

export function checkUrlShape(u, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links are allowed');
  if (url.username || url.password) throw new Error('Links with a username or password are not allowed');
  if (!allowPrivate) {
    if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Only the standard web ports are allowed');
    const h = url.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') throw new Error('Internal addresses are not allowed');
    if (net.isIP(h.replace(/^\[|\]$/g, '')) && isPrivateIp(h.replace(/^\[|\]$/g, ''))) throw new Error('Private addresses are not allowed');
  }
  return url;
}

/** DNS lookup that refuses private addresses at connection time (stops DNS-rebinding tricks too). */
const safeLookup = (allowPrivate) => (host, opts, cb) => {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => allowPrivate || !isPrivateIp(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(new Error('Address is not public'));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
};

/** One safe GET with redirects handled by us (each hop is checked again). */
export async function safeGet(startUrl, { allowPrivate = false, timeoutMs = 15000, accept = 'text/html,text/plain;q=0.9' } = {}) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = checkUrlShape(current, { allowPrivate });
    const res = await new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        url,
        { method: 'GET', timeout: timeoutMs, lookup: safeLookup(allowPrivate), headers: { 'user-agent': UA, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en,hi;q=0.8' } },
        (r) => resolve(r)
      );
      req.on('timeout', () => req.destroy(new Error('Timed out')));
      req.on('error', reject);
      req.end();
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, url).href;
      continue;
    }
    const type = String(res.headers['content-type'] || '').toLowerCase();
    let stream = res;
    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
    if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
    else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
    if (res.statusCode !== 200) {
      res.resume();
      return { status: res.statusCode, type, body: '', url: url.href };
    }
    const chunks = [];
    let size = 0;
    for await (const c of stream) {
      size += c.length;
      if (size > MAX_BYTES) {
        res.destroy();
        break;
      }
      chunks.push(c);
    }
    return { status: 200, type, body: Buffer.concat(chunks).toString('utf8'), url: url.href };
  }
  throw new Error('Too many redirects');
}

/* ------------------------------------------------------------------ robots.txt */
export function parseRobots(text, agent = 'illegalaibot') {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], delay: 0 };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', pattern: val });
    else if (key === 'crawl-delay') cur.delay = Number(val) || 0;
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== '');
  const delay = Math.max(0, ...chosen.map((g) => g.delay), 0);
  const toRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  const compiled = rules.map((r) => ({ ...r, re: toRe(r.pattern), len: r.pattern.length }));
  return {
    delay,
    allowed(pathAndQuery) {
      let best = null;
      for (const r of compiled) {
        if (r.re.test(pathAndQuery) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
      }
      return !best || best.allow;
    },
  };
}

/* ------------------------------------------------------------------ HTML -> text */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', copy: '©' };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d) || 32))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);

export function parseHtml(html, baseUrl) {
  const noindex = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html) || /<meta[^>]+content=["'][^"']*noindex[^"']*["'][^>]*name=["']robots["']/i.test(html);
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
  const links = [];
  const nofollowPage = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*nofollow/i.test(html);
  if (!nofollowPage) {
    for (const m of html.matchAll(/<a\s[^>]*href=(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
      if (/rel=["'][^"']*nofollow/i.test(m[0])) continue;
      try {
        const u = new URL(decode(m[1] ?? m[2]).trim(), baseUrl);
        u.hash = '';
        if (/^https?:$/.test(u.protocol)) links.push(u.href);
      } catch {}
    }
  }
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<(script|style|noscript|svg|template|nav|footer|aside|form|iframe|button|select)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = body.match(/<(main|article)\b[\s\S]*?<\/\1>/i);
  if (main && main[0].length > 400) body = main[0];
  body = body.replace(/<\/(p|div|section|article|li|ul|ol|tr|table|h[1-6]|blockquote|pre|dd|dt)>/gi, '\n').replace(/<(br|hr)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '\n• ');
  const text = decode(body.replace(/<[^>]+>/g, ' '));
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1);
  return { title, text: normalizeText(lines.join('\n')), links, noindex };
}

/* ------------------------------------------------------------------ crawling one website */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function crawlSite(source, hooks = {}, opts = {}) {
  const { allowPrivate = false, deadline = Date.now() + 10 * 60 * 1000, minDelayMs = 1000, get = safeGet } = opts;
  const start = checkUrlShape(source.url, { allowPrivate });
  const maxPages = Math.min(Math.max(Number(source.maxPages) || 10, 1), 50);
  const origin = start.origin;
  let robots = parseRobots('');
  try {
    const r = await get(origin + '/robots.txt', { allowPrivate, accept: 'text/plain' });
    if (r.status === 200) robots = parseRobots(r.body);
  } catch {}
  const delayMs = Math.min(Math.max(minDelayMs, robots.delay * 1000), 10000);
  const pathOf = (u) => u.pathname + u.search;
  if (!robots.allowed(pathOf(start))) throw new Error('This website does not allow crawling this address (robots.txt).');

  const queue = [{ url: start.href, depth: 0 }];
  const seen = new Set([start.href]);
  const pages = [];
  const skipped = [];
  while (queue.length && pages.length < maxPages && Date.now() < deadline) {
    const { url, depth } = queue.shift();
    if (hooks.shouldStop && (await hooks.shouldStop())) throw Object.assign(new Error('Stopped'), { stopped: true });
    let res;
    try {
      res = await get(url, { allowPrivate });
    } catch (e) {
      skipped.push(`${url} (${e.message})`);
      continue;
    }
    if (res.status !== 200 || !/text\/(html|plain)|application\/xhtml/.test(res.type)) {
      skipped.push(`${url} (${res.status})`);
      await sleep(delayMs);
      continue;
    }
    const page = parseHtml(res.body, res.url);
    if (!page.noindex && page.text.length >= 60) {
      pages.push({ url: res.url, title: page.title || res.url, text: page.text });
      if (hooks.onPage) await hooks.onPage(pages.length, res.url);
    }
    if (depth < 3) {
      for (const l of page.links) {
        let u;
        try {
          u = new URL(l);
        } catch {
          continue;
        }
        if (u.origin !== origin || SKIP_EXT.test(u.pathname) || seen.has(u.href) || !robots.allowed(pathOf(u))) continue;
        if (seen.size >= maxPages * 6) break;
        seen.add(u.href);
        queue.push({ url: u.href, depth: depth + 1 });
      }
    }
    await sleep(delayMs);
  }
  return { pages, skipped, hitDeadline: Date.now() >= deadline };
}

/* ------------------------------------------------------------------ job processing */
const HOURS = 3600 * 1000;

export function isDue(s, now) {
  if (s.type !== 'website') return false;
  if (s.status === 'pending') return true;
  const every = Number(s.schedule?.everyHours) || 0;
  return (s.status === 'done' || s.status === 'error') && every > 0 && (Number(s.nextRunAt) || 0) <= now;
}

export async function learnSource(store, source, opts = {}) {
  const now = () => Date.now();
  const log = async (action, message) => store.addHistory({ sourceId: source.id, title: source.title || source.url, action, message, ts: now() });
  await store.updateSource(source.id, { status: 'running', error: null, progress: { pages: 0, chunks: 0, message: 'Crawling…' }, updatedAt: now() });
  try {
    const existing = await store.existingChunkIds(source.id);
    const newDocs = new Map();
    const { pages, skipped, hitDeadline } = await crawlSite(
      source,
      {
        shouldStop: async () => !(await store.getSource(source.id)),
        onPage: async (n, url) => store.updateSource(source.id, { progress: { pages: n, chunks: newDocs.size, message: url }, updatedAt: now() }),
      },
      opts
    );
    if (!pages.length) throw new Error('No readable pages were found. The site may need JavaScript, a login, or may block crawlers.');
    for (const p of pages) {
      for (const piece of chunkText(p.text)) {
        const c = makeChunk(source, piece, { pageUrl: p.url, pageTitle: p.title });
        if (!newDocs.has(c.id)) newDocs.set(c.id, c);
        if (newDocs.size >= 2000) break;
      }
    }
    const toAdd = [...newDocs.values()].filter((c) => !existing.has(c.id));
    const toRemove = [...existing].filter((id) => !newDocs.has(id));
    await store.writeChunks(toAdd);
    await store.deleteChunks(toRemove);
    const every = Number(source.schedule?.everyHours) || 0;
    await store.updateSource(source.id, {
      status: 'done', error: null, title: pages[0].title.slice(0, 120) || source.title,
      progress: { pages: pages.length, chunks: newDocs.size, message: hitDeadline ? 'Finished (time limit reached)' : 'Finished' },
      pageCount: pages.length, chunkCount: newDocs.size, lastLearnedAt: now(), updatedAt: now(), nextRunAt: every ? now() + every * HOURS : 0,
    });
    await log(existing.size ? 'updated' : 'learned', `${pages.length} pages, ${toAdd.length} new, ${toRemove.length} removed, ${newDocs.size - toAdd.length} unchanged${skipped.length ? `, ${skipped.length} skipped` : ''}`);
    return { pages: pages.length, added: toAdd.length, removed: toRemove.length };
  } catch (e) {
    if (e.stopped) {
      // the source was deleted while learning: clean up anything we wrote
      await store.deleteChunks([...(await store.existingChunkIds(source.id))]);
      return { stopped: true };
    }
    const every = Number(source.schedule?.everyHours) || 0;
    await store.updateSource(source.id, {
      status: 'error', error: String(e.message || e).slice(0, 300), updatedAt: now(), nextRunAt: every ? now() + every * HOURS : 0,
      progress: { pages: 0, chunks: 0, message: 'Failed' },
    });
    await log('error', String(e.message || e).slice(0, 300));
    return { error: e.message };
  }
}

export async function processDue(store, opts = {}) {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 12 * 60 * 1000;
  const sources = (await store.listSources()).filter((s) => isDue(s, t0));
  const done = [];
  for (const s of sources.slice(0, 5)) {
    if (Date.now() - t0 > budget) break;
    done.push({ id: s.id, ...(await learnSource(store, s, { ...opts, deadline: Math.min(t0 + budget, Date.now() + 6 * 60 * 1000) })) });
  }
  return done;
}
