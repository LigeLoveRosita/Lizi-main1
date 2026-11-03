'use strict';

/* ============================== 基础工具 ============================== */

const $ = (sel, root = document) => root.querySelector(sel);

const STATUS = {
  joinme: { label: '可加入', cls: 'joinme' },
  active: { label: '在线', cls: 'active' },
  askme: { label: '询问我', cls: 'askme' },
  busy: { label: '忙碌', cls: 'busy' },
  offline: { label: '离线', cls: 'offline' },
};

const TAB_LABEL = { online: '在线', all: '全部', watch: '关注', offline: '离线' };

const TWO_FACTOR_LABEL = {
  totp: '身份验证器 App',
  emailotp: '邮箱验证码',
  otp: '恢复代码',
};

const PLATFORM_LABEL = {
  standalonewindows: 'PC',
  android: 'Quest',
  ios: 'iOS',
  web: 'Web',
};

const app = {
  data: null,
  view: { tab: 'online', q: '', sort: 'status' },
  pending: null,
  method: 'totp',
  lastSig: '',
  seenEvents: new Set(),
  booted: false,
  pollTimer: null,
  toastTimer: null,
};

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function rel(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  if (diff < 45 * 1000) return '刚刚';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function duration(ts) {
  if (!ts) return '刚刚';
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天`;
}

function clock(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function trustOf(tags) {
  const list = Array.isArray(tags) ? tags : [];
  if (list.includes('system_trust_veteran')) return { label: '老兵', key: 'veteran' };
  if (list.includes('system_trust_trusted')) return { label: '受信', key: 'trusted' };
  if (list.includes('system_trust_known')) return { label: '已知', key: 'known' };
  if (list.includes('system_trust_intermediate')) return { label: '用户', key: 'user' };
  if (list.includes('system_trust_basic')) return { label: '新用户', key: 'basic' };
  return { label: '游客', key: 'visitor' };
}

function platformLabel(platform) {
  return PLATFORM_LABEL[platform] || (platform ? String(platform) : '未知');
}

function instanceOf(location) {
  if (!location) return null;
  const idx = String(location).indexOf(':');
  if (idx < 0) return { label: '公开', cls: 'public' };
  const inst = String(location).slice(idx + 1);
  if (!inst) return { label: '公开', cls: 'public' };
  if (inst.includes('~canRequestInvite')) return { label: '邀请+', cls: 'inviteplus' };
  if (inst.includes('~private')) return { label: '私人', cls: 'private' };
  if (inst.includes('~friends')) return { label: '好友', cls: 'friends' };
  if (inst.includes('~hidden')) return { label: '好友+', cls: 'hidden' };
  if (inst.includes('~group-public')) return { label: '群组公开', cls: 'group' };
  if (inst.includes('~group')) return { label: '群组', cls: 'group' };
  return { label: '公开', cls: 'public' };
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || (data && data.ok === false)) {
    const error = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`.trim();
  el.hidden = false;
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3600);
}

/* ============================== 登录界面 ============================== */

function showLogin(message) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#drawer').hidden = true;
  const box = $('#login-error');
  if (message) {
    box.textContent = message;
    box.hidden = false;
  } else {
    box.hidden = true;
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (label) button.textContent = busy ? '处理中…' : label;
}

async function doLogin(username, password, button) {
  setBusy(button, true);
  $('#login-error').hidden = true;
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    if (result.stage === 'twofactor') {
      app.pending = { token: result.token, methods: result.methods || ['totp'] };
      app.method = app.pending.methods[0] || 'totp';
      showTwoFactor();
    } else {
      $('#login-form').reset();
      await refresh();
    }
  } catch (err) {
    const box = $('#login-error');
    box.textContent = err.message;
    box.hidden = false;
  } finally {
    setBusy(button, false, '登录');
  }
}

