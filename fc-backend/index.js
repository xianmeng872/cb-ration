// aliyun-fc-sync.js
// 阿里云函数计算(FC)同步后端 —— 计算在阿里云FC，存储用同地域阿里云OSS（深圳），密钥走FC环境变量。
// 部署：FC HTTP 触发器（免鉴权），handler = index.handler
// 与前端契约一致：GET/POST /api/sync?u=用户名&t=令牌
// 新增：/api/invites（邀请码云端管理+校验）、/api/admin/login（管理员登录拿 token）
// 适配阿里云 FC Node.js HTTP 触发器格式：exports.handler = (req, resp, context)
'use strict';
const OSS = require('ali-oss');
const crypto = require('crypto');
const https = require('https');

const SALT = process.env.SALT || 'wg-grid-sync-v1-fixed-salt-do-not-leak';
const OSS_BUCKET = process.env.OSS_BUCKET || '';
const OSS_REGION = process.env.OSS_REGION || 'oss-cn-shenzhen';
// 管理员密码：必须走 FC 环境变量（切勿在前端/仓库明文），部署脚本 deploy_aliyun.py 写入
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin2026';

// 优先使用 FC 服务角色注入的临时凭证（ALIBABA_CLOUD_*），彻底不依赖长期 AK。
// 回退：OSS_AK_ID/OSS_AK_SECRET（本地调试或兼容）。每次新建以拿到最新轮转的临时凭证。
function ossClient() {
  const ak = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const sk = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  const token = process.env.ALIBABA_CLOUD_SECURITY_TOKEN;
  if (ak && sk) {
    return new OSS({
      region: OSS_REGION,
      accessKeyId: ak,
      accessKeySecret: sk,
      stsToken: token,
      bucket: OSS_BUCKET
    });
  }
  return new OSS({
    region: OSS_REGION,
    accessKeyId: process.env.OSS_AK_ID || '',
    accessKeySecret: process.env.OSS_AK_SECRET || '',
    bucket: OSS_BUCKET
  });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

// ================= 真账号体系（注册/登录/找回 + 服务端签发 token） =================
// AUTH_SECRET 必须走 FC 环境变量（deploy_aliyun.py 写入随机值）；缺省 fallback 仅本地调试用，绝不可上线。
const AUTH_SECRET = process.env.AUTH_SECRET || (SALT + '-auth-fallback-do-not-use-in-prod');
const TOKEN_TTL = 30 * 24 * 3600 * 1000; // token 有效期 30 天

function b64url(s){ return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function b64urlDecode(s){ s = s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length % 4) s += '='; return Buffer.from(s,'base64').toString('utf8'); }

// 密码哈希：scrypt + 随机盐，存储格式 scrypt$<saltB64>$<hashB64>
function hashPw(pw){
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
function verifyPw(pw, stored){
  if(!stored || typeof stored !== 'string' || stored.indexOf('scrypt$') !== 0) return false;
  const parts = stored.split('$');
  if(parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], 'base64');
  const h = Buffer.from(parts[2], 'base64');
  const h2 = crypto.scryptSync(String(pw), salt, 64);
  if(h.length !== h2.length) return false;
  return crypto.timingSafeEqual(h, h2);
}
// 服务端签发 token：payload(用户名+签发时间).HMAC，前端只持有 token 不含明文密码
function signToken(username){
  const payload = b64url(JSON.stringify({ sub: username, iat: Date.now() }));
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return payload + '.' + sig;
}
function verifyToken(token){
  if(!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const parts = token.split('.');
  if(parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(parts[0]).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const a = Buffer.from(parts[1]); const b = Buffer.from(expected);
  if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj; try { obj = JSON.parse(b64urlDecode(parts[0])); } catch(e){ return null; }
  if(!obj || !obj.sub) return null;
  if(Date.now() - (obj.iat || 0) > TOKEN_TTL) return null;
  return obj;
}
function bearerToken(req){
  const h = (req.headers && (req.headers.Authorization || req.headers.authorization)) || '';
  return h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : '';
}
function safeName(n){ return /^[a-zA-Z0-9_]{3,20}$/.test(n); }

// 用户存储：users/<username>.json = { username, pwHash, secHash, createdAt }
async function getUser(name){
  try { const res = await ossClient().get('users/' + name + '.json'); return JSON.parse(res.content.toString('utf8')); }
  catch(e){ if(e && e.code === 'NoSuchKey') return null; throw e; }
}
async function putUser(name, rec){ await ossClient().put('users/' + name + '.json', Buffer.from(JSON.stringify(rec))); }

async function getRec(u) {
  try {
    const res = await ossClient().get('wg/' + u + '.json');
    return JSON.parse(res.content.toString('utf8'));
  } catch (e) {
    if (e && e.code === 'NoSuchKey') return null;
    throw e;
  }
}
async function putRec(u, rec) {
  await ossClient().put('wg/' + u + '.json', Buffer.from(JSON.stringify(rec)));
}

// 邀请码云端存储：invites.json = { codes: ["AAAA","BBBB"], updatedAt }
async function getInvites() {
  try {
    const res = await ossClient().get('invites.json');
    return JSON.parse(res.content.toString('utf8'));
  } catch (e) {
    if (e && e.code === 'NoSuchKey') return { codes: [] };
    throw e;
  }
}
async function putInvites(obj) {
  await ossClient().put('invites.json', Buffer.from(JSON.stringify(obj)));
}

function safeUser(u) { return /^[a-zA-Z0-9_\-]{1,40}$/.test(u); }
function isToken(t) { return /^[a-f0-9]{64}$/.test(t); }

// 服务端 HTTPS GET（用于代理集思录等无 CORS 的第三方接口），自动跟随一次重定向
function httpsGet(url, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jisilu.cn/' }
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        return httpsGet(res.headers.location, timeoutMs).then(resolve, reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('jisilu request timeout')); });
  });
}

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

    // ============ /api/auth（真账号：注册/登录/找回） ============
    if (path === '/api/auth/register' && method === 'POST') {
      let body = {};
      try { body = req.body ? JSON.parse(req.body) : {}; } catch (e) { return send(resp, 400, { error: 'bad json' }, origin); }
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const sec = String(body.securityCode || '');
      if (!safeName(username)) return send(resp, 400, { error: '用户名需3-20位字母数字下划线' }, origin);
      if (password.length < 4) return send(resp, 400, { error: '密码至少4位' }, origin);
      if (sec.length < 4 || sec.length > 6) return send(resp, 400, { error: '安全码需4-6位' }, origin);
      if (await getUser(username)) return send(resp, 400, { error: '该用户名已被注册' }, origin);
      const rec = { username, pwHash: hashPw(password), secHash: hashPw(sec), createdAt: Date.now() };
      await putUser(username, rec);
      // 初始化同步记录（空 grids/favorites/cbFavorites）
      try { const ex = await getRec(username); if (!ex) await putRec(username, { grids: [], favorites: [], cbFavorites: [], updatedAt: Date.now() }); } catch (e) {}
      return send(resp, 200, { ok: true, token: signToken(username) }, origin);
    }
    if (path === '/api/auth/login' && method === 'POST') {
      let body = {};
      try { body = req.body ? JSON.parse(req.body) : {}; } catch (e) { return send(resp, 400, { error: 'bad json' }, origin); }
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return send(resp, 400, { error: 'missing' }, origin);
      const rec = await getUser(username);
      if (!rec || !verifyPw(password, rec.pwHash)) return send(resp, 403, { error: '用户名或密码错误' }, origin);
      return send(resp, 200, { ok: true, token: signToken(username) }, origin);
    }
    if (path === '/api/auth/forgot' && method === 'POST') {
      let body = {};
      try { body = req.body ? JSON.parse(req.body) : {}; } catch (e) { return send(resp, 400, { error: 'bad json' }, origin); }
      const username = String(body.username || '').trim();
      const sec = String(body.securityCode || '');
      const np = String(body.newPassword || '');
      if (!username || !sec || np.length < 4) return send(resp, 400, { error: '参数不完整或新密码过短' }, origin);
      const rec = await getUser(username);
      if (!rec || !verifyPw(sec, rec.secHash)) return send(resp, 403, { error: '用户名或安全码不正确' }, origin);
      rec.pwHash = hashPw(np); rec.updatedAt = Date.now();
      await putUser(username, rec);
      return send(resp, 200, { ok: true }, origin);
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

    // ============ /api/jisilu：代理集思录「待发新债」列表 ============
    // 浏览器直连集思录有 CORS 限制且公开代理不稳，故走自家 FC 后端（服务端抓数+带 CORS 返回）。
    // 默认 pre_list = 待发新债表，含 apply_date(申购日)/record_dt(股权登记日)/ration(每股配售元面值)/apply10/convert_price/rating_cd/apply_cd/ration_cd。
    // 【重要】cb_list_new 是「转债行情表」，其中未上市条目 apply_cd 恒为 null，拿不到申购日，不能用于待申购判断。
    // 可用 ?src=cb 切到 cb_list_new。公开行情数据，无需鉴权。
    if (path === '/api/jisilu' && method === 'GET') {
      try {
        const src = getQ('src') || 'pre';
        const jslUrl = src === 'cb'
          ? 'https://www.jisilu.cn/data/cbnew/cb_list_new/?___jsl=LST___'
          : 'https://www.jisilu.cn/data/cbnew/pre_list/?___jsl=LST___';
        const raw = await httpsGet(jslUrl);
        const j = JSON.parse(raw);
        return send(resp, 200, j, origin);
      } catch (e) {
        return send(resp, 502, { error: 'jisilu fetch failed', detail: String((e && e.message) || e) }, origin);
      }
    }

    // ============ /api/sync（/api/wg 同逻辑）：接真账号 token 校验 ============
    // 鉴权：优先 Bearer 签名 token（新客户端）；兼容旧客户端自算 token（过渡期保留，后续移除）
    const authHdr = bearerToken(req);
    const legacyU = getQ('u') || '';
    const legacyT = getQ('t') || '';
    let authUser = null;
    if (authHdr) {
      const tk = verifyToken(authHdr);
      if (tk) authUser = tk.sub;
    }
    if (!authUser && legacyT && safeUser(legacyU)) {
      try {
        const lr = await getRec(legacyU);
        if (lr && lr.token === legacyT) authUser = legacyU;
      } catch (e) { /* ignore */ }
    }
    if (!authUser) return send(resp, 401, { error: 'unauthorized' }, origin);
    const u = authUser;

    if (method === 'GET') {
      const rec = await getRec(u);
      if (!rec) return send(resp, 404, { error: 'not found' }, origin);
      return send(resp, 200, {
        updatedAt: rec.updatedAt,
        data: {
          securityCode: rec.securityCode || '',
          favorites: rec.favorites || [],
          grids: rec.grids || [],
          cbFavorites: rec.cbFavorites || [],
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
      // 字段级合并：只更新请求里显式传了的字段，没传的保留云端旧值，避免网格/可转债两应用互相覆盖
      const newRec = {
        favorites: body.favorites !== undefined ? body.favorites : (rec ? rec.favorites : []),
        grids: body.grids !== undefined ? body.grids : (rec ? rec.grids : []),
        cbFavorites: body.cbFavorites !== undefined ? body.cbFavorites : (rec ? rec.cbFavorites : []),
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
