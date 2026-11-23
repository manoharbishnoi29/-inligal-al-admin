import { esc, toast, icon, initTheme, debounce, registerSW, timeAgo } from './shared.js';
import { configured, app, db, fs } from './firebase.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { chunkText, makeChunk, normalizeText, termsOf, hash2 } from './kb-common.js';

const PDF_JS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
const col = (n) => fs.collection(db, n);

let SOURCES = [];
let tab = 'overview';
let kbFilter = 'all';
let unsubSources = null;

/* ---------- static UI ---------- */
$('#sideLogo').innerHTML = icon('chat', 20);
$('#menuBtn').innerHTML = icon('menu');
$('#logoutBtn').innerHTML = `${icon('logout')} Sign out`;
$$('#nav a').forEach((a) => (a.innerHTML = `${icon(a.dataset.i)}<span>${a.innerHTML}</span>`));
initTheme($('#themeBtn'));
registerSW();
$('#menuBtn').addEventListener('click', () => $('#app').classList.add('open'));
$('#scrim').addEventListener('click', () => $('#app').classList.remove('open'));
$('#logoutBtn').addEventListener('click', async () => {
  await signOut(getAuth(app));
  location.href = 'index.html';
});

/* ---------- modal helpers ---------- */
function openModal(html, { wide = false } = {}) {
  closeModal();
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  bd.addEventListener('mousedown', (e) => e.target === bd && closeModal());
  document.body.appendChild(bd);
  document.body.classList.add('modal-open');
  return bd.querySelector('.modal');
}
function closeModal() {
  const bd = $('.modal-backdrop');
  if (bd) {
    bd._onClose?.();
    bd.remove();
  }
  document.body.classList.remove('modal-open');
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());
function confirmBox(message, okText = 'Delete') {
  return new Promise((resolve) => {
    const m = openModal(`<h2>Are you sure?</h2><p style="margin:0 0 18px;color:var(--muted)">${esc(message)}</p>
      <div class="modal-actions"><button class="btn btn-ghost" data-no>Cancel</button><button class="btn btn-danger" data-yes>${esc(okText)}</button></div>`);
    const bd = m.parentElement;
    bd._onClose = () => resolve(false);
    $('[data-no]', m).onclick = () => closeModal();
    $('[data-yes]', m).onclick = () => {
      bd._onClose = null;
      closeModal();
      resolve(true);
    };
  });
}
async function guard(btn, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/* ---------- history ---------- */
const addHistory = (sourceId, title, action, message) =>
  fs.addDoc(col('kb_history'), { sourceId, title: String(title || '').slice(0, 160), action, message: String(message || '').slice(0, 300), ts: Date.now() }).catch(() => {});

/* ---------- reading files (checks first) ---------- */
const loadedScripts = {};
function loadScript(src) {
  loadedScripts[src] ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load the reader library. Check your internet and try again.'));
    document.head.appendChild(s);
  });
  return loadedScripts[src];
}

async function readPdf(buf) {
  await loadScript(PDF_JS);
  const lib = window.pdfjsLib;
  if (!lib.GlobalWorkerOptions.workerSrc) {
    const code = await (await fetch(PDF_WORKER)).text();
    lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  let out = '';
  for (let p = 1; p <= Math.min(pdf.numPages, 300); p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    out += content.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('') + '\n\n';
  }
  return out;
}
async function readDocx(buf) {
  await loadScript(MAMMOTH);
  return (await window.mammoth.extractRawText({ arrayBuffer: buf })).value;
}
function htmlToPlain(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,nav,footer,form,iframe,svg').forEach((e) => e.remove());
  doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,br,tr,section,article').forEach((e) => e.append('\n'));
  return doc.body.textContent || '';
}

async function readFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['txt', 'md', 'csv', 'html', 'htm', 'pdf', 'docx'].includes(ext)) throw new Error('Unsupported file type. Use TXT, MD, CSV, HTML, PDF or DOCX.');
  if (file.size > 8 * 1024 * 1024) throw new Error('This file is larger than 8 MB.');
  if (file.size < 20) throw new Error('This file is empty.');
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  if (ext === 'pdf') {
    if (String.fromCharCode(...head) !== '%PDF') throw new Error('This file is not a real PDF.');
    return readPdf(buf);
  }
  if (ext === 'docx') {
    if (!(head[0] === 0x50 && head[1] === 0x4b)) throw new Error('This file is not a real DOCX.');
    return readDocx(buf);
  }
  const text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('\u0000')) throw new Error('This looks like a binary file, not text.');
  return ext === 'html' || ext === 'htm' ? htmlToPlain(text) : text;
}