function showTwoFactor() {
  const pending = app.pending;
  if (!pending) return;
  $('#login-form').hidden = true;
  $('#twofa-form').hidden = false;
  $('#twofa-hint').textContent = TWO_FACTOR_LABEL[app.method] || '验证码';

  const box = $('#twofa-methods');
  const methods = pending.methods && pending.methods.length ? pending.methods : ['totp'];
  box.innerHTML = methods
    .map(
      (m) =>
        `<button type="button" class="method-chip" data-method="${esc(m)}" aria-pressed="${m === app.method}">${esc(
          TWO_FACTOR_LABEL[m] || m,
        )}</button>`,
    )
    .join('');
  box.hidden = methods.length < 2;
  const input = $('#twofa-form input[name="code"]');
  input.value = '';
  input.focus();
}

function backToLogin() {
  app.pending = null;
  $('#twofa-form').hidden = true;
  $('#login-form').hidden = false;
}

/* ============================== 渲染 ============================== */

function applyState(data) {
  app.data = data;

  if (!data.loggedIn) {
    showLogin();
    return;
  }
  showApp();
  $('#demo-badge').hidden = !data.demo;

  renderSelf(data);
  renderSummary(data);
  renderBanner(data);
  renderTabs(data);
  renderGrid(data);
  renderTimeline(data);
  renderSyncState(data);
  renderDrawerAccount(data);
  maybeNotify(data);

  const online = data.friends.filter((f) => f.online).length;
  document.title = online ? `(${online}) VRC 好友雷达` : 'VRC 好友雷达';
}

function avatarHtml(item, size = '') {
  const thumb = item.thumbnail ? `/api/img?u=${encodeURIComponent(item.thumbnail)}` : '';
  const initial = (item.displayName || '?').trim().charAt(0).toUpperCase();
  const status = item.online === false ? 'offline' : item.status || 'offline';
  return `<div class="avatar ${size}" data-status="${esc(status)}">
    <span class="fallback">${esc(initial)}</span>
    ${thumb ? `<img src="${thumb}" alt="" loading="lazy" />` : ''}
    <i class="dot"></i>
  </div>`;
}

function renderSelf(data) {
  const self = data.self || {};
  $('#self-chip').innerHTML = `
    ${avatarHtml({ ...self, online: true })}
    <div>
      <div class="self-name">${esc(self.displayName || '我')}</div>
      <div class="self-status">${esc(STATUS[self.status]?.label || '在线')}</div>
    </div>`;
}

function renderSummary(data) {
  const stats = data.stats || {};
  const total = stats.total || 0;
  const online = stats.online || 0;
  const watching = stats.watching || 0;
  $('#summary').innerHTML = `
    <div class="stat accent"><span class="k">在线好友</span><span class="v">${online}</span></div>
    <div class="stat"><span class="k">好友总数</span><span class="v">${total}</span></div>
    <div class="stat"><span class="k">特别关注</span><span class="v">${watching}</span></div>
    <div class="stat"><span class="k">上次同步</span><span class="v" style="font-size:15px;padding-top:4px">${
      stats.lastSyncAt ? rel(stats.lastSyncAt) : '等待首次同步'
    }</span></div>`;
}

function renderBanner(data) {
  const banner = $('#banner');
  if (data.authError) {
    banner.className = 'banner bad';
    banner.innerHTML = `<span>登录状态已失效（Cookie 过期或被登出），请重新登录。</span><button class="btn" data-action="relogin">重新登录</button>`;
    banner.hidden = false;
    return;
  }
  const error = data.stats && data.stats.error;
  if (error) {
    banner.className = 'banner';
    banner.innerHTML = `<span>${esc(error.message)}</span><button class="btn" data-action="sync">重试</button>`;
    banner.hidden = false;
    return;
  }
  banner.hidden = true;
}

function renderTabs(data) {
  const stats = data.stats || {};
  const total = stats.total || 0;
  const online = stats.online || 0;
  const counts = {
    online,
    all: total,
    watch: stats.watching || 0,
    offline: Math.max(0, total - online),
  };
  document.querySelectorAll('.tab').forEach((btn) => {
    const key = btn.dataset.tab;
    btn.textContent = `${TAB_LABEL[key]} ${counts[key] ?? 0}`;
  });
}

