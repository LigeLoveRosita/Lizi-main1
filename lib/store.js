'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_VERSION = 1;

function defaultSettings() {
  return {
    pollSeconds: 60, // 好友在线状态轮询间隔
    refreshSeconds: 150, // 单个好友详情的缓存时长（越小越准，但请求越多）
    maxRequestsPerTick: 26, // 每轮最多请求多少个好友详情
    requestGapMs: 800, // 两次 API 请求之间的最小间隔（防风控）
    proxyUrl: '', // 形如 http://127.0.0.1:7890
    notify: true,
    lanEnabled: true, // 允许手机/平板等局域网设备访问
    accessKey: '', // 首次启动时自动生成
  };
}

function defaultState() {
  return {
    version: STATE_VERSION,
    createdAt: Date.now(),
    settings: defaultSettings(),
    accounts: {},
    sessions: {},
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'state.json');
    this.keyFile = path.join(this.dir, 'secret.key');
    this.key = this.loadKey();
    this.state = defaultState();
    this.saveTimer = null;
  }

  loadKey() {
    try {
      const raw = fs.readFileSync(this.keyFile, 'utf8').trim();
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 32) return buf;
    } catch {
      /* 首次运行 */
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyFile, key.toString('base64'), { mode: 0o600 });
    return key;
  }

  encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
  }

  decrypt(payload) {
    if (!payload) return '';
    const parts = String(payload).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return '';
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[1], 'base64'));
      decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.state = {
          ...defaultState(),
          ...parsed,
          settings: { ...defaultSettings(), ...(parsed.settings || {}) },
          accounts: parsed.accounts || {},
          sessions: parsed.sessions || {},
        };
      }
    } catch {
      this.state = defaultState();
    }
    return this.state;
  }

  /** 立即落盘（原子写入） */
  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 保存失败:', err.message);
    }
  }

  /** 合并写入，避免高频 IO */
  touch() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 600);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }
}

module.exports = { Store, defaultSettings, defaultState, STATE_VERSION };
