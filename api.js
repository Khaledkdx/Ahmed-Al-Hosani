// Shared client code for the SABCO pages (GitHub Pages) talking to the Cloudflare Worker API.

// Worker URL. Local runs (localhost) talk to `wrangler dev` on the same machine.
const WORKER_URL = 'https://ahmed-al-hosani.khalid-growth-automation.workers.dev';
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://localhost:8787' : WORKER_URL;

const TYPES = [
  ['Material', 'Material'], ['Labour', 'Labour'], ['Employees', 'Employees'], ['Subcontract', 'Subcontract'],
  ['Government', 'Government'], ['Equipment', 'Equipment'], ['Rental', 'Rental'], ['Gas', 'Gas'],
  ['Consultant overtime / Tender fees', 'Consultant / Tender'], ['Water', 'Water'],
];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const Session = {
  KEY: 'sabco_token',
  get() { try { return localStorage.getItem(this.KEY) || ''; } catch (e) { return ''; } },
  set(t) { try { t ? localStorage.setItem(this.KEY, t) : localStorage.removeItem(this.KEY); } catch (e) {} },
};

const Api = (() => {
  async function call(path, opts = {}) {
    let res;
    const token = Session.get();
    try {
      res = await fetch(API_BASE + path, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(opts.headers || {}),
        },
      });
    } catch (e) {
      throw new ApiError(0, 'No internet connection');
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && !path.startsWith('/api/login')) {
      Session.set('');
      if (/\/login(\.html)?$/.test(location.pathname)) throw new ApiError(401, data.error || 'Please sign in');
      location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search);
      return new Promise(() => {}); // page is navigating away; leave callers waiting
    }
    if (res.status === 403 && data.error === 'Change your password first') {
      location.href = 'login.html?change=1';
      return new Promise(() => {});
    }
    if (!res.ok) throw new ApiError(res.status, data.error || 'Request failed (' + res.status + ')');
    return data;
  }
  const post = (p, b) => call(p, { method: 'POST', body: JSON.stringify(b) });
  const patch = (p, b) => call(p, { method: 'PATCH', body: JSON.stringify(b) });

  let mePromise = null;
  return {
    call,
    login: async (username, password) => {
      const r = await post('/api/login', { username, password });
      Session.set(r.token);
      return r;
    },
    logout: async () => { try { await post('/api/logout', {}); } finally { Session.set(''); } },
    changePassword: (current, password) => post('/api/password', { current, password }),
    me: (fresh) => { if (fresh || !mePromise) mePromise = call('/api/me'); return mePromise; },
    extract: imageB64 => post('/api/extract', { image: imageB64 }),
    // public form (no sign-in)
    publicConfig: () => call('/api/public/config'),
    publicExtract: (engineerId, imageB64) => post('/api/public/extract', { engineer_id: engineerId, image: imageB64 }),
    publicSaveOp: op => post('/api/public/ops', op),
    saveOp: op => post('/api/ops', op),
    ops: params => call('/api/ops?' + new URLSearchParams(params)).then(r => r.ops),
    removeOp: id => call('/api/ops/' + encodeURIComponent(id), { method: 'DELETE' }),
    users: () => call('/api/users').then(r => r.users),
    createUser: u => post('/api/users', u),
    updateUser: (id, u) => patch('/api/users/' + id, u),
    createProject: p => post('/api/projects', p),
    updateProject: (id, p) => patch('/api/projects/' + id, p),
    createStage: name => post('/api/stages', { name }),
    updateStage: (id, s) => patch('/api/stages/' + id, s),
  };
})();

// Sign-in guard for app pages: resolves with /api/me, or redirects to the login page.
async function requireLogin() {
  const me = await Api.me();
  if (me.user.must_change_password) { location.href = 'login.html?change=1'; throw new Error('password change required'); }
  return me;
}

async function signOut() {
  try { await Api.logout(); } catch (e) {}
  location.href = 'login.html';
}

