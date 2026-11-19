// Shared client for the SABCO operations API (Cloudflare Worker in /worker)
// Worker URL, set at deploy time (e.g. https://sabco-ops-api.<account>.workers.dev).
// Empty = same origin, used when the Worker serves the pages itself (local preview).
const API_BASE = '';

const PROJECTS = ['Ahmed Al Hosani', 'Al Khalidya'];
const PROJECT_COLORS = { 'Ahmed Al Hosani': '#185FA5', 'Al Khalidya': '#D9822B' };

const Api = (() => {
  const KEY = 'sabco_access_code';
  const getCode = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  const setCode = c => { try { localStorage.setItem(KEY, c); } catch (e) {} };

  function askCode(msg) {
    const c = prompt(msg || 'Access code / كود الدخول');
    if (c) setCode(c.trim());
    return !!c;
  }

  async function call(path, opts = {}, retry = true) {
    if (!getCode() && !askCode()) throw new Error('no access code');
    const res = await fetch(API_BASE + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Access-Code': getCode(), ...(opts.headers || {}) },
    });
    if (res.status === 401 && retry) {
      setCode('');
      if (askCode('Wrong code, try again / الكود غلط، حاول تاني')) return call(path, opts, false);
    }
    if (!res.ok) throw new Error('API ' + res.status);
    return res.json();
  }

  return {
    extract: imageB64 => call('/api/extract', { method: 'POST', body: JSON.stringify({ image: imageB64, media_type: 'image/jpeg' }) }),
    saveOp: op => call('/api/ops', { method: 'POST', body: JSON.stringify(op) }),
    month: ym => call('/api/ops?month=' + ym).then(r => r.ops),
    day: d => call('/api/ops?date=' + d).then(r => r.ops),
    remove: id => call('/api/ops/' + encodeURIComponent(id), { method: 'DELETE' }),
  };
})();

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
