import Anthropic from '@anthropic-ai/sdk';
import { hashPassword, verifyPassword, randomToken, sha256Hex } from './crypto.js';

const SESSION_DAYS = 30;
const COOKIE = 'sabco_session';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const MAX_THUMB = 1_500_000; // chars of data URL

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = v => (Array.isArray(v) ? v.map(x => str(String(x))).filter(Boolean).slice(0, 30) : []);
const bool = v => (v ? 1 : 0);

async function body(req) {
  try { return await req.json(); } catch { fail(400, 'Invalid request body'); }
}

function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

// ---------- auth ----------

async function currentUser(req, env) {
  const token = getCookie(req, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.active = 1`
  ).bind(await sha256Hex(token), new Date().toISOString()).first();
  return row || null;
}

async function projectIdsFor(env, user) {
  if (user.role === 'admin') {
    const { results } = await env.DB.prepare('SELECT id FROM projects').all();
    return results.map(r => r.id);
  }
  const { results } = await env.DB.prepare('SELECT project_id FROM user_projects WHERE user_id = ?1').bind(user.id).all();
  return results.map(r => r.project_id);
}

const publicUser = u => ({
  id: u.id, name: u.name, username: u.username, role: u.role,
  can_edit_stages: !!u.can_edit_stages, must_change_password: !!u.must_change_password,
});

const requireAdmin = user => { if (user.role !== 'admin') fail(403, 'Admins only'); };
const requireStageEditor = user => { if (user.role !== 'admin' && !user.can_edit_stages) fail(403, 'Not allowed to edit stages'); };

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8) fail(400, 'Password must be at least 8 characters');
  if (p.length > 200) fail(400, 'Password is too long');
}

// ---------- AI amount reading ----------

async function extractAmount(env, imageB64, mediaType) {
  if (env.MOCK_AI !== undefined) return env.MOCK_AI === '' ? null : Number(env.MOCK_AI); // local testing only
  if (!env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            amount: {
              anyOf: [{ type: 'number' }, { type: 'null' }],
              description: 'Grand total actually paid, as a plain number. null if not clearly readable.',
            },
          },
          required: ['amount'],
          additionalProperties: false,
        },
      },
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
        {
          type: 'text',
          text: 'This is a photo of an invoice or receipt from a construction site in the UAE (it may be in Arabic or English, printed or handwritten). ' +
            'Return the final total amount paid, including VAT if shown, as a number in AED. ' +
            'If the photo is not an invoice/receipt, or the total is missing, cut off or you are not confident reading it, return null. Never guess.',
        },
      ],
    }],
  });
  if (res.stop_reason !== 'end_turn') return null;
  const text = res.content.find(b => b.type === 'text')?.text;
  const amount = text ? JSON.parse(text).amount : null;
  return typeof amount === 'number' && amount > 0 ? amount : null;
}

// ---------- operations ----------

const OP_COLUMNS = `o.id, o.created_at, o.date, o.stage, o.type, o.amount, o.amount_source,
  o.project_id, p.name AS project, p.color AS project_color, o.user_id, u.name AS engineer`;

function rowToOp(r) {
  return { ...r, stage: JSON.parse(r.stage), type: JSON.parse(r.type) };
}

async function listOps(env, user, url) {
  const month = url.searchParams.get('month');
  const date = url.searchParams.get('date');
  const where = [], args = [];
  if (date) { if (!DATE_RE.test(date)) fail(400, 'Bad date'); args.push(date); where.push(`o.date = ?${args.length}`); }
  else if (month) { if (!MONTH_RE.test(month)) fail(400, 'Bad month'); args.push(month + '-%'); where.push(`o.date LIKE ?${args.length}`); }
  else fail(400, 'month or date required');

  if (user.role !== 'admin') {
    args.push(user.id);
    where.push(`o.project_id IN (SELECT project_id FROM user_projects WHERE user_id = ?${args.length})`);
  }
  const cols = date ? OP_COLUMNS + ', o.thumb' : OP_COLUMNS;
  const { results } = await env.DB.prepare(
    `SELECT ${cols} FROM ops o JOIN projects p ON p.id = o.project_id JOIN users u ON u.id = o.user_id
     WHERE ${where.join(' AND ')} ORDER BY o.created_at`
  ).bind(...args).all();
  return results.map(rowToOp);
}

async function saveOp(env, user, b) {
  const id = str(b.id, 64);
  const projectId = Number(b.project_id);
  const amount = b.amount == null || b.amount === '' ? null : Number(b.amount);
  if (!id || !DATE_RE.test(b.date) || !Number.isInteger(projectId)) fail(400, 'Invalid operation');
  if (amount === null || !(amount > 0) || amount > 1e9) fail(400, 'Amount is required');
  const allowed = await projectIdsFor(env, user);
  if (!allowed.includes(projectId)) fail(403, 'This project is not assigned to you');

  const existing = await env.DB.prepare('SELECT user_id FROM ops WHERE id = ?1').bind(id).first();
  if (existing && existing.user_id !== user.id && user.role !== 'admin') fail(403, 'Not your operation');

  const thumb = typeof b.thumb === 'string' && b.thumb.startsWith('data:image/jpeg;base64,') && b.thumb.length < MAX_THUMB ? b.thumb : null;
  const createdAt = typeof b.created_at === 'string' && !isNaN(Date.parse(b.created_at)) ? b.created_at : new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO ops (id, user_id, project_id, created_at, date, stage, type, amount, amount_source, thumb)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(id) DO UPDATE SET project_id = ?3, stage = ?6, type = ?7, amount = ?8, amount_source = ?9,
       thumb = COALESCE(?10, thumb)`
  ).bind(id, existing ? existing.user_id : user.id, projectId, createdAt, b.date,
    JSON.stringify(strList(b.stage)), JSON.stringify(strList(b.type)),
    amount, b.amount_source === 'ai' ? 'ai' : 'manual', thumb).run();
}