/* ---------- learning a document / pasted text ---------- */
async function learnDocument({ title, text, fileName }, onProgress) {
  const clean = normalizeText(text);
  if (clean.length < 40) throw new Error('No readable text found. Scanned PDFs (images) cannot be read.');
  const ref = fs.doc(col('kb_sources'));
  const source = { id: ref.id, type: 'document', title, fileName };
  const map = new Map();
  for (const piece of chunkText(clean).slice(0, 2000)) {
    const c = makeChunk(source, piece);
    if (!map.has(c.id)) map.set(c.id, c); // identical text is saved only once
  }
  const list = [...map.values()];
  const now = Date.now();
  await fs.setDoc(ref, {
    type: 'document', title, fileName, status: 'learning', progress: { pages: 1, chunks: 0, message: 'Saving…' },
    chunkCount: 0, pageCount: 1, createdAt: now, updatedAt: now, schedule: { everyHours: 0 }, nextRunAt: 0,
  });
  for (let i = 0; i < list.length; i += 400) {
    const batch = fs.writeBatch(db);
    list.slice(i, i + 400).forEach((c) => batch.set(fs.doc(db, 'kb_chunks', c.id), { ...c.data, createdAt: now }));
    await batch.commit();
    onProgress?.(Math.min(i + 400, list.length), list.length);
  }
  await fs.updateDoc(ref, { status: 'done', chunkCount: list.length, progress: { pages: 1, chunks: list.length, message: 'Finished' }, lastLearnedAt: Date.now(), updatedAt: Date.now() });
  await addHistory(ref.id, title, 'learned', `${list.length} pieces saved`);
  return list.length;
}

async function deleteChunksOf(sourceId) {
  for (;;) {
    const snap = await fs.getDocs(fs.query(col('kb_chunks'), fs.where('sourceId', '==', sourceId), fs.limit(400)));
    if (snap.empty) break;
    const batch = fs.writeBatch(db);
    snap.docs.forEach((d) => batch.delete(fs.doc(db, 'kb_chunks', d.id)));
    await batch.commit();
    if (snap.docs.length < 400) break;
  }
}

/* ---------- tabs ---------- */
function drawTabs() {
  const tabs = [['overview', 'Overview'], ['knowledge', 'Knowledge'], ['history', 'History'], ['settings', 'Settings']];
  return `<div class="tabs">${tabs.map(([k, t]) => `<button class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${t}</button>`).join('')}</div>`;
}
function render() {
  view.innerHTML = drawTabs() + '<div id="tabBody"></div>';
  $$('.tab').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
  ({ overview: renderOverview, knowledge: renderKnowledge, history: renderHistory, settings: renderSettings })[tab]();
}

