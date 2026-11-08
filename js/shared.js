import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const configured =
  /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 40;

export function makeClient(persist) {
  if (!configured) return null;
  const auth = persist
    ? { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'autoreply-admin-auth' }
    : { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth });
}

export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function safeUrl(u) {
  try {
    let v = String(u).trim();
    if (!v) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
    const x = new URL(v);
    return ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'].includes(x.protocol) ? null : x.href;
  } catch {
    return null;
  }
}

export const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export function timeAgo(d) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;
  return new Date(d).toLocaleDateString();
}

const P = {
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  app: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  home: '<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01M2 14h2M20 14h2"/>',
  reply: '<path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12A9 9 0 0 1 18.5 5.8L21 8M21 3v5h-5M3 21v-5h5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
};
export const icon = (n, size = 20) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;

export function initTheme(btn) {
  const meta = document.querySelector('meta[name="theme-color"]');
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('ar-theme', t);
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0a1412' : '#0b5d55');
    if (btn) {
      btn.innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
      btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }
  };
  apply(document.documentElement.dataset.theme || 'light');
  btn?.addEventListener('click', () => apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

export function toast(msg, type = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

export function registerSW() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}
