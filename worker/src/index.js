import Anthropic from '@anthropic-ai/sdk';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Access-Code',
  'Access-Control-Max-Age': '86400',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const strList = v => Array.isArray(v) ? v.map(String).slice(0, 30) : [];

function rowToOp(r) {
  return { ...r, stage: JSON.parse(r.stage), type: JSON.parse(r.type) };
}

// Ask Claude for the invoice total. Returns a number, or null when it can't tell.
async function extractAmount(env, imageB64, mediaType) {
  if (env.MOCK_AI !== undefined) return env.MOCK_AI === '' ? null : Number(env.MOCK_AI); // local testing only
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

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.startsWith('/api/')) return json({ error: 'not found' }, 404);

    if (!env.ACCESS_CODE || req.headers.get('X-Access-Code') !== env.ACCESS_CODE)
      return json({ error: 'unauthorized' }, 401);

    try {
      if (path === '/api/ping' && req.method === 'GET') return json({ ok: true });

      if (path === '/api/extract' && req.method === 'POST') {
        const { image, media_type } = await req.json();
        if (typeof image !== 'string' || !image) return json({ error: 'image required' }, 400);
        try {
          return json({ amount: await extractAmount(env, image, media_type || 'image/jpeg') });
        } catch (e) {
          console.error('extract failed', e);
          return json({ amount: null, error: 'ai_unavailable' }); // client falls back to manual entry
        }
      }

      if (path === '/api/ops' && req.method === 'POST') {
        const b = await req.json();
        const amount = b.amount == null || b.amount === '' ? null : Number(b.amount);
        if (!b.id || !DATE_RE.test(b.date) || !b.project || (amount !== null && !(amount >= 0)))
          return json({ error: 'invalid operation' }, 400);
        await env.DB.prepare(
          `INSERT INTO ops (id, created_at, date, project, stage, type, amount, amount_source, thumb)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
           ON CONFLICT(id) DO UPDATE SET project=?4, stage=?5, type=?6, amount=?7, amount_source=?8`
        ).bind(
          String(b.id), b.created_at || new Date().toISOString(), b.date, String(b.project),
          JSON.stringify(strList(b.stage)), JSON.stringify(strList(b.type)),
          amount, b.amount_source === 'ai' ? 'ai' : 'manual',
          typeof b.thumb === 'string' && b.thumb.length < 400000 ? b.thumb : null
        ).run();
        return json({ ok: true });
      }

      if (path === '/api/ops' && req.method === 'GET') {
        const month = url.searchParams.get('month'), date = url.searchParams.get('date');
        if (date && DATE_RE.test(date)) {
          const { results } = await env.DB.prepare('SELECT * FROM ops WHERE date = ?1 ORDER BY created_at').bind(date).all();
          return json({ ops: results.map(rowToOp) });
        }
        if (month && MONTH_RE.test(month)) {
          const { results } = await env.DB.prepare(
            `SELECT id, created_at, date, project, stage, type, amount, amount_source
             FROM ops WHERE date LIKE ?1 ORDER BY created_at`
          ).bind(month + '-%').all();
          return json({ ops: results.map(rowToOp) });
        }
        return json({ error: 'month or date required' }, 400);
      }

      const m = path.match(/^\/api\/ops\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM ops WHERE id = ?1').bind(decodeURIComponent(m[1])).run();
        return json({ ok: true });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'server error' }, 500);
    }
  },
};
