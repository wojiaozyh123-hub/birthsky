// Cloudflare Workers + D1 version of the poem counter (alternative to CloudBase; needs your own domain
// for reliable access from mainland China — *.workers.dev is often unreachable there).
//   POST /hit {"id":"p012"} → {"id","count"}      GET /count?id=p012 → {"id","count"}
const ID = /^p\d{3,4}$/;
const ORIGINS = ['https://wojiaozyh123-hub.github.io'];

function reply(req, status, data) {
  const origin = req.headers.get('origin') || '';
  return new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return reply(req, 204, null);
    if (req.method === 'POST' && url.pathname.endsWith('/hit')) {
      let id = '';
      try { id = String((await req.json()).id || ''); } catch { /* bad body */ }
      if (!ID.test(id)) return reply(req, 400, { error: 'bad id' });
      const row = await env.DB.prepare('INSERT INTO poem_counts (id, n) VALUES (?1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1 RETURNING n')
        .bind(id).first();
      return reply(req, 200, { id, count: row ? row.n : 1 });
    }
    if (req.method === 'GET' && url.pathname.endsWith('/count')) {
      const id = url.searchParams.get('id') || '';
      if (!ID.test(id)) return reply(req, 400, { error: 'bad id' });
      const row = await env.DB.prepare('SELECT n FROM poem_counts WHERE id = ?1').bind(id).first();
      return reply(req, 200, { id, count: row ? row.n : 0 });
    }
    return reply(req, 404, { error: 'not found' });
  },
};
