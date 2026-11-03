'use strict';

/**
 * 演示模式：不访问 VRChat，用一份假数据驱动界面，方便本地看效果 / 录屏。
 * 接口与 VRChatClient 保持一致。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORLDS = {
  'wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd': 'The Black Cat',
  'wrld_1b88d3c9-79b2-4f1a-8d4d-50d9c4c0b0b1': 'Just B Club',
  'wrld_9d1f2b3c-8f5a-4d6e-b7c8-112233445566': 'Furry Hangout',
  'wrld_5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d': 'VRChat 中文社区酒吧',
  'wrld_7f6e5d4c-3b2a-4988-8776-655443322110': 'Midnight Rooftop',
  'wrld_2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f': 'Dance Dance Neon',
};

const PLATFORMS = ['standalonewindows', 'android', 'standalonewindows', 'ios'];

const PEOPLE = [
  { id: 'usr_demo_01', displayName: '夜行列车', status: 'join me', sd: '在 Black Cat 蹲人，来就完事', world: 'wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd', inst: '~public', platform: 'standalonewindows', tags: ['system_trust_trusted', 'language_zh'] },
  { id: 'usr_demo_02', displayName: '青柠气泡', status: 'active', sd: '听歌中 勿扰（其实可以聊）', world: 'wrld_1b88d3c9-79b2-4f1a-8d4d-50d9c4c0b0b1', inst: '~friends(usr_demo_01)', platform: 'standalonewindows', tags: ['system_trust_known', 'language_zh'] },
  { id: 'usr_demo_03', displayName: 'Kitsune_09', status: 'busy', sd: '在画图，晚上再来', world: 'wrld_9d1f2b3c-8f5a-4d6e-b7c8-112233445566', inst: '~private(usr_demo_03)', platform: 'android', tags: ['system_trust_veteran'] },
  { id: 'usr_demo_04', displayName: '阿岚', status: 'active', sd: '', world: 'wrld_5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', inst: '~public', platform: 'standalonewindows', tags: ['system_trust_trusted', 'language_zh'] },
  { id: 'usr_demo_05', displayName: 'Miko', status: 'ask me', sd: '想玩恐怖图就叫我', world: 'wrld_7f6e5d4c-3b2a-4988-8776-655443322110', inst: '~friends(usr_demo_06)', platform: 'standalonewindows', tags: ['system_trust_known'] },
  { id: 'usr_demo_06', displayName: '白桃乌龙', status: 'join me', sd: 'Neon 舞池见', world: 'wrld_2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', inst: '~hidden(usr_demo_06)', platform: 'android', tags: ['system_trust_intermediate', 'language_zh'] },
  { id: 'usr_demo_07', displayName: 'Nyx', status: 'offline', sd: '', world: '', inst: '', platform: '', tags: ['system_trust_trusted'] },
  { id: 'usr_demo_08', displayName: '柚子茶', status: 'offline', sd: '', world: '', inst: '', platform: '', tags: ['system_trust_basic', 'language_zh'] },
  { id: 'usr_demo_09', displayName: 'T-800', status: 'active', sd: '测试模型', world: 'wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd', inst: '~group(grp_demo_01)', platform: 'standalonewindows', tags: ['system_trust_veteran'] },
  { id: 'usr_demo_10', displayName: '春眠不觉晓', status: 'offline', sd: '', world: '', inst: '', platform: '', tags: ['system_trust_known', 'language_zh'] },
  { id: 'usr_demo_11', displayName: 'Lumi', status: 'active', sd: 'FFXIV 挂机', world: 'wrld_1b88d3c9-79b2-4f1a-8d4d-50d9c4c0b0b1', inst: '~public', platform: 'standalonewindows', tags: ['system_trust_trusted'] },
  { id: 'usr_demo_12', displayName: '碳烤麻薯', status: 'offline', sd: '', world: '', inst: '', platform: '', tags: ['system_trust_basic', 'language_zh'] },
  { id: 'usr_demo_13', displayName: 'Aster', status: 'join me', sd: '通宵', world: 'wrld_9d1f2b3c-8f5a-4d6e-b7c8-112233445566', inst: '~public', platform: 'android', tags: ['system_trust_known'] },
  { id: 'usr_demo_14', displayName: '月见', status: 'ask me', sd: '有点困', world: 'wrld_7f6e5d4c-3b2a-4988-8776-655443322110', inst: '~private(usr_demo_14)', platform: 'ios', tags: ['system_trust_trusted', 'language_zh'] },
  { id: 'usr_demo_15', displayName: 'Rin', status: 'offline', sd: '', world: '', inst: '', platform: '', tags: ['system_trust_intermediate'] },
  { id: 'usr_demo_16', displayName: '大福', status: 'active', sd: '在学做模型', world: 'wrld_5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', inst: '~friends(usr_demo_04)', platform: 'standalonewindows', tags: ['system_trust_basic', 'language_zh'] },
];

class DemoClient {
  constructor() {
    this.people = PEOPLE.map((p) => ({ ...p }));
    this.proxyUrl = '';
    this.ticks = 0;
  }

  cookiesObject() {
    return { demo: '1' };
  }

  mutate() {
    this.ticks += 1;
    if (this.ticks % 2 === 0) return;
    const person = this.people[Math.floor(Math.random() * this.people.length)];
    if (!person) return;
    const roll = Math.random();
    if (person.status === 'offline') {
      person.status = ['active', 'join me', 'ask me'][Math.floor(Math.random() * 3)];
      person.world = Object.keys(WORLDS)[Math.floor(Math.random() * 6)];
      person.inst = '~public';
      person.platform = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];
    } else if (roll < 0.5) {
      person.world = Object.keys(WORLDS)[Math.floor(Math.random() * 6)];
      person.inst = '~public';
    } else if (roll < 0.8) {
      person.sd = ['刚上线', '挂机中', '在等人', '想睡觉了', '肝模型中'][Math.floor(Math.random() * 5)];
    } else {
      person.status = 'offline';
      person.world = '';
      person.inst = '';
      person.platform = '';
    }
  }

  async fetchMe() {
    await sleep(180);
    this.mutate();
    const online = this.people.filter((p) => p.status !== 'offline').map((p) => p.id);
    return {
      id: 'usr_demo_self',
      displayName: '你（演示模式）',
      status: 'active',
      statusDescription: '这是本地演示数据',
      currentAvatarThumbnailImageUrl: '',
      friends: this.people.map((p) => p.id),
      onlineFriends: online,
      tags: ['system_trust_trusted'],
    };
  }

  async fetchUser(id) {
    await sleep(50);
    const p = this.people.find((x) => x.id === id);
    if (!p) return null;
    return {
      id: p.id,
      displayName: p.displayName,
      tags: p.tags,
      presence: {
        status: p.status,
        statusDescription: p.sd,
        world: p.world ? `${p.world}:${p.inst || '~public'}` : '',
        platform: p.platform,
        avatarThumbnail: '',
      },
    };
  }

  /** 演示模式走逐个查详情的回退路径 */
  async listFriendsPage() {
    return null;
  }

  async fetchWorld(worldId) {
    await sleep(20);
    if (!WORLDS[worldId]) return null;
    return { id: worldId, name: WORLDS[worldId], authorName: 'demo', thumbnailImageUrl: '' };
  }

  async fetchBinary() {
    return { status: 404, headers: {}, buffer: Buffer.alloc(0) };
  }
}

module.exports = { DemoClient };
