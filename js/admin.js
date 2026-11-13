import { esc, safeUrl, toast, icon, initTheme, debounce, registerSW, timeAgo, uuid } from './shared.js';
import { configured, app, db, fs } from './firebase.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { USER_SITE_URL } from './config.js';
import { CONTENT_LANG, langName, safeTranslate } from './translate.js';

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
  const map = {
    dashboard: ['home', 'Dashboard'], questions: ['list', 'Questions & answers'], unanswered: ['inbox', 'Unanswered'],
    payments: ['check', 'Payments'], chats: ['chat', 'Chats & users'], settings: ['edit', 'Premium settings'],
  };
  const badgeId = v === 'unanswered' ? 'badge' : v === 'payments' ? 'badgePay' : '';
  a.innerHTML = `${icon(map[v][0])}<span>${map[v][1]}</span>${badgeId ? `<em class="count hidden" id="${badgeId}" style="font-style:normal">0</em>` : ''}`;
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
    <div class="hint">Add as many links as you need. Choose "APK download" for APK files.</div>
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
  const set = async (id, q) => {
    const b = $('#' + id);
    if (!b) return;
    try {
      const n = await countOf(q);
      b.textContent = n;
      b.classList.toggle('hidden', !n);
    } catch (e) {
      console.warn(e);
    }
  };
  set('badge', fs.query(col('unanswered'), fs.where('status', '==', 'pending')));
  set('badgePay', fs.query(col('payments'), fs.where('status', '==', 'pending')));
}

/** Create or update a Q&A. Premium answers + links live in a separate protected collection. Returns the id. */
async function saveItem({ id, question, answer, keywords, category, isActive, isPremium, preview }, links) {
  const now = Date.now();
  const base = { question, keywords, category, isActive, isPremium: !!isPremium, updatedAt: now };
  if (isPremium) {
    base.answer = preview || '🔒 Premium answer';
    base.links = [];
  } else {
    base.answer = answer;
    base.links = links;
  }
  let itemId = id;
  if (id) {
    await fs.updateDoc(fs.doc(db, 'qa', id), base);
  } else {
    const ref = await fs.addDoc(col('qa'), { ...base, createdAt: now });
    itemId = ref.id;
  }
  if (isPremium) await fs.setDoc(fs.doc(db, 'qa_premium', itemId), { answer, links, updatedAt: now });
  else if (id) await fs.deleteDoc(fs.doc(db, 'qa_premium', id)).catch(() => {});
  return itemId;
}