function card(f, self) {
  const status = f.online ? (STATUS[f.status] ? f.status : 'active') : 'offline';
  const st = STATUS[status];
  const name = f.displayName || `好友 ${String(f.id).slice(-4)}`;
  const trust = Array.isArray(f.tags) && f.tags.length ? trustOf(f.tags) : null;
  const inst = f.online ? instanceOf(f.location) : null;
  const same =
    Boolean(self && self.location && f.location) && self.location === f.location && self.id !== f.id;
  const sig = f.online ? f.statusDescription : f.statusDescription || '';

  const world = f.online
    ? `<div class="world">
        <span class="wicon">◎</span>
        <span class="wname">${esc(f.worldName || (f.worldId ? '未知世界' : '未知世界'))}</span>
        ${inst ? `<span class="chip ${inst.cls}">${inst.label}</span>` : ''}
        ${same ? '<span class="same">同世界</span>' : ''}
      </div>`
    : `<div class="world offline"><span class="wicon">◎</span><span class="wname">${
        f.lastSeenAt ? '已离线' : '尚未记录到在线'
      }</span></div>`;

  const confirmed = f.lastDetailAt ? `详情更新于 ${clock(f.lastDetailAt)}` : '这轮还没拿到详情';
  const foot = f.online
    ? `<span class="plat">${esc(platformLabel(f.platform))}</span>
       <span class="seen online" data-ts="${f.lastSeenAt || 0}" data-mode="since" title="${esc(confirmed)}">在线 ${duration(
         f.lastSeenAt,
       )}</span>`
    : `<span class="plat">${esc(platformLabel(f.platform))}</span>
       <span class="seen" data-ts="${f.lastSeenAt || 0}" data-mode="rel" title="${esc(confirmed)}">${
         f.lastSeenAt ? `最后在线 ${rel(f.lastSeenAt)}` : '暂无记录'
       }</span>`;

  return `<article class="card ${f.online ? 'is-online' : 'is-offline'} ${f.watch ? 'is-watched' : ''}" data-id="${esc(f.id)}">
    <header class="card-head">
      ${avatarHtml(f)}
      <div class="ident">
        <div class="name"><b title="${esc(name)}">${esc(name)}</b>${
          trust ? `<span class="trust ${trust.key}">${trust.label}</span>` : ''
        }</div>
        <div class="sig ${sig ? '' : 'is-blank'}">${
          f.online ? `<em class="st ${esc(status)}">${st.label}</em>` : ''
        }${sig ? esc(sig) : f.online ? '没有签名' : esc(st.label)}</div>
      </div>
      <button class="pin" data-action="watch" data-id="${esc(f.id)}" aria-pressed="${f.watch ? 'true' : 'false'}" title="${
        f.watch ? '取消关注' : '关注这位好友'
      }">★</button>
    </header>
    ${world}
    <footer class="card-foot">${foot}</footer>
  </article>`;
}

