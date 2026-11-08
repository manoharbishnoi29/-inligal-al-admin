import { esc, safeUrl, toast, icon, initTheme, debounce, registerSW, timeAgo, uuid } from './shared.js';
import { configured, app, db, fs } from './firebase.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { USER_SITE_URL } from './config.js';

const auth = configured ? getAuth(app) : null;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');
const col = (n) => fs.collection(db, n);
const countOf = async (q) => (await fs.getCountFromServer(q)).data().count;

let QA = [];
let UN = [];
let shown = 25;
let unTab = 'pending';
let notAdminMsg = '';
const filters = { q: '', status: 'all', cat: 'all' };

const KINDS = [['app', 'App link'], ['website', 'Website link'], ['apk', 'APK download']];
const KICON = { app: 'app', website: 'globe', apk: 'download' };
const userSite = USER_SITE_URL && !USER_SITE_URL.includes('YOUR_') ? USER_SITE_URL : '';

/* ---------- static UI ---------- */
$('#loginLogo').innerHTML = icon('chat', 22);
$('#sideLogo').innerHTML = icon('chat', 20);
$('#pwToggle').innerHTML = icon('eye');
$('#menuBtn').innerHTML = icon('menu');
$('#refreshBtn').innerHTML = icon('refresh');
$('#openChat').innerHTML = `${icon('chat')} Open user chat`;
$('#logoutBtn').innerHTML = `${icon('logout')} Sign out`;
$$('#nav a').forEach((a) => {
  const v = a.dataset.v;
  const map = { dashboard: ['home', 'Dashboard'], questions: ['list', 'Questions & answers'], unanswered: ['inbox', 'Unanswered'] };
  a.innerHTML = `${icon(map[v][0])}<span>${map[v][1]}</span>${v === 'unanswered' ? '<em class="count hidden" id="badge" style="font-style:normal">0</em>' : ''}`;
});
if (userSite) $('#backLink').href = userSite;
else $('#backLink').classList.add('hidden');
initTheme($('#themeBtn'));
registerSW();

