'use strict';

/**
 * 李子视奸朋友的网站 —— 本地服务
 * 仅监听 127.0.0.1，所有 VRChat 请求由本机代理转发。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const { Store } = require('./lib/store');
const { VRChatClient, VRChatError, normalizeUser, DEFAULT_BASE } = require('./lib/vrchat');
const { Tracker } = require('./lib/tracker');
const { DemoClient } = require('./lib/demo');

const PORT = Number(process.env.PORT || 8899);
// 默认只听本机；想在手机上用就设 HOST=0.0.0.0（会要求输入设备访问码）
const HOST = process.env.HOST || '127.0.0.1';
const LAN_MODE = HOST !== '127.0.0.1' && HOST !== 'localhost';
const DEMO = process.argv.includes('--demo') || process.env.VRCW_DEMO === '1';
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ''));
const API_BASE = process.env.VRC_API_BASE || DEFAULT_BASE;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.VRCW_DATA_DIR ? path.resolve(process.env.VRCW_DATA_DIR) : path.join(__dirname, 'data');
const DEMO_ID = 'usr_demo_self';
const SESSION_COOKIE = 'vrcw_sid';
const ACCESS_COOKIE = 'vrcw_key';
const SESSION_MAX_AGE = 30 * 24 * 3600;
const ACCESS_MAX_AGE = 365 * 24 * 3600;

const store = new Store(DATA_DIR);
const state = store.load();

const sessions = new Map(Object.entries(state.sessions || {}));
const trackers = new Map();
const pending = new Map(); // 两步验证的临时会话
const imageCache = new Map(); // url -> { type, buffer, at }
const IMAGE_CACHE_MAX = 160;

if (DEMO) {
  state.settings.pollSeconds = Math.min(state.settings.pollSeconds || 30, 30);
  state.settings.refreshSeconds = Math.min(state.settings.refreshSeconds || 45, 45);
}

/* ------------------------------ 局域网 / 设备访问 ------------------------------ */

function randomAccessKey() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉 0O1lI 之类易混字符
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

if (!state.settings.accessKey) {
  state.settings.accessKey = randomAccessKey();
  store.save();
}

function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return [...new Set(out)];
}

function isLoopback(remote) {
  const addr = String(remote || '').replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '';
}