function filterFriends(data) {
  const self = data.self || null;
  const q = app.view.q.trim().toLowerCase();
  let list = (data.friends || []).slice();

  if (app.view.tab === 'online') list = list.filter((f) => f.online);
  else if (app.view.tab === 'watch') list = list.filter((f) => f.watch);
  else if (app.view.tab === 'offline') list = list.filter((f) => !f.online);

  if (q) {
    list = list.filter((f) =>
      [f.displayName, f.worldName, f.statusDescription]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }

  const order = { joinme: 0, active: 1, askme: 2, busy: 3, offline: 4 };
  list.sort((a, b) => {
    if (a.watch !== b.watch) return a.watch ? -1 : 1;
    if (app.view.sort === 'name') return String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-CN');
    if (app.view.sort === 'recent') return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    const sa = order[a.online ? a.status : 'offline'] ?? 5;
    const sb = order[b.online ? b.status : 'offline'] ?? 5;
    if (sa !== sb) return sa - sb;
    return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
  });
  return { list, self };
}

function renderGrid(data) {
  const { list, self } = filterFriends(data);
  const sig = JSON.stringify(
    list.map((f) => [f.id, f.online, f.status, f.statusDescription, f.worldId, f.worldName, f.lastSeenAt, f.watch, f.displayName, f.platform]),
  );
  if (sig === app.lastSig) return;
  app.lastSig = sig;

  const grid = $('#grid');
  grid.innerHTML = list.map((f) => card(f, self)).join('');

  const empty = $('#empty');
  if (!list.length) {
    const messages = {
      online: '现在没有好友在线。',
      watch: '还没有关注任何好友 —— 点击卡片右上角的 ★ 就能把它固定在最前面。',
      offline: '没有离线好友。',
      all: '好友列表还是空的，等同步完成后再看看。',
    };
    empty.textContent = messages[app.view.tab] || '没有匹配的好友。';
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

function eventHtml(ev) {
  const cls =
    ev.type === 'online'
      ? 'ev-online'
      : ev.type === 'offline'
        ? 'ev-offline'
        : ev.type === 'world'
          ? 'ev-world'
          : ev.type === 'status'
            ? 'ev-status'
            : 'ev-friend';
  let text = '';
  switch (ev.type) {
    case 'online':
      text = '上线了';
      break;
    case 'offline':
      text = '下线了';
      break;
    case 'world':
      text = `去了 <span class="ev-where">${esc(ev.worldName || '新世界')}</span>`;
      break;
    case 'status':
      text = `状态改为 ${esc(STATUS[ev.status]?.label || ev.status || '未知')}`;
      break;
    case 'new_friend':
      text = '成为了好友';
      break;
    case 'removed_friend':
      text = '不再是好友';
      break;
    default:
      text = '';
  }
  return `<li class="${cls}">
    <div class="ev-main"><b>${esc(ev.name || '好友')}</b> ${text}</div>
    <span class="ev-time" data-ts="${ev.at}" data-mode="rel" title="${esc(clock(ev.at))}">${rel(ev.at)}</span>
  </li>`;
}

function renderTimeline(data) {
  const events = data.events || [];
  $('#timeline').innerHTML = events.slice(0, 80).map(eventHtml).join('');
  $('#rail-empty').hidden = events.length > 0;
  $('#rail-count').textContent = events.length ? `${events.length} 条` : '';
}

function renderSyncState(data) {
  const stats = data.stats || {};
  const el = $('#sync-state');
  if (stats.syncing) {
    el.className = 'sync-state busy';
    el.innerHTML = '<span class="spin">◔</span> 同步中';
  } else {
    el.className = 'sync-state';
    el.textContent = stats.lastSyncAt ? `同步于 ${clock(stats.lastSyncAt)}` : '待同步';
  }
  $('#btn-sync').disabled = Boolean(stats.syncing);
}

function renderDrawerAccount(data) {
  const self = data.self || {};
  $('#drawer-account').innerHTML = `
    ${avatarHtml({ ...self, online: true })}
    <div>
      <div class="acc-name">${esc(self.displayName || '我')}</div>
      <div class="self-status">${esc(data.account && data.account.id ? data.account.id : '')}</div>
    </div>`;
}

function updateTimes() {
  document.querySelectorAll('[data-ts]').forEach((el) => {
    const ts = Number(el.dataset.ts) || 0;
    if (el.dataset.mode === 'since') {
      el.textContent = `在线 ${duration(ts)}`;
    } else {
      el.textContent = ts ? rel(ts) : '暂无记录';
    }
  });
}

/* ============================== 通知 ============================== */

function maybeNotify(data) {
  const events = data.events || [];
  const watched = new Set((data.friends || []).filter((f) => f.watch).map((f) => f.id));

  if (!app.booted) {
    events.forEach((ev) => app.seenEvents.add(ev.id));
    app.booted = true;
    return;
  }

  for (const ev of events) {
    if (app.seenEvents.has(ev.id)) continue;
    app.seenEvents.add(ev.id);
    if (ev.type !== 'online') continue;
    if (!watched.has(ev.userId)) continue;
    if (!data.settings || !data.settings.notify) continue;
    if (!('Notification' in window) || Notification.permission !== 'granted') continue;
    try {
      new Notification(`${ev.name} 上线了`, {
        body: ev.worldName || '刚上线，快去看看',
        tag: ev.id,
        silent: false,
      });
    } catch {
      /* 忽略 */
    }
  }
}

/* ============================== 轮询 ============================== */

async function refresh() {
  try {
    const data = await api('/api/state');
    applyState(data);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function startPolling() {
  if (app.pollTimer) return;
  app.pollTimer = setInterval(() => {
    if (document.hidden) return;
    refresh();
  }, 8000);
}

/* ============================== 事件绑定 ============================== */

function bindLogin() {
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = String(fd.get('username') || '').trim();
    const password = String(fd.get('password') || '');
    if (!username || !password) return;
    doLogin(username, password, $('#login-form button[type="submit"]'));
  });

  $('#twofa-methods').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-method]');
    if (!btn) return;
    app.method = btn.dataset.method;
    document.querySelectorAll('#twofa-methods .method-chip').forEach((el) => {
      el.setAttribute('aria-pressed', String(el.dataset.method === app.method));
    });
    $('#twofa-hint').textContent = TWO_FACTOR_LABEL[app.method] || '验证码';
    $('#twofa-form input[name="code"]').focus();
  });

  $('#twofa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!app.pending) return backToLogin();
    const code = String(new FormData(e.target).get('code') || '').trim();
    const button = $('#twofa-form button[type="submit"]');
    setBusy(button, true);
    try {
      await api('/api/auth/2fa', { method: 'POST', body: { token: app.pending.token, code, method: app.method } });
      app.pending = null;
      $('#twofa-form').reset();
      backToLogin();
      await refresh();
    } catch (err) {
      const box = $('#login-error');
      box.textContent = err.message;
      box.hidden = false;
    } finally {
      setBusy(button, false, '验证并进入');
    }
  });

  $('#twofa-back').addEventListener('click', backToLogin);

  $('#cookie-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cookie = String(new FormData(e.target).get('cookie') || '').trim();
    if (!cookie) return;
    const button = $('#cookie-form button[type="submit"]');
    setBusy(button, true);
    try {
      await api('/api/auth/cookie', { method: 'POST', body: { cookie } });
      $('#cookie-form').reset();
      await refresh();
    } catch (err) {
      const box = $('#login-error');
      box.textContent = err.message;
      box.hidden = false;
    } finally {
      setBusy(button, false, '使用 Cookie 登录');
    }
  });
}

