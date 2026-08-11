// aliyun-fc-sync.js
// 阿里云函数计算(FC)同步后端 —— 计算在阿里云FC，存储复用腾讯云COS桶（函数用子账号密钥访问）。
// 部署：FC HTTP 触发器（免鉴权），handler = index.handler
// 与前端契约一致：GET/POST /api/sync?u=用户名&t=令牌
// 新增：/api/invites（邀请码云端管理+校验）、/api/admin/login（管理员登录拿 token）
// 适配阿里云 FC Node.js HTTP 触发器格式：exports.handler = (req, resp, context)
'use strict';
const COS = require('cos-nodejs-sdk-v5');
const crypto = require('crypto');

const SALT = process.env.SALT || 'cb-ration-cloud-sync-v1-fixed-salt-do-not-leak';
const BUCKET = process.env.COS_BUCKET || '';
const REGION = process.env.COS_REGION || 'ap-guangzhou';
// 管理员密码：必须走 FC 环境变量（切勿在前端/仓库明文），部署脚本 deploy_aliyun.py 写入
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin2026';

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
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}
function send(resp, status, obj, origin) {
  const h = corsHeaders(origin);
  h['Content-Type'] = 'application/json';
  resp.setStatusCode(status);
  for (const k in h) resp.setHeader(k, h[k]);
  resp.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

// 管理员登录 token：sha256("admin:" + 密码 + ":" + SALT)，稳定且前端只持有 token 不含明文密码
function adminToken() {
  return crypto.createHash('sha256').update('admin:' + ADMIN_PASS + ':' + SALT).digest('hex');
}
// 防时序侧信道比较
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
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

// 邀请码云端存储：invites.json = { codes: ["AAAA","BBBB"], updatedAt }
async function getInvites() {
  try {
    const res = await cos().getObject({ Bucket: BUCKET, Region: REGION, Key: 'invites.json' });
    return JSON.parse(res.Body.toString('utf8'));
  } catch (e) {
    if (e && (e.statusCode === 404 || e.error === 'NoSuchKey')) return { codes: [] };
    throw e;
  }
}
async function putInvites(obj) {
  await cos().putObject({
    Bucket: BUCKET, Region: REGION, Key: 'invites.json',
    Body: JSON.stringify(obj), ContentType: 'application/json'
  });
}

function safeUser(u) { return /^[a-zA-Z0-9_\-]{1,40}$/.test(u); }
function isToken(t) { return /^[a-f0-9]{64}$/.test(t); }

function reqPath(req) {
  if (req.path) return req.path;
  const url = req.url || '';
  const q = url.indexOf('?');
  return (q >= 0 ? url.slice(0, q) : url) || '/api/sync';
}

exports.handler = async function (req, resp, context) {
  const method = (req.method || 'GET').toUpperCase();
  const origin = (req.headers && (req.headers.Origin || req.headers.origin)) || '';
  const q = req.queries || {};
  const getQ = (k) => { const v = q[k]; return Array.isArray(v) ? v[0] : (v || ''); };
  const path = reqPath(req);

  try {
    if (method === 'OPTIONS') return send(resp, 204, '', origin);

    // ============ /api/admin/login ============
    if (path === '/api/admin/login' && method === 'POST') {
      let body = {};
      try { body = req.body ? JSON.parse(req.body) : {}; } catch (e) { return send(resp, 400, { error: 'bad json' }, origin); }
      const pass = body.pass || '';
      if (!safeEqual(pass, ADMIN_PASS)) return send(resp, 403, { error: 'forbidden' }, origin);
      return send(resp, 200, { ok: true, token: adminToken() }, origin);
    }

    // ============ /api/invites ============
    if (path === '/api/invites') {
      if (method === 'GET') {
        // 仅校验单个码是否有效，绝不返回码列表（避免泄露全部邀请码）
        const code = String(getQ('code') || '').trim().toUpperCase();
        if (!code) return send(resp, 400, { error: 'missing code' }, origin);
        const inv = await getInvites();
        const valid = Array.isArray(inv.codes) && inv.codes.includes(code);
        return send(resp, 200, { valid: !!valid }, origin);
      }
      if (method === 'POST') {
        let body = {};
        try { body = req.body ? JSON.parse(req.body) : {}; } catch (e) { return send(resp, 400, { error: 'bad json' }, origin); }
        // 管理操作必须带有效 admin token
        if (!safeEqual(body.token || '', adminToken())) return send(resp, 403, { error: 'forbidden' }, origin);
        const inv = await getInvites();
        if (!Array.isArray(inv.codes)) inv.codes = [];
        const action = body.action;
        if (action === 'list') {
          return send(resp, 200, { codes: inv.codes }, origin);
        }
        if (action === 'add') {
          const c = String(body.code || '').trim().toUpperCase();
          if (c.length < 4) return send(resp, 400, { error: 'code too short' }, origin);
          if (inv.codes.includes(c)) return send(resp, 400, { error: 'exists' }, origin);
          inv.codes.push(c);
          inv.updatedAt = Date.now();
          await putInvites(inv);
          return send(resp, 200, { ok: true, codes: inv.codes }, origin);
        }
        if (action === 'remove') {
          const c = String(body.code || '').trim().toUpperCase();
          inv.codes = inv.codes.filter(x => x !== c);
          inv.updatedAt = Date.now();
          await putInvites(inv);
          return send(resp, 200, { ok: true, codes: inv.codes }, origin);
        }
        return send(resp, 400, { error: 'unknown action' }, origin);
      }
      return send(resp, 405, { error: 'method not allowed' }, origin);
    }

    // ============ /api/sync（原逻辑，扩展 usage 字段）============
    const u = getQ('u') || '';
    const t = getQ('t') || '';
    if (!safeUser(u)) return send(resp, 400, { error: 'invalid user' }, origin);

    if (method === 'GET') {
      const rec = await getRec(u);
      if (!rec) return send(resp, 404, { error: 'not found' }, origin);
      if (!isToken(t) || rec.token !== t) return send(resp, 403, { error: 'forbidden' }, origin);
      return send(resp, 200, {
        updatedAt: rec.updatedAt,
        data: {
          securityCode: rec.securityCode,
          favorites: rec.favorites,
          grids: rec.grids || [],
          usageCount: rec.usageCount || 0,
          unlocked: !!rec.unlocked,
          inviteCode: rec.inviteCode || ''
        }
      }, origin);
    }

    if (method === 'POST') {
      let body = {};
      try { body = req.body ? JSON.parse(req.body) : {}; } catch (e) { return send(resp, 400, { error: 'bad json' }, origin); }
      const rec = await getRec(u);
      if (rec) {
        if (!isToken(t) || rec.token !== t) return send(resp, 403, { error: 'forbidden' }, origin);
      } else {
        if (!isToken(t)) return send(resp, 403, { error: 'bad token' }, origin);
      }
      // 字段级合并：只更新请求里显式传了的字段，没传的保留云端旧值，避免网格/可转债两应用互相覆盖
      const newRec = {
        token: t,
        securityCode: body.securityCode !== undefined ? String(body.securityCode) : (rec ? rec.securityCode : ''),
        favorites: body.favorites !== undefined ? body.favorites : (rec ? rec.favorites : []),
        grids: body.grids !== undefined ? body.grids : (rec ? rec.grids : []),
        usageCount: body.usageCount !== undefined ? Number(body.usageCount) : (rec ? rec.usageCount : 0),
        unlocked: body.unlocked !== undefined ? !!body.unlocked : (rec ? !!rec.unlocked : false),
        inviteCode: body.inviteCode !== undefined ? String(body.inviteCode) : (rec ? rec.inviteCode : ''),
        updatedAt: Date.now()
      };
      await putRec(u, newRec);
      return send(resp, 200, { ok: true }, origin);
    }

    return send(resp, 405, { error: 'method not allowed' }, origin);
  } catch (e) {
    return send(resp, 500, { error: String((e && e.message) || e) }, origin);
  }
};