// ---------- admin: users ----------

async function listUsers(env) {
  const { results: users } = await env.DB.prepare(
    'SELECT id, name, username, role, can_edit_stages, active, must_change_password, created_at FROM users ORDER BY role, name'
  ).all();
  const { results: links } = await env.DB.prepare('SELECT user_id, project_id FROM user_projects').all();
  return users.map(u => ({
    ...u, can_edit_stages: !!u.can_edit_stages, active: !!u.active, must_change_password: !!u.must_change_password,
    project_ids: links.filter(l => l.user_id === u.id).map(l => l.project_id),
  }));
}

async function setUserProjects(env, userId, projectIds) {
  const ids = Array.isArray(projectIds) ? [...new Set(projectIds.map(Number).filter(Number.isInteger))] : [];
  const stmts = [env.DB.prepare('DELETE FROM user_projects WHERE user_id = ?1').bind(userId)];
  for (const pid of ids) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO user_projects (user_id, project_id) SELECT ?1, id FROM projects WHERE id = ?2').bind(userId, pid));
  }
  await env.DB.batch(stmts);
}

async function createUser(env, b) {
  const name = str(b.name, 80), username = str(b.username, 32);
  if (!name) fail(400, 'Name is required');
  if (!USERNAME_RE.test(username)) fail(400, 'Username: 3-32 letters, numbers, dot, dash or underscore');
  checkPassword(b.password);
  const role = b.role === 'admin' ? 'admin' : 'engineer';
  if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ?1').bind(username).first()) fail(409, 'Username is taken');
  const { hash, salt } = await hashPassword(b.password);
  const r = await env.DB.prepare(
    `INSERT INTO users (name, username, pass_hash, salt, role, can_edit_stages, active, must_change_password, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7)`
  ).bind(name, username, hash, salt, role, bool(b.can_edit_stages), new Date().toISOString()).run();
  const id = r.meta.last_row_id;
  await setUserProjects(env, id, b.project_ids);
  return id;
}