function bindDashboard() {
  $('#btn-sync').addEventListener('click', async () => {
    try {
      await api('/api/sync', { method: 'POST', body: {} });
      toast('已触发同步', 'ok');
      setTimeout(refresh, 800);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    app.view.tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el === btn));
    app.lastSig = '';
    if (app.data) renderGrid(app.data);
  });

  $('#search').addEventListener('input', (e) => {
    app.view.q = e.target.value;
    app.lastSig = '';
    if (app.data) renderGrid(app.data);
  });

  $('#sort').addEventListener('change', (e) => {
    app.view.sort = e.target.value;
    app.lastSig = '';
    if (app.data) renderGrid(app.data);
  });

  $('#grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="watch"]');
    if (!btn) return;
    e.preventDefault();
    const watch = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(watch));
    try {
      await api('/api/friends/watch', { method: 'POST', body: { userId: btn.dataset.id, watch } });
      app.lastSig = '';
      await refresh();
      if (watch) toast('已加入关注', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#timeline').addEventListener('click', (e) => {
    const name = e.target.closest('b');
    if (!name) return;
    $('#search').value = name.textContent;
    app.view.q = name.textContent;
    app.view.tab = 'all';
    document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === 'all'));
    app.lastSig = '';
    if (app.data) renderGrid(app.data);
  });

  $('#banner').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'relogin') showLogin('请重新登录。');
    if (btn.dataset.action === 'sync') $('#btn-sync').click();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

