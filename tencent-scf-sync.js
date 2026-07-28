// tencent-scf-sync.js
// 腾讯云 SCF（云函数）同步后端 —— 替代 Cloudflare Worker，国内直连。
// 触发方式：API 网关（请求集成），函数返回 {statusCode, headers, body, isBase64Encoded}
// 存储：腾讯云 COS，每个用户一个对象  sync/<用户名>.json
//
// 与前端契约完全一致（照搬 Cloudflare Worker 逻辑）：
//   GET  /api/sync?u=用户名&t=令牌
//        -> 404  key 不存在（供重名探测判断"未注册"）
//        -> 403  令牌格式非法 或 令牌不匹配
//        -> 200  { updatedAt, data:{ securityCode, favorites } }
//   POST /api/sync?u=用户名&t=令牌   body={securityCode, favorites}
//        -> 400  令牌格式非法 / body 非 JSON
//        -> 403  已存在且令牌不匹配
//        -> 200  { ok:true }
//
// 鉴权盐 SALT 必须与前端 index.html 的 CF_SALT 完全一致。

'use strict';
const COS = require('cos-nodejs-sdk-v5');

const SALT = process.env.SALT || 'cb-ration-cloud-sync-v1-fixed-salt-do-not-leak';
const BUCKET = process.env.COS_BUCKET || '';
const REGION = process.env.COS_REGION || 'ap-guangzhou';
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

let _cos = null;
function cos() {
  if (!_cos) {
    _cos = new COS({
      SecretId: process.env.COS_SECRET_ID,
      SecretKey: process.env.COS_SECRET_KEY
    });
  }
  return _cos;
}

function corsHeaders(origin) {
  const allowOrigin = (ALLOWED_ORIGIN.length && ALLOWED_ORIGIN.includes(origin)) ? origin : (ALLOWED_ORIGIN[0] || '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}
function json(status, obj, origin) {
  return {
    statusCode: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin)),
    isBase64Encoded: false,
    body: JSON.stringify(obj)
  };
}

async function getRec(u) {
  try {
    const res = await cos().getObject({ Bucket: BUCKET, Region: REGION, Key: 'sync/' + u + '.json' });
    return JSON.parse(res.Body.toString('utf8'));
  } catch (e) {
    if (e && (e.statusCode === 404 || e.error === 'NoSuchKey')) return null;
    throw e;
  }
}
async function putRec(u, rec) {
  await cos().putObject({
    Bucket: BUCKET, Region: REGION, Key: 'sync/' + u + '.json',
    Body: JSON.stringify(rec), ContentType: 'application/json'
  });
}

function safeUser(u) { return /^[a-zA-Z0-9_\-]{1,40}$/.test(u); }
function isToken(t) { return /^[a-f0-9]{64}$/.test(t); }

async function handle(event) {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const path = event.path || '';
  const origin = (event.headers && (event.headers.Origin || event.headers.origin)) || '';
  const q = event.queryString || {};
  const u = q.u || '';
  const t = q.t || '';

  if (!path.startsWith('/api/sync')) return json(404, { error: 'not found' }, origin);
  if (method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(origin), isBase64Encoded: false, body: '' };
  if (!safeUser(u)) return json(400, { error: 'invalid user' }, origin);

  // GET：拉取
  if (method === 'GET') {
    const rec = await getRec(u);
    if (!rec) return json(404, { error: 'not found' }, origin);
    if (!isToken(t) || rec.token !== t) return json(403, { error: 'forbidden' }, origin);
    return json(200, { updatedAt: rec.updatedAt, data: rec.data }, origin);
  }

  // POST：保存
  if (method === 'POST') {
    if (!isToken(t)) return json(400, { error: 'invalid token' }, origin);
    let payload;
    try {
      const raw = event.body || '';
      payload = JSON.parse(event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw);
    } catch (e) {
      return json(400, { error: 'bad json' }, origin);
    }
    if (JSON.stringify(payload).length > 100000) return json(413, { error: 'too large' }, origin);
    const rec = await getRec(u);
    if (rec && rec.token !== t) return json(403, { error: 'forbidden' }, origin);
    await putRec(u, {
      token: t,
      updatedAt: new Date().toISOString(),
      data: { securityCode: payload.securityCode || '', favorites: payload.favorites || [] }
    });
    return json(200, { ok: true }, origin);
  }

  return json(405, { error: 'method not allowed' }, origin);
}

exports.main_handler = async (event, context) => {
  try {
    return await handle(event);
  } catch (e) {
    console.error('sync error', e);
    return json(500, { error: 'internal error' }, (event && event.headers && (event.headers.Origin || event.headers.origin)) || '');
  }
};
