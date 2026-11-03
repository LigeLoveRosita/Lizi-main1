# 李子视奸朋友的网站

> 一个跑在自己电脑上的 VRChat 好友在线看板：谁在线、在哪个世界、状态签名是什么，谁刚上线 / 下线 / 换世界，一眼看完。

![界面预览](preview.png)

它不修改任何 VRChat 数据，只把**你自己账号本来就能看到的好友状态**整理成一个好看的看板。数据全部留在本机。

---

## 功能

- **账号登录**：VRChat 用户名 + 密码，支持两步验证（验证器 / 邮箱验证码 / 恢复代码）；也可以直接粘贴 `auth` Cookie 登录。
- **在线状态**：可加入 / 在线 / 询问我 / 忙碌 / 离线，头像有状态光圈和呼吸点。
- **所在世界**：自动把 `wrld_xxx:instance` 解析成世界名，并标注实例类型（公开 / 好友 / 好友+ / 群组 / 私人 / 邀请+）。
- **平台**：PC / Quest / iOS / Web 都会显示在卡片上。
- **好友动态**：上线、下线、换世界、改状态、加好友、删好友，按时间倒序记录。
- **特别关注**：点卡片右上角 ★ 置顶，TA 上线时发浏览器桌面通知。
- **同世界提醒**：好友和你在同一个实例时，卡片会亮出「同世界」标签。
- **筛选与搜索**：在线 / 全部 / 关注 / 离线四个分栏，可按名字、世界、签名搜索。
- **深色界面**：自适应手机、平板、桌面，手机可「添加到主屏幕」当 App 用。
- **白天 / 夜晚**：右上角一键切换，设置里还能选「极光 / 深海 / 樱雾 / 纯色」四种背景，只保存在本机。

---

## 外观

| 白天 | 夜晚 |
| --- | --- |
| ![白天](preview-day.png) | ![夜晚](preview.png) |

- 右上角的 ☀ / ☾ 按钮切换白天夜晚；
- 设置 → 外观 里可以换背景：极光（默认）、深海、樱雾、纯色；
- 主题存在浏览器 `localStorage`，每台设备可以不一样，也可以直接用 `?theme=day&bg=sakura` 分享链接；
- 跟随系统？没有做自动跟随，因为夜间深色是这个界面的主要形态，默认就是夜晚。

---

## 快速开始

需要 **Node.js 18+**。零依赖，不需要 `npm install`。

```bash
node server.js
```

Windows 下也可以直接双击 `start.cmd`。

然后打开 <http://127.0.0.1:8899>。

想先看看界面长什么样（不需要账号、不联网）：

```bash
node server.js --demo
```

> 服务默认只监听 `127.0.0.1`，只有本机能访问。

---

## 部署到云服务器

一个 Node 进程、无数据库、无第三方依赖。**2 核 2G 完全够用**，1 核 512M 也能跑：

| 指标 | 实际占用 |
| --- | --- |
| 常驻内存 | 约 60–80 MB（纯 Node 进程） |
| CPU | 基本空闲，只有轮询时的少量 JSON 解析 |
| 磁盘 | 代码 + 依赖不到 1 MB，`data/` 只有几 KB 到几 MB |
| 带宽 | 每轮同步 4 个请求，流量可忽略；头像走本机代理，缓存 1 小时 |

真正影响体验的是**服务器到 `api.vrchat.cloud` 的网络延迟**，不是机器配置。

### 网络要求（关键）

- 服务器要能直连 `api.vrchat.cloud`：香港 / 日本 / 新加坡 / 美西节点都可以；
- 大陆机房一般连不上，需要在服务器上跑代理，然后 `HTTPS_PROXY=http://127.0.0.1:7890` 启动；
- 判断方法：`curl -s -o /dev/null -w "%{http_code}" https://api.vrchat.cloud/api/1/config`，返回 200 就行。

### 方式一：systemd（直连）

```bash
sudo apt install -y nodejs          # 需要 18+
sudo mkdir -p /opt/lizi && sudo chown $USER /opt/lizi
git clone https://github.com/LigeLoveRosita/Lizi-main1.git /opt/lizi
cd /opt/lizi && node server.js      # 先手动跑一次，确认能启动
sudo cp deploy/lizi-watch.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lizi-watch
journalctl -u lizi-watch -f
```

### 方式二：Docker Compose

```bash
docker compose up -d --build
docker logs -f lizi-watch
```

`docker-compose.yml` 已经把 `data/` 挂到宿主机，重启不丢登录状态。

### 反向代理 + HTTPS（公网必备）

公网必须上 HTTPS，否则登录 Cookie 和访问码都是明文。示例见 `deploy/nginx.conf.example`：

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/lizi-watch.conf
sudo certbot --nginx -d 你的域名
```

- 服务监听 `127.0.0.1:8899`，由 nginx 反代；
- **记得给服务加 `TRUST_PROXY=1`**，否则所有请求都会被当成"本机"，设备访问码就失效了；
- 还可以在 nginx 里再加一层 `auth_basic`，和 App 内的访问码双保险。

### 安全提醒

- 公网访问会要求输入设备访问码（控制台和设置里都能看到），连续输错 8 次封 10 分钟；
- `data/` 里是加密后的 VRChat 会话和密钥，定期备份，别提交到公开仓库；
- 建议只给自己用，不要做多租户。

---

## 登录

1. **用户名 + 密码**：密码只用于一次登录请求，**不会写入磁盘**。登录成功后保存在本机的是 VRChat 的 `auth` Cookie，使用 AES-256-GCM 加密。
2. **两步验证**：账号开了 2FA 时，界面会切到验证码步骤，可选验证器 App / 邮箱 / 恢复代码。
3. **Cookie 登录**（不想输密码时）：浏览器登录 <https://vrchat.com> → F12 → Application → Cookies → 复制 `auth` 的值，粘到登录页「用 auth Cookie 登录」。

登录态会一直保持（Cookie 每次请求自动续期），重启程序后自动恢复。

---

## 网络 / 代理

VRChat API（`api.vrchat.cloud`）在部分网络下无法直连，表现为登录时提示 **「连接 VRChat API 超时」**。

- 打开本地代理（Clash / V2Ray 等），在右上角 **⚙ 设置 → 网络** 里填 `http://127.0.0.1:7890`（Clash 默认端口），保存后重新登录。
- 也支持带账号密码的代理：`http://user:pass@127.0.0.1:7890`。
- 程序自带 HTTP CONNECT 隧道，只影响自己访问 VRChat，不改系统代理。