function bindDrawer() {
  const drawer = $('#drawer');

  const applyLan = (s) => {
    const urls = (s && s.lanUrls) || [];
    $('#lan-urls').innerHTML = urls.length
      ? urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(u)}</a>`).join('')
      : '<span style="color:var(--dim)">未检测到局域网地址</span>';
    $('#lan-key').textContent = (s && s.accessKey) || '—';
    $('#set-lan').checked = !s || s.lanEnabled !== false;
    $('#sec-lan').hidden = !(s && s.lanMode);
  };

  const open = () => {
    if (!app.data) return;
    drawer.hidden = false;
    const s = app.data.settings || {};
    $('#set-poll').value = s.pollSeconds ?? 60;
    $('#set-refresh').value = s.refreshSeconds ?? 240;
    $('#set-proxy').value = s.proxyUrl || '';
    $('#set-notify').checked = Boolean(s.notify);
    applyLan(s);
  };

  $('#btn-settings').addEventListener('click', open);
  $('#drawer-close').addEventListener('click', () => {
    drawer.hidden = true;
  });
  drawer.addEventListener('click', (e) => {
    if (e.target.dataset.close) drawer.hidden = true;
  });

  const save = async (patch) => {
    try {
      const res = await api('/api/settings', { method: 'POST', body: patch });
      await refresh();
      if (res && res.settings) applyLan(res.settings);
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  };

  $('#set-poll').addEventListener('change', (e) => save({ pollSeconds: Number(e.target.value) }));
  $('#set-refresh').addEventListener('change', (e) => save({ refreshSeconds: Number(e.target.value) }));
  $('#set-proxy').addEventListener('change', (e) => save({ proxyUrl: e.target.value.trim() }));
  $('#set-lan').addEventListener('change', (e) => save({ lanEnabled: e.target.checked }));

  $('#btn-reset-key').addEventListener('click', async () => {
    if (!confirm('重置访问码？已经连过的手机/平板需要重新输入新的访问码。')) return;
    if (await save({ resetAccessKey: true })) toast('访问码已更新', 'ok');
  });

  $('#btn-copy-key').addEventListener('click', async () => {
    const key = app.data && app.data.settings ? app.data.settings.accessKey : '';
    if (!key) return;
    // 局域网是 http，不是安全上下文，clipboard API 不可用，退化为选中文本
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(key);
        toast('已复制访问码', 'ok');
        return;
      } catch {
        /* 继续走选中 */
      }
    }
    const el = $('#lan-key');
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('已选中，请手动复制', 'ok');
  });

  $('#set-notify').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('浏览器没有授予通知权限', 'error');
        e.target.checked = false;
        return;
      }
    }
    save({ notify: on });
  });

  $('#btn-logout').addEventListener('click', async () => {
    if (!confirm('退出登录？本机保存的登录 Cookie 会被清除。')) return;
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    drawer.hidden = true;
    app.booted = false;
    app.seenEvents.clear();
    showLogin();
    await refresh();
  });

  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('清空好友缓存与全部动态记录？')) return;
    await api('/api/data/reset', { method: 'POST', body: {} }).catch((err) => toast(err.message, 'error'));
    app.lastSig = '';
    await refresh();
    toast('已清空', 'ok');
  });

  $('#btn-forget').addEventListener('click', async () => {
    if (!confirm('删除本机保存的全部数据（含登录 Cookie）并退出？')) return;
    await api('/api/data/forget', { method: 'POST', body: {} }).catch(() => {});
    drawer.hidden = true;
    app.booted = false;
    app.seenEvents.clear();
    showLogin();
    await refresh();
  });
}

/* ============================== 启动 ============================== */

async function boot() {
  bindLogin();
  bindDashboard();
  bindDrawer();
  // 头像加载失败（图片接口需要登录态）时，回退到首字母占位
  document.addEventListener(
    'error',
    (e) => {
      const target = e.target;
      if (target && target.tagName === 'IMG') target.remove();
    },
    true,
  );
  setInterval(updateTimes, 30000);
  await refresh();
  startPolling();
  if (location.hash === '#settings' && app.data && app.data.loggedIn) $('#btn-settings').click();
}

boot();