/* ---------- modal helpers ---------- */
function openModal(html, { wide = false } = {}) {
  closeModal();
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  bd.addEventListener('mousedown', (e) => {
    if (e.target === bd) closeModal();
  });
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

/* ---------- links repeater ---------- */
function linkRow(l = { kind: 'app', label: '', url: '' }) {
  return `<div class="link-row">
    <select class="select l-kind" aria-label="Link type">${KINDS.map(([v, t]) => `<option value="${v}" ${l.kind === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <input class="input l-label" placeholder="Button text (optional)" maxlength="60" value="${esc(l.label || '')}">
    <input class="input l-url" placeholder="https://…" inputmode="url" value="${esc(l.url || '')}">
    <button type="button" class="icon-btn danger l-del" aria-label="Remove link">${icon('trash')}</button>
  </div>`;
}
function linksBlock(links = []) {
  return `<div class="links-block">
    <div class="lb-head"><label>Links: app, website, APK</label>
      <button type="button" class="btn btn-ghost btn-sm l-add">${icon('plus', 16)} Add link</button></div>
    <div class="l-rows">${links.map(linkRow).join('')}</div>
    <div class="hint">Ek answer mein jitne chahein utne links add karo. APK ke liye "APK download" chuno.</div>
  </div>`;
}
function wireLinks(root) {
  root.addEventListener('click', (e) => {
    if (e.target.closest('.l-add')) $('.l-rows', root).insertAdjacentHTML('beforeend', linkRow());
    const d = e.target.closest('.l-del');
    if (d) d.closest('.link-row').remove();
  });
}
function readLinks(root) {
  const out = [];
  for (const row of $$('.link-row', root)) {
    const raw = $('.l-url', row).value.trim();
    if (!raw) continue;
    const url = safeUrl(raw);
    if (!url) throw new Error(`Invalid link: ${raw}`);
    out.push({ kind: $('.l-kind', row).value, label: $('.l-label', row).value.trim().slice(0, 60), url });
  }
  return out;
}
const parseKeywords = (s) => [...new Set(String(s).split(/[,\n]+/).map((k) => k.trim().toLowerCase()).filter(Boolean))];

/* ---------- data helpers ---------- */
async function loadQA() {
  const snap = await fs.getDocs(fs.query(col('qa'), fs.orderBy('updatedAt', 'desc'), fs.limit(2000)));
  QA = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function loadUN() {
  const snap = await fs.getDocs(fs.query(col('unanswered'), fs.orderBy('createdAt', 'desc'), fs.limit(500)));
  UN = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  updateBadge();
}
async function updateBadge() {
  const b = $('#badge');
  if (!b) return;
  try {
    const n = await countOf(fs.query(col('unanswered'), fs.where('status', '==', 'pending')));
    b.textContent = n;
    b.classList.toggle('hidden', !n);
  } catch (e) {
    console.warn(e);
  }
}

/** Create or update a Q&A (links are stored inside the same document). Returns the id. */
async function saveItem({ id, question, answer, keywords, category, isActive }, links) {
  const now = Date.now();
  const payload = { question, answer, keywords, category, isActive, links, updatedAt: now };
  if (id) {
    await fs.updateDoc(fs.doc(db, 'qa', id), payload);
    return id;
  }
  const ref = await fs.addDoc(col('qa'), { ...payload, createdAt: now });
  return ref.id;
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

/* ---------- auth ---------- */
function showLogin(msg) {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  const e = $('#loginErr');
  e.textContent = msg || '';
  e.classList.toggle('hidden', !msg);
}

async function enter(user) {
  let ok = false;
  try {
    ok = (await fs.getDoc(fs.doc(db, 'admins', user.uid))).exists();
  } catch (e) {
    console.warn(e);
  }
  if (!ok) {
    notAdminMsg = `This account is not an admin. Firestore mein admins/${user.uid} document banao.`;
    await signOut(auth);
    return;
  }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who').textContent = user.email;
  route();
}

$('#pwToggle').addEventListener('click', () => {
  const p = $('#password');
  const show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $('#pwToggle').innerHTML = icon(show ? 'ban' : 'eye');
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!auth) return showLogin('Setup pending: js/config.js mein Firebase config daalo.');
  const btn = $('#loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Signing in…';
  try {
    await signInWithEmailAndPassword(auth, $('#email').value.trim(), $('#password').value);
    $('#password').value = '';
  } catch (err) {
    const bad = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(err.code);
    showLogin(bad ? 'Wrong email or password.' : err.code === 'auth/too-many-requests' ? 'Too many attempts. Thodi der baad try karo.' : err.message);
  }
  btn.disabled = false;
  btn.textContent = 'Sign in';
});

$('#logoutBtn').addEventListener('click', async () => {
  await signOut(auth);
  location.hash = '';
});
$('#openChat').addEventListener('click', () => {
  if (userSite) window.open(userSite, '_blank', 'noopener');
  else toast('config.js mein USER_SITE_URL daalo', 'error');
});

/* ---------- router ---------- */
const TITLES = { dashboard: 'Dashboard', questions: 'Questions & answers', unanswered: 'Unanswered questions' };
const VIEWS = { dashboard: renderDashboard, questions: renderQuestions, unanswered: renderUnanswered };

async function route() {
  const h = (location.hash || '#dashboard').slice(1);
  const name = VIEWS[h] ? h : 'dashboard';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.v === name));
  $('#title').textContent = TITLES[name];
  $('#app').classList.remove('open');
  view.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    await VIEWS[name]();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty">${icon('ban', 28)}<p><b>Could not load data.</b><br>${esc(err.message || '')}<br>Firestore database aur rules set kiye?</p></div>`;
  }
  updateBadge();
}
window.addEventListener('hashchange', () => !$('#app').classList.contains('hidden') && route());
$('#menuBtn').addEventListener('click', () => $('#app').classList.add('open'));
$('#scrim').addEventListener('click', () => $('#app').classList.remove('open'));
$('#refreshBtn').addEventListener('click', route);

/* ---------- dashboard ---------- */
async function renderDashboard() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today);
  since.setDate(since.getDate() - 6);

  const [, pending, asked, askedToday, recent, week] = await Promise.all([
    loadQA(),
    countOf(fs.query(col('unanswered'), fs.where('status', '==', 'pending'))),
    countOf(col('asked')),
    countOf(fs.query(col('asked'), fs.where('ts', '>=', today.getTime()))),
    fs.getDocs(fs.query(col('unanswered'), fs.orderBy('createdAt', 'desc'), fs.limit(50))),
    fs.getDocs(fs.query(col('asked'), fs.where('ts', '>=', since.getTime()), fs.limit(10000))),
  ]);

  const total = QA.length;
  const active = QA.filter((i) => i.isActive).length;
  const links = QA.reduce((n, i) => n + (i.links || []).length, 0);
  const recentRows = recent.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.status === 'pending').slice(0, 5);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    return { key: d.toDateString(), label: d.toLocaleDateString(undefined, { weekday: 'short' }), n: 0 };
  });
  week.docs.forEach((d) => {
    const hit = days.find((x) => x.key === new Date(d.data().ts).toDateString());
    if (hit) hit.n++;
  });
  const max = Math.max(1, ...days.map((d) => d.n));

  view.innerHTML = `
    <div class="stats">
      <div class="stat"><small>${icon('list', 16)} Saved Q&amp;A</small><b>${total}</b></div>
      <div class="stat"><small>${icon('check', 16)} Active answers</small><b>${active}</b></div>
      <div class="stat"><small>${icon('link', 16)} Links attached</small><b>${links}</b></div>
      <div class="stat ${pending ? 'hot' : ''}"><small>${icon('inbox', 16)} Unanswered</small><b>${pending}</b></div>
      <div class="stat"><small>${icon('chat', 16)} Questions asked</small><b>${asked}</b></div>
      <div class="stat"><small>${icon('send', 16)} Asked today</small><b>${askedToday}</b></div>
    </div>
    <div class="grid2">
      <section class="panel"><h2>Questions in the last 7 days</h2>
        <div class="bars">${days.map((d) => `<div class="bar"><b>${d.n}</b><i style="height:${Math.round((d.n / max) * 100)}%"></i><span>${esc(d.label)}</span></div>`).join('')}</div>
      </section>
      <section class="panel"><h2>Waiting for a reply <a class="btn btn-ghost btn-sm" href="#unanswered">View all</a></h2>
        <div class="mini">${
          recentRows.length
            ? recentRows.map((r) => `<div class="mini-row"><span title="${esc(r.question)}">${esc(r.question)}</span><small class="hint">${timeAgo(r.createdAt)}</small></div>`).join('')
            : `<div class="empty" style="padding:22px">All caught up. No pending questions.</div>`
        }</div>
      </section>
    </div>
    <button class="btn btn-primary" id="dashAdd">${icon('plus', 18)} Add question</button>`;
  $('#dashAdd').onclick = () => openEditor();
}

