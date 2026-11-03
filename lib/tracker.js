'use strict';

/**
 * 好友状态追踪器
 *
 * 数据来源（按优先级）：
 *  1. GET /auth/user/friends?offline=false|true —— 一次拿到全部好友的 status / location / platform，
 *     服务端自己区分在线与离线，最准也最省请求；
 *  2. 如果这个接口不可用，退回 GET /auth/user 的 friends + onlineFriends，再逐个查 /users/{id}。
 *
 * 在线判定：只认服务端给的在线列表，绝不用 /users/{id} 的 status 反推（那个字段会滞后）。
 */

const crypto = require('node:crypto');
const { normalizeUser, normalizeStatus, splitLocation, VRChatError } = require('./vrchat');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowTs = () => Date.now();

const MAX_EVENTS = 400;
const MAX_WORLDS = 400;
const LIST_PAGE = 100; // 接口上限
const LIST_MAX_PAGES = 10;
const LIST_BLOCK_MS = 10 * 60 * 1000; // 接口不可用时，10 分钟后再试
const NOISE_THRESHOLD = 12; // 一次修正超过这么多人，就不写动态

function emptyFriend(id) {
  return {
    id,
    displayName: '',
    thumbnail: '',
    status: 'offline',
    statusDescription: '',
    location: '',
    worldId: '',
    platform: '',
    tags: [],
    online: false,
    watch: false,
    firstSeenAt: nowTs(),
    lastSeenAt: 0,
    lastDetailAt: 0,
    lastProfileAt: 0,
  };
}

/** 把 ['usr_x', { id:'usr_y' }] 或 undefined 统一成 Set；undefined 表示接口没返回该字段 */
function idSet(value) {
  if (!Array.isArray(value)) return null;
  const set = new Set();
  for (const item of value) {
    const id = typeof item === 'string' ? item : item && item.id;
    if (id) set.add(id);
  }
  return set;
}

/**
 * /auth/user 里判断在线用的字段：
 *  - onlineFriends：当前在线（含网页端在线）
 *  - activeFriends：正在某个世界里
 * 这两个字段服务端都可能省略，省略时 hasList=false，只能退回「逐个查详情」。
 */
function buildPresence(me) {
  const online = idSet(me.onlineFriends);
  const active = idSet(me.activeFriends);
  let onlineSet = online;
  if ((!onlineSet || onlineSet.size === 0) && active && active.size > 0) onlineSet = active;
  return { onlineSet: onlineSet || null, hasList: Boolean(onlineSet) };
}

class Tracker {
  constructor({ account, store, settings, client }) {
    this.account = account;
    this.store = store;
    this.settings = settings;
    this.client = client;

    this.account.friends = this.account.friends || {};
    this.account.events = this.account.events || [];
    this.account.worlds = this.account.worlds || {};
    this.account.watch = this.account.watch || [];

    this.running = false;
    this.busy = false;
    this.pending = false;
    this.timer = null;
    this.error = account.lastError || null;
    this.lastSyncAt = account.lastSyncAt || 0;
    this.nextSyncAt = 0;
    this.requests = 0;
    this.budget = 0;
    this.lastCallAt = 0;
    this.forceNext = false;
    this.stopped = false;
    this.syncCount = 0;
    this.mode = 'list';
    this.modeLogged = false;
    this.listingBlockedUntil = 0;
  }

  // ---------- 生命周期 ----------

