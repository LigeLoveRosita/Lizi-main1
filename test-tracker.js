'use strict';

/**
 * 追踪逻辑回归测试（不联网）
 *  1. 回退模式：/auth/user 的 onlineFriends + 逐个查详情
 *  2. 主模式：/auth/user/friends 一次拿全量 presence
 *
 * 运行：node test-tracker.js
 */

const { Tracker } = require('./lib/tracker');

const store = { touch() {}, save() {}, encrypt: (s) => s, decrypt: (s) => s };
const settings = { pollSeconds: 60, refreshSeconds: 30, maxRequestsPerTick: 10, requestGapMs: 0, notify: false };

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${a}, want ${e})`);
}

function newAccount(id) {
  return { id, friends: {}, events: [], worlds: {}, watch: [] };
}

/** 旧路径的假客户端：listFriendsPage 不可用 */
function legacyClient(state) {
  return {
    cookiesObject: () => ({ auth: 'x' }),
    async listFriendsPage() {
      return null;
    },
    async fetchMe() {
      const online = state.online === null ? undefined : state.online;
      return {
        id: 'usr_self',
        displayName: 'me',
        friends: ['usr_A', 'usr_B'],
        ...(online === undefined ? {} : { onlineFriends: online }),
      };
    },
    async fetchUser(id) {
      if (id === 'usr_A') {
        return {
          id,
          displayName: 'Alice',
          presence: { status: state.aStatus, statusDescription: 'hi', world: state.aStatus === 'offline' ? '' : 'wrld_1:1' },
        };
      }
      return { id, displayName: 'Bob', presence: { status: 'offline', statusDescription: '', world: '' } };
    },
    async fetchWorld() {
      return { id: 'wrld_1', name: 'Test World' };
    },
  };
}

/** 新路径的假客户端：好友列表带 presence */
function listingClient(state) {
  return {
    cookiesObject: () => ({ auth: 'x' }),
    async fetchMe() {
      return { id: 'usr_self', displayName: 'me' };
    },
    async listFriendsPage({ offline }) {
      return offline ? state.offline : state.online;
    },
    async fetchUser(id) {
      state.userCalls.push(id);
      return { id, displayName: id, tags: ['system_trust_trusted'], presence: { status: 'active', world: 'wrld_1:1' } };
    },
    async fetchWorld() {
      return { id: 'wrld_1', name: 'Test World' };
    },
  };
}

const row = (id, status, location) => ({
  id,
  displayName: `名字-${id}`,
  status,
  statusDescription: '',
  location,
  platform: 'standalonewindows',
  currentAvatarImageUrl: `https://api.vrchat.cloud/${id}.png`,
});

(async () => {
  /* ------------------------- 回退模式 ------------------------- */
  const state = { online: ['usr_A'], aStatus: 'active' };
  const account = newAccount('usr_legacy');
  const tracker = new Tracker({ account, store, settings, client: legacyClient(state) });
  tracker.running = true;

  await tracker.sync();
  check('回退：第 1 轮 A 在线', account.friends.usr_A.online, true);
  check('回退：第 1 轮 A 世界解析', account.friends.usr_A.worldId, 'wrld_1');

  state.online = [];
  await tracker.sync();
  check('回退：第 2 轮 A 离线（列表为准）', account.friends.usr_A.online, false);

  for (let i = 0; i < 3; i += 1) await tracker.sync();
  check('回退：滞后详情不会复活 A', account.friends.usr_A.online, false);
  check('回退：离线后清空世界', account.friends.usr_A.worldId, '');

  state.online = ['usr_A'];
  state.aStatus = 'join me';
  await tracker.sync();
  check('回退：A 重新上线', account.friends.usr_A.online, true);
  check('回退：A 状态更新', account.friends.usr_A.status, 'joinme');

  /* ------------------------- 好友列表模式 ------------------------- */
  const listState = {
    online: [row('usr_A', 'active', 'wrld_1:1')],
    offline: [row('usr_B', 'offline', 'offline')],
    userCalls: [],
  };
  const acc2 = newAccount('usr_list');
  const t2 = new Tracker({ account: acc2, store, settings, client: listingClient(listState) });
  t2.running = true;

  await t2.sync();
  check('列表：好友总数', Object.keys(acc2.friends).length, 2);
  check('列表：A 在线', acc2.friends.usr_A.online, true);
  check('列表：A 名字来自列表', acc2.friends.usr_A.displayName, '名字-usr_A');
  check('列表：A 世界解析', t2.friendList().find((f) => f.id === 'usr_A').worldName, 'Test World');
  check('列表：B 离线', acc2.friends.usr_B.online, false);
  check('列表：离线好友不查详情', listState.userCalls.includes('usr_B'), false);
  check('列表：在线好友补了信任标签', acc2.friends.usr_A.tags, ['system_trust_trusted']);

  // A 下线、B 上线
  listState.online = [row('usr_B', 'join me', 'wrld_1:2')];
  listState.offline = [row('usr_A', 'offline', 'offline')];
  await t2.sync();
  check('列表：A 下线', acc2.friends.usr_A.online, false);
  check('列表：A 清空世界', acc2.friends.usr_A.worldId, '');
  check('列表：B 上线', acc2.friends.usr_B.online, true);
  check('列表：B 状态', acc2.friends.usr_B.status, 'joinme');
  check('列表：B 世界', acc2.friends.usr_B.worldId, 'wrld_1');

  const types = acc2.events.map((e) => e.type).sort();
  check('列表：动态记录了上下线', types.includes('offline') && types.includes('online'), true);

  // 世界变化
  listState.online = [row('usr_B', 'join me', 'wrld_2:1')];
  listState.offline = [row('usr_A', 'offline', 'offline')];
  await t2.sync();
  check('列表：换世界写进动态', acc2.events.some((e) => e.type === 'world'), true);

  // 接口挂掉时回退，不丢数据
  const acc3 = newAccount('usr_broken');
  const broken = {
    cookiesObject: () => ({}),
    async listFriendsPage() {
      return null;
    },
    async fetchMe() {
      return { id: 'usr_self', displayName: 'me', friends: ['usr_A'], onlineFriends: ['usr_A'] };
    },
    async fetchUser(id) {
      return { id, displayName: 'Alice', presence: { status: 'active', world: 'wrld_1:1' } };
    },
    async fetchWorld() {
      return { id: 'wrld_1', name: 'W' };
    },
  };
  const t3 = new Tracker({ account: acc3, store, settings, client: broken });
  t3.running = true;
  await t3.sync();
  check('列表接口不可用时回退成功', acc3.friends.usr_A.online, true);
  check('回退后记录名字', acc3.friends.usr_A.displayName, 'Alice');

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