---

## 数据源与请求频率

| 接口 | 用途 |
| --- | --- |
| `GET /auth/user` | 登录 / 校验登录态 / 续期 Cookie，顺便取自己的资料 |
| `GET /auth/user/friends?offline=false&n=100&offset=0` | 在线好友（自带 status / location / platform），超过 100 人自动翻页 |
| `GET /auth/user/friends?offline=true&n=100&offset=0` | 离线好友，用来确认谁不在了 |
| `GET /users/{id}` | 只用来补信任等级（好友列表接口不返回 tags），每轮最多 4 个 |
| `GET /worlds/{id}` | 解析世界名，本地缓存 7 天 |
| `PUT /logout` | 退出登录时真正结束服务端会话 |

一轮同步通常只有 **4 个请求**（1 次 auth + 2 次好友列表 + 少量补资料）。

**在线判定规则**：只认好友列表接口的 `offline` 分桶。

- 好友列表接口由服务端直接分好在线 / 离线，和 VRChat 网页端同源；
- `/users/{id}` 只负责补世界名、签名、信任等级，**不参与在线判断** —— 它的 `status` 经常滞后
  （人已下线仍返回 `active`），拿它反推会出现「离线好友显示在线」；
- 只有好友列表接口不可用时，才退回 `/auth/user` 的 `onlineFriends` + 逐个查详情。

轮询间隔、详情缓存都可以在设置里调（20–900 秒 / 30–3600 秒）。想立刻刷新，点右上角 ↻。

---

## 隐私与安全

- 服务默认只监听 `127.0.0.1`，局域网/外网访问不到。
- 登录 Cookie 在磁盘上是 AES-256-GCM 密文（密钥 `data/secret.key`）；密码从不落盘。
- 头像图片经本机 `/api/img` 代理拉取，浏览器页面拿不到你的 Cookie。
- 所有数据只存在 `data/state.json`，不会上传到任何服务器。
- **不要**把 `data/` 目录发给别人，也不要部署到公网。

想清空：设置 → 清空好友缓存与动态；或删除整个 `data/` 目录。

> 想在手机上看？把 `HOST` 设为 `0.0.0.0` 再启动，控制台会打印局域网地址和设备访问码，
> 手机浏览器打开地址、输入访问码即可（每台设备只需一次）。

---

## 目录结构

```
.
├─ server.js              # HTTP 服务 + 路由 + 图片代理
├─ lib/
│  ├─ http.js             # 极简 HTTPS 客户端（带代理隧道）
│  ├─ vrchat.js           # VRChat API 客户端（登录 / 2FA / 好友 / 世界 / 注销）
│  ├─ tracker.js          # 同步、状态对比、动态生成
│  ├─ store.js            # JSON 持久化 + Cookie 加密
│  └─ demo.js             # 演示数据
├─ public/                # 前端，原生 JS，无构建步骤
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js
│  └─ manifest.webmanifest
├─ test-api.js            # 接口契约测试（本地假服务器）
├─ test-tracker.js        # 追踪逻辑回归测试
└─ data/                  # 运行时生成：state.json / secret.key（已 gitignore）
```

---

## 自测

不需要账号，也不需要联网：

```bash
node test-api.js        # 请求方法 / 路径 / 参数 / 请求头 / Cookie / 2FA 流程
node test-tracker.js    # 上下线判定、换世界、接口挂掉时的回退
```

两个脚本都会打印逐条断言，最后输出「全部通过」。

---

## 常见问题

**登录提示「用户名或密码不正确」**
先确认密码；部分账号需要用注册邮箱登录。若提示 403 则是被 Cloudflare 拦截，换网络或开代理。

**好友列表一直是空的**
看顶部黄色提示条。常见原因：网络超时、账号好友确实为空、或短时间请求过多被限流（等几分钟会自动恢复）。

**好友明明下线了，还显示在线？**
在线状态取的是 VRChat 自己的在线列表，所以和网页端一致。仍可能有延迟：① 对方客户端异常退出，
VRChat 要过一两分钟才判定离线（这时网页端也显示在线）；② 本程序每 60 秒拉一次列表。
鼠标悬停卡片右下角可以看到详情更新时间。

**世界名显示「未知世界」**
该世界已删除或不可见（接口 404），属正常现象。

**端口被占用**
`set PORT=9000 && node server.js`（PowerShell：`$env:PORT=9000; node server.js`）。

---

## 免责声明

仅供个人学习与自用。它只能读取**你账号本来就有权限看到**的好友信息（和你打开 VRChat 网页端看到的一致）。
请勿用于骚扰、跟踪他人，也不要公开部署。使用第三方 API 客户端可能涉及 VRChat 服务条款，风险自担。