/* ---------- overview ---------- */
function renderOverview() {
  $('#tabBody').innerHTML = `
    <div class="stats" id="kbStats"></div>
    <div class="grid3">
      <section class="panel"><h2>🌐 Add website</h2>
        <form id="webForm" novalidate>
          <div class="field"><label for="wUrl">Website link</label>
            <input class="input" id="wUrl" inputmode="url" placeholder="https://example.com/help" autocapitalize="none"></div>
          <div class="field"><label for="wMax">Pages to read</label>
            <select class="select" id="wMax"><option value="10">Up to 10 pages</option><option value="25">Up to 25 pages</option><option value="50">Up to 50 pages</option></select></div>
          <div class="field"><label for="wEvery">Automatic update</label>
            <select class="select" id="wEvery"><option value="0">Off</option><option value="24">Every day</option><option value="168">Every week</option><option value="720">Every month</option></select></div>
          <div class="err hidden" id="wErr"></div>
          <button class="btn btn-primary" id="wGo" type="submit">${icon('plus', 16)} Start learning</button>
          <p class="hint" style="margin:10px 0 0">Only public pages of that site are read, and its robots.txt is respected. The crawler runs about every 15 minutes. To start sooner: GitHub &rarr; Actions &rarr; Knowledge crawler &rarr; Run workflow.</p>
        </form>
      </section>
      <section class="panel"><h2>📄 Upload document</h2>
        <div class="field"><label for="dFile">TXT, MD, CSV, HTML, PDF or DOCX (max 8 MB)</label>
          <input class="input" id="dFile" type="file" accept=".txt,.md,.csv,.html,.htm,.pdf,.docx"></div>
        <div class="err hidden" id="dErr"></div>
        <button class="btn btn-primary" id="dGo" type="button">${icon('plus', 16)} Learn this file</button>
        <div id="dProg" class="hint" style="margin-top:10px"></div>
        <h2 style="margin-top:22px">✍️ Paste text</h2>
        <div class="field"><label for="pTitle">Title</label><input class="input" id="pTitle" maxlength="100" placeholder="e.g. Refund policy"></div>
        <div class="field"><label for="pText">Text</label><textarea class="textarea" id="pText" placeholder="Paste the information here"></textarea></div>
        <button class="btn btn-ghost" id="pGo" type="button">Learn this text</button>
      </section>
    </div>
    <h2 style="margin:18px 0 12px;font-size:1.1rem">Learning progress</h2>
    <div class="list" id="srcList"></div>`;

  $('#webForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#wErr');
    err.classList.add('hidden');
    const fail = (t) => { err.textContent = t; err.classList.remove('hidden'); };
    let url;
    try {
      url = new URL($('#wUrl').value.trim());
    } catch {
      return fail('Enter a full link, like https://example.com');
    }
    if (!/^https?:$/.test(url.protocol)) return fail('Only http and https links are allowed.');
    if (!url.hostname.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || /localhost|\.local$|\.internal$/i.test(url.hostname)) return fail('Enter a public website address (not an IP address or a local address).');
    if (SOURCES.length >= 60) return fail('You have reached the limit of 60 sources. Delete some first.');
    guard($('#wGo'), async () => {
      url.hash = '';
      const now = Date.now();
      const every = Number($('#wEvery').value);
      const ref = await fs.addDoc(col('kb_sources'), {
        type: 'website', url: url.href, title: url.hostname, status: 'pending', maxPages: Number($('#wMax').value),
        schedule: { everyHours: every }, nextRunAt: 0, chunkCount: 0, pageCount: 0,
        progress: { pages: 0, chunks: 0, message: 'Waiting for the crawler' }, createdAt: now, updatedAt: now,
      });
      await addHistory(ref.id, url.hostname, 'added', url.href);
      $('#wUrl').value = '';
      toast('Website added. Learning starts when the crawler runs.', 'success');
    });
  });

  $('#dGo').addEventListener('click', () => {
    const file = $('#dFile').files[0];
    const err = $('#dErr');
    err.classList.add('hidden');
    if (!file) return;
    guard($('#dGo'), async () => {
      try {
        $('#dProg').textContent = 'Reading the file…';
        const text = await readFile(file);
        const n = await learnDocument({ title: file.name.replace(/\.[^.]+$/, '').slice(0, 100), fileName: file.name, text }, (a, b) => ($('#dProg').textContent = `Saving ${a} of ${b} pieces…`));
        $('#dProg').textContent = `Done. ${n} pieces saved.`;
        $('#dFile').value = '';
        toast('Document learned', 'success');
      } catch (e) {
        $('#dProg').textContent = '';
        err.textContent = e.message;
        err.classList.remove('hidden');
      }
    });
  });

  $('#pGo').addEventListener('click', () => {
    const title = $('#pTitle').value.trim() || 'Pasted text';
    const text = $('#pText').value;
    guard($('#pGo'), async () => {
      const n = await learnDocument({ title: title.slice(0, 100), fileName: 'Pasted text', text });
      $('#pText').value = '';
      $('#pTitle').value = '';
      toast(`Learned ${n} pieces`, 'success');
    });
  });

  $('#srcList').addEventListener('click', onSourceClick);
  $('#srcList').addEventListener('change', onSourceChange);
  drawStatsAndSources();
}

const STATUS = { pending: ['warn', 'Waiting'], running: ['warn', 'Learning…'], learning: ['warn', 'Saving…'], done: ['ok', 'Learned'], error: ['off', 'Failed'] };