async function updateUser(env, admin, id, b) {
  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  if (!target) fail(404, 'User not found');
  const sets = [], args = [];
  const set = (col, val) => { args.push(val); sets.push(`${col} = ?${args.length}`); };
  if (b.name !== undefined) { const n = str(b.name, 80); if (!n) fail(400, 'Name is required'); set('name', n); }
  if (b.can_edit_stages !== undefined) set('can_edit_stages', bool(b.can_edit_stages));
  if (b.active !== undefined) {
    if (target.id === admin.id && !b.active) fail(400, 'You cannot deactivate your own account');
    set('active', bool(b.active));
  }
  if (b.role !== undefined) {
    if (target.id === admin.id && b.role !== 'admin') fail(400, 'You cannot remove your own admin role');
    set('role', b.role === 'admin' ? 'admin' : 'engineer');
  }
  if (b.password !== undefined) {
    checkPassword(b.password);
    const { hash, salt } = await hashPassword(b.password);
    set('pass_hash', hash); set('salt', salt); set('must_change_password', 1);
  }
  if (sets.length) {
    args.push(id);
    await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${args.length}`).bind(...args).run();
  }
  if (b.project_ids !== undefined) await setUserProjects(env, id, b.project_ids);
  // A deactivated account or a reset password signs the user out everywhere
  if ((b.active !== undefined && !b.active) || b.password !== undefined) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id).run();
  }
}

// ---------- router ----------

async function handleApi(req, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;

  // Same-origin only for state-changing requests (cookie auth)
  if (method !== 'GET') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) fail(403, 'Cross-origin request blocked');
  }

  if (path === '/api/login' && method === 'POST') {
    const b = await body(req);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?1').bind(str(b.username, 32)).first();
    const ok = user && user.active && await verifyPassword(String(b.password || ''), user.salt, user.pass_hash);
    if (!ok) fail(401, 'Wrong username or password');
    const token = randomToken();
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(new Date().toISOString()),
      env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)').bind(await sha256Hex(token), user.id, expires),
    ]);
    return json({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = getCookie(req, COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256Hex(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const user = await currentUser(req, env);
  if (!user) fail(401, 'Please sign in');

  if (path === '/api/password' && method === 'POST') {
    const b = await body(req);
    if (!await verifyPassword(String(b.current || ''), user.salt, user.pass_hash)) fail(400, 'Current password is wrong');
    checkPassword(b.password);
    if (b.password === b.current) fail(400, 'Choose a new password');
    const { hash, salt } = await hashPassword(b.password);
    const token = getCookie(req, COOKIE);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ?1, salt = ?2, must_change_password = 0 WHERE id = ?3').bind(hash, salt, user.id),
      // sign out other devices, keep this one
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2').bind(user.id, await sha256Hex(token)),
    ]);
    return json({ ok: true });
  }

  // Everything below requires a password that is not a temporary one
  if (user.must_change_password && path !== '/api/me') fail(403, 'Change your password first');

  if (path === '/api/me' && method === 'GET') {
    const ids = await projectIdsFor(env, user);
    const { results: projects } = await env.DB.prepare('SELECT id, name, color, active FROM projects ORDER BY name').all();
    const { results: stages } = await env.DB.prepare('SELECT id, name, sort, active FROM stages ORDER BY sort, id').all();
    const body = {
      user: publicUser(user),
      projects: projects.filter(p => ids.includes(p.id)).map(p => ({ ...p, active: !!p.active })),
      stages: stages.map(s => ({ ...s, active: !!s.active })),
    };
    if (user.role === 'admin') {
      const { results } = await env.DB.prepare("SELECT id, name FROM users WHERE role = 'engineer' OR id = ?1 ORDER BY name").bind(user.id).all();
      body.engineers = results;
    }
    return json(body);
  }

  if (path === '/api/extract' && method === 'POST') {
    const b = await body(req);
    if (typeof b.image !== 'string' || !b.image || b.image.length > 6_000_000) fail(400, 'Image required');
    try {
      return json({ amount: await extractAmount(env, b.image, 'image/jpeg') });
    } catch (e) {
      console.error('extract failed', e);
      return json({ amount: null, error: 'ai_unavailable' }); // client falls back to manual entry
    }
  }

  if (path === '/api/ops' && method === 'GET') return json({ ops: await listOps(env, user, url) });
  if (path === '/api/ops' && method === 'POST') { await saveOp(env, user, await body(req)); return json({ ok: true }); }

  let m = path.match(/^\/api\/ops\/([^/]+)$/);
  if (m && method === 'DELETE') {
    requireAdmin(user);
    await env.DB.prepare('DELETE FROM ops WHERE id = ?1').bind(decodeURIComponent(m[1])).run();
    return json({ ok: true });
  }

  // users (admin)
  if (path === '/api/users' && method === 'GET') { requireAdmin(user); return json({ users: await listUsers(env) }); }
  if (path === '/api/users' && method === 'POST') { requireAdmin(user); return json({ id: await createUser(env, await body(req)) }); }
  m = path.match(/^\/api\/users\/(\d+)$/);
  if (m && method === 'PATCH') { requireAdmin(user); await updateUser(env, user, Number(m[1]), await body(req)); return json({ ok: true }); }

  // projects (admin)
  if (path === '/api/projects' && method === 'POST') {
    requireAdmin(user);
    const b = await body(req), name = str(b.name, 80);
    if (!name) fail(400, 'Project name is required');
    const color = COLOR_RE.test(b.color) ? b.color : '#185FA5';
    if (await env.DB.prepare('SELECT 1 FROM projects WHERE name = ?1').bind(name).first()) fail(409, 'A project with this name exists');
    const r = await env.DB.prepare('INSERT INTO projects (name, color) VALUES (?1, ?2)').bind(name, color).run();
    return json({ id: r.meta.last_row_id });
  }
  m = path.match(/^\/api\/projects\/(\d+)$/);
  if (m && method === 'PATCH') {
    requireAdmin(user);
    const b = await body(req), sets = [], args = [];
    const set = (c, v) => { args.push(v); sets.push(`${c} = ?${args.length}`); };
    if (b.name !== undefined) { const n = str(b.name, 80); if (!n) fail(400, 'Project name is required'); set('name', n); }
    if (b.color !== undefined) { if (!COLOR_RE.test(b.color)) fail(400, 'Bad color'); set('color', b.color); }
    if (b.active !== undefined) set('active', bool(b.active));
    if (sets.length) {
      args.push(Number(m[1]));
      try { await env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?${args.length}`).bind(...args).run(); }
      catch (e) { if (String(e).includes('UNIQUE')) fail(409, 'A project with this name exists'); throw e; }
    }
    return json({ ok: true });
  }

  // stages (admin or engineers allowed to edit stages)
  if (path === '/api/stages' && method === 'POST') {
    requireStageEditor(user);
    const name = str((await body(req)).name, 120);
    if (!name) fail(400, 'Stage name is required');
    if (await env.DB.prepare('SELECT 1 FROM stages WHERE name = ?1').bind(name).first()) fail(409, 'This stage already exists');
    const r = await env.DB.prepare('INSERT INTO stages (name, sort) VALUES (?1, (SELECT COALESCE(MAX(sort), 0) + 1 FROM stages))').bind(name).run();
    return json({ id: r.meta.last_row_id });
  }
  m = path.match(/^\/api\/stages\/(\d+)$/);
  if (m && method === 'PATCH') {
    requireStageEditor(user);
    const b = await body(req), sets = [], args = [];
    const set = (c, v) => { args.push(v); sets.push(`${c} = ?${args.length}`); };
    if (b.name !== undefined) { const n = str(b.name, 120); if (!n) fail(400, 'Stage name is required'); set('name', n); }
    if (b.active !== undefined) set('active', bool(b.active));
    if (b.sort !== undefined && Number.isInteger(b.sort)) set('sort', b.sort);
    if (sets.length) {
      args.push(Number(m[1]));
      try { await env.DB.prepare(`UPDATE stages SET ${sets.join(', ')} WHERE id = ?${args.length}`).bind(...args).run(); }
      catch (e) { if (String(e).includes('UNIQUE')) fail(409, 'This stage already exists'); throw e; }
    }
    return json({ ok: true });
  }

  fail(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, env, url);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error(e);
        return json({ error: 'Server error' }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
