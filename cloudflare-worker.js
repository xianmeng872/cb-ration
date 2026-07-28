// cloudflare-worker.js
// 传统 service-worker 格式（兼容性最好，无需模块声明）
// 部署：绑定一个 KV namespace，变量名固定为 CB_SYNC
// 可选环境变量 ALLOWED_ORIGIN（逗号分隔，如 https://adile.cn,http://adile.cn），不填则允许所有来源
//
// 公共云后端：让【每一个】登录用户在手机/电脑间自动同步关注列表。
// - 按用户名分 key 存储（sync:用户名），各用户数据互不可见、互不覆盖
// - 用 sha256(用户名|密码|盐) 作为写入/读取令牌，云端不存明文密码
// - 首次写入设定令牌；之后必须令牌匹配才能改，防止他人篡改别人的数据

addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/sync')) {
    return new Response('Not Found', { status: 404 });
  }

  // CORS：限制调用来源，防止别人拿你的 Worker 乱写（不设 ALLOWED_ORIGIN 则放行所有）
  const allowed = (typeof ALLOWED_ORIGIN !== 'undefined' ? (ALLOWED_ORIGIN || '') : '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = (allowed.length && allowed.includes(origin)) ? origin : (allowed[0] || '*');
  const cors = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
  const jsonHeaders = Object.assign({}, cors, { 'Content-Type': 'application/json' });

  // 浏览器跨域预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // 校验用户名（防止脏 key / 注入）
  const u = url.searchParams.get('u') || '';
  if (!/^[a-zA-Z0-9_\-]{1,40}$/.test(u)) {
    return new Response(JSON.stringify({ error: 'invalid user' }), { status: 400, headers: jsonHeaders });
  }
  const t = url.searchParams.get('t') || '';
  const key = 'sync:' + u;

  // 拉取：GET /api/sync?u=用户名&t=令牌
  if (request.method === 'GET') {
    const val = await CB_SYNC.get(key);
    if (!val) {
      // key 不存在：返回 404（供重名探测判断"用户名未注册"）
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: jsonHeaders });
    }
    // key 存在：无论 token 格式是否合法，都返回 403（供重名探测判断"用户名已注册"）
    if (!/^[a-f0-9]{64}$/.test(t)) {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: jsonHeaders });
    }
    const rec = JSON.parse(val);
    if (rec.token !== t) {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ updatedAt: rec.updatedAt, data: rec.data }), { status: 200, headers: jsonHeaders });
  }

  // 保存：POST /api/sync?u=用户名&t=令牌  body={securityCode, favorites}
  if (request.method === 'POST') {
    if (!/^[a-f0-9]{64}$/.test(t)) {
      return new Response(JSON.stringify({ error: 'invalid token' }), { status: 400, headers: jsonHeaders });
    }
    const text = await request.text();
    if (text.length > 100000) {
      return new Response(JSON.stringify({ error: 'too large' }), { status: 413, headers: jsonHeaders });
    }
    let payload;
    try { payload = JSON.parse(text); } catch (e) {
      return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: jsonHeaders });
    }
    const val = await CB_SYNC.get(key);
    if (val) {
      const rec = JSON.parse(val);
      if (rec.token !== t) {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: jsonHeaders });
      }
    }
    const newRec = {
      token: t,
      updatedAt: new Date().toISOString(),
      data: { securityCode: payload.securityCode || "", favorites: payload.favorites || [] }
    };
    await CB_SYNC.put(key, JSON.stringify(newRec));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
  }

  return new Response('Method Not Allowed', { status: 405, headers: cors });
}