/** Give a user Premium time. New time is added after any remaining time. */
async function grantPremium(uid, email, plan, days, paymentId) {
  const ref = fs.doc(db, 'subscriptions', uid);
  const old = await fs.getDoc(ref);
  const oldData = old.exists() ? old.data() : null;
  const base = Math.max(Date.now(), oldData?.expiresAt || 0);
  const data = {
    uid, email: email || '', plan, startAt: oldData?.startAt || Date.now(),
    expiresAt: base + days * 86400000, paymentId: paymentId || 'manual', updatedAt: Date.now(),
  };
  await fs.setDoc(ref, data);
  return data;
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
    notAdminMsg = `This account is not an admin. Create the document admins/${user.uid} in Firestore.`;
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
  if (!auth) return showLogin('Setup pending: add your Firebase config in js/config.js.');
  const btn = $('#loginBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Signing in…';
  try {
    await signInWithEmailAndPassword(auth, $('#email').value.trim(), $('#password').value);
    $('#password').value = '';
  } catch (err) {
    const bad = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(err.code);
    showLogin(bad ? 'Wrong email or password.' : err.code === 'auth/too-many-requests' ? 'Too many attempts. Please try again later.' : err.message);
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
  else toast('Set USER_SITE_URL in js/config.js', 'error');
});

/* ---------- router ---------- */
const TITLES = {
  dashboard: 'Dashboard', questions: 'Questions & answers', unanswered: 'Unanswered questions',
  payments: 'Payments', chats: 'Chats & users', settings: 'Premium settings',
};
const VIEWS = {
  dashboard: renderDashboard, questions: renderQuestions, unanswered: renderUnanswered,
  payments: renderPayments, chats: renderChats, settings: renderSettings,
};

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
    view.innerHTML = `<div class="empty">${icon('ban', 28)}<p><b>Could not load data.</b><br>${esc(err.message || '')}<br>Did you create the Firestore database and publish the rules?</p></div>`;
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

  const [, pending, asked, askedToday, recent, week, usersN, payPending, subs] = await Promise.all([
    loadQA(),
    countOf(fs.query(col('unanswered'), fs.where('status', '==', 'pending'))),
    countOf(col('asked')),
    countOf(fs.query(col('asked'), fs.where('ts', '>=', today.getTime()))),
    fs.getDocs(fs.query(col('unanswered'), fs.orderBy('createdAt', 'desc'), fs.limit(50))),
    fs.getDocs(fs.query(col('asked'), fs.where('ts', '>=', since.getTime()), fs.limit(10000))),
    countOf(col('users')),
    countOf(fs.query(col('payments'), fs.where('status', '==', 'pending'))),
    fs.getDocs(col('subscriptions')),
  ]);

  const total = QA.length;
  const premiumQ = QA.filter((i) => i.isPremium).length;
  const links = QA.reduce((n, i) => n + (i.links || []).length, 0);
  const premiumN = subs.docs.filter((d) => (d.data().expiresAt || 0) > Date.now()).length;
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
      <div class="stat"><small>${icon('check', 16)} Premium Q&amp;A</small><b>${premiumQ}</b></div>
      <div class="stat"><small>${icon('link', 16)} Links attached</small><b>${links}</b></div>
      <div class="stat ${pending ? 'hot' : ''}"><small>${icon('inbox', 16)} Unanswered</small><b>${pending}</b></div>
      <div class="stat ${payPending ? 'hot' : ''}"><small>${icon('check', 16)} Pending payments</small><b>${payPending}</b></div>
      <div class="stat"><small>${icon('chat', 16)} Users</small><b>${usersN}</b></div>
      <div class="stat"><small>👑 Premium members</small><b>${premiumN}</b></div>
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
      ${i.isPremium ? '<span class="badge warn">👑 Premium</span>' : ''}
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

async function openEditor(item = null) {
  let premAnswer = '';
  let premLinks = [];
  if (item?.isPremium) {
    try {
      const pd = await fs.getDoc(fs.doc(db, 'qa_premium', item.id));
      if (pd.exists()) {
        premAnswer = pd.data().answer || '';
        premLinks = pd.data().links || [];
      }
    } catch (e) {
      console.warn(e);
    }
  }
  const d = item || { question: '', answer: '', keywords: [], category: '', isActive: true, isPremium: false, links: [] };
  const answerVal = item?.isPremium ? premAnswer : d.answer;
  const linksVal = item?.isPremium ? premLinks : d.links || [];
  const previewVal = item?.isPremium && !String(d.answer).startsWith('🔒') ? d.answer : '';
  const cats = [...new Set(QA.map((i) => i.category).filter(Boolean))];
  const m = openModal(`
    <h2>${item ? 'Edit question' : 'Add question'}</h2>
    <form id="edForm">
      <div class="field"><label for="fq">Question</label>
        <input class="input" id="fq" required maxlength="500" value="${esc(d.question)}" placeholder="e.g. How do I download the Instagram APK?"></div>
      <div class="field"><label for="fa">Answer</label>
        <textarea class="textarea" id="fa" required maxlength="5000" placeholder="Users will see this reply. **bold** and new lines are supported.">${esc(answerVal)}</textarea></div>
      <div class="field"><label for="fk">Keywords</label>
        <input class="input" id="fk" value="${esc((d.keywords || []).join(', '))}" placeholder="instagram, apk, download, डाउनलोड">
        <span class="hint">Separate with commas and use single words. Add Hindi, English and Hinglish versions, e.g. download, डाउनलोड, daunlod.</span></div>
      <div class="field"><label for="fc">Category (optional)</label>
        <input class="input" id="fc" list="catlist" maxlength="60" value="${esc(d.category || '')}" placeholder="General">
        <datalist id="catlist">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
      ${linksBlock(linksVal)}
      <label class="check" style="margin-bottom:8px"><input type="checkbox" id="fprem" ${d.isPremium ? 'checked' : ''}> 👑 Premium answer</label>
      <div class="field ${d.isPremium ? '' : 'hidden'}" id="fprevWrap">
        <label for="fprev">Free preview (optional)</label>
        <input class="input" id="fprev" maxlength="300" value="${esc(previewVal)}" placeholder="Shown to users without Premium">
        <span class="hint">With Premium on, the answer and links above are visible only to Premium members. Everyone else sees this preview and a Get Premium button.</span>
      </div>
      <label class="check" style="margin-bottom:16px"><input type="checkbox" id="fact" ${d.isActive ? 'checked' : ''}> Active (visible to users)</label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`, { wide: true });
  wireLinks(m);
  $('#fprem', m).addEventListener('change', (e) => $('#fprevWrap', m).classList.toggle('hidden', !e.target.checked));
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
          isPremium: $('#fprem', m).checked,
          preview: $('#fprev', m).value.trim(),
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
        ${u.lang && u.lang !== CONTENT_LANG ? `<p class="hint" data-tr="${esc(u.id)}">${esc(langName(u.lang))} · translating…</p>` : ''}
        <div class="tags"><span class="badge ${u.status === 'pending' ? 'warn' : u.status === 'answered' ? 'ok' : ''}">${u.status}</span><span class="tag">${timeAgo(u.createdAt)}</span><span class="tag">${esc(u.email || 'user ' + String(u.sessionId || '').slice(0, 6))}</span></div>
        ${u.adminReply ? `<p>${esc(u.adminReply)}</p>` : ''}
        <div class="card-actions">
          <button class="btn btn-primary btn-sm" data-act="reply">${icon('reply', 16)} ${u.status === 'answered' ? 'Reply again' : 'Reply'}</button>
          ${u.status === 'pending' ? `<button class="btn btn-ghost btn-sm" data-act="ignore">${icon('ban', 16)} Ignore</button>` : ''}
          <button class="btn btn-danger btn-sm" data-act="del">${icon('trash', 16)} Delete</button>
        </div></article>`).join('')
    : `<div class="empty">${icon('inbox', 30)}<p>${unTab === 'pending' ? 'No pending questions. Nice work!' : 'Nothing here yet.'}</p></div>`;
  box.onclick = onUnClick;
  rows.filter((u) => u.lang && u.lang !== CONTENT_LANG).forEach(async (u) => {
    const r = await safeTranslate(u.question, u.lang, CONTENT_LANG);
    const el = box.querySelector(`[data-tr="${u.id}"]`);
    if (el) el.textContent = r.ok ? `${langName(u.lang)} → ${CONTENT_LANG.toUpperCase()}: ${r.text}` : `${langName(u.lang)} (translation unavailable)`;
  });
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
        <span class="hint">More keywords give better auto-reply matching.</span></div>
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
      const foreign = u.lang && u.lang !== CONTENT_LANG;
      let qaId = u.qaId || null;
      if ($('#rsave', m).checked) {
        let qText = String(u.question).slice(0, 500);
        let kws = parseKeywords($('#rk', m).value);
        if (foreign) {
          // keep the user's own words as keywords so the same question matches next time, and save the question in your language
          const words = qText.toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter((w) => w.length >= 2).slice(0, 10);
          kws = [...new Set([...kws, ...words])];
          const tq = await safeTranslate(qText, u.lang, CONTENT_LANG);
          if (tq.ok) qText = tq.text.slice(0, 500);
        }
        qaId = await saveItem({ id: null, question: qText, answer, keywords: kws, category: '', isActive: true }, links);
      }
      let sendText = answer;
      if (foreign) {
        const tr = await safeTranslate(answer, CONTENT_LANG, u.lang);
        if (tr.ok) sendText = tr.text;
        else toast('Could not translate the reply, so it was sent as you wrote it.', 'error');
      }
      await fs.updateDoc(fs.doc(db, 'unanswered', u.id), {
        status: 'answered', adminReply: answer, replyLinks: links, qaId, repliedAt: Date.now(),
      });
      // the reply appears instantly in the user's chat (their chat page syncs live)
      const tid = u.threadId || 'general';
      const now = Date.now();
      await fs.setDoc(fs.doc(db, 'chats', u.sessionId, 'threads', tid), u.threadId ? { updatedAt: now } : { title: 'Admin replies', createdAt: now, updatedAt: now }, { merge: true });
      await fs.setDoc(fs.doc(db, 'chats', u.sessionId, 'threads', tid, 'messages', uuid()), {
        role: 'bot', content: sendText, links, qaId, ts: now,
      });
      closeModal();
      toast('Reply sent to user', 'success');
      renderUnanswered();
    });
  });
}


/* ---------- payments ---------- */
let PAY = [];
let payTab = 'pending';

async function renderPayments() {
  const snap = await fs.getDocs(fs.query(col('payments'), fs.orderBy('createdAt', 'desc'), fs.limit(300)));
  PAY = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const n = (st) => PAY.filter((p) => p.status === st).length;
  const tabs = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']];
  view.innerHTML = `
    <div class="tabs">${tabs.map(([k, t]) => `<button class="tab ${payTab === k ? 'on' : ''}" data-tab="${k}">${t} (${n(k)})</button>`).join('')}</div>
    <p class="hint" style="margin:0 0 12px">Approve a payment only after you see the same amount and UTR in your own UPI app or bank statement.</p>
    <div class="list" id="pList"></div>`;
  $$('.tab').forEach((b) => (b.onclick = () => { payTab = b.dataset.tab; renderPayments(); }));
  const rows = PAY.filter((p) => p.status === payTab);
  const box = $('#pList');
  box.innerHTML = rows.length
    ? rows.map((p) => `<article class="q-card" data-id="${esc(p.id)}">
        <h3>₹${esc(p.amount)} &middot; ${esc(p.plan)}</h3>
        <div class="tags"><span class="badge ${p.status === 'pending' ? 'warn' : p.status === 'approved' ? 'ok' : 'off'}">${esc(p.status)}</span><span class="tag">UTR ${esc(p.id)}</span><span class="tag">${timeAgo(p.createdAt)}</span></div>
        <div class="info-grid">
          <div><small>Email</small>${esc(p.email)}</div>
          <div><small>Name</small>${esc(p.name || '-')}</div>
          <div><small>Mobile</small>${esc(p.mobile || '-')}</div>
          <div><small>Submitted</small>${new Date(p.createdAt).toLocaleString()}</div>
        </div>
        ${p.reason ? `<p>Reason: ${esc(p.reason)}</p>` : ''}
        ${p.status === 'pending' ? `<div class="card-actions">
          <button class="btn btn-primary btn-sm" data-act="approve">${icon('check', 16)} Approve</button>
          <button class="btn btn-danger btn-sm" data-act="reject">${icon('x', 16)} Reject</button></div>` : ''}
      </article>`).join('')
    : `<div class="empty">${icon('check', 30)}<p>${payTab === 'pending' ? 'No pending payments.' : 'Nothing here yet.'}</p></div>`;
  box.onclick = onPayClick;
}

async function onPayClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const p = PAY.find((x) => x.id === id);
  if (!p) return;
  if (btn.dataset.act === 'approve') {
    if (!(await confirmBox(`Approve ₹${p.amount} (${p.plan}) from ${p.email}? Check that UTR ${p.id} for ₹${p.amount} is in your UPI app first.`, 'Approve'))) return;
    return guard(btn, async () => {
      await grantPremium(p.uid, p.email, p.plan, p.plan === 'yearly' ? 365 : 30, p.id);
      await fs.updateDoc(fs.doc(db, 'payments', p.id), { status: 'approved', reviewedAt: Date.now() });
      toast('Approved. Premium is active for this user.', 'success');
      renderPayments();
      updateBadge();
    });
  }
  if (btn.dataset.act === 'reject') {
    const m = openModal(`<h2>Reject payment</h2>
      <p style="margin:0 0 12px;color:var(--muted)">₹${esc(p.amount)} from ${esc(p.email)}</p>
      <div class="field"><label for="rj">Reason (the user will see this)</label>
        <textarea class="textarea" id="rj" maxlength="200" placeholder="e.g. Payment not received"></textarea></div>
      <div class="modal-actions"><button class="btn btn-ghost" data-no>Cancel</button><button class="btn btn-danger" id="rjGo">Reject</button></div>`);
    $('[data-no]', m).onclick = closeModal;
    $('#rjGo', m).onclick = () =>
      guard($('#rjGo', m), async () => {
        await fs.updateDoc(fs.doc(db, 'payments', p.id), { status: 'rejected', reason: $('#rj', m).value.trim(), reviewedAt: Date.now() });
        closeModal();
        toast('Payment rejected');
        renderPayments();
        updateBadge();
      });
  }
}

/* ---------- chats & users ---------- */
let USERS = [];
let SUBS = {};

async function renderChats() {
  const [us, ss] = await Promise.all([
    fs.getDocs(fs.query(col('users'), fs.orderBy('lastSeen', 'desc'), fs.limit(300))),
    fs.getDocs(col('subscriptions')),
  ]);
  USERS = us.docs.map((d) => ({ id: d.id, ...d.data() }));
  SUBS = Object.fromEntries(ss.docs.map((d) => [d.id, d.data()]));
  view.innerHTML = `
    <div class="toolbar" style="grid-template-columns:1fr">
      <div class="searchbox">${icon('search', 18)}<input class="input" id="uSearch" type="search" placeholder="Search by email, name or mobile…"></div>
    </div>
    <div class="list" id="usList"></div>`;
  $('#uSearch').addEventListener('input', debounce(drawUsers, 200));
  $('#usList').addEventListener('click', (e) => {
    const c = e.target.closest('[data-uid]');
    if (c) openUser(USERS.find((x) => x.id === c.dataset.uid));
  });
  drawUsers();
}

const isActiveSub = (uid) => (SUBS[uid]?.expiresAt || 0) > Date.now();

function drawUsers() {
  const q = ($('#uSearch')?.value || '').trim().toLowerCase();
  const rows = USERS.filter((u) => !q || [u.email, u.name, u.mobile].join(' ').toLowerCase().includes(q));
  $('#usList').innerHTML = rows.length
    ? rows.map((u) => `<article class="q-card" data-uid="${esc(u.id)}" style="cursor:pointer">
        <h3>${esc(u.email || u.id)}</h3>
        <div class="tags">
          <span class="badge ${isActiveSub(u.id) ? 'warn' : ''}">${isActiveSub(u.id) ? '👑 Premium' : 'Free'}</span>
          ${u.name ? `<span class="tag">${esc(u.name)}</span>` : ''}${u.mobile ? `<span class="tag">${esc(u.mobile)}</span>` : ''}
          <span class="tag">Last seen ${timeAgo(u.lastSeen || Date.now())}</span>
        </div></article>`).join('')
    : `<div class="empty">${icon('chat', 30)}<p>No users yet.</p></div>`;
}

async function openUser(u) {
  if (!u) return;
  const sub = SUBS[u.id];
  const m = openModal(`
    <h2>${esc(u.email || u.id)}</h2>
    <div class="info-grid">
      <div><small>Name</small>${esc(u.name || '-')}</div>
      <div><small>Mobile</small>${esc(u.mobile || '-')}</div>
      <div><small>Language</small>${esc(langName(u.lang))}</div>
      <div><small>Joined</small>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}</div>
      <div><small>Last seen</small>${u.lastSeen ? new Date(u.lastSeen).toLocaleString() : '-'}</div>
      <div><small>Plan</small>${isActiveSub(u.id) ? `👑 ${esc(sub.plan)} until ${new Date(sub.expiresAt).toLocaleDateString()}` : 'Free'}</div>
      <div><small>User ID</small>${esc(u.id)}</div>
    </div>
    <div class="row-actions">
      <button class="btn btn-ghost btn-sm" data-g="30">+30 days Premium</button>
      <button class="btn btn-ghost btn-sm" data-g="365">+1 year Premium</button>
      ${sub ? '<button class="btn btn-danger btn-sm" data-rev>Remove Premium</button>' : ''}
    </div>
    <div class="field"><label for="thSel">Chat</label><select class="select" id="thSel"></select></div>
    <div class="chatbox" id="thMsgs">Loading…</div>
    <div class="modal-actions" style="margin-top:14px"><button class="btn btn-ghost" data-close>Close</button></div>`, { wide: true });
  $('[data-close]', m).onclick = closeModal;
  m.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-g]');
    const rev = e.target.closest('[data-rev]');
    if (!g && !rev) return;
    try {
      if (g) {
        const days = Number(g.dataset.g);
        SUBS[u.id] = await grantPremium(u.id, u.email, days >= 365 ? 'yearly' : 'monthly', days, 'manual');
        toast(`Added ${days} days of Premium`, 'success');
      } else {
        if (!(await confirmBox('Remove Premium from this user?', 'Remove'))) return;
        await fs.deleteDoc(fs.doc(db, 'subscriptions', u.id));
        delete SUBS[u.id];
        toast('Premium removed');
      }
      closeModal();
      drawUsers();
      openUser(u);
    } catch (err) {
      toast(err.message || 'Failed', 'error');
    }
  });

  const sel = $('#thSel', m);
  const box = $('#thMsgs', m);
  const loadMsgs = async (tid) => {
    box.textContent = 'Loading…';
    try {
      const snap = await fs.getDocs(fs.query(fs.collection(db, 'chats', u.id, 'threads', tid, 'messages'), fs.orderBy('ts', 'asc'), fs.limit(500)));
      box.innerHTML = snap.docs.length
        ? snap.docs.map((d) => {
            const x = d.data();
            const ls = (x.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label || l.kind)}</a>`).join(' · ');
            return `<div class="cm ${esc(x.role)}">${esc(x.content).replace(/\n/g, '<br>')}${x.premium ? ' 👑' : ''}${ls ? `<br>${ls}` : ''}<small>${new Date(x.ts).toLocaleString()}</small></div>`;
          }).join('')
        : '<p class="hint">No messages.</p>';
      box.scrollTop = box.scrollHeight;
    } catch (err) {
      box.textContent = err.message;
    }
  };
  try {
    const ts = await fs.getDocs(fs.query(fs.collection(db, 'chats', u.id, 'threads'), fs.orderBy('updatedAt', 'desc'), fs.limit(100)));
    if (!ts.docs.length) {
      sel.innerHTML = '<option>No chats yet</option>';
      box.innerHTML = '<p class="hint">This user has not sent any messages.</p>';
      return;
    }
    sel.innerHTML = ts.docs.map((d) => `<option value="${esc(d.id)}">${esc(d.data().title || 'Chat')} · ${new Date(d.data().updatedAt || 0).toLocaleDateString()}</option>`).join('');
    sel.onchange = () => loadMsgs(sel.value);
    loadMsgs(sel.value);
  } catch (err) {
    box.textContent = err.message;
  }
}