function localDateKey(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fmtAmount(n) {
  return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Downscale an image File to a JPEG data URL (max = longest side in px)
function resizeImage(file, max, quality) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ---------- UI helpers (toast + confirmation dialog) ----------

(function injectUiStyles() {
  const css = `
.ui-toast{position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:#1a1a2e;color:#fff;font-size:13px;padding:9px 16px;border-radius:20px;opacity:0;pointer-events:none;transition:opacity .25s;max-width:90vw;text-align:center;z-index:50}
.ui-toast.show{opacity:1}
.ui-modal{position:fixed;inset:0;background:rgba(15,25,40,.55);display:flex;align-items:flex-end;justify-content:center;z-index:40;padding:16px}
.ui-modal[hidden]{display:none}
.ui-box{background:#fff;border-radius:14px;width:100%;max-width:440px;max-height:90vh;overflow:auto;padding:1.1rem 1.1rem 1rem;box-shadow:0 10px 40px rgba(0,0,0,.25)}
@media(min-width:600px){.ui-modal{align-items:center}}
.ui-box h3{font-size:16px;font-weight:600;color:#1a1a2e;margin-bottom:.6rem}
.ui-body{font-size:13.5px;color:#444;line-height:1.55}
.ui-actions{display:flex;gap:8px;margin-top:1rem}
.ui-actions button{flex:1;padding:12px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid #dde3ea;background:#fafbfc;color:#333}
.ui-actions .ok{background:#185FA5;border-color:#185FA5;color:#fff}
.ui-actions .ok.danger{background:#c0392b;border-color:#c0392b}
.ui-actions .ok.wa{background:#25D366;border-color:#25D366}
.ui-actions button:focus-visible{outline:2px solid #378ADD;outline-offset:2px}
.userbar{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.userbar .who{font-size:12px;color:#666}
.pill-link{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:#185FA5;background:#fff;border:1px solid #dde3ea;border-radius:20px;padding:5px 12px;text-decoration:none;cursor:pointer;font-family:inherit}
.pill-link:hover{background:#E6F1FB}
.pill-link.quiet{color:#666}
`;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();

function toast(msg, ms = 2800) {
  let t = document.querySelector('.ui-toast');
  if (!t) { t = document.createElement('div'); t.className = 'ui-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

// Shows a confirmation dialog. onConfirm (optional) runs synchronously inside the click,
// which keeps the browser's user-gesture (needed for the WhatsApp share sheet).
function confirmDialog({ title, html = '', ok = 'Confirm', cancel = 'إلغاء', tone = '', onConfirm }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'ui-modal';
    wrap.innerHTML = `<div class="ui-box" role="dialog" aria-modal="true" aria-labelledby="ui-title">
      <h3 id="ui-title">${esc(title)}</h3><div class="ui-body">${html}</div>
      <div class="ui-actions"><button type="button" class="cancel">${esc(cancel)}</button>
      <button type="button" class="ok ${tone}">${esc(ok)}</button></div></div>`;
    document.body.appendChild(wrap);
    const close = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    wrap.querySelector('.cancel').onclick = () => close(false);
    wrap.addEventListener('click', e => { if (e.target === wrap) close(false); });
    wrap.querySelector('.ok').onclick = () => { if (onConfirm) onConfirm(); close(true); };
    wrap.querySelector('.ok').focus();
  });
}

function renderUserBar(el, me, links) {
  el.innerHTML = `<span class="who">👷 ${esc(me.user.name)}${me.user.role === 'admin' ? ' · Admin' : ''}</span>` +
    links.map(l => `<a class="pill-link" href="${l.href}"><i class="ti ${l.icon}"></i> ${esc(l.label)}</a>`).join('') +
    `<button class="pill-link quiet" type="button" id="signout-btn"><i class="ti ti-logout"></i> خروج</button>`;
  el.querySelector('#signout-btn').onclick = signOut;
}

// ---------- offline queue: operations that could not be uploaded yet ----------

const Pending = (() => {
  const KEY = 'sabco_pending_ops';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } };
  const write = list => {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; }
    catch (e) {
      // storage full: keep the record without its photo rather than lose it
      try { localStorage.setItem(KEY, JSON.stringify(list.map(o => ({ ...o, thumb: null })))); return true; } catch (e2) { return false; }
    }
  };
  let flushing = false;
  return {
    count: () => read().length,
    add(op) { const l = read().filter(o => o.id !== op.id); l.push(op); return write(l); },
    async flush() {
      if (flushing) return 0;
      flushing = true;
      let sent = 0;
      try {
        for (const op of read()) {
          try { await (op.engineer_id ? Api.publicSaveOp(op) : Api.saveOp(op)); sent++; write(read().filter(o => o.id !== op.id)); }
          catch (e) {
            if (e.status === 0 || e.status >= 500 || e.status === 401) break; // try again later
            write(read().filter(o => o.id !== op.id)); // rejected for good (e.g. project unassigned)
            console.warn('pending op dropped', op.id, e.message);
          }
        }
      } finally { flushing = false; }
      return sent;
    },
  };
})();