/* ---------- questions & answers ---------- */
async function renderQuestions() {
  await loadQA();
  const cats = [...new Set(QA.map((i) => i.category).filter(Boolean))].sort();
  view.innerHTML = `
    <div class="toolbar">
      <div class="searchbox">${icon('search', 18)}<input class="input" id="qSearch" type="search" placeholder="Search questions, answers, keywords…" value="${esc(filters.q)}"></div>
      <select class="select" id="qStatus"><option value="all">All status</option><option value="active">Active</option><option value="inactive">Hidden</option></select>
      <select class="select" id="qCat"><option value="all">All categories</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
      <button class="btn btn-primary" id="qAdd">${icon('plus', 18)} Add question</button>
    </div>
    <div class="list" id="qList"></div>`;
  $('#qStatus').value = filters.status;
  $('#qCat').value = cats.includes(filters.cat) ? filters.cat : 'all';
  $('#qSearch').addEventListener('input', debounce((e) => { filters.q = e.target.value; shown = 25; drawList(); }, 200));
  $('#qStatus').addEventListener('change', (e) => { filters.status = e.target.value; shown = 25; drawList(); });
  $('#qCat').addEventListener('change', (e) => { filters.cat = e.target.value; shown = 25; drawList(); });
  $('#qAdd').onclick = () => openEditor();
  $('#qList').addEventListener('click', onListClick);
  drawList();
}

