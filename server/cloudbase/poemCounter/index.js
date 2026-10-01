// 腾讯云开发 CloudBase 云函数：诗句计数。每首诗只存一个数字，不存任何个人信息。
// 部署：见 server/README.md。HTTP 访问路径建议设为 /poem，前端配置 CONFIG.poemStats.url = 'https://<环境域名>/poem'
//   POST /poem/hit        body {"id":"p012"}   → {"id":"p012","count":1234}
//   GET  /poem/count?id=p012                  → {"id":"p012","count":1234}
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;
const COL = 'poem_counts';
const ID = /^p\d{3,4}$/;
// 只允许你的站点调用；换了域名记得加进来
const ORIGINS = ['https://wojiaozyh123-hub.github.io'];

function reply(event, status, data) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Cache-Control': 'no-store',
    },
    body: data === null ? '' : JSON.stringify(data),
  };
}

async function read(id) {
  const res = await db.collection(COL).doc(id).get();
  return res.data && res.data.length ? res.data[0].n || 0 : 0;
}

exports.main = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return reply(event, 204, null);
  const path = String(event.path || '');
  try {
    if (method === 'POST' && path.endsWith('/hit')) {
      let body = event.body || '{}';
      if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
      const id = String(JSON.parse(body).id || '');
      if (!ID.test(id)) return reply(event, 400, { error: 'bad id' });
      const doc = db.collection(COL).doc(id);
      const up = await doc.update({ n: _.inc(1) });
      if (!up.updated) await doc.set({ n: 1 });
      return reply(event, 200, { id, count: await read(id) });
    }
    if (method === 'GET' && path.endsWith('/count')) {
      const id = String((event.queryStringParameters || {}).id || '');
      if (!ID.test(id)) return reply(event, 400, { error: 'bad id' });
      return reply(event, 200, { id, count: await read(id) });
    }
    return reply(event, 404, { error: 'not found' });
  } catch (e) {
    return reply(event, 500, { error: 'server' });
  }
};