/* ---------- premium settings ---------- */
async function renderSettings() {
  const snap = await fs.getDoc(fs.doc(db, 'settings', 'premium'));
  const s = snap.exists() ? snap.data() : { enabled: true, monthlyPrice: 99, yearlyPrice: 999, upiId: '', payeeName: '', note: '' };
  view.innerHTML = `
    <section class="panel" style="max-width:560px">
      <h2>Premium plans &amp; payment</h2>
      <form id="stForm" novalidate>
        <div class="field"><label for="stUpi">Your UPI ID</label>
          <input class="input" id="stUpi" value="${esc(s.upiId || '')}" placeholder="name@bank" autocapitalize="none">
          <span class="hint">All subscription payments go directly to this UPI ID. Double-check it.</span></div>
        <div class="field"><label for="stName">Payee name</label>
          <input class="input" id="stName" value="${esc(s.payeeName || '')}" maxlength="50" placeholder="Name shown in the UPI app"></div>
        <div class="field"><label for="stMonthly">Monthly price (₹)</label>
          <input class="input" id="stMonthly" type="number" min="0" step="1" value="${esc(s.monthlyPrice ?? '')}" placeholder="99"></div>
        <div class="field"><label for="stYearly">Yearly price (₹)</label>
          <input class="input" id="stYearly" type="number" min="0" step="1" value="${esc(s.yearlyPrice ?? '')}" placeholder="999">
          <span class="hint">Set a price to 0 to hide that plan.</span></div>
        <div class="field"><label for="stNote">Note for users (optional)</label>
          <input class="input" id="stNote" maxlength="200" value="${esc(s.note || '')}" placeholder="e.g. Activation can take up to 1 hour"></div>
        <label class="check" style="margin-bottom:16px"><input type="checkbox" id="stOn" ${s.enabled !== false ? 'checked' : ''}> Premium purchases enabled</label>
        <div class="err hidden" id="stErr"></div>
        <button class="btn btn-primary" id="stSave" type="submit">Save settings</button>
      </form>
    </section>`;
  $('#stForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#stErr');
    const fail = (t) => {
      err.textContent = t;
      err.classList.remove('hidden');
    };
    err.classList.add('hidden');
    const upiId = $('#stUpi').value.trim();
    const monthlyPrice = Math.round(Number($('#stMonthly').value) || 0);
    const yearlyPrice = Math.round(Number($('#stYearly').value) || 0);
    const enabled = $('#stOn').checked;
    if (!/^[\w.\-]{2,}@[A-Za-z][A-Za-z0-9]{1,}$/.test(upiId)) return fail('Enter a valid UPI ID, like name@bank.');
    if (monthlyPrice < 0 || yearlyPrice < 0) return fail('Prices cannot be negative.');
    if (enabled && !monthlyPrice && !yearlyPrice) return fail('Set at least one plan price, or turn purchases off.');
    guard($('#stSave'), async () => {
      await fs.setDoc(fs.doc(db, 'settings', 'premium'), {
        upiId, payeeName: $('#stName').value.trim(), monthlyPrice, yearlyPrice, note: $('#stNote').value.trim(), enabled, updatedAt: Date.now(),
      });
      toast('Settings saved', 'success');
    });
  });
}

/* ---------- boot ---------- */
if (!configured) {
  $('#setupBanner').textContent = 'Setup pending: add your Firebase config in js/config.js.';
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