function drawList() {
  const q = filters.q.trim().toLowerCase();
  const rows = QA.filter((i) => {
    if (filters.status === 'active' && !i.isActive) return false;
    if (filters.status === 'inactive' && i.isActive) return false;
    if (filters.cat !== 'all' && i.category !== filters.cat) return false;
    if (!q) return true;
    return [i.question, i.answer, i.category, (i.keywords || []).join(' ')].join(' ').toLowerCase().includes(q);
  });
  const box = $('#qList');
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${icon('list', 30)}<p>${QA.length ? 'No questions match your filters.' : 'No questions yet. Add your first question and answer.'}</p></div>`;
    return;
  }
  box.innerHTML =
    rows.slice(0, shown).map(cardHTML).join('') +
    (rows.length > shown ? `<button class="btn btn-ghost" id="more">Show more (${rows.length - shown})</button>` : '');
  $('#more')?.addEventListener('click', () => { shown += 25; drawList(); });
}

function cardHTML(i) {
  const kinds = { app: 0, website: 0, apk: 0 };
  (i.links || []).forEach((l) => kinds[l.kind]++);
  return `<article class="q-card ${i.isActive ? '' : 'inactive'}" data-id="${i.id}">
    <h3>${esc(i.question)}</h3>
    <p>${esc(i.answer)}</p>
    <div class="tags">
      <span class="badge ${i.isActive ? 'ok' : 'off'}">${i.isActive ? 'Active' : 'Hidden'}</span>
      ${i.category ? `<span class="badge">${esc(i.category)}</span>` : ''}
      ${Object.entries(kinds).filter(([, n]) => n).map(([k, n]) => `<span class="badge warn">${icon(KICON[k], 12)} ${n} ${k}</span>`).join('')}
      ${(i.keywords || []).slice(0, 5).map((k) => `<span class="tag">${esc(k)}</span>`).join('')}
    </div>
    <div class="card-actions">
      <button class="btn btn-ghost btn-sm" data-act="edit">${icon('edit', 16)} Edit</button>
      <button class="btn btn-ghost btn-sm" data-act="toggle">${i.isActive ? 'Hide' : 'Show'}</button>
      <button class="btn btn-danger btn-sm" data-act="del">${icon('trash', 16)} Delete</button>
    </div></article>`;
}

async function onListClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const item = QA.find((x) => x.id === id);
  if (!item) return;
  if (btn.dataset.act === 'edit') return openEditor(item);
  if (btn.dataset.act === 'toggle') {
    return guard(btn, async () => {
      await fs.updateDoc(fs.doc(db, 'qa', id), { isActive: !item.isActive, updatedAt: Date.now() });
      item.isActive = !item.isActive;
      toast(item.isActive ? 'Answer is live for users' : 'Answer hidden from users', 'success');
      drawList();
    });
  }
  if (btn.dataset.act === 'del') {
    if (!(await confirmBox('This question, its answer and all its links will be deleted permanently.'))) return;
    try {
      await fs.deleteDoc(fs.doc(db, 'qa', id));
    } catch (err) {
      return toast(err.message, 'error');
    }
    QA = QA.filter((x) => x.id !== id);
    toast('Deleted', 'success');
    drawList();
  }
}

function openEditor(item = null) {
  const d = item || { question: '', answer: '', keywords: [], category: '', isActive: true, links: [] };
  const cats = [...new Set(QA.map((i) => i.category).filter(Boolean))];
  const m = openModal(`
    <h2>${item ? 'Edit question' : 'Add question'}</h2>
    <form id="edForm">
      <div class="field"><label for="fq">Question</label>
        <input class="input" id="fq" required maxlength="500" value="${esc(d.question)}" placeholder="e.g. Instagram ka APK kaise download karein?"></div>
      <div class="field"><label for="fa">Answer</label>
        <textarea class="textarea" id="fa" required maxlength="5000" placeholder="Users ko yeh reply dikhega. **bold** aur naye lines chalte hain.">${esc(d.answer)}</textarea></div>
      <div class="field"><label for="fk">Keywords</label>
        <input class="input" id="fk" value="${esc((d.keywords || []).join(', '))}" placeholder="instagram, apk, download, डाउनलोड, kaise">
        <span class="hint">Comma se alag karo. Ek-ek shabd likho. Hindi, English aur Hinglish teeno daalo, jaise: download, डाउनलोड, daunlod.</span></div>
      <div class="field"><label for="fc">Category (optional)</label>
        <input class="input" id="fc" list="catlist" maxlength="60" value="${esc(d.category || '')}" placeholder="General">
        <datalist id="catlist">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
      ${linksBlock(d.links || [])}
      <label class="check" style="margin-bottom:16px"><input type="checkbox" id="fact" ${d.isActive ? 'checked' : ''}> Active (visible to users)</label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`, { wide: true });
  wireLinks(m);
  $('[data-cancel]', m).onclick = closeModal;
  $('#edForm', m).addEventListener('submit', (e) => {
    e.preventDefault();
    guard($('button[type=submit]', m), async () => {
      const ls = readLinks(m);
      await saveItem(
        {
          id: item?.id,
          question: $('#fq', m).value.trim(),
          answer: $('#fa', m).value.trim(),
          keywords: parseKeywords($('#fk', m).value),
          category: $('#fc', m).value.trim(),
          isActive: $('#fact', m).checked,
        },
        ls
      );
      closeModal();
      toast(item ? 'Changes saved' : 'Question added', 'success');
      route();
    });
  });
}

/* ---------- unanswered questions ---------- */
async function renderUnanswered() {
  await loadUN();
  const n = (s) => UN.filter((u) => u.status === s).length;
  const tabs = [['pending', 'Pending'], ['answered', 'Answered'], ['ignored', 'Ignored']];
  view.innerHTML = `
    <div class="tabs">${tabs.map(([k, t]) => `<button class="tab ${unTab === k ? 'on' : ''}" data-tab="${k}">${t} (${n(k)})</button>`).join('')}</div>
    <div class="list" id="uList"></div>`;
  $$('.tab').forEach((b) => (b.onclick = () => { unTab = b.dataset.tab; renderUnanswered(); }));
  const rows = UN.filter((u) => u.status === unTab);
  const box = $('#uList');
  box.innerHTML = rows.length
    ? rows.map((u) => `<article class="q-card" data-id="${u.id}">
        <h3>${esc(u.question)}</h3>
        <div class="tags"><span class="badge ${u.status === 'pending' ? 'warn' : u.status === 'answered' ? 'ok' : ''}">${u.status}</span><span class="tag">${timeAgo(u.createdAt)}</span><span class="tag">user ${esc(String(u.sessionId || '').slice(0, 6))}</span></div>
        ${u.adminReply ? `<p>${esc(u.adminReply)}</p>` : ''}
        <div class="card-actions">
          <button class="btn btn-primary btn-sm" data-act="reply">${icon('reply', 16)} ${u.status === 'answered' ? 'Reply again' : 'Reply'}</button>
          ${u.status === 'pending' ? `<button class="btn btn-ghost btn-sm" data-act="ignore">${icon('ban', 16)} Ignore</button>` : ''}
          <button class="btn btn-danger btn-sm" data-act="del">${icon('trash', 16)} Delete</button>
        </div></article>`).join('')
    : `<div class="empty">${icon('inbox', 30)}<p>${unTab === 'pending' ? 'No pending questions. Nice work!' : 'Nothing here yet.'}</p></div>`;
  box.onclick = onUnClick;
}

async function onUnClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const u = UN.find((x) => x.id === id);
  if (!u) return;
  if (btn.dataset.act === 'reply') return openReply(u);
  if (btn.dataset.act === 'ignore') {
    return guard(btn, async () => {
      await fs.updateDoc(fs.doc(db, 'unanswered', id), { status: 'ignored' });
      toast('Marked as ignored');
      renderUnanswered();
    });
  }
  if (btn.dataset.act === 'del') {
    if (!(await confirmBox('This user question will be deleted permanently.'))) return;
    try {
      await fs.deleteDoc(fs.doc(db, 'unanswered', id));
    } catch (err) {
      return toast(err.message, 'error');
    }
    toast('Deleted', 'success');
    renderUnanswered();
  }
}

function openReply(u) {
  const m = openModal(`
    <h2>Reply to user</h2>
    <div class="reply-q"><small class="hint">User asked</small><br><b>${esc(u.question)}</b></div>
    <form id="rpForm">
      <div class="field"><label for="ra">Your reply</label>
        <textarea class="textarea" id="ra" required maxlength="5000" placeholder="Write the answer the user will see in their chat">${esc(u.adminReply || '')}</textarea></div>
      ${linksBlock(u.replyLinks || [])}
      <label class="check" style="margin-bottom:10px"><input type="checkbox" id="rsave" checked> Save as Q&amp;A so future users get this answer automatically</label>
      <div class="field" id="rkwWrap"><label for="rk">Keywords for this Q&amp;A</label>
        <input class="input" id="rk" placeholder="keyword1, keyword2, हिंदी शब्द">
        <span class="hint">Jitne zyada keywords, utna accha auto-reply match.</span></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" class="btn btn-primary">${icon('send', 16)} Send reply</button>
      </div>
    </form>`, { wide: true });
  wireLinks(m);
  $('[data-cancel]', m).onclick = closeModal;
  $('#rsave', m).addEventListener('change', (e) => $('#rkwWrap', m).classList.toggle('hidden', !e.target.checked));
  $('#rpForm', m).addEventListener('submit', (e) => {
    e.preventDefault();
    guard($('button[type=submit]', m), async () => {
      const answer = $('#ra', m).value.trim();
      const links = readLinks(m);
      let qaId = u.qaId || null;
      if ($('#rsave', m).checked) {
        qaId = await saveItem(
          { id: null, question: String(u.question).slice(0, 500), answer, keywords: parseKeywords($('#rk', m).value), category: '', isActive: true },
          links
        );
      }
      await fs.updateDoc(fs.doc(db, 'unanswered', u.id), {
        status: 'answered', adminReply: answer, replyLinks: links, qaId, repliedAt: Date.now(),
      });
      // user ki chat mein reply turant dikhta hai (unka chat page live sync karta hai)
      await fs.setDoc(fs.doc(db, 'chats', u.sessionId, 'messages', uuid()), {
        role: 'bot', content: answer, links, qaId, ts: Date.now(),
      });
      closeModal();
      toast('Reply sent to user', 'success');
      renderUnanswered();
    });
  });
}

/* ---------- boot ---------- */
if (!configured) {
  $('#setupBanner').textContent = 'Setup pending: js/config.js mein Firebase config daalo.';
  $('#setupBanner').classList.remove('hidden');
  showLogin();
} else {
  onAuthStateChanged(auth, (user) => {
    if (user) enter(user);
    else {
      showLogin(notAdminMsg);
      notAdminMsg = '';
    }
  });
}
