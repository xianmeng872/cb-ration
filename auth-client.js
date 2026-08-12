// auth-client.js —— 三页共用的真账号模块（注册/登录/找回 + 本地状态 + Bearer 注入）
// 用法：
//   <script src="auth-client.js"></script>
//   CBAuth.init({ apiBase: 'https://xxxx.fcapp.run', onLogin:fn, onLogout:fn });
//   登录按钮 -> CBAuth.showAuth();   同步请求 -> CBAuth.api('/wg', {method:'GET'}).then(...)
(function () {
  'use strict';
  var LS_TOKEN = 'cb_auth_token', LS_USER = 'cb_auth_user';

  var CBAuth = {
    apiBase: '', _onLogin: null, _onLogout: null, _mode: 'login',

    init: function (opts) {
      opts = opts || {};
      this.apiBase = (opts.apiBase || '').replace(/\/+$/, '');
      this._onLogin = opts.onLogin || null;
      this._onLogout = opts.onLogout || null;
      this._buildUI();
      this._bindStorage();
      return this;
    },

    // 跨标签页同步：其他标签页登录/退出后，本页自动跟随（storage 事件仅在「其他」标签修改时触发）
    _bindStorage: function () {
      if (this._storageBound) return;
      this._storageBound = true;
      var self = this;
      window.addEventListener('storage', function (e) {
        if (e.key !== LS_TOKEN && e.key !== LS_USER) return;
        var t = self.getToken(), u = self.getUser();
        if (t && u) { if (self._onLogin) self._onLogin(u); }
        else { if (self._onLogout) self._onLogout(); }
      });
    },

    getToken: function () { try { return localStorage.getItem(LS_TOKEN) || ''; } catch (e) { return ''; } },
    getUser: function () { try { return localStorage.getItem(LS_USER) || ''; } catch (e) { return ''; } },
    isLoggedIn: function () { return !!this.getToken(); },

    logout: function () {
      try { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); } catch (e) {}
      if (this._onLogout) this._onLogout();
    },

    // 统一请求封装：自动注入 Bearer token
    api: function (path, opts) {
      opts = opts || {};
      var headers = { 'Content-Type': 'application/json' };
      var t = this.getToken();
      if (t) headers['Authorization'] = 'Bearer ' + t;
      var url = this.apiBase + path;
      var init = { method: opts.method || 'GET', headers: headers };
      if (opts.body !== undefined) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      return fetch(url, init).then(function (r) {
        return r.json().then(function (d) { return { status: r.status, data: d }; })
          .catch(function () { return { status: r.status, data: {} }; });
      });
    },

    register: function (username, password, securityCode) {
      var self = this;
      return this.api('/api/auth/register', { method: 'POST', body: { username: username, password: password, securityCode: securityCode } })
        .then(function (res) {
          if (res.status === 200 && res.data.ok) { self._save(res.data.token, username); return { ok: true }; }
          return { ok: false, error: (res.data && res.data.error) || '注册失败' };
        });
    },
    login: function (username, password) {
      var self = this;
      return this.api('/api/auth/login', { method: 'POST', body: { username: username, password: password } })
        .then(function (res) {
          if (res.status === 200 && res.data.ok) { self._save(res.data.token, username); return { ok: true }; }
          return { ok: false, error: (res.data && res.data.error) || '登录失败' };
        });
    },
    forgot: function (username, securityCode, newPassword) {
      return this.api('/api/auth/forgot', { method: 'POST', body: { username: username, securityCode: securityCode, newPassword: newPassword } })
        .then(function (res) {
          if (res.status === 200 && res.data.ok) return { ok: true };
          return { ok: false, error: (res.data && res.data.error) || '重置失败' };
        });
    },

    _save: function (token, user) {
      try { localStorage.setItem(LS_TOKEN, token); localStorage.setItem(LS_USER, user); } catch (e) {}
      if (this._onLogin) this._onLogin(user);
    },

    showAuth: function (mode) { this._open(mode || 'login'); },

    // ---------- UI ----------
    _buildUI: function () {
      if (document.getElementById('cbAuthMask')) return;
      var css = '.cbauth-tab.active{background:#5573a8!important;color:#fff!important;}'
        + '#cbAuthMask input:focus{outline:none;border-color:#5573a8!important;}'
        + '#cbAuthSubmit:active{transform:scale(.985);}';
      var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

      var html = ''
        + '<div id="cbAuthMask" style="display:none;position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;align-items:center;justify-content:center;font-family:system-ui,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;">'
        + '  <div style="width:344px;max-width:92vw;background:#fff;border-radius:18px;padding:24px 22px;box-shadow:0 20px 60px rgba(0,0,0,.25);">'
        + '    <h3 id="cbAuthTitle" style="margin:0 0 4px;font-size:18px;font-weight:800;color:#1f2937;">欢迎登录</h3>'
        + '    <p id="cbAuthSub" style="margin:0 0 16px;font-size:12.5px;color:#6b7280;">登录后可多端同步保存你的数据</p>'
        + '    <div style="display:flex;gap:8px;margin-bottom:14px;">'
        + '      <div class="cbauth-tab" data-mode="login" style="flex:1;text-align:center;padding:9px;font-size:13px;font-weight:700;border-radius:10px;cursor:pointer;background:#5573a8;color:#fff;">登录</div>'
        + '      <div class="cbauth-tab" data-mode="register" style="flex:1;text-align:center;padding:9px;font-size:13px;font-weight:700;border-radius:10px;cursor:pointer;background:#eef2f7;color:#475067;">注册</div>'
        + '    </div>'
        + '    <input id="cbAuthUser" placeholder="用户名(3-20位字母数字_)" style="width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;border:1px solid #d7dee8;border-radius:10px;font-size:14px;">'
        + '    <input id="cbAuthPass" type="password" placeholder="密码(至少4位)" style="width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;border:1px solid #d7dee8;border-radius:10px;font-size:14px;">'
        + '    <div id="cbAuthSecField" style="display:none;">'
        + '      <input id="cbAuthSec" placeholder="安全码(4-6位,用于找回密码)" style="width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;border:1px solid #d7dee8;border-radius:10px;font-size:14px;">'
        + '    </div>'
        + '    <div id="cbAuthNewField" style="display:none;">'
        + '      <input id="cbAuthNew" type="password" placeholder="新密码(至少4位)" style="width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;border:1px solid #d7dee8;border-radius:10px;font-size:14px;">'
        + '    </div>'
        + '    <div id="cbAuthError" style="display:none;color:#ef4444;font-size:12.5px;margin-bottom:8px;"></div>'
        + '    <button id="cbAuthSubmit" style="width:100%;padding:12px;border:none;border-radius:12px;background:#5573a8;color:#fff;font-size:15px;font-weight:700;cursor:pointer;">登录</button>'
        + '    <div style="text-align:center;margin-top:12px;font-size:12px;">'
        + '      <a id="cbAuthForgot" href="javascript:void(0)" style="color:#9ca3af;text-decoration:none;">忘记密码？</a>'
        + '    </div>'
        + '  </div>'
        + '</div>';
      var div = document.createElement('div'); div.innerHTML = html;
      document.body.appendChild(div.firstChild);

      var self = this;
      document.getElementById('cbAuthMask').addEventListener('click', function (e) { if (e.target.id === 'cbAuthMask') self._close(); });
      Array.prototype.forEach.call(document.querySelectorAll('.cbauth-tab'), function (tab) {
        tab.addEventListener('click', function () { self._setMode(tab.getAttribute('data-mode')); });
      });
      document.getElementById('cbAuthForgot').addEventListener('click', function () { self._setMode('forgot'); });
      document.getElementById('cbAuthSubmit').addEventListener('click', function () { self._submit(); });
      document.getElementById('cbAuthPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') self._submit(); });
      document.getElementById('cbAuthUser').addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('cbAuthPass').focus(); });
    },

    _open: function (mode) {
      this._buildUI();
      var m = document.getElementById('cbAuthMask');
      if (!m) return;
      this._setMode(mode || 'login');
      m.style.display = 'flex';
      setTimeout(function () { var i = document.getElementById('cbAuthUser'); if (i) i.focus(); }, 50);
    },
    _close: function () { var m = document.getElementById('cbAuthMask'); if (m) m.style.display = 'none'; },

    _setMode: function (mode) {
      this._mode = mode;
      var title = document.getElementById('cbAuthTitle');
      var sub = document.getElementById('cbAuthSub');
      var secField = document.getElementById('cbAuthSecField');
      var newField = document.getElementById('cbAuthNewField');
      var passField = document.getElementById('cbAuthPass');
      var submit = document.getElementById('cbAuthSubmit');
      var forgot = document.getElementById('cbAuthForgot');
      var tabs = document.querySelectorAll('.cbauth-tab');
      Array.prototype.forEach.call(tabs, function (t) {
        t.classList.toggle('active', t.getAttribute('data-mode') === mode);
        t.style.background = (t.getAttribute('data-mode') === mode) ? '#5573a8' : '#eef2f7';
        t.style.color = (t.getAttribute('data-mode') === mode) ? '#fff' : '#475067';
      });
      this._clearError();
      if (mode === 'login') {
        title.textContent = '欢迎登录'; sub.textContent = '登录后可多端同步保存你的数据';
        secField.style.display = 'none'; newField.style.display = 'none'; passField.style.display = '';
        submit.textContent = '登录'; forgot.style.display = 'inline';
      } else if (mode === 'register') {
        title.textContent = '创建账号'; sub.textContent = '注册后即可多端同步你的数据（请牢记安全码）';
        secField.style.display = ''; newField.style.display = 'none'; passField.style.display = '';
        submit.textContent = '注册'; forgot.style.display = 'none';
      } else if (mode === 'forgot') {
        title.textContent = '重置密码'; sub.textContent = '输入用户名和安全码，即可设置新密码';
        secField.style.display = ''; newField.style.display = ''; passField.style.display = 'none';
        submit.textContent = '确认重置'; forgot.style.display = 'none';
      }
    },

    _error: function (msg) { var e = document.getElementById('cbAuthError'); e.textContent = msg; e.style.display = 'block'; },
    _clearError: function () { var e = document.getElementById('cbAuthError'); if (e) { e.textContent = ''; e.style.display = 'none'; } },

    _submit: function () {
      var self = this;
      var u = document.getElementById('cbAuthUser').value.trim();
      var p = document.getElementById('cbAuthPass').value;
      var sec = document.getElementById('cbAuthSec').value.trim();
      var np = document.getElementById('cbAuthNew').value;
      this._clearError();
      var btn = document.getElementById('cbAuthSubmit');
      btn.disabled = true;
      var done = function () { btn.disabled = false; };
      if (this._mode === 'login') {
        if (!u || !p) { this._error('请输入用户名和密码'); done(); return; }
        this.login(u, p).then(function (r) { done(); if (r.ok) { self._close(); } else self._error(r.error); });
      } else if (this._mode === 'register') {
        if (!u || !p) { this._error('请输入用户名和密码'); done(); return; }
        this.register(u, p, sec).then(function (r) { done(); if (r.ok) { self._close(); } else self._error(r.error); });
      } else if (this._mode === 'forgot') {
        if (!u || !sec || np.length < 4) { this._error('请填用户名、安全码与新密码(至少4位)'); done(); return; }
        this.forgot(u, sec, np).then(function (r) {
          done();
          if (r.ok) { self._setMode('login'); document.getElementById('cbAuthUser').value = u; alert('密码重置成功，请用新密码登录'); }
          else self._error(r.error);
        });
      }
    }
  };

  window.CBAuth = CBAuth;
})();
