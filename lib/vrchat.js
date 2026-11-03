'use strict';

/**
 * VRChat 社区 Web API 客户端
 * 文档（社区维护）: https://vrchatapi.github.io/
 * 所有请求都直接打到 https://api.vrchat.cloud/api/1
 */

const { request } = require('./http');

const DEFAULT_BASE = 'https://api.vrchat.cloud/api/1';
const USER_AGENT = 'VRCWatch/1.0.0 (local personal friend-status dashboard)';

const TWO_FACTOR_PATHS = {
  totp: '/auth/twofactorauth/totp/verify',
  emailotp: '/auth/twofactorauth/emailotp/verify',
  otp: '/auth/twofactorauth/otp/verify',
};

/**
 * 接口返回的是 ['totp'] / ['emailOtp'] / ['otp']（注意 emailOtp 是驼峰），
 * 统一成能查表的小写形式。
 */
function normalizeTwoFactorMethod(method) {
  const key = String(method || 'totp')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return TWO_FACTOR_PATHS[key] ? key : '';
}

const STATUS_MAP = {
  'join me': 'joinme',
  joinme: 'joinme',
  active: 'active',
  'ask me': 'askme',
  askme: 'askme',
  busy: 'busy',
  offline: 'offline',
};

class VRChatError extends Error {
  constructor(message, status = 0, body = null, cause = null) {
    super(message);
    this.name = 'VRChatError';
    this.status = status;
    this.body = body;
    this.cause = cause;
    this.fatal = status === 401;
  }
}

function normalizeStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  return STATUS_MAP[key] || 'offline';
}

function splitLocation(location) {
  const loc = String(location || '');
  if (!loc || loc === 'offline' || loc === 'private') return { worldId: '', instanceId: '' };
  const idx = loc.indexOf(':');
  if (idx < 0) return { worldId: loc, instanceId: '' };
  return { worldId: loc.slice(0, idx), instanceId: loc.slice(idx + 1) };
}

function trustOf(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const has = (t) => list.includes(t);
  if (has('system_trust_veteran')) return { label: '老兵', key: 'veteran' };
  if (has('system_trust_trusted')) return { label: '受信', key: 'trusted' };
  if (has('system_trust_known')) return { label: '已知', key: 'known' };
  if (has('system_trust_intermediate')) return { label: '用户', key: 'user' };
  if (has('system_trust_basic')) return { label: '新用户', key: 'basic' };
  return { label: '游客', key: 'visitor' };
}

/** 把 VRChat 的 user / presence 结构压平成界面需要的形状 */
function normalizeUser(raw) {
  const u = raw || {};
  const p = u.presence || {};
  const location = String(p.world || u.worldId || u.location || '');
  const { worldId } = splitLocation(location);
  return {
    id: u.id || '',
    displayName: u.displayName || u.username || u.id || '',
    thumbnail: p.avatarThumbnail || u.currentAvatarThumbnailImageUrl || u.profilePicOverride || u.currentAvatarImageUrl || '',
    status: normalizeStatus(p.status || u.status),
    statusDescription: p.statusDescription ?? u.statusDescription ?? '',
    location,
    worldId,
    platform: p.platform || u.platform || '',
    tags: Array.isArray(u.tags) ? u.tags : [],
    trust: trustOf(u.tags),
    lastLogin: u.last_login || '',
  };
}

/** 从 VRChat 的错误响应里取出人类可读的原因（形如 {"error":{"message":"..."}}） */
function apiErrorMessage(data) {
  if (!data) return '';
  const raw = typeof data.error === 'string' ? data.error : data.error && data.error.message;
  if (!raw) return '';
  return String(raw)
    .replace(/^"+|"+$/g, '')
    .slice(0, 140);
}

