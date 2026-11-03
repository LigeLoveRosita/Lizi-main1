'use strict';

/**
 * 接口契约测试：用一个假的 VRChat 服务器，逐条校验请求的方法 / 路径 / 参数 / 请求头 / Cookie / 请求体。
 * 不联网、不需要账号。
 *
 * 运行：node test-api.js
 */

const http = require('node:http');
const { VRChatClient, normalizeUser, normalizeTwoFactorMethod } = require('./lib/vrchat');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${a}, want ${e})`);
}

function startServer(handlerRef) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handlerRef.current(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function json(res, status, payload, headers = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function cookieOf(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

(async () => {
  const handlerRef = { current: (req, res) => json(res, 500, { error: 'no handler' }) };
  const { server, port } = await startServer(handlerRef);
  const base = `http://127.0.0.1:${port}/api/1`;

  // ---------------------------------------------------------------- 1. 登录
  let captured = null;
  handlerRef.current = (req, res, body) => {
    captured = { method: req.method, url: req.url, auth: req.headers.authorization, ua: req.headers['user-agent'] };
    json(res, 200, { id: 'usr_1', displayName: 'Me', requiresTwoFactorAuth: ['emailOtp'] });
  };
  const client = new VRChatClient({ apiBase: base });
  const login = await client.loginPassword('user+tag@example.com', 'p@ss&word=1');

  check('登录使用 GET /auth/user', `${captured.method} ${captured.url}`, 'GET /api/1/auth/user');
  const decoded = Buffer.from(String(captured.auth).replace(/^Basic /, ''), 'base64').toString('utf8');
  check('Basic Auth 按规范做了 urlencode', decoded, 'user%2Btag%40example.com:p%40ss%26word%3D1');
  check('请求带 User-Agent', Boolean(captured.ua && captured.ua.includes('VRCWatch')), true);
  check('识别两步验证', login.stage, 'twofactor');
  check('返回 2FA 方式', login.methods, ['emailOtp']);

  // ------------------------------------------------------------ 2. 邮箱 2FA
  captured = null;
  handlerRef.current = (req, res, body) => {
    if (req.url.endsWith('/auth/twofactorauth/emailotp/verify')) {
      captured = {
        method: req.method,
        url: req.url,
        type: req.headers['content-type'],
        body: JSON.parse(body || '{}'),
        twoFactorCookie: cookieOf(req, 'twoFactorAuth'),
      };
      json(res, 200, { verified: true }, { 'Set-Cookie': 'auth=fresh-token; Path=/; HttpOnly' });
      return;
    }
    if (req.url.endsWith('/auth/user')) {
      captured.me = { method: req.method, authCookie: cookieOf(req, 'auth') };
      json(res, 200, { id: 'usr_1', displayName: 'Me' });
      return;
    }
    json(res, 404, {});
  };
  // 模拟第一步拿到的 twoFactorAuth Cookie
  client.cookies.set('twoFactorAuth', 'tf-cookie');
  const me = await client.verifyTwoFactor(' 123 456 ', 'emailOtp');

  check('emailOtp 打到正确路径', `${captured.method} ${captured.url}`, 'POST /api/1/auth/twofactorauth/emailotp/verify');
  check('2FA 请求带 JSON Content-Type', captured.type, 'application/json');
  check('验证码去空格后提交', captured.body, { code: '123456' });
  check('带上 twoFactorAuth Cookie', captured.twoFactorCookie, 'tf-cookie');
  check('验证成功后带新 auth Cookie 取用户', captured.me, { method: 'GET', authCookie: 'fresh-token' });
  check('返回用户信息', me.id, 'usr_1');

  // ------------------------------------------------------- 3. 全小写/驼峰都认
  check('emailOtp 归一化', normalizeTwoFactorMethod('emailOtp'), 'emailotp');
  check('TOTP 归一化', normalizeTwoFactorMethod('TOTP'), 'totp');
  check('未知方式', normalizeTwoFactorMethod('sms'), '');

  // -------------------------------------------------------- 4. 好友列表接口
  const queries = [];
  handlerRef.current = (req, res) => {
    queries.push(req.url);
    if (req.url.includes('offline=true')) return json(res, 404, { error: 'gone' });
    json(res, 200, [{ id: 'usr_a', displayName: 'A', status: 'active', location: 'wrld_1:1', platform: 'android' }]);
  };
  const rows = await client.listFriendsPage({ offline: false, limit: 100, offset: 0 });
  check('好友列表分页参数用 n', queries[0], '/api/1/auth/user/friends?offline=false&n=100&offset=0');
  check('好友列表返回数组', Array.isArray(rows), true);

  const unavailable = await client.listFriendsPage({ offline: true, limit: 100, offset: 0 });
  check('接口 404 时返回 null（调用方回退）', unavailable, null);

  // ---------------------------------------------------------------- 5. 注销
  captured = null;
  handlerRef.current = (req, res) => {
    captured = { method: req.method, url: req.url };
    json(res, 200, { success: { message: 'logged out' } });
  };
  const okLogout = await client.logout();
  check('注销用 PUT /logout', captured, { method: 'PUT', url: '/api/1/logout' });
  check('注销成功', okLogout, true);

  // ------------------------------------------------------------ 6. 401 致命
  handlerRef.current = (req, res) => json(res, 401, { error: { message: 'Missing Credentials' } });
  let fatal = false;
  try {
    await client.fetchMe();
  } catch (err) {
    fatal = Boolean(err.fatal);
  }
  check('401 标记为致命（触发重新登录）', fatal, true);

  // ------------------------------------------------------------ 7. 数据归一
  const modern = normalizeUser({
    id: 'usr_x',
    displayName: 'X',
    presence: {
      status: 'join me',
      statusDescription: 'hi',
      world: 'wrld_9:123~region(us)',
      platform: 'standalonewindows',
      avatarThumbnail: 'https://api.vrchat.cloud/a.png',
    },
  });
  check('presence 形态：状态', modern.status, 'joinme');
  check('presence 形态：世界 ID', modern.worldId, 'wrld_9');
  check('presence 形态：位置完整', modern.location, 'wrld_9:123~region(us)');

  const legacy = normalizeUser({ id: 'usr_y', displayName: 'Y', status: 'busy', worldId: 'wrld_2', currentAvatarThumbnailImageUrl: 'u' });
  check('旧字段形态：状态', legacy.status, 'busy');
  check('旧字段形态：世界', legacy.worldId, 'wrld_2');

  const offline = normalizeUser({ id: 'usr_z', status: 'offline', location: 'offline' });
  check('离线用户 location=offline 时世界为空', offline.worldId, '');
  check('离线用户状态', offline.status, 'offline');

  server.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
