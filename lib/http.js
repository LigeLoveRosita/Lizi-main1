'use strict';

/**
 * 极简 HTTPS 客户端：
 *  - 不依赖任何 npm 包（Node 18+ 内置模块）
 *  - 支持 HTTP(S) 代理的 CONNECT 隧道（VRChat API 在部分地区必须走代理）
 *  - 手动处理 Cookie / 重定向 / 超时 / 响应体上限
 */

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

const DEFAULT_TIMEOUT = 25000;
const MAX_BODY = 12 * 1024 * 1024;

function proxyTunnel(proxyUrl, target, timeout) {
  let proxy;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    throw new Error(`代理地址无效: ${proxyUrl}`);
  }
  return function createConnection(_options, callback) {
    const secureProxy = proxy.protocol === 'https:';
    const lib = secureProxy ? https : http;
    const port = Number(proxy.port) || (secureProxy ? 443 : 80);
    const headers = {
      Host: `${target.hostname}:${target.port}`,
      'Proxy-Connection': 'keep-alive',
    };
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`;
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(cred).toString('base64');
    }

    const connectReq = lib.request({
      host: proxy.hostname,
      port,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`,
      headers,
      agent: false,
    });

    connectReq.setTimeout(timeout, () => connectReq.destroy(new Error('代理连接超时')));
    connectReq.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`代理拒绝隧道连接 (HTTP ${res.statusCode})`));
        return;
      }
      if (head && head.length) socket.unshift(head);
      const secure = tls.connect(
        { socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] },
        () => callback(null, secure),
      );
      secure.once('error', (err) => callback(err));
    });
    connectReq.once('error', (err) => callback(err));
    connectReq.end();
  };
}

function once(urlStr, { method = 'GET', headers = {}, body = null, proxyUrl = null, timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`无效的 URL: ${urlStr}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = Number(url.port) || (isHttps ? 443 : 80);
    const payload =
      body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

    const outHeaders = { ...headers };
    if (payload) {
      outHeaders['Content-Length'] = String(payload.length);
      const hasType = Object.keys(outHeaders).some((k) => k.toLowerCase() === 'content-type');
      if (!hasType) outHeaders['Content-Type'] = 'application/json';
    }

    const options = {
      hostname: url.hostname,
      port,
      path: url.pathname + url.search,
      method,
      headers: outHeaders,
    };

    if (isHttps && proxyUrl) {
      options.agent = false;
      options.createConnection = proxyTunnel(proxyUrl, { hostname: url.hostname, port }, timeout);
    }

    const req = lib.request(options);
    req.setTimeout(timeout, () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
    req.once('error', reject);
    req.once('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          req.destroy(new Error('响应体过大'));
          return;
        }
        chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => {
        resolve({ status: res.statusCode || 0, headers: res.headers, buffer: Buffer.concat(chunks) });
      });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @returns {Promise<{status:number, headers:object, buffer:Buffer, text:string, json:any}>}
 */
async function request(urlStr, opts = {}) {
  let current = urlStr;
  let method = opts.method || 'GET';
  let body = opts.body ?? null;
  const redirects = opts.redirects ?? 4;

  for (let i = 0; i <= redirects; i += 1) {
    const res = await once(current, { ...opts, method, body });
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      current = new URL(String(location), current).toString();
      if (res.status === 303 || (res.status !== 307 && res.status !== 308 && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = null;
      }
      continue;
    }
    res.text = res.buffer.toString('utf8');
    try {
      res.json = res.text ? JSON.parse(res.text) : null;
    } catch {
      res.json = null;
    }
    return res;
  }
  throw new Error('重定向次数过多');
}

module.exports = { request, DEFAULT_TIMEOUT };