function describeNetworkError(err, proxyUrl) {  const code = err && (err.code || (err.cause && err.cause.code));
  const hint = proxyUrl
    ? '请确认代理地址可用（例如 http://127.0.0.1:7890），或临时关闭代理后重试。'
    : '你的网络可能无法直连 VRChat API，请在「设置」里填写本地代理地址（例如 http://127.0.0.1:7890）后重试。';
  if (code === 'ENOTFOUND') return `无法解析 VRChat 域名（DNS 失败）。${hint}`;
  if (code === 'ECONNREFUSED') return `代理端口拒绝连接。${hint}`;
  if (code === 'ETIMEDOUT' || /timeout|超时/i.test(err.message)) return `连接 VRChat API 超时。${hint}`;
  if (code === 'ECONNRESET') return `连接被重置。${hint}`;
  return `网络请求失败：${err.message}。${hint}`;
}

class VRChatClient {
  constructor({ cookies = {}, proxyUrl = '', apiBase = DEFAULT_BASE } = {}) {
    this.cookies = new Map();
    for (const [name, value] of Object.entries(cookies)) {
      if (value) this.cookies.set(name, String(value));
    }
    this.proxyUrl = proxyUrl || '';
    this.apiBase = (apiBase || DEFAULT_BASE).replace(/\/+$/, '');
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  cookiesObject() {
    return Object.fromEntries(this.cookies.entries());
  }

  absorbCookies(headers) {
    const raw = headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const line of list) {
      const parts = String(line).split(';');
      const pair = parts.shift() || '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired =
        !value ||
        parts.some((p) => /^\s*max-age\s*=\s*0\s*$/i.test(p)) ||
        parts.some((p) => /^\s*expires\s*=.*1970/i.test(p));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async call(path, { method = 'GET', body, headers = {}, timeout } = {}) {
    const url = /^https?:/i.test(path) ? path : this.apiBase + path;
    const hasBody = body !== undefined && body !== null;
    const outHeaders = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      // 没有 Content-Type 时 VRChat 的 express.json() 不会解析 body，
      // 2FA 校验会变成“缺少 code”
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    };
    const cookie = this.cookieHeader();
    if (cookie) outHeaders.Cookie = cookie;

    let res;
    try {
      res = await request(url, {
        method,
        headers: outHeaders,
        body: body == null ? null : body,
        proxyUrl: this.proxyUrl || null,
        timeout,
      });
    } catch (err) {
      throw new VRChatError(describeNetworkError(err, this.proxyUrl), 0, null, err);
    }

    this.absorbCookies(res.headers);
    if (res.status === 429) {
      throw new VRChatError('请求过于频繁，已被 VRChat 限流，稍后会自动重试。', 429, res.json);
    }
    return { status: res.status, data: res.json, text: res.text, headers: res.headers };
  }

  /** 第一步：用户名 + 密码（Basic Auth） */
  async loginPassword(username, password) {
    this.cookies.clear();
    // 官方要求：base64(urlencode(username) + ':' + urlencode(password))
    // 邮箱里的 @、密码里的 & % + 等字符如果不编码，解码时会出错
    const basic = Buffer.from(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`, 'utf8').toString(
      'base64',
    );
    const { status, data } = await this.call('/auth/user', { headers: { Authorization: `Basic ${basic}` } });

    if (status === 401) throw new VRChatError('用户名或密码不正确', 401, data);
    if (status === 403)
      throw new VRChatError('被 Cloudflare 拦截（403）：请尝试更换网络、开启/关闭代理后重试。', 403, data);
    if (status < 200 || status >= 300) throw new VRChatError(`登录失败（HTTP ${status}）`, status, data);

    const methods = (data && data.requiresTwoFactorAuth) || [];
    if (methods.length) return { stage: 'twofactor', methods, user: null };
    return { stage: 'done', methods: [], user: data };
  }

  /** 第二步：两步验证（method 支持 totp / emailOtp / otp，大小写不敏感） */
  async verifyTwoFactor(code, method = 'totp') {
    const key = normalizeTwoFactorMethod(method);
    if (!key) throw new VRChatError(`不支持的验证方式：${method}`, 400);
    const clean = String(code || '').replace(/\s+/g, '');
    if (!clean) throw new VRChatError('请输入验证码', 400);

    const { status, data } = await this.call(TWO_FACTOR_PATHS[key], { method: 'POST', body: { code: clean } });
    const detail = apiErrorMessage(data);
    console.warn('[2fa]', key, 'status=', status, 'body=', JSON.stringify(data).slice(0, 300));

    if (status === 400 || status === 401) {
      throw new VRChatError(
        `验证码被拒绝${detail ? `（VRChat: ${detail}）` : ''}。请确认系统时间准确，或改用邮箱验证码 / 恢复代码。`,
        status,
        data,
      );
    }
    if (status >= 400) throw new VRChatError(`验证失败（HTTP ${status}）${detail ? `：${detail}` : ''}`, status, data);
    if (data && data.verified === false) throw new VRChatError('验证码被拒绝，请重新输入', status, data);

    return this.fetchMe();
  }

  /** 直接用已有的 auth Cookie 登录 */
  async loginWithCookie(rawCookie) {
    const value = String(rawCookie || '').trim();
    if (!value) throw new VRChatError('请粘贴 auth Cookie', 400);
    this.cookies.clear();
    if (value.includes('=')) {
      for (const part of value.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        if (name) this.cookies.set(name, val);
      }
    } else {
      this.cookies.set('auth', value);
    }
    if (!this.cookies.get('auth')) throw new VRChatError('Cookie 中未找到 auth 字段', 400);
    return this.fetchMe();
  }

  /** 拉取当前账号信息（同时会刷新 auth Cookie） */
  async fetchMe() {
    const { status, data } = await this.call('/auth/user');
    if (status === 401) throw new VRChatError('登录状态已失效，请重新登录', 401, data);
    if (status >= 400) throw new VRChatError(`获取账号信息失败（HTTP ${status}）`, status, data);
    if (!data || !data.id) throw new VRChatError('账号信息异常，请重新登录', status, data);
    return data;
  }

  async fetchUser(userId) {
    const { status, data } = await this.call(`/users/${encodeURIComponent(userId)}`);
    if (status === 404) return null;
    if (status === 401) throw new VRChatError('登录状态已失效，请重新登录', 401, data);
    if (status >= 400) throw new VRChatError(`获取好友信息失败（HTTP ${status}）`, status, data);
    return data;
  }

  async fetchWorld(worldId) {
    const { status, data } = await this.call(`/worlds/${encodeURIComponent(worldId)}`);
    if (status === 404) return null;
    if (status >= 400) return null;
    return data;
  }

  /**
   * 好友列表（带 presence）。比逐个查 /users/{id} 准确得多：
   * 服务端直接按 offline=false / true 分开返回，location / status 都是最新的。
   * 注意分页参数名是 n（不是 number），上限 100。
   * 接口不可用时返回 null，调用方回退到旧逻辑。
   */
  async listFriendsPage({ offline = false, limit = 100, offset = 0 } = {}) {
    const query = new URLSearchParams({
      offline: offline ? 'true' : 'false',
      n: String(limit),
      offset: String(offset),
    });
    const { status, data } = await this.call(`/auth/user/friends?${query.toString()}`);
    if (status === 401) throw new VRChatError('登录状态已失效，请重新登录', 401, data);
    if (status === 400 || status === 403 || status === 404) return null;
    if (status === 429) throw new VRChatError('请求过于频繁，已被 VRChat 限流，稍后会自动重试。', 429, data);
    if (status >= 400) return null;
    return Array.isArray(data) ? data : null;
  }

  /** 注销：PUT /logout，让服务端真正结束会话（失败也不影响本地登出） */
  async logout() {
    const { status } = await this.call('/logout', { method: 'PUT' });
    return status >= 200 && status < 300;
  }

  /** 拉取图片（头像 / 世界封面），走同一个 Cookie 与代理 */
  async fetchBinary(url, { timeout = 20000 } = {}) {
    const res = await request(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*', 'Accept-Encoding': 'identity', Cookie: this.cookieHeader() },
      proxyUrl: this.proxyUrl || null,
      timeout,
    });
    return res;
  }
}

module.exports = {
  VRChatClient,
  VRChatError,
  normalizeUser,
  normalizeStatus,
  normalizeTwoFactorMethod,
  splitLocation,
  trustOf,
  describeNetworkError,
  apiErrorMessage,
  USER_AGENT,
  DEFAULT_BASE,
};