function drawStatsAndSources() {
  if (tab !== 'overview' || !$('#kbStats')) return;
  const sites = SOURCES.filter((s) => s.type === 'website' && s.status === 'done').length;
  const docs = SOURCES.filter((s) => s.type === 'document' && s.status === 'done').length;
  const chunks = SOURCES.reduce((n, s) => n + (Number(s.chunkCount) || 0), 0);
  const busy = SOURCES.filter((s) => ['pending', 'running', 'learning'].includes(s.status)).length;
  $('#kbStats').innerHTML = `
    <div class="stat"><small>🌐 Websites learned</small><b>${sites}</b></div>
    <div class="stat"><small>📄 Documents learned</small><b>${docs}</b></div>
    <div class="stat"><small>${icon('list', 16)} Knowledge pieces</small><b>${chunks}</b></div>
    <div class="stat ${busy ? 'hot' : ''}"><small>${icon('refresh', 16)} In progress</small><b>${busy}</b></div>`;
  const box = $('#srcList');
  box.innerHTML = SOURCES.length
    ? SOURCES.map((s) => {
        const [cls, label] = STATUS[s.status] || ['', s.status];
        const p = s.progress || {};
        const pct = s.status === 'done' ? 100 : s.type === 'website' ? Math.min(100, Math.round(((p.pages || 0) / (s.maxPages || 10)) * 100)) : 50;
        const web = s.type === 'website';
        return `<article class="q-card" data-id="${esc(s.id)}">
          <h3>${web ? '🌐' : '📄'} ${esc(s.title || s.url || s.fileName)}</h3>
          <div class="src-line">${web ? esc(s.url) : esc(s.fileName || '')}</div>
          <div class="tags" style="margin-top:8px"><span class="badge ${cls}">${label}</span>
            <span class="tag">${Number(s.chunkCount) || 0} pieces</span>${web ? `<span class="tag">${Number(s.pageCount) || 0} pages</span>` : ''}
            ${s.lastLearnedAt ? `<span class="tag">Learned ${timeAgo(s.lastLearnedAt)}</span>` : ''}</div>
          ${['pending', 'running', 'learning'].includes(s.status) ? `<div class="bar-wrap"><div class="bar-fill" style="width:${pct}%"></div></div><div class="src-line">${esc(p.message || '')}</div>` : ''}
          ${s.status === 'error' ? `<div class="err" style="margin-top:8px">${esc(s.error || 'Failed')}</div>` : ''}
          ${web ? `<div class="field" style="margin:10px 0 0"><label>Automatic update</label>
            <select class="select" data-every>${[[0, 'Off'], [24, 'Every day'], [168, 'Every week'], [720, 'Every month']].map(([v, t]) => `<option value="${v}" ${Number(s.schedule?.everyHours || 0) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>` : ''}
          <div class="card-actions" style="margin-top:12px">
            ${web ? `<button class="btn btn-ghost btn-sm" data-act="update" ${['pending', 'running'].includes(s.status) ? 'disabled' : ''}>${icon('refresh', 16)} Update now</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-act="view">${icon('list', 16)} View knowledge</button>
            <button class="btn btn-danger btn-sm" data-act="del">${icon('trash', 16)} Delete</button>
          </div></article>`;
      }).join('')
    : `<div class="empty">${icon('bot', 30)}<p>Nothing learned yet. Add a website or upload a document above.</p></div>`;
}

async function onSourceClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const s = SOURCES.find((x) => x.id === id);
  if (!s) return;
  if (btn.dataset.act === 'view') {
    kbFilter = id;
    tab = 'knowledge';
    return render();
  }
  if (btn.dataset.act === 'update') {
    return guard(btn, async () => {
      await fs.updateDoc(fs.doc(db, 'kb_sources', id), { status: 'pending', error: null, progress: { pages: 0, chunks: 0, message: 'Waiting for the crawler' }, updatedAt: Date.now() });
      toast('Queued. It will update when the crawler runs.', 'success');
    });
  }
  if (btn.dataset.act === 'del') {
    if (!(await confirmBox(`Delete "${s.title || s.url}" and everything learned from it?`))) return;
    return guard(btn, async () => {
      await deleteChunksOf(id);
      await fs.deleteDoc(fs.doc(db, 'kb_sources', id));
      await addHistory(id, s.title || s.url, 'deleted', 'Source and its knowledge were deleted');
      toast('Deleted', 'success');
    });
  }
}
async function onSourceChange(e) {
  if (!e.target.matches('[data-every]')) return;
  const id = e.target.closest('[data-id]').dataset.id;
  const every = Number(e.target.value);
  try {
    await fs.updateDoc(fs.doc(db, 'kb_sources', id), { schedule: { everyHours: every }, nextRunAt: every ? Date.now() + every * 3600000 : 0, updatedAt: Date.now() });
    toast(every ? 'Automatic update saved' : 'Automatic update turned off', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- knowledge database ---------- */
async function renderKnowledge() {
  $('#tabBody').innerHTML = `
    <div class="toolbar" style="grid-template-columns:1fr 1fr">
      <select class="select" id="kSrc"><option value="all">All sources (latest 100)</option>${SOURCES.map((s) => `<option value="${esc(s.id)}">${esc((s.title || s.url || '').slice(0, 50))}</option>`).join('')}</select>
      <div class="searchbox">${icon('search', 18)}<input class="input" id="kSearch" type="search" placeholder="Search inside the knowledge…"></div>
    </div>
    <p class="hint" style="margin:0 0 12px">Edits to website knowledge are replaced the next time that website is updated.</p>
    <div class="list" id="kList"><div class="skeleton"></div></div>`;
  $('#kSrc').value = SOURCES.some((s) => s.id === kbFilter) ? kbFilter : 'all';
  let rows = [];
  const draw = () => {
    const q = ($('#kSearch').value || '').trim().toLowerCase();
    const shownRows = rows.filter((r) => !q || (r.text + ' ' + (r.pageTitle || '')).toLowerCase().includes(q));
    $('#kList').innerHTML = shownRows.length
      ? shownRows.slice(0, 100).map((r) => `<article class="q-card" data-cid="${esc(r.id)}">
          <div class="tags"><span class="tag">${esc(r.sourceTitle || '')}</span>${r.pageUrl ? `<a class="tag" href="${esc(r.pageUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.pageTitle || r.pageUrl).slice(0, 60)}</a>` : ''}</div>
          <p class="chunk-text" style="color:var(--text)">${esc(r.text)}</p>
          <div class="card-actions"><button class="btn btn-ghost btn-sm" data-act="edit">${icon('edit', 16)} Edit</button><button class="btn btn-danger btn-sm" data-act="del">${icon('trash', 16)} Delete</button></div></article>`).join('')
      : `<div class="empty">${icon('list', 30)}<p>No knowledge found.</p></div>`;
  };
  const load = async () => {
    const f = $('#kSrc').value;
    kbFilter = f;
    $('#kList').innerHTML = '<div class="skeleton"></div>';
    const q = f === 'all' ? fs.query(col('kb_chunks'), fs.orderBy('updatedAt', 'desc'), fs.limit(100)) : fs.query(col('kb_chunks'), fs.where('sourceId', '==', f), fs.limit(300));
    rows = (await fs.getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
    draw();
  };
  $('#kSrc').addEventListener('change', load);
  $('#kSearch').addEventListener('input', debounce(draw, 200));
  $('#kList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('[data-cid]').dataset.cid;
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    if (btn.dataset.act === 'del') {
      if (!(await confirmBox('Delete this piece of knowledge?'))) return;
      await fs.deleteDoc(fs.doc(db, 'kb_chunks', id));
      rows = rows.filter((r) => r.id !== id);
      toast('Deleted', 'success');
      return draw();
    }
    const m = openModal(`<h2>Edit knowledge</h2>
      <div class="field"><textarea class="textarea" id="kEdit" maxlength="3000" style="min-height:220px">${esc(row.text)}</textarea></div>
      <div class="modal-actions"><button class="btn btn-ghost" data-no>Cancel</button><button class="btn btn-primary" id="kSave">Save</button></div>`, { wide: true });
    $('[data-no]', m).onclick = closeModal;
    $('#kSave', m).onclick = () =>
      guard($('#kSave', m), async () => {
        const text = normalizeText($('#kEdit', m).value);
        if (text.length < 10) throw new Error('The text is too short.');
        await fs.updateDoc(fs.doc(db, 'kb_chunks', id), { text, terms: termsOf(text, 60), hash: hash2(text.toLowerCase()), updatedAt: Date.now(), edited: true });
        row.text = text;
        closeModal();
        draw();
        toast('Saved', 'success');
        addHistory(row.sourceId, row.sourceTitle, 'updated', 'A piece of knowledge was edited');
      });
  });
  await load();
}

/* ---------- history ---------- */
async function renderHistory() {
  $('#tabBody').innerHTML = '<div class="list" id="hList"><div class="skeleton"></div></div>';
  const snap = await fs.getDocs(fs.query(col('kb_history'), fs.orderBy('ts', 'desc'), fs.limit(100)));
  const rows = snap.docs.map((d) => d.data());
  const cls = { learned: 'ok', updated: 'ok', added: 'warn', deleted: 'off', error: 'off' };
  $('#hList').innerHTML = rows.length
    ? rows.map((h) => `<article class="q-card"><div class="tags"><span class="badge ${cls[h.action] || ''}">${esc(h.action)}</span><span class="tag">${new Date(h.ts).toLocaleString()}</span></div>
        <h3 style="font-size:1rem">${esc(h.title)}</h3><p>${esc(h.message)}</p></article>`).join('')
    : `<div class="empty">${icon('list', 30)}<p>No history yet.</p></div>`;
}

/* ---------- settings ---------- */
async function renderSettings() {
  const snap = await fs.getDoc(fs.doc(db, 'settings', 'ai'));
  const s = snap.exists() ? snap.data() : { enabled: false, model: 'gemini-3.8-flash', dailyLimit: 20 };
  $('#tabBody').innerHTML = `
    <section class="panel" style="max-width:560px"><h2>🧠 AI answers</h2>
      <div class="note">AI answers use Firebase AI Logic (Gemini). First enable it in the Firebase console: Build &rarr; AI Logic &rarr; Get started &rarr; Gemini Developer API. The free tier has limits that all your users share.</div>
      <form id="aiForm" novalidate>
        <label class="check" style="margin-bottom:14px"><input type="checkbox" id="aiOn" ${s.enabled ? 'checked' : ''}> Let AI answer from the knowledge when no saved Q&amp;A matches</label>
        <div class="field"><label for="aiModel">Gemini model name</label>
          <input class="input" id="aiModel" value="${esc(s.model || '')}" autocapitalize="none" placeholder="gemini-3.8-flash">
          <span class="hint">If answers stop working, check the current model name in the Firebase console and enter it here.</span></div>
        <div class="field"><label for="aiLimit">AI answers per user per day</label>
          <input class="input" id="aiLimit" type="number" min="1" max="500" step="1" value="${esc(s.dailyLimit ?? 20)}"></div>
        <div class="err hidden" id="aiErr"></div>
        <button class="btn btn-primary" id="aiSave" type="submit">Save</button>
      </form></section>`;
  $('#aiForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const model = $('#aiModel').value.trim();
    const dailyLimit = Math.round(Number($('#aiLimit').value));
    const err = $('#aiErr');
    err.classList.add('hidden');
    if (!/^[a-z0-9][a-z0-9.\-]{2,60}$/i.test(model)) {
      err.textContent = 'Enter a valid model name.';
      return err.classList.remove('hidden');
    }
    if (!(dailyLimit >= 1 && dailyLimit <= 500)) {
      err.textContent = 'The daily limit must be between 1 and 500.';
      return err.classList.remove('hidden');
    }
    guard($('#aiSave'), async () => {
      await fs.setDoc(fs.doc(db, 'settings', 'ai'), { enabled: $('#aiOn').checked, model, dailyLimit, updatedAt: Date.now() });
      toast('Saved', 'success');
    });
  });
}

/* ---------- boot ---------- */
if (!configured) {
  view.innerHTML = '<div class="empty"><p>Setup pending: add your Firebase config in js/config.js.</p></div>';
} else {
  onAuthStateChanged(getAuth(app), async (user) => {
    if (!user) return location.replace('index.html');
    let ok = false;
    try {
      ok = (await fs.getDoc(fs.doc(db, 'admins', user.uid))).exists();
    } catch {}
    if (!ok) return location.replace('index.html');
    $('#who').textContent = user.email;
    unsubSources?.();
    unsubSources = fs.onSnapshot(
      fs.query(col('kb_sources'), fs.orderBy('createdAt', 'desc'), fs.limit(200)),
      (snap) => {
        SOURCES = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (!$('#tabBody')) render();
        else drawStatsAndSources();
      },
      (err) => {
        console.warn(err);
        view.innerHTML = `<div class="empty"><p><b>Could not load.</b><br>${esc(err.message)}<br>Did you publish the new Firestore rules?</p></div>`;
      }
    );
  });
}