  start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.loop().catch(() => {});
  }

  stop() {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async loop() {
    while (this.running) {
      const started = nowTs();
      await this.sync().catch((err) => {
        this.setError(err);
      });
      if (!this.running) break;
      const interval = Math.max(20, Number(this.settings.pollSeconds) || 60) * 1000;
      const wait = Math.max(3000, interval - (nowTs() - started));
      this.nextSyncAt = nowTs() + wait;
      await sleep(wait);
    }
  }

  /** 手动触发一次同步；force 时忽略缓存，重新拉一遍在线好友详情 */
  kick(force = false) {
    if (force) this.forceNext = true;
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.sync().catch((err) => this.setError(err));
  }

  setError(err) {
    const message = err && err.message ? err.message : String(err);
    this.error = { message, at: nowTs(), fatal: Boolean(err && err.fatal) };
    this.account.lastError = this.error;
    if (err && err.fatal) {
      this.account.authError = true;
      this.stop();
    }
    this.store.touch();
  }

  saveCookies() {
    try {
      this.account.cookieCipher = this.store.encrypt(JSON.stringify(this.client.cookiesObject()));
    } catch {
      /* 忽略 */
    }
  }

  // ---------- 核心同步 ----------

  async sync() {
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    this.pending = false;
    // 首次同步时多给一些额度，尽快把好友资料补齐
    const base = Math.max(4, Number(this.settings.maxRequestsPerTick) || 26);
    this.budget = this.account.initialized ? base : base + 40;
    this.lastCallAt = 0;

    try {
      const me = await this.client.fetchMe();
      this.saveCookies();
      this.account.self = normalizeUser(me);
      this.account.authError = false;
      this.error = null;
      this.account.lastError = null;

      // 启动后的第一次同步只做状态校准，不往动态里灌一堆「下线」
      const emitEvents = Boolean(this.account.initialized) && this.syncCount > 0;

      const listing = await this.loadFriendListing();
      if (listing) {
        this.mode = 'list';
        const total = listing.online.length + listing.offline.length;
        const previous = Object.keys(this.account.friends).length;
        if (total === 0 && previous > 5) {
          throw new VRChatError('VRChat 返回的好友数据为空（可能是接口抖动），已保留本地数据', 0, null);
        }
        await this.applyListing(listing.online, listing.offline, emitEvents);
        await this.enrichProfiles();
      } else {
        // 回退路径：/auth/user 的 friends + 逐个查详情
        this.mode = 'details';
        const rawFriends = Array.isArray(me.friends) ? me.friends : [];
        const ids = rawFriends.map((f) => (typeof f === 'string' ? f : f && f.id)).filter(Boolean);
        const presence = buildPresence(me);

        const previousCount = Object.keys(this.account.friends).length;
        if (ids.length === 0 && previousCount > 0) {
          throw new VRChatError('VRChat 返回的好友列表为空（可能是接口异常），已保留本地数据', 0, null);
        }

        this.reconcile(ids, presence, emitEvents);
        await this.refreshDetails(ids, presence, emitEvents);
      }

      this.account.initialized = true;
      this.lastSyncAt = nowTs();
      this.account.lastSyncAt = this.lastSyncAt;
      this.account.requests = (this.account.requests || 0) + this.requests;
      this.syncCount += 1;
      if (!this.modeLogged) {
        this.modeLogged = true;
        console.log(`[tracker] 数据源：${this.mode === 'list' ? '好友列表接口 /auth/user/friends' : '逐用户详情接口'}`);
      }
      this.store.touch();
    } catch (err) {
      this.setError(err);
      throw err;
    } finally {
      this.busy = false;
      if (this.pending && this.running) {
        this.pending = false;
        setTimeout(() => this.kick(), 400);
      }
    }
  }

  /** 拉取完整好友列表（在线 + 离线两遍），接口不可用时返回 null 让调用方回退 */
  async loadFriendListing() {
    if (this.listingBlockedUntil && nowTs() < this.listingBlockedUntil) return null;

    const collect = async (offline) => {
      const rows = [];
      for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
        await this.throttle();
        this.requests += 1;
        const chunk = await this.client.listFriendsPage({
          offline,
          limit: LIST_PAGE,
          offset: page * LIST_PAGE,
        });
        if (!chunk) return null;
        rows.push(...chunk);
        if (chunk.length < LIST_PAGE) break;
      }
      return rows;
    };

    const online = await collect(false);
    if (!online) {
      this.listingBlockedUntil = nowTs() + LIST_BLOCK_MS;
      return null;
    }
    const offline = await collect(true);
    if (!offline) {
      this.listingBlockedUntil = nowTs() + LIST_BLOCK_MS;
      return null;
    }
    return { online, offline };
  }

  async applyListing(online, offline, emit) {
    const now = nowTs();
    const present = new Set();
    for (const row of online) if (row && row.id) present.add(row.id);
    for (const row of offline) if (row && row.id) present.add(row.id);

    const pending = [];
    let transitions = 0;

    for (const id of Object.keys(this.account.friends)) {
      if (!present.has(id)) {
        const rec = this.account.friends[id];
        delete this.account.friends[id];
        if (rec) {
          pending.push({ type: 'removed_friend', userId: id, name: rec.displayName || id, thumbnail: rec.thumbnail });
        }
      }
    }

    for (const row of online) transitions += await this.applyRow(row, true, now, pending);
    for (const row of offline) transitions += await this.applyRow(row, false, now, pending);

    // 一次修正大量状态（刚启动 / 接口抖动）时不刷屏动态
    if (!emit || transitions > NOISE_THRESHOLD) return;
    for (const ev of pending) this.addEvent(ev);
  }

  /** 把一条好友列表记录合并进本地状态，返回 1 表示发生了在线/离线切换 */
  async applyRow(row, isOnline, now, pending) {
    if (!row || !row.id) return 0;

    let rec = this.account.friends[row.id];
    let created = false;
    if (!rec) {
      rec = this.account.friends[row.id] = emptyFriend(row.id);
      created = true;
      pending.push({
        type: 'new_friend',
        userId: rec.id,
        name: row.displayName || '新好友',
        thumbnail: '',
      });
    }

    const wasOnline = rec.online;
    const prevStatus = rec.status;
    const prevWorld = rec.worldId;
    const { worldId } = splitLocation(row.location || '');

    rec.displayName = row.displayName || rec.displayName;
    rec.thumbnail = row.currentAvatarImageUrl || row.currentAvatarThumbnailImageUrl || rec.thumbnail;
    rec.platform = row.platform || rec.platform;
    rec.lastDetailAt = now;
    rec.online = isOnline;

    let transition = 0;

    if (isOnline) {
      rec.status = normalizeStatus(row.status);
      rec.statusDescription = row.statusDescription || '';
      rec.location = row.location || '';
      rec.worldId = worldId;

      const worldChanged = Boolean(worldId) && prevWorld !== worldId;
      if (worldChanged && this.budget > 0) await this.ensureWorld(worldId).catch(() => {});

      if (!wasOnline && !created) {
        rec.lastSeenAt = now;
        transition = 1;
        pending.push({ type: 'online', userId: rec.id, name: rec.displayName, thumbnail: rec.thumbnail });
      } else if (wasOnline && worldChanged) {
        pending.push({
          type: 'world',
          userId: rec.id,
          name: rec.displayName,
          thumbnail: rec.thumbnail,
          worldId,
          worldName: this.worldName(worldId),
          text: this.worldName(worldId) || '未知世界',
        });
      } else if (wasOnline && prevStatus !== rec.status) {
        pending.push({
          type: 'status',
          userId: rec.id,
          name: rec.displayName,
          thumbnail: rec.thumbnail,
          status: rec.status,
          text: rec.statusDescription || '',
        });
      }
    } else {
      if (wasOnline) {
        rec.lastSeenAt = now;
        transition = 1;
        pending.push({ type: 'offline', userId: rec.id, name: rec.displayName, thumbnail: rec.thumbnail });
      }
      rec.status = 'offline';
      rec.statusDescription = '';
      rec.location = '';
      rec.worldId = '';
    }

    return transition;
  }

  /**
   * 好友列表接口不返回 tags（信任等级），这里慢慢补齐。
   * 每轮最多补几个，关注的好友优先。
   */
  async enrichProfiles() {
    const watch = new Set(this.account.watch);
    const targets = Object.values(this.account.friends)
      .filter((rec) => rec.online && (!rec.tags || rec.tags.length === 0) && rec.id)
      .sort((a, b) => {
        const wa = watch.has(a.id) ? 1 : 0;
        const wb = watch.has(b.id) ? 1 : 0;
        if (wa !== wb) return wb - wa;
        return (a.lastProfileAt || 0) - (b.lastProfileAt || 0);
      })
      .slice(0, Math.min(this.budget, 4));

    for (const rec of targets) {
      if (this.budget <= 0) break;
      try {
        const raw = await this.call(() => this.client.fetchUser(rec.id));
        if (!raw) continue;
        const u = normalizeUser(raw);
        if (u.tags && u.tags.length) rec.tags = u.tags;
        if (u.thumbnail) rec.thumbnail = u.thumbnail;
        rec.lastProfileAt = nowTs();
      } catch (err) {
        if (err instanceof VRChatError && (err.fatal || err.status === 429)) return;
      }
    }
  }

  // ---------- 回退路径（旧逻辑） ----------

  reconcile(ids, presence, emit) {
    const now = nowTs();
    const present = new Set(ids);
    const pending = [];

    for (const id of Object.keys(this.account.friends)) {
      if (!present.has(id)) {
        const rec = this.account.friends[id];
        delete this.account.friends[id];
        if (rec) {
          pending.push({ type: 'removed_friend', userId: id, name: rec.displayName || id, thumbnail: rec.thumbnail });
        }
      }
    }

    let transitions = 0;

    for (const id of ids) {
      let rec = this.account.friends[id];
      if (!rec) {
        rec = this.account.friends[id] = emptyFriend(id);
        pending.push({ type: 'new_friend', userId: id, name: rec.displayName || '新好友', thumbnail: '' });
      }

      // 在线状态以 /auth/user 的 onlineFriends 为准；接口没给就交给详情接口判断
      if (!presence.onlineSet) continue;
      const isOnline = presence.onlineSet.has(id);
      if (rec.online === isOnline) continue;

      rec.online = isOnline;
      rec.lastSeenAt = now;
      transitions += 1;

      if (isOnline) {
        // 刚上线：丢弃旧详情，下一轮立刻拉世界和状态
        rec.lastDetailAt = 0;
        pending.push({ type: 'online', userId: id, name: rec.displayName || id, thumbnail: rec.thumbnail });
      } else {
        rec.status = 'offline';
        rec.statusDescription = '';
        rec.location = '';
        rec.worldId = '';
        // 不要清空 lastDetailAt：否则下一轮会把详情接口里滞后的 "active" 状态又拉回来，
        // 导致刚下线的人反复显示成在线
        pending.push({ type: 'offline', userId: id, name: rec.displayName || id, thumbnail: rec.thumbnail });
      }
    }

    if (!emit || transitions > NOISE_THRESHOLD) return;
    for (const ev of pending) this.addEvent(ev);
  }

  async refreshDetails(ids, presence, emit) {
    const now = nowTs();
    const ttl = Math.max(30, Number(this.settings.refreshSeconds) || 150) * 1000;
    const offlineTtl = Math.max(ttl * 3, 10 * 60 * 1000);
    const watch = new Set(this.account.watch);
    const force = this.forceNext;
    this.forceNext = false;

    const candidates = ids.filter((id) => {
      const rec = this.account.friends[id];
      if (!rec) return false;
      const unknown = !rec.lastDetailAt;
      if (rec.online) {
        if (force) return true;
        return unknown || now - rec.lastDetailAt > ttl;
      }
      if (unknown) return ids.length <= 400;
      return !presence.hasList && now - rec.lastDetailAt > offlineTtl;
    });

    candidates.sort((a, b) => this.score(b, watch) - this.score(a, watch));

    for (const id of candidates) {
      if (this.budget <= 0 || !this.running) break;
      try {
        const raw = await this.call(() => this.client.fetchUser(id));
        if (!raw) continue;
        await this.applyDetail(id, raw, {
          emit,
          presenceFromList: presence.onlineSet ? presence.onlineSet.has(id) : null,
        });
      } catch (err) {
        if (err instanceof VRChatError && err.fatal) throw err;
        if (err instanceof VRChatError && err.status === 429) throw err;
        // 单个好友失败不影响整轮
      }
    }
  }

  score(id, watch) {
    const rec = this.account.friends[id];
    if (!rec) return 0;
    let s = 0;
    if (watch.has(id)) s += 100;
    if (rec.online) s += 50;
    if (!rec.lastDetailAt) s += 30;
    if (!rec.displayName) s += 10;
    return s;
  }

  async applyDetail(id, raw, { emit, presenceFromList }) {
    const rec = this.account.friends[id];
    if (!rec) return;
    const u = normalizeUser(raw);
    const wasOnline = rec.online;
    const prevStatus = rec.status;
    const prevWorldId = rec.worldId;
    const detailOnline = u.status !== 'offline';

    rec.displayName = u.displayName || rec.displayName;
    rec.thumbnail = u.thumbnail || rec.thumbnail;
    rec.platform = u.platform || rec.platform;
    if (u.tags && u.tags.length) rec.tags = u.tags;
    rec.lastDetailAt = nowTs();

    if (presenceFromList === null) {
      // 没有在线列表时，只能相信详情接口
      rec.online = detailOnline;
      if (rec.online && !wasOnline) rec.lastSeenAt = rec.lastDetailAt;
    } else {
      // 以在线列表为准：详情接口的 status 常常滞后（人已下线但仍返回 active）
      rec.online = presenceFromList;
    }

    if (rec.online && detailOnline) {
      rec.status = u.status;
      rec.statusDescription = u.statusDescription;
      rec.location = u.location;
      rec.worldId = u.worldId;
      if (!rec.lastSeenAt) rec.lastSeenAt = rec.lastDetailAt;
    }

    if (rec.online && rec.worldId && prevWorldId !== rec.worldId) {
      await this.ensureWorld(rec.worldId).catch(() => {});
    }

    if (!emit || !rec.online) return;

    if (rec.worldId && prevWorldId !== rec.worldId) {
      this.addEvent({
        type: 'world',
        userId: id,
        name: rec.displayName,
        thumbnail: rec.thumbnail,
        worldId: rec.worldId,
        worldName: this.worldName(rec.worldId),
        text: this.worldName(rec.worldId) || '未知世界',
      });
    } else if (prevStatus !== rec.status) {
      this.addEvent({
        type: 'status',
        userId: id,
        name: rec.displayName,
        thumbnail: rec.thumbnail,
        status: rec.status,
        text: rec.statusDescription || '',
      });
    }
  }

  // ---------- 通用 ----------

  async ensureWorld(worldId) {
    if (!worldId) return null;
    const cached = this.account.worlds[worldId];
    if (cached && cached.name && nowTs() - (cached.fetchedAt || 0) < 7 * 24 * 3600 * 1000) return cached;
    if (this.budget <= 0) return cached || null;
    const world = await this.call(() => this.client.fetchWorld(worldId));
    if (!world) return cached || null;
    const entry = {
      id: worldId,
      name: world.name || (cached && cached.name) || '未知世界',
      thumbnail: world.thumbnailImageUrl || world.imageUrl || '',
      authorName: world.authorName || '',
      fetchedAt: nowTs(),
    };
    this.account.worlds[worldId] = entry;
    const keys = Object.keys(this.account.worlds);
    if (keys.length > MAX_WORLDS) delete this.account.worlds[keys[0]];
    return entry;
  }

  worldName(worldId) {
    return this.account.worlds[worldId] ? this.account.worlds[worldId].name : '';
  }

  /** 请求节流：两次调用之间至少隔 requestGapMs */
  async throttle() {
    const gap = Math.max(0, Number(this.settings.requestGapMs) || 800);
    const wait = this.lastCallAt + gap - nowTs();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = nowTs();
  }

  async call(fn) {
    if (this.budget <= 0) return null;
    await this.throttle();
    this.budget -= 1;
    this.requests += 1;
    return fn();
  }

  addEvent(partial) {
    const ev = {
      id: crypto.randomUUID(),
      at: nowTs(),
      type: partial.type,
      userId: partial.userId || '',
      name: partial.name || '',
      thumbnail: partial.thumbnail || '',
      worldId: partial.worldId || '',
      worldName: partial.worldName || '',
      status: partial.status || '',
      text: partial.text || '',
    };
    this.account.events.unshift(ev);
    if (this.account.events.length > MAX_EVENTS) this.account.events.length = MAX_EVENTS;
    this.store.touch();
    return ev;
  }

  // ---------- 对外快照 ----------

  watchers() {
    return new Set(this.account.watch || []);
  }

  friendList() {
    const watch = this.watchers();
    return Object.values(this.account.friends).map((rec) => {
      const { worldId } = splitLocation(rec.location);
      return {
        ...rec,
        worldId: rec.worldId || worldId,
        worldName: rec.worldId ? this.worldName(rec.worldId) : '',
        watch: watch.has(rec.id),
      };
    });
  }

  events() {
    return this.account.events.slice(0, 150);
  }

  stats() {
    const list = Object.values(this.account.friends);
    return {
      total: list.length,
      online: list.filter((f) => f.online).length,
      watching: (this.account.watch || []).length,
      lastSyncAt: this.lastSyncAt,
      nextSyncAt: this.nextSyncAt,
      syncing: this.busy,
      requests: this.requests,
      mode: this.mode,
      error: this.error,
    };
  }

  setWatch(userId, watched) {
    const set = new Set(this.account.watch || []);
    if (watched) set.add(userId);
    else set.delete(userId);
    this.account.watch = [...set];
    this.store.touch();
    if (watched) this.kick();
  }
}

module.exports = { Tracker };
