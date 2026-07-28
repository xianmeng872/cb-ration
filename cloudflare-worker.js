// cloudflare-worker.js
// 部署到 Cloudflare Workers（创建时选 ES Module / 模块 格式）
// 需绑定一个 KV namespace，变量名必须固定为：CB_SYNC
// 可选：设置环境变量 ALLOWED_ORIGIN（逗号分隔，如 https://adile.cn,http://adile.cn），不填则允许所有来源调用
//
// 公共云后端：让【每一个】登录用户在手机/电脑间自动同步关注列表。
// - 按用户名分 key 存储（sync:用户名），各用户数据互不可见、互不覆盖
// - 用 sha256(用户名|密码|盐) 作为写入/读取令牌，云端不存明文密码
// - 首次写入设定令牌；之后必须令牌匹配才能改，防止他人篡改别人的数据

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 只处理 /api/sync 路径
    if (!url.pathname.startsWith('/api/sync')) {
      return new Response('Not Found', { status: 404 });
    }

    // CORS：限制调用来源，防止别人拿你的 Worker 乱写
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = allowed.length && allowed.includes(origin) ? origin : (allowed[0] || '*');
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };

    // 浏览器跨域预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 校验用户名（防止脏 key / 注入）
    const u = url.searchParams.get('u') || '';
    if (!/^[a-zA-Z0-9_\-]{1,40}$/.test(u)) {
      return new Response(JSON.stringify({ error: 'invalid user' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    // 校验令牌格式（64 位 hex）
    const t = url.searchParams.get('t') || '';
    if (!/^[a-f0-9]{64}$/.test(t)) {
      return new Response(JSON.stringify({ error: 'invalid token' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    const key = 'sync:' + u;

    // 拉取：GET /api/sync?u=用户名&t=令牌
    if (request.method === 'GET') {
      const val = await env.CB_SYNC.get(key);
      if (!val) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
      const rec = JSON.parse(val);
      if (rec.token !== t) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ updatedAt: rec.updatedAt, data: rec.data }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // 保存：POST /api/sync?u=用户名&t=令牌  body={securityCode, favorites}
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.length > 100000) return new Response(JSON.stringify({ error: 'too large' }), { status: 413, headers: { ...cors, 'Content-Type': 'application/json' } });
      let payload;
      try { payload = JSON.parse(text); } catch (e) {
        return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const val = await env.CB_SYNC.get(key);
      if (val) {
        const rec = JSON.parse(val);
        if (rec.token !== t) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const newRec = {
        token: t,
        updatedAt: new Date().toISOString(),
        data: { securityCode: payload.securityCode || "", favorites: payload.favorites || [] }
      };
      await env.CB_SYNC.put(key, JSON.stringify(newRec));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response('Method Not Allowed', { status: 405, headers: cors });
  }
};