/** 放在 nginx 等反代后面时，用 X-Forwarded-For 里的真实 IP 判断设备是否需要访问码 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded.replace(/^::ffff:/, '');
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function accessKeyFromRequest(req) {
  return parseCookies(req.headers.cookie)[ACCESS_COOKIE] || '';
}

function setAccessCookie(res, key) {
  res.setHeader('Set-Cookie', `${ACCESS_COOKIE}=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ACCESS_MAX_AGE}`);
}

// 连续输错访问码的 IP 会被短暂封锁
const accessFailures = new Map();

function accessBlocked(ip) {
  const rec = accessFailures.get(ip);
  return Boolean(rec && rec.until && rec.until > Date.now());
}

function noteAccessFailure(ip) {
  const rec = accessFailures.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 8) {
    rec.until = Date.now() + 10 * 60 * 1000;
    rec.count = 0;
  }
  accessFailures.set(ip, rec);
}

function gatePage(message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>需要访问码 · 李子视奸</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(900px 500px at 50% -10%,rgba(124,92,255,.25),transparent 60%),#070911;color:#e9edf9;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;padding:24px}
  .card{width:min(360px,100%);padding:26px 22px;border-radius:20px;background:rgba(20,24,38,.9);border:1px solid rgba(255,255,255,.08);box-shadow:0 30px 80px -50px #000;text-align:center}
  h1{margin:0 0 6px;font-size:19px}
  p{margin:0 0 18px;color:#8b93ad;font-size:13px;line-height:1.6}
  form{display:flex;gap:8px}
  input{flex:1;min-width:0;background:rgba(7,10,17,.8);border:1px solid rgba(255,255,255,.1);border-radius:11px;padding:12px;color:#e9edf9;font-size:16px;font-family:inherit;outline:none}
  input:focus{border-color:rgba(139,92,246,.6)}
  button{appearance:none;border:0;border-radius:11px;padding:12px 16px;font-size:14px;font-weight:600;color:#fff;background:linear-gradient(135deg,#8b5cf6,#5b8cff);font-family:inherit}
  .err{margin:0 0 14px;padding:9px 12px;border-radius:10px;font-size:12.5px;color:#ffc2c5;background:rgba(242,86,95,.12);border:1px solid rgba(242,86,95,.3)}
  .tip{margin:16px 0 0;font-size:11.5px;color:#5f6782;line-height:1.7}
</style></head><body>
<div class="card">
  <h1>这台设备还没有授权</h1>
  <p>请输入电脑端「设置 → 设备与局域网」里显示的访问码。</p>
  ${message ? `<p class="err">${message}</p>` : ''}
  <form method="get" action="/">
    <input name="k" inputmode="latin" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="访问码" autofocus>
    <button type="submit">进入</button>
  </form>
  <p class="tip">只需要输一次，之后会记住这台设备。<br>忘记访问码可以在电脑上重置。</p>
</div></body></html>`;
}

function blockedPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>局域网访问已关闭</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070911;color:#e9edf9;font-family:"Segoe UI","Microsoft YaHei",sans-serif;padding:24px;text-align:center}
p{color:#8b93ad;font-size:13px;line-height:1.7}</style></head>
<body><div><h1 style="font-size:18px">局域网访问已关闭</h1><p>请在运行本程序的电脑上打开「设置 → 设备与局域网」重新开启。</p></div></body></html>`;
}

/* ---------------------------------- 工具 ---------------------------------- */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function sessionFor(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  const account = state.accounts[session.accountId];
  if (!account) {
    sessions.delete(sid);
    delete state.sessions[sid];
    return null;
  }
  return { sid, session, account };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        const err = new Error('请求体不是合法 JSON');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    // 同一主机（含端口）就允许：既支持 localhost，也支持手机通过局域网 IP 访问
    if (req.headers.host && parsed.host === req.headers.host) return true;
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function publicSettings() {
  return {
    pollSeconds: state.settings.pollSeconds,
    refreshSeconds: state.settings.refreshSeconds,
    proxyUrl: state.settings.proxyUrl,
    notify: state.settings.notify,
    apiBase: API_BASE,
    lanEnabled: state.settings.lanEnabled !== false,
    lanMode: LAN_MODE,
    accessKey: state.settings.accessKey,
    lanUrls: LAN_MODE ? lanAddresses().map((ip) => `http://${ip}:${PORT}`) : [],
    port: PORT,
  };
}

/* ------------------------------ 账号 / 追踪器 ------------------------------ */

function createClient(account) {
  if (DEMO && account && account.id === DEMO_ID) return new DemoClient();
  let cookies = {};
  try {
    cookies = JSON.parse(store.decrypt(account.cookieCipher || '') || '{}');
  } catch {
    cookies = {};
  }
  return new VRChatClient({ cookies, proxyUrl: state.settings.proxyUrl, apiBase: API_BASE });
}

function ensureTracker(account) {
  let tracker = trackers.get(account.id);
  if (tracker) return tracker;
  tracker = new Tracker({
    account,
    store,
    settings: state.settings,
    client: createClient(account),
  });
  trackers.set(account.id, tracker);
  return tracker;
}

function newAccount(id, seed = {}) {
  return {
    id,
    friends: {},
    events: [],
    worlds: {},
    watch: [],
    createdAt: Date.now(),
    ...seed,
  };
}

/** 清理过期/过多的设备会话，避免每次新设备访问都堆积 */
function pruneSessions() {
  const now = Date.now();
  const byAccount = new Map();
  for (const [sid, session] of [...sessions.entries()]) {
    if (now - (session.createdAt || 0) > SESSION_MAX_AGE * 1000) {
      sessions.delete(sid);
      delete state.sessions[sid];
      continue;
    }
    const list = byAccount.get(session.accountId) || [];
    list.push([sid, session]);
    byAccount.set(session.accountId, list);
  }
  for (const list of byAccount.values()) {
    if (list.length <= 10) continue;
    list.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    for (const [sid] of list.slice(10)) {
      sessions.delete(sid);
      delete state.sessions[sid];
    }
  }
}

function createSession(client, rawUser) {
  const me = normalizeUser(rawUser);
  if (!me.id) throw new VRChatError('账号信息异常', 400);
  const account = state.accounts[me.id] || newAccount(me.id);
  account.self = me;
  account.authError = false;
  account.lastError = null;
  account.cookieCipher = store.encrypt(JSON.stringify(client.cookiesObject()));
  state.accounts[me.id] = account;

  const sid = crypto.randomBytes(24).toString('base64url');
  const session = { accountId: me.id, createdAt: Date.now() };
  state.sessions[sid] = session;
  sessions.set(sid, session);
  pruneSessions();
  store.save();

  const tracker = ensureTracker(account);
  tracker.client = client;
  tracker.start();
  return { account, sid, me, tracker };
}

function demoSession(res) {  const account = state.accounts[DEMO_ID] || newAccount(DEMO_ID);
  state.accounts[DEMO_ID] = account;
  account.self = {
    id: DEMO_ID,
    displayName: '你（演示模式）',
    thumbnail: '',
    status: 'active',
    statusDescription: '这是本地演示数据',
    location: '',
    worldId: '',
    platform: '',
    tags: [],
    trust: { label: '受信', key: 'trusted' },
  };
  const sid = crypto.randomBytes(24).toString('base64url');
  const session = { accountId: DEMO_ID, createdAt: Date.now() };
  state.sessions[sid] = session;
  sessions.set(sid, session);
  setSessionCookie(res, sid);
  const tracker = ensureTracker(account);
  tracker.start();
  return { sid, session, account };
}

/**
 * 已经有一个登录好的账号时，新设备（手机/平板/另一个浏览器）不用再输密码，
 * 直接给它发一个 session。
 */
function attachAccountSession(res) {
  const candidates = Object.values(state.accounts).filter((a) => a && a.cookieCipher && !a.authError);
  if (candidates.length !== 1) return null;
  const account = candidates[0];

  const sid = crypto.randomBytes(24).toString('base64url');
  const session = { accountId: account.id, createdAt: Date.now() };
  state.sessions[sid] = session;
  sessions.set(sid, session);
  pruneSessions();
  setSessionCookie(res, sid);
  store.touch();

  const tracker = ensureTracker(account);
  if (!tracker.running) tracker.start();
  return { sid, session, account };
}

function buildState(account) {
  const tracker = ensureTracker(account);
  return {
    ok: true,
    demo: DEMO,
    loggedIn: true,
    self: account.self || null,
    account: {
      id: account.id,
      displayName: (account.self && account.self.displayName) || account.id,
      thumbnail: (account.self && account.self.thumbnail) || '',
    },
    friends: tracker.friendList(),
    events: tracker.events(),
    stats: tracker.stats(),
    settings: publicSettings(),
    authError: Boolean(account.authError),
    serverTime: Date.now(),
  };
}

/* --------------------------------- 路由 --------------------------------- */

async function handleApi(req, res, url, pathname) {
  const method = req.method || 'GET';

  if (method !== 'GET' && !isSameOrigin(req)) {
    return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
  }

  if (method === 'GET' && pathname === '/api/state') {
    let found = sessionFor(req);
    if (!found && DEMO) found = demoSession(res);
    if (!found) found = attachAccountSession(res);
    if (!found) return sendJson(res, 200, { ok: true, loggedIn: false, demo: DEMO, settings: publicSettings() });
    const { account } = found;
    const tracker = ensureTracker(account);
    if (!tracker.running && !account.authError) tracker.start();
    return sendJson(res, 200, buildState(account));
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return sendJson(res, 400, { ok: false, error: '请输入用户名和密码' });

    const client = new VRChatClient({ proxyUrl: state.settings.proxyUrl, apiBase: API_BASE });
    const result = await client.loginPassword(username, password);

    if (result.stage === 'twofactor') {
      const token = crypto.randomBytes(18).toString('base64url');
      // 接口返回的是 ['totp'] / ['emailOtp']，统一小写后再交给前端展示
      const methods = result.methods.map((m) => String(m).toLowerCase());
      pending.set(token, { client, methods, createdAt: Date.now() });
      return sendJson(res, 200, { ok: true, stage: 'twofactor', methods, token });
    }

    const created = createSession(client, result.user);
    setSessionCookie(res, created.sid);
    return sendJson(res, 200, { ok: true, stage: 'done', ...buildState(created.account) });
  }

  if (method === 'POST' && pathname === '/api/auth/2fa') {
    const body = await readJson(req);
    const token = String(body.token || '');
    const entry = pending.get(token);
    if (!entry) return sendJson(res, 400, { ok: false, error: '验证会话已过期，请重新登录' });
    if (Date.now() - entry.createdAt > 10 * 60 * 1000) {
      pending.delete(token);
      return sendJson(res, 400, { ok: false, error: '验证会话已过期，请重新登录' });
    }

    const rawUser = await entry.client.verifyTwoFactor(body.code, body.method || entry.methods[0] || 'totp');
    pending.delete(token);
    const created = createSession(entry.client, rawUser);
    setSessionCookie(res, created.sid);
    return sendJson(res, 200, { ok: true, stage: 'done', ...buildState(created.account) });
  }

  if (method === 'POST' && pathname === '/api/auth/cookie') {
    const body = await readJson(req);
    const client = new VRChatClient({ proxyUrl: state.settings.proxyUrl, apiBase: API_BASE });
    const rawUser = await client.loginWithCookie(body.cookie);
    const created = createSession(client, rawUser);
    setSessionCookie(res, created.sid);
    return sendJson(res, 200, { ok: true, stage: 'done', ...buildState(created.account) });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const found = sessionFor(req);
    if (found) {
      const tracker = trackers.get(found.account.id);
      if (tracker) {
        // 先让 VRChat 服务端真正结束会话，再清本地
        await tracker.client.logout().catch(() => {});
        tracker.stop();
        trackers.delete(found.account.id);
      }
      found.account.cookieCipher = '';
      found.account.authError = false;
      // 退出登录 = 所有设备一起退出
      for (const [sid, session] of [...sessions.entries()]) {
        if (session.accountId !== found.account.id) continue;
        sessions.delete(sid);
        delete state.sessions[sid];
      }
      store.save();
    }
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // 以下接口需要登录
  const found = sessionFor(req);
  const PROTECTED = new Set([
    '/api/sync',
    '/api/friends/watch',
    '/api/settings',
    '/api/data/reset',
    '/api/data/forget',
    '/api/img',
  ]);
  if (!found) {
    if (!PROTECTED.has(pathname)) return sendJson(res, 404, { ok: false, error: '接口不存在' });
    return sendJson(res, 401, { ok: false, error: '未登录' });
  }
  const { account } = found;
  const tracker = ensureTracker(account);

  if (method === 'POST' && pathname === '/api/sync') {
    tracker.kick(true);
    return sendJson(res, 200, { ok: true, syncing: true });
  }

  if (method === 'POST' && pathname === '/api/friends/watch') {
    const body = await readJson(req);
    const userId = String(body.userId || '');
    if (!userId) return sendJson(res, 400, { ok: false, error: '缺少 userId' });
    tracker.setWatch(userId, Boolean(body.watch));
    return sendJson(res, 200, { ok: true, watch: account.watch });
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJson(req);
    if ('pollSeconds' in body) {
      state.settings.pollSeconds = clamp(body.pollSeconds, 20, 900, state.settings.pollSeconds);
    }
    if ('refreshSeconds' in body) {
      state.settings.refreshSeconds = clamp(body.refreshSeconds, 30, 3600, state.settings.refreshSeconds);
    }
    if ('notify' in body) state.settings.notify = Boolean(body.notify);
    if ('lanEnabled' in body) state.settings.lanEnabled = Boolean(body.lanEnabled);
    if (body.resetAccessKey) state.settings.accessKey = randomAccessKey();
    if ('proxyUrl' in body) {
      const raw = String(body.proxyUrl || '').trim();
      if (raw && !/^https?:\/\/[^\s]+$/i.test(raw)) {
        return sendJson(res, 400, { ok: false, error: '代理地址格式不正确，应形如 http://127.0.0.1:7890' });
      }
      state.settings.proxyUrl = raw;
      for (const t of trackers.values()) t.client.proxyUrl = raw;
    }
    store.touch();
    return sendJson(res, 200, { ok: true, settings: publicSettings() });
  }

  if (method === 'POST' && pathname === '/api/data/reset') {
    account.friends = {};
    account.events = [];
    account.worlds = {};
    account.initialized = false;
    tracker.account.friends = account.friends;
    tracker.account.events = account.events;
    tracker.account.worlds = account.worlds;
    store.save();
    tracker.kick();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/data/forget') {
    tracker.stop();
    trackers.delete(account.id);
    delete state.accounts[account.id];
    sessions.delete(found.sid);
    delete state.sessions[found.sid];
    store.save();
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/img') {
    return proxyImage(req, res, url, tracker.client);
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

const IMAGE_HOSTS = new Set(['api.vrchat.cloud', 'vrchat.com', 'files.vrchat.cloud']);

async function proxyImage(req, res, url, client) {
  const raw = url.searchParams.get('u') || '';
  let target;
  try {
    target = new URL(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: '图片地址无效' });
  }
  if (target.protocol !== 'https:' || !IMAGE_HOSTS.has(target.hostname)) {
    return sendJson(res, 403, { ok: false, error: '不允许的图片域名' });
  }

  const key = target.toString();
  const hit = imageCache.get(key);
  if (hit && Date.now() - hit.at < 3600 * 1000) {
    res.writeHead(200, {
      'Content-Type': hit.type,
      'Content-Length': hit.buffer.length,
      'Cache-Control': 'public, max-age=3600',
    });
    return res.end(hit.buffer);
  }

  const result = await client.fetchBinary(key).catch(() => null);
  if (!result || result.status !== 200 || !result.buffer.length) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('image not available');
  }

  const type = String(result.headers['content-type'] || 'image/png').split(';')[0];
  imageCache.set(key, { type, buffer: result.buffer, at: Date.now() });
  if (imageCache.size > IMAGE_CACHE_MAX) {
    const oldest = [...imageCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) imageCache.delete(oldest[0]);
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': result.buffer.length,
    'Cache-Control': 'public, max-age=3600',
  });
  return res.end(result.buffer);
}

/* -------------------------------- 静态资源 -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buffer) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buffer.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    });
    res.end(buffer);
  });
}

/* --------------------------------- 启动 --------------------------------- */

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  const pathname = decodeURIComponent(url.pathname);

  res.on('error', () => {});
  req.on('error', () => {});

  // ---- 局域网设备访问控制：只有本机免访问码 ----
  const remoteIp = clientIp(req);
  if (!isLoopback(remoteIp)) {
    if (state.settings.lanEnabled === false) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(blockedPage());
      return;
    }

    const alreadyPaired = accessKeyFromRequest(req) === state.settings.accessKey;
    const supplied = url.searchParams.get('k');

    if (!alreadyPaired && supplied !== null) {
      if (accessBlocked(remoteIp)) {
        res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(gatePage('尝试次数过多，请 10 分钟后再试'));
        return;
      }
      if (supplied === state.settings.accessKey) {
        setAccessCookie(res, supplied);
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
      noteAccessFailure(remoteIp);
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(gatePage('访问码不正确，请再试一次'));
      return;
    }

    if (!alreadyPaired) {
      if (pathname.startsWith('/api/')) {
        sendJson(res, 401, { ok: false, error: '这台设备还没有授权，请输入访问码', needAccessKey: true });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(gatePage(''));
      return;
    }
  }

  const run = async () => {
    if (pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url, pathname);
      } catch (err) {
        if (res.headersSent) return res.end();
        const status = err instanceof VRChatError ? (err.status === 401 ? 401 : err.status || 502) : 500;
        sendJson(res, status, { ok: false, error: err.message || '服务器错误' });
      }
      return;
    }
    serveStatic(req, res, pathname);
  };
  run().catch((err) => {
    console.error('[server] 未捕获异常:', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' });
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  // 恢复上次的登录态
  for (const account of Object.values(state.accounts)) {
    if (!account.cookieCipher) continue;
    const tracker = ensureTracker(account);
    tracker.start();
  }
  const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
  const lan = lanAddresses();
  console.log('');
  console.log('  李子视奸朋友的网站 已启动');
  if (DEMO) console.log('  模式：演示数据（不会访问 VRChat）');
  console.log(`  本机：${url}`);
  if (LAN_MODE) {
    const lan = lanAddresses();
    if (lan.length) {
      for (const ip of lan) console.log(`  局域网：http://${ip}:${PORT}`);
      console.log(`  手机/平板访问码：${state.settings.accessKey}`);
      if (state.settings.lanEnabled === false) console.log('  注意：局域网访问当前是关闭状态（设置里可开启）');
    } else {
      console.log('  未检测到局域网地址');
    }
  } else {
    console.log('  仅本机可访问（想用手机打开：设 HOST=0.0.0.0 后重启）');
  }
  console.log(`  API ：${API_BASE}`);
  if (state.settings.proxyUrl) console.log(`  代理：${state.settings.proxyUrl}`);
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

function shutdown() {
  try {
    for (const tracker of trackers.values()) tracker.stop();
    store.save();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err);
  store.save();
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandledRejection:', err && err.message ? err.message : err);
});
