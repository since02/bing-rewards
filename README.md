# Microsoft Rewards 自动化 · Docker 完整项目

基于三个开源项目整合的一键 Docker 方案，自动完成 Microsoft Rewards 各项任务赚取积分，
并自带**后台面板**、**多账户管理**、**每日运行日志**与**多渠道推送**（含钉钉）。

| 组件 | 来源 | 作用 |
| --- | --- | --- |
| 机器人 bot | [chiihero/Microsoft-Rewards-Script](https://github.com/chiihero/Microsoft-Rewards-Script) `V4-china` | 自动做任务（搜索/每日集/打卡/签到/阅读等），内置 Control API |
| 面板 dashboard | 本项目**自研中文面板**（`dashboard/`，零依赖 Node） | 概览 / 运行控制 / 账户管理 / 运行记录 / 实时日志 / 调度 / 推送 / 会话登录 / 诊断 |
| 原始上游 | [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) `v4` | 本项目的上游架构基础 |

> 两个镜像都**固定到具体 commit 构建**，避免上游漂移导致某天突然跑不起来。
> 钉钉通知为**内置补丁**（上游原生不支持），通过环境变量启用，不改动上游逻辑。

---

## 目录

| | |
| --- | --- |
| 一、[特性](#一特性) | 十、[日志与每日运行情况](#十日志与每日运行情况) |
| 二、[架构](#二架构) | 十一、[调度](#十一调度) |
| 三、[目录结构](#三目录结构) | 十二、[备份与恢复](#十二备份与恢复) |
| 四、[准备工作](#四准备工作) | 十三、[常见问题](#十三常见问题) |
| 五、[快速开始](#五快速开始5-步) | 十四、[安全与免责声明](#十四安全与免责声明) |
| 六、[手动登录（2FA 必看）](#六手动登录docker-内2fa-账号必看) | 十五、[部署自检](#十五部署自检推荐先跑一遍) |
| 七、[多账户](#七多账户) | 十六、[已知坑](#十六已知坑自检也覆盖的版本) |
| 八、[推送配置](#八推送配置) | 十七、[面板排错手册](#十七面板排错手册打不开--空白) |
| 九、[面板使用](#九面板使用httplocalhost8890) | 十八、[目录补充说明](#十八目录补充说明) |
| | 十九、[部署到 Linux 服务器](#十九部署到-linux-服务器debian--ubuntu) · 二十、[上游与更新](#二十与上游的关系--更新维护) · 二十一、[许可](#二十一许可) |

> **只想快速跑起来** → 看第五章；**要挂云服务器** → 看第五章 + 第十九章（或直接用
> `scripts/first-run.sh` 一条命令）；**面板打不开/空白** → 直接跳第十七章。

---

## 一、特性

- ✅ **全任务覆盖**：桌面搜索、移动搜索、每日集（Daily Set）、更多促销（More Promotions）、
  打卡（Punch Cards）、App 活动、每日签到、阅读赚取（Read-to-Earn）、搜索加成 perk 等。
- ✅ **多账户**：`.env` 里按 `ACCOUNT_N_*` 添加任意数量账号，编号不要求连续。
- ✅ **后台面板**：浏览器打开 `http://<本机IP>:8890`，可视化看所有账户积分、趋势、运行状态。
- ✅ **每日日志与运行记录**：面板内「日志 / 运行」标签页按天查看；日志同时落盘 `data/bot/logs`。
- ✅ **推送通知**：原生支持 PushPlus（微信，**默认开**）、Server酱、Telegram、Discord、ntfy，
  并**内置钉钉补丁（默认开）**；跑完自动推送摘要（内置过滤，不会刷屏）。
- ✅ **Docker 内手动登录**：开启 2FA / Authenticator 的账号，可用 noVNC 在浏览器里可视化完成登录，
  自动保存会话，无需盯着日志等验证码。
- ✅ **调度**：容器内 cron 每日定时跑，也可用面板「调度」标签页可视化定制。
- ✅ **持久化**：登录会话（cookie/指纹）、配置、日志、面板数据库全部挂载在 `./data`，重建容器不丢。
- ✅ **国内优化**：默认走中国热搜源（gmya.net 聚合百度/头条/抖音/微博/知乎）+ 本地词库，无需代理。

---

## 二、架构

```
                         ┌──────────────────────────────────────────┐
   浏览器 ──8890──▶      │  rewards-dashboard  (面板)                │
                         │  - 账户/积分/趋势  - 实时日志(SSE)         │
                         │  - 运行历史/调度/配置/诊断                 │
                         └───────────────┬──────────────────────────┘
                                         │  HTTP + Bearer(API_TOKEN)
                                         │  Control API  :3010
                         ┌───────────────▼──────────────────────────┐
                         │  microsoft-rewards-script (机器人)        │
                         │  - 调度 cron / 或 API 触发                │
                         │  - Patchright 无头 Chromium 做任务         │
                         │  - 登录会话/配置/日志 挂载 ./data          │
                         └───────────────────────────────────────────┘

   持久化目录 ./data
     ├── bot/config    自动生成的 config.json（任务开关等）
     ├── bot/sessions  登录 cookie / 浏览器指纹（丢了这个要重新登录！）
     ├── bot/logs      按天分文件的运行日志
     └── dashboard     history.json（积分趋势快照）
```

两个服务在同一个 Docker 网络 `rewards` 内，面板用服务名 `microsoft-rewards-script:3010`
访问机器人的 Control API，无需暴露到公网。

---

## 三、目录结构

```
rewards/
├── docker-compose.yml     # 统一编排（bot + dashboard + 共享网络）
├── .env.example           # 账号 / 密钥 / 推送令牌 模板
├── bot/
│   ├── Dockerfile         # 构建 chiihero V4-china（固定 commit）
│   ├── patches/           # 钉钉补丁：DingTalk.ts + apply_patch.mjs
│   └── scripts/docker/manual-login.sh  # 容器侧手动登录封装（noVNC）
├── dashboard/             # 自研中文面板（零依赖 Node，全部源码随项目走）
│   ├── Dockerfile
│   ├── server.js          # Control API 代理 + SSE 转发 + 账户/钉钉写 .env + docker 集成
│   ├── lib/dockerSocket.js# 经 docker.sock 调 Docker HTTP API（重启容器 / 拉起登录容器）
│   ├── package.json
│   └── public/            # index.html / app.js（中文标签页）/ style.css
├── scripts/
│   ├── first-run.sh       # ★ 一键首装：装 Docker(缺时) / 修换行 / 生成 .env / 放行端口 /
│   │                      #   引导填账号 / 修属主 / 自检 / 后台构建，全程后台跑不受 SSH 断开影响
│   ├── setup.sh           # 首次初始化：生成 .env、补 API_TOKEN 与面板密码、建目录
│   ├── up.sh              # 构建并拉起（支持 --no-build 快速重启）
│   ├── doctor.sh          # 部署自检（只读，9 段，随时可跑）
│   ├── logs.sh            # 实时日志
│   ├── backup.sh          # 备份 sessions/config（含 restore）
│   ├── manual-login.sh    # 本机一键手动登录（启动 noVNC 容器）
│   └── deploy-ssh.sh      # 一键传到 SSH 服务器并远程执行（rsync/tar 双通道）
├── docs/
│   ├── DEPLOY-SSH.md          # ★ SSH 服务器分步部署手册（连 SSH→开安全组→开机自启→排错表）
│   └── config-overrides.txt   # 上游 CONFIG_* 白名单（自检校验用，改配置前先看它）
├── data/                  # 持久化数据（运行时自动填充，已 gitignore）
└── _legacy/               # 历史方案（保留参考，不参与构建，可随时删除）
    ├── rewards-docker.sh  # 早期单机脚本
    └── dashboard-zh/      # 更早的自建面板原型（功能已并入 dashboard/，仅作归档）
```

> `_legacy/` 与构建、运行都无关。想让仓库更干净，直接删掉这一整个目录即可，不影响任何功能。

---

## 四、准备工作

- 安装 **Docker**（含 Docker Compose v2）与 **Git**。
- Windows 用户推荐用 **Git Bash** 或 **WSL2** 执行下面的脚本；PowerShell 亦可，把 `bash scripts/xxx.sh`
  换成对应的等价命令即可。
- 准备至少一个 Microsoft 账号（邮箱 + 密码；或仅 Authenticator 登录）。
- 如需推送：到 [pushplus.plus](https://www.pushplus.plus/) 拿 PushPlus token；或在钉钉群
  「智能群助手 → 添加机器人 → 自定义」拿到 webhook（详见第八节）。

---

## 五、快速开始（5 步）

> **只要一条命令的场景**：把整个文件夹复制到服务器后，直接跑这一条（等价于下面 5 步），
> 它会自动装 Docker（缺失时）、修换行、生成 `.env`、引导填账号、**放行 8890 端口**、
> 修属主、自检、后台构建：
>
> ```bash
> cd /opt/rewards && sudo bash scripts/first-run.sh
> ```
>
> （已有 Docker 的机器用 `bash scripts/first-run.sh --no-docker`；不耐烦交互填账号用 `--quick`）
>
> 它跑完后会直接打印**可访问的公网 IPv4 地址**（例如 `http://<你的公网IP>:8890`）。
> 注意：**云服务器上 `hostname -I` 多半返回的是内网 IP**，直接拿它拼地址必然打不开，
> 脚本已优先取公网 IP（`curl -4 api.ipify.org`），内网网段会自动提示替换。
> 脚本还会顺手检查「云安全组是否放行 8890」并给出下一步动作。

```bash
# 1) 进入项目
cd rewards

# 2) 初始化（生成 .env，自动补 API_TOKEN 与面板密码）
bash scripts/setup.sh

# 3) 编辑 .env，至少填一个账号
#    ACCOUNT_1_EMAIL=you@example.com
#    ACCOUNT_1_PASSWORD=your_password
#    （Windows 记事本/VS Code 编辑均可；密码留空=仅 Authenticator 登录）
#    同时可在 .env 填 PUSHPLUS_TOKEN / DINGTALK_WEBHOOK（见第八节，默认已启用）

# 4) 构建并启动（首次会拉取 Node/Chromium，可能需几分钟）
bash scripts/up.sh

# 5) 打开面板
#    本机：  http://localhost:8890
#    服务器：http://<公网IP>:8890   ← 看云控制台实例列表里的公网 IP，别用内网 IP / 127.0.0.1
#             地址脚本会打印在 first-run.sh 结尾
#    账号 admin / 密码见 .env 的 DASHBOARD_PASSWORD
#    弹账号密码框是正常的（Basic Auth 生效），不是故障
```

**改过 `dashboard/` 源码后（面板界面/JS）必须禁缓存重建**：

```bash
docker compose build --no-cache rewards-dashboard
docker compose up -d --force-recreate rewards-dashboard
```

> 原因：Docker 会比对 `COPY` 层的指纹，一次普通 `--build` 若命中 CACHED，
> **你改的新代码根本不会进镜像**，线上跑的还是旧代码（表现：改了没任何变化）。
> 重建之后浏览器还要按 **Ctrl+F5**（Windows）/ **Cmd+Shift+R**（macOS）强制刷新，
> 否则 `app.js` 被浏览器缓存，你看到的还是旧空白页。

常用命令：

```bash
bash scripts/doctor.sh                 # 部署自检（只读，出问题先跑它）
bash scripts/logs.sh                   # 实时看全部日志
bash scripts/logs.sh bot 500           # 只看机器人，回溯 500 行（dash 同理）
docker compose ps                      # 看容器状态（Up / Exit / healthy）
bash scripts/up.sh --no-build          # 改了 .env 后快速生效（不重新构建镜像）
bash scripts/backup.sh                 # 备份会话 + 配置 + 面板历史库
bash scripts/backup.sh restore         # 列出备份并提示恢复命令
```

> **关于 2FA / Authenticator 账号**：如果账号开启了两步验证，自动登录会卡在验证码。
> 推荐用**第六节「手动登录」**在浏览器里一次性完成登录并保存会话，之后自动运行会复用，
> 不再卡顿。也可以在 `.env` 给该账号设 `ACCOUNT_N_TOTP_SECRET`（微软安全设置里「手动输入代码」
> 拿到的密钥），脚本会自动填 6 位验证码，无需人工干预。

---

## 六、手动登录（Docker 内，2FA 账号必看）

开启两步验证的账号，自动化流程里手动批准容易错过。本项目提供**容器内的可视化登录**：
启动一个一次性容器，用 `Xvfb` 虚拟桌面 + `noVNC` 把 Chromium 画面投到本机浏览器，
你像平时一样在网页里完成微软登录（含 2FA / 验证码），停留在 `rewards.bing.com` 满 5 秒后
脚本**自动保存会话并退出**。会话与自动运行共用，落盘到 `data/bot/sessions`。

前提：目标邮箱必须已在 `.env` 配置为某个 `ACCOUNT_N_EMAIL`。

**最省事的方式**：直接打开面板 http://<服务器IP>:8890 →「**会话与登录**」页，
填目标邮箱、选范围（桌面/移动/两者），点「启动手动登录」，面板会自动拉起 noVNC 容器
并把访问地址显示出来（服务器上无桌面时，配合本节末尾的 SSH 转发即可在浏览器里操作）。
用面板触发的前提是面板已挂载 `docker.sock` 与 `.env`（`docker-compose.yml` 已配好）。

命令行等价物：

```bash
# 启动手动登录（默认 both = 桌面+移动 两个会话都建）
bash scripts/manual-login.sh you@example.com both

# 也可只建某一个平台
bash scripts/manual-login.sh you@example.com mobile
bash scripts/manual-login.sh you@example.com desktop

# 会话异常时重登：丢弃旧 cookie（指纹仍复用）
bash scripts/manual-login.sh you@example.com both --fresh
```

> 会话保存为 `data/bot/sessions` 下的 **SQLite**（不是单个 cookie 文件），
> 与自动运行共用；脚本会在检测到页面停留在 `rewards.bing.com` 满 5 秒后自动保存并退出。
>
> **跑在 Linux 服务器上时**（服务器无桌面），登录容器只监听容器内的 `127.0.0.1:7900`，
> 需要用 **SSH 端口转发**把画面引到你的本地浏览器：
> ```bash
> # 本机（保持这个终端开着）
> ssh -N -L 7900:127.0.0.1:7900 user@server
> # 服务器另开一个终端
> bash scripts/manual-login.sh you@example.com both
> # 然后本机浏览器打开 http://localhost:7900/vnc.html
> ```

执行后按提示操作：

1. 脚本会在本机映射 `7900` 端口并启动 noVNC。
2. 用**本机浏览器**打开 `http://localhost:7900/vnc.html`（若打不开，试 `http://localhost:7900/` 并在页面里填 `ws://localhost:7900/websockify`）。
3. 在弹出的 Chromium 窗口里完成微软登录（手机批准 / 输入验证码都行）。
4. 登录成功并停留在 Rewards 页面 5 秒后，窗口关闭、容器自动退出，会话已保存。

> 安全提示：noVNC 仅监听本机 `127.0.0.1:7900`，不要在公网暴露该端口。
> 登录完成后容器即退出，端口随之释放。

---

## 七、多账户

在 `.env` 里每个账号加一组 `ACCOUNT_N_*`（`N` 为任意正整数，可跳号）：

```env
ACCOUNT_1_EMAIL=a@example.com
ACCOUNT_1_PASSWORD=xxx
ACCOUNT_1_LANG_CODE=zh-CN
ACCOUNT_1_GEO_LOCALE=CN

ACCOUNT_2_EMAIL=b@example.com
ACCOUNT_2_PASSWORD=yyy
ACCOUNT_2_LANG_CODE=en
ACCOUNT_2_GEO_LOCALE=auto
```

改完 `.env` 后让变更生效：

```bash
docker compose up -d --build    # 或 docker compose restart
```

面板打开「**账户管理**」标签页，可直接在网页里**新增 / 修改 / 删除**账户：填邮箱密码（含可选 TOTP、
代理、地区等）点保存，面板会把 `ACCOUNT_N_*` 写回项目 `.env` 并**自动重启机器人容器**加载新账户，
不用再手动改文件再 `docker compose restart`。

> 账号字段名单取自机器人实际读取的 `ACCOUNT_N_*`（见「四、多账户与代理」）。
> 修改会重写 `.env`，因此**不要同时手工编辑 `.env`**，否则后写的会覆盖你的改动。

---

## 八、推送配置

机器人原生支持以下渠道，跑完自动推送当日积分摘要。**PushPlus 与钉钉默认已开启**，
只需在 `.env` 填对应的令牌即可，无需改 `docker-compose.yml`。

1. 在 `.env` 填对应的令牌变量（钉钉/PushPlus 已在 compose 默认启用）。
2. 其它渠道（Server酱 / Telegram / Discord / ntfy）在 `docker-compose.yml` 取消对应注释并填令牌。
3. `docker compose up -d --build` 生效。

| 渠道 | 适用 | `.env` 变量 | 说明 |
| --- | --- | --- | --- |
| **PushPlus** | 国内微信 | `PUSHPLUS_TOKEN` | 默认开启；[pushplus.plus](https://www.pushplus.plus/) 拿 token，留空不发送 |
| **钉钉** | 国内办公 | `DINGTALK_WEBHOOK` | 默认开启（内置补丁）；群机器人完整 URL 或仅 access_token |
| **Server酱** | 国内微信 | `SERVERCHAN_SENDKEY` | Turbo 版，[sct.ftqq.com](https://sct.ftqq.com/) 微信扫码拿 SendKey |
| **Telegram** | 全球 | `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` | 对应 compose 的 `CONFIG_TELEGRAM_BOTTOKEN` / `CONFIG_TELEGRAM_CHATID` |
| **Discord** | 全球 | `DISCORD_WEBHOOK` | 对应 compose 的 `CONFIG_DISCORD_URL` |
| **ntfy** | 自建/公共 | `NTFY_URL` / `NTFY_TOPIC` | 手机装 ntfy App 订阅话题 |
| **ClawBot** | 国内微信 | `CONFIG_CLAWBOT_AUTHFILE` | 微信直连推送，凭证由扫码生成（见下表下方说明） |

> ⚠ **变量名必须一字不差**。上游只认 `docs/config-overrides.txt` 白名单里的 `CONFIG_*`，
> 拼错（例如把 `CONFIG_TELEGRAM_BOTTOKEN` 写成 `CONFIG_TELEGRAM_TOKEN`）会被**静默忽略**——
> 不报错、也不生效。`bash scripts/doctor.sh` 的第 7 段会自动帮你查这类问题。
>
> ClawBot 需先在宿主机扫码生成凭证文件，再把文件所在目录挂进容器，
> 并把 `CONFIG_CLAWBOT_AUTHFILE` 指向容器内路径（默认示例 `/usr/src/microsoft-rewards-script/config/clawbot.json`）。

钉钉额外变量（可选）：
- `DINGTALK_SECRET`：机器人开启「加签」时的签名密钥，脚本会自动带 `timestamp+sign`。
- `DINGTALK_TITLE`：消息标题前缀（默认 `Microsoft Rewards`）。
- `DINGTALK_MIN_LEVEL`：最低发送级别 `info|warn|error`（默认 `warn`）。
- `DINGTALK_KEYWORDS`：额外关键词（逗号分隔），命中即发送，用于过滤掉日常噪音。

> 钉钉默认只推送 `error` 以及含关键摘要词（完成 / SUCCESS / collected / points / 积分 / 签到 …）
> 的 `info/warn`，避免在群里刷屏；如需更详尽，把 `DINGTALK_MIN_LEVEL` 设为 `info`。

示例（钉钉，`.env`）：

```env
DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=你的token
DINGTALK_SECRET=你的加签密钥   # 若未开启加签可留空
```

---

## 九、面板使用（http://localhost:8890）

面板为**中文优先**的自研界面（不含任何英文视图），所有数据实时来自机器人 Control API：

| 标签页 | 能做什么 |
| --- | --- |
| **概览** | 运行状态/版本/运行时长、当前账户实时积分余额、每日积分趋势图 |
| **运行控制** | 「立即运行」「停止运行」，显示本次进度（已处理/总账户、本次积分） |
| **账户管理** | 新增/修改/删除账户；显示编号、语言、地区、代理、累计积分、连续成功次数、上次结果 |
| **运行记录** | 历史运行表（开始/结束/退出码/版本/共赚/每个账户明细），数据存 `data/dashboard/history.json` |
| **实时日志** | 经机器人 `/events` SSE 转发，含登录验证码提示；断线自动重连 |
| **调度** | 可视化改 Cron 与「运行中跳过」，写入 `schedule.json`（需 `API_ALLOW_SCHEDULE_WRITE=true`） |
| **推送通知** | PushPlus / Server酱 / Telegram / Discord / ntfy 写 `config.json`；钉钉单独一项，保存后自动重启机器人 |
| **会话与登录** | 手动登录（2FA 账号，拉起 noVNC 容器）+ 查看/清除已保存会话 |
| **机器人配置** | 直接编辑 `config.json`，只提交改动的字段（需 `API_ALLOW_CONFIG_WRITE=true`） |
| **诊断** | 出错时的截图 / 错误文本 / 页面 dump（需 `CONFIG_ERROR_DIAGNOSTICS=true`） |

面板依赖两个挂载才能发挥完整能力，缺了会相应功能不可用（`bash scripts/doctor.sh` 第 8 段会检查）：

- `/var/run/docker.sock` → 账户增删、手动登录容器、重启机器人
- `.env` → 账号与钉钉配置的回写路径（`ENV_FILE=/shared/env/.env`）

> ⚠ **安全**：能操作 `docker.sock` 等于能控制整台机器上的所有容器，所以
> ① 必须设置 `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`（setup.sh 已自动生成随机密码）；
> ② 8890 只暴露到可信网络，公网用 SSH 隧道或反代带 HTTPS + 二次认证，切勿裸奔。

---

## 十、日志与每日运行情况

- **面板内查看**：「实时日志」标签页是实时流；「运行记录」标签页看每次运行的明细（开始/结束/退出码/各账户积分）。
  面板自己还会在轮询时按天记一份积分余额快照到 `data/dashboard/history.json`，用于「概览」的趋势图。
- **直接看落盘日志**：`data/bot/logs/` 下按天分文件，可直接下载或 `bash scripts/logs.sh` 实时跟踪。
- **时区**：日志按天滚动、积分按天分桶都依赖 `TZ`，请确认 `docker-compose.yml` 里 `TZ` 设为你所在时区（默认 `Asia/Shanghai`）。

---

## 十一、调度

- 默认由 bot 容器内 cron 按 `CRON_SCHEDULE`（默认每天 `0 9 * * *`，容器时区）运行；`RUN_ON_START=true`
  让容器启动后立即跑一次。
- **触发后不会立刻开跑**：`run_daily.sh` 会先在 `MIN_SLEEP_MINUTES`~`MAX_SLEEP_MINUTES`
  （compose 默认 5~30 分钟）之间随机等待再执行，这是防风控设计。
  想「到点立刻跑」就把这两个值都设为 `0`，或设 `SKIP_RANDOM_SLEEP=true`（仅调试用）。
- 单次运行超过 `STUCK_PROCESS_TIMEOUT_HOURS`（默认 8 小时）会被判定卡死并自动终止，
  避免进程挂起一直占着锁、导致后续调度全部跳过。
- 想在面板里可视化改调度：确保 bot 的 `API_ALLOW_SCHEDULE_WRITE=true`（已默认开），到面板
  「调度 Schedule」标签页设置即可，结果存 `data/bot/config/schedule.json`，删除它即回退到 `CRON_SCHEDULE`。

---

## 十二、备份与恢复

登录会话（`data/bot/sessions`）丢了就要重新走一遍登录+2FA，面板的趋势快照（`data/dashboard/history.json`）
丢了积分曲线就再也补不回来，**两者都建议定期备份**：

```bash
bash scripts/backup.sh                 # 打包 sessions + config + dashboard 到 backups/，保留最近 10 个
bash scripts/backup.sh restore         # 列出最近备份并提示恢复命令
bash scripts/backup.sh restore backups/rewards-backup-20261004-090000.tar.gz
```

脚本内置 `restore` 子命令：恢复前会自动把当前状态另存一份 `pre-restore-*.tar.gz`（防误操作不可逆）。
恢复流程：先 `docker compose down` → 执行 restore → 再 `docker compose up -d`。

---

## 十三、常见问题

**Q：登录失败 / 每次都要重新登录？**
开启 2FA 的账号请先用**第六节手动登录**一次性保存会话；多备份 `data/bot/sessions`。
也可用面板「诊断」或 `bash scripts/logs.sh` 排查。

**Q：手动登录打不开 noVNC 页面？**
确认容器在运行（`docker ps` 里有 `ms-rewards-manual-login`）；本机访问 `http://localhost:7900/vnc.html`。
若提示连接失败，试 `http://localhost:7900/` 进入 noVNC 后手动填 `ws://localhost:7900/websockify`。

**Q：钉钉没收到消息？**
检查 `.env` 的 `DINGTALK_WEBHOOK` 是否填了完整 URL（或仅 access_token）；开启了「加签」必须同时填
`DINGTALK_SECRET`；默认 `DINGTALK_MIN_LEVEL=warn`，普通信息不推送，可临时调成 `info` 验证。

**Q：国内热搜被限流 403？**
到 [gmya.net](https://gmya.net) 申请 appkey，在 `.env` 设 `CHINA_API_APPKEY=xxx` 并在
compose 取消 `CONFIG_CHINA_API_APPKEY` 注释，解除免费档限流。

**Q：面板打不开 / 一直转圈？**
检查面板容器日志 `docker compose logs rewards-dashboard`；确认 `CONTROL_API_URL` 指向
`microsoft-rewards-script:3010` 且两容器在同一 `rewards` 网络；确认 `API_TOKEN` 与
`CONTROL_API_TOKEN` 一致。

**Q：改了 `.env` / 推送配置不生效？**
改完 `.env` 或 `docker-compose.yml` 后必须 `docker compose up -d --build`（重建镜像/重读变量）。

**Q：需要手机 Authenticator 批准，但批准出现在运行后段错过？**
在 `.env` 给该账号设 `ACCOUNT_N_TOTP_SECRET=`（微软安全设置里「手动输入代码」拿到的密钥），
脚本会自动生成并填入 6 位验证码，无需人工干预；或用第六节手动登录一次性保存会话。

**Q：到点了却没开始跑？**
这是正常的：`run_daily.sh` 触发后会先随机等待 `MIN_SLEEP_MINUTES`~`MAX_SLEEP_MINUTES`（默认 5~30 分钟）。
把两个值设为 `0` 即可到点立刻跑。另外 `RUN_ON_START=true` 只在容器**启动**时触发一次，重启容器才会再跑。

**Q：浏览器动不动崩 / 报 "Page crashed"？**
容器默认只有 64MB `/dev/shm`。compose 已设 `shm_size: '1gb'`，若仍不够可调大到 `2gb`。

**Q：推送配了但收不到，也没报错？**
先跑 `bash scripts/doctor.sh` 看第 7 段——`CONFIG_*` 变量名拼错会被上游**静默忽略**。
再确认面板「**推送通知**」页里对应渠道 enabled 已为 true（PushPlus/钉钉存 `.env`，其余存 `config.json`）。

**Q：想完全离线/不依赖 ghcr？**
本项目两镜像均由源码**现场构建**（固定 commit），不依赖任何第三方镜像仓库，适合国内网络。

---

## 十四、安全与免责声明

- `.env` 含账号密码与密钥，**切勿提交到公开仓库**（已加入 `.gitignore`）。
- 面板建议设置 `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`（已默认生成密码）并仅在可信网络暴露 8890。
- 手动登录的 noVNC 仅监听本机 `127.0.0.1:7900`，切勿在公网暴露该端口。
- **风险自负**：自动化脚本可能导致 Microsoft Rewards 账号被限制或封禁；本项目仅供学习研究，
  作者对由此产生的任何后果不承担责任。

---

## 十五、部署自检（推荐先跑一遍）

任何时候怀疑「配置不对 / 面板打不开 / 机器人没跑」，先跑自检：

```bash
bash scripts/doctor.sh
```

它会依次检查 **9 段**：

| 段 | 检查内容 |
| --- | --- |
| 1/9 | 依赖环境：`docker` / `docker compose` / daemon 是否可用 |
| 2/9 | 换行符（CRLF→LF 提醒，Windows 拷贝过去常见的坑） |
| 3/9 | 配置文件：`.env` 存在、`API_TOKEN` / `DASHBOARD_PASSWORD` / 钉钉变量是否齐全 |
| 4/9 | 账号是否至少填了一个 |
| 5/9 | 数据目录、目录属主、常见坑（`config.json is a directory` 等） |
| 6/9 | 容器运行状态与健康检查 |
| 7/9 | Control API / 面板端口连通性，并校验全部 `CONFIG_*` 变量是否在白名单内 |
| 8/9 | 面板与 Docker 集成 + **响应头 ASCII 静态扫描** |
| 9/9 | **对外访问可达性**：面板监听地址是 `0.0.0.0` 还是 `127.0.0.1`、公网 IPv4、浏览器该敲哪个地址 |

最后给出 `✅ 通过 / 🟡 警告 / ❌ 失败` 计数。脚本**只读不改**，可随时重复执行。

其中第 8 段的**响应头 ASCII 扫描**是硬性防复发检查：Node 的响应头只接受 ASCII，
一旦有人在 `WWW-Authenticate` 之类的头里写了中文（例如 `realm="Rewards 面板"`），
会直接抛 `ERR_INVALID_CHAR` **打死整个面板进程**（详见第十七节「面板排错手册」）。自检会在构建前就把它揪出来。

第 9 段专门覆盖「服务明明 healthy、外网却打不开」这一类问题。

有 ❌ 时脚本以非零码退出，按提示修完再 `bash scripts/up.sh` 即可。

---

## 十六、已知坑（自检也覆盖的版本）

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 面板积分曲线空、重建容器后丢失 | 面板默认把数据写到镜像内的 `../data` | 必须显式 `DATA_DIR=/data`（compose 与 `dashboard/Dockerfile` 均已设置，**不要删**） |
| 实时日志一片空白、没有任何输出 | 机器人 SSE 发的是**具名事件**（`event: log`），用 `onmessage` 收不到 | 面板前端已改用 `addEventListener("log")`；若你自己改过前端，别再退回 `onmessage` |
| 面板里手动登录完，下次运行还是要求登录 | 登录容器挂到了另一个（空的）会话目录 | `PANEL_SESSIONS_BIND` 必须指向与机器人相同的 `./data/bot/sessions`；面板已内置无效路径自动回退 |
| 面板报错「读取 .env 失败」/ 保存账户无效 | `.env` 没挂进面板容器，或挂载成只读后还想回写 | 面板同时挂 `.env` 与 `docker.sock`：前者让「账户管理 / 钉钉」可回写，后者用于重启容器 |
| 手动登录容器起不来 | 手动登录镜像与机器人镜像不是同一个 | `PANEL_MANUAL_LOGIN_IMAGE` 必须与 bot 的 `image` 一致（doctor 第 8 段会校验） |
| bot 容器状态一直是 unhealthy | `scripts/docker/healthcheck.sh` 是 shell 脚本 | healthcheck 必须写成 `sh …/healthcheck.sh`；写成 `node …/healthcheck.sh` 会因语法错误永远失败 |
| bot 启动即退出，日志报 `config.json is a directory` | Docker 自动创建了空的 `config/` 目录 | `rmdir data/bot/config/config.json` 后重启；`setup.sh` / `doctor.sh` 会主动检测 |
| Windows 手动登录挂载报错或挂载为空目录 | Git Bash 的 `$PWD` 是 `/e/...` MSYS 路径 | `scripts/manual-login.sh` 已用 `cygpath` 自动转换为 Windows 路径 |
| noVNC 端口打不开 | 端口被上次登录占用或未正确映射 | 确认本机 7900 空闲，且容器已启动（`docker ps`） |
| 容器一直 `healthy` 却完全打不开面板 | 面板响应头含中文 → `ERR_INVALID_CHAR`。healthcheck 带 Authorization 不走 401 分支，所以永远显示 healthy | 见第十七节第 1 条 |
| 面板能看到"已连接 / 机器人版本"，但**标签页和内容区一片空白** | `VIEWS` 数组里装的是视图**工厂函数**本身，漏了 `.map(f => f())` → `v.id` 全是 `undefined` | 见第十七节第 2 条 |
| 改了 `dashboard/` 却毫无变化 | `COPY` 层命中 CACHED，新代码没进镜像 | `--no-cache` 重建 + 浏览器 Ctrl+F5 |
| 复制粘贴脚本后报 `$/\_` 之类怪错 | Windows 换行符（CRLF） | `sed -i 's/\r$//' scripts/*.sh && chmod +x scripts/*.sh` |
| `first-run.sh` 结尾给的面板地址打不开 | 拿到的是**内网 IP**（`hostname -I` 在云服务器上常见）或 **IPv6** | 必须用云控制台的公网 IPv4；脚本已改优先取公网 IP 并过滤 IPv6 |
| 浏览器转圈、但本机 `curl 127.0.0.1:8890` 正常 | 云安全组没放行 8890；或浏览器开了系统代理把 `IP:8890` 也代理走了 | 控制台加入站 `TCP 8890`；代理软件绕过里加 `localhost;127.0.0.1;<服务器IP>` |

> 上面这些都不是"玄学"，是有明确根因、已修并写进自检的。第十七节给了逐条验证命令。

---

## 十七、面板排错手册（打不开 / 空白）

按编号对应上面"已知坑"的后 7 行。每一步都给了**可直接复制的命令**，按顺序跑即可定位。

### 1. 容器 healthy 却完全打不开

链路是：容器显示 healthy → 你在浏览器访问 → **面板进程当场崩掉** → 容器 Restarting →
docker-proxy 仍占着端口但后端已死 → 宿主机 `curl 127.0.0.1:8890` 返回 `000`。

```bash
# ① 到底是不是进程死了
docker compose ps
docker compose logs rewards-dashboard --tail=50

# ② 如果看到 ERR_INVALID_CHAR / WWW-Authenticate  ⇒ 第 1 条根因
# ③ 容器内视角（健康与不健康都该有响应，000 说明进程已不在）
docker exec rewards-dashboard sh -c "curl -s -o /dev/null -w 'in=%{http_code}' http://127.0.0.1:8890/api/health"
```

**根因**：Node 的响应头只接受 ASCII。`requireAuth()` 里若写成

```js
"WWW-Authenticate": 'Basic realm="Rewards 面板"'   // ❌ "面"字 → ERR_INVALID_CHAR
```

`storeHeader()` 会直接抛错。而它位于 `http.createServer` 的 `'request'` **同步回调**里、
异常无人接 → **每被访问一次就死一次**。
本项目已修：`realm` 固定为纯 ASCII `'Basic realm="Rewards Dashboard"'`，且
`requireAuth()` 与整个请求回调都加了 `try/catch`，任何同步抛错最多断当前连接、面板继续服务。

**改了代码必须禁缓存重建**（否则你改的根本不进镜像）：

```bash
docker compose build --no-cache rewards-dashboard
docker compose up -d --force-recreate rewards-dashboard
docker compose logs rewards-dashboard --tail=20 --follow   # 另开窗口，然后浏览器访问一次
```

### 2. 面板"已连接"但内容空白

这是**前端渲染层**的问题，跟网络、后端都无关：
状态徽章/footer 由独立的 `renderStatus()` 更新，跟标签页渲染完全没关系，
所以"看起来连上了"，实际内容区一个字都没有。

```bash
# 前端控制台按 F12 → Console，看有没有红色报错
docker compose logs rewards-dashboard --tail=30   # 后端日志一般干净（因为崩在浏览器侧）
```

**根因**：10 个视图（概览/运行控制/…）都是**工厂函数**——必须调用才返回视图对象：

```js
function overview() {
  let root = null;
  return { id: "overview", label: "概览", mount(panel) {...}, async refresh() {...} };
}
```

如果数组里装的是**函数本身**而不是调用结果：

```js
const VIEWS = [overview, controlsView, ...];        // ❌ v.id 全是 undefined
const VIEWS = [overview, ...].map((f) => f());      // ✅ 正确：调用工厂函数
```

漏掉 `.map()` → `v.id` / `v.label` 全为 `undefined` → 渲染出 `id="tab-btn-undefined"`、
按钮文字空 → `activate()` 里所有 id 互相覆盖 → 抛错中断，**整页空白**。
本项目已修，并给 `activate()` 加了防护（视图找不到直接 return、DOM 查询判空、
`mount()` 包 try/catch 后在面板内显示中文错误，不再整页空白）。

**修完后浏览器要按 Ctrl+F5**（`app.js` 被浏览器缓存，普通刷新还是旧页）。

### 3~7. 其他几类

```bash
# 3) 确认服务器跑的是不是最新代码
grep -n 'realm=' dashboard/server.js      # 必须是 Rewards Dashboard（ASCII）
grep -n '].map((makeView) => makeView())' dashboard/public/app.js   # 必须存在

# 4) Windows 换行符污染
sed -i 's/\r$//' scripts/*.sh bot/scripts/docker/*.sh && chmod +x scripts/*.sh

# 5) 面板地址到底该填什么
curl -4 -s --max-time 5 https://api.ipify.org        # 公网 IPv4（这才是浏览器要敲的）
hostname -I                                          # 云服务器上多半是内网 IP，别用

# 6) 端口是否真的在监听 / 有没有被防火墙拦（Debian 常见是 nftables 而非 ufw）
ss -tlnp | grep 8890
(nft list ruleset || iptables -L -n) 2>/dev/null | grep 8890
curl -4 -s --noproxy '*' -o /dev/null -w 'local=%{http_code}\n' http://127.0.0.1:8890/api/health
#   期望 200 / 401；000 = 进程真死了；加了 --noproxy 有响应而原命令没有 = 代理假象

# 7) 外网还转圈，但上面本机全是 200/401 => 只剩云安全组
#    云控制台 → 安全组 → 入站规则 → 添加 TCP 8890（来源先填你自己的 IP 更稳）
```

> **最后一条兜底（绕开一切安全组 / 代理问题）**：在自己电脑上做 SSH 端口转发，
> 然后访问 `http://localhost:8890`：

```bash
ssh -N -L 8890:127.0.0.1:8890 user@<服务器公网IP>
```

---

## 十八、目录补充说明

- `dashboard/` 是**本项目自研的中文面板**，源码随项目走（`server.js` + `lib/` + `public/`），
  零 npm 依赖（只用 Node 内置模块），构建时直接 `COPY` 本地源码，**不再克隆任何上游仓库**。
  想改界面/加字段，直接改这几个文件 + `docker compose up -d --build` 即可。
- `_legacy/dashboard-zh/` 是更早的自建面板原型；其功能已全部并入 `dashboard/`，
  仅作归档保留，不参与构建、也不再维护。
- 面板**只依赖机器人的 Control API**（HTTP + `events` SSE），不碰机器人内部文件，
  因此上游 chiihero 升级时，只要 Control API 的字段名不变，面板无需改动。

---

## 十九、部署到 Linux 服务器（Debian / Ubuntu）

第五节是「本机快速开始」。要长期挂在云服务器/NAS 上，按本章来。

> 📘 **要一份能照着敲的分步手册，直接看 [`docs/DEPLOY-SSH.md`](docs/DEPLOY-SSH.md)**——
> 从连 SSH、装 Docker、传源码、填账号、构建启动、放行端口（含云安全组）、
> 手动登录隧道、开机自启到排错表，一步步都给了可直接复制的命令。
> 本章是精简版；两者以 `docs/DEPLOY-SSH.md` 为准。

### 1. 安装 Docker 与 Compose（Debian 11/12、Ubuntu 20.04+）

```bash
sudo apt update
sudo apt install -y ca-certificates curl git ufw
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
| sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"      # 之后重新登录 SSH，docker 命令才可免 sudo
docker compose version               # 确认输出 v2.x
```

> 装完务必重新登录一次（或 `newgrp docker`），否则 `docker compose` 会报权限不足。

### 2. 把项目弄上服务器（三选一）

| 方式 | 命令 |
|---|---|
| A. 服务器能连 GitHub（最省事） | `git clone <你的仓库> rewards && cd rewards` |
| B. 从 Windows 推送 | 本机 Git Bash：`cd <本地仓库目录> && scp -r ./* user@server:/opt/rewards/`（换成你自己的本地路径） |
| C. 同步工具（Rclone/Syncthing…） | 只同步下面「上传清单」的文件 |

**上传清单（只需这些，别把无关目录带上）**

```
rewards/
├── docker-compose.yml
├── .env.example              # setup.sh 会据此生成 .env
├── README.md
├── bot/    Dockerfile  .dockerignore  patches/  scripts/docker/manual-login.sh
├── dashboard/  Dockerfile  .dockerignore     # ⚠ 面板是自研源码，必须完整上传
├── LICENSE                    # MIT 许可（开源仓库建议带上）
├── docs/   DEPLOY-SSH.md  config-overrides.txt
└── scripts/  setup.sh  up.sh  logs.sh  doctor.sh  backup.sh
              manual-login.sh  deploy-ssh.sh  first-run.sh
              push-github.sh   # 把本仓库推到 GitHub（仓库不存在会自动建）
```

> 💡 **已有 GitHub 仓库、想同步上去**：在项目根目录跑
> `bash scripts/push-github.sh [--private]`，它会自动找 token（`gh auth login`
> 或 `GITHUB_TOKEN`）、仓库不存在就创建、推完把带 token 的 remote 立刻删掉不落盘。
> 仓库归属可用 `REPO_NAME=` / `REPO_OWNER=` 环境变量覆盖。

> 💡 **懒人路线**：本机（Git Bash）在项目根目录直接跑
> `bash scripts/deploy-ssh.sh user@server /opt/rewards`，
> 它会自动rsync上传 → 远程 setup → doctor → 后台构建，你只需在服务器上 `nano .env` 填账号。

> ⚠ 不要上传：`_legacy/`（历史归档）、`data/`、`backups/`、`.env`（由 `setup.sh` 生成）。
> 注意 `dashboard/` **要完整上传**——面板源码是本项目自研的，不再从 GitHub 克隆。
> 放到 `/opt/rewards` 这类**非 root 用户可写**的目录，避免 `data/` 出现 root:root 导致容器写不进去。

### 3. 初始化并填账号

```bash
cd /opt/rewards
bash scripts/setup.sh              # 生成 .env + 补 API_TOKEN/面板密码 + 建目录 + 端口预检
nano .env                          # 至少填一组 ACCOUNT_N_EMAIL/_PASSWORD，可顺手填推送令牌
```

### 4. 自检 → 构建 → 启动

```bash
bash scripts/doctor.sh             # 有问题先修（尤其第 7 段 CONFIG_* 校验）
bash scripts/up.sh                 # 首次构建 5~15 分钟（拉 Node + 下载 Chromium，镜像较大）
docker compose ps                  # 期望：两个容器都是 Up（bot 最终 healthy）
```

> 若 SSH 会定时断连，用后台构建避免被掐断（日志在 `/tmp/rewards-build.log`）：
> ```bash
> nohup bash -c 'docker compose up -d --build > /tmp/rewards-build.log 2>&1; echo BUILD_RC=$? >> /tmp/rewards-build.log' >/dev/null 2>&1 &
> tail -f /tmp/rewards-build.log     # 另开窗口盯进度，看到 BUILD_RC=0 才是真成功
> ```

### 5. 面板访问与防火墙

```bash
sudo ufw allow 8890/tcp
```
浏览器打开 `http://<服务器IP>:8890`，账号 `admin`，密码见 `.env` 的 `DASHBOARD_PASSWORD`。

> 8890 直接暴露公网有风险。更稳的做法三选一：
> - 限来源 IP：`sudo ufw allow from 1.2.3.4 to any port 8890`
> - Nginx 反代 + HTTPS + 改默认端口
> - 只走 SSH 隧道：`ssh -N -L 8890:127.0.0.1:8890 user@server`，然后 `http://localhost:8890`

### 6. 服务器上的手动登录（2FA 账号）

见第六节：**必须用 SSH 端口转发**把 noVNC 引到本地浏览器（`ssh -N -L 7900:127.0.0.1:7900 user@server`），
然后在服务器上 `bash scripts/manual-login.sh you@example.com both`。
登录容器跑完自动退出，会话已落到 `data/bot/sessions`，之后自动运行会复用。

### 7. 定时备份

```bash
(crontab -l 2>/dev/null; echo "0 3 * * * cd /opt/rewards && bash scripts/backup.sh") | crontab -
```

### 8. 常用运维

| 操作 | 命令 |
|---|---|
| 容器状态 | `docker compose ps` |
| 实时日志 | `bash scripts/logs.sh`（`bot 500` 只看机器人回溯 500 行） |
| 改完 `.env` 生效 | `bash scripts/up.sh --no-build`（不重建镜像，快） |
| 改了 Dockerfile/compose | `bash scripts/up.sh --build`（或 `-d --build-only` 先编） |
| 只重启面板 | `docker compose restart rewards-dashboard` |
| 立即跑一次 | 面板「运行控制」页「立即运行」（或 `curl -X POST -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3010/start`） |
| 备份 / 恢复 | `bash scripts/backup.sh` / `bash scripts/backup.sh restore` |
| 彻底停掉 | `docker compose down`（数据在 `./data`，不会丢） |

### 9. 服务器不能直连 GitHub / npm（离线构建）

两个 Dockerfile 构建时要 `git clone` + `npm ci`，不通外网会直接失败。两条路：

**A. 本地构建好镜像 → 导出 → 上传 → 只 up 不 build**
```bash
# 本机（能上网的机器）cd rewards
docker compose build
docker save ms-rewards-bot:china ms-rewards-dashboard:latest -o rewards-images.tar
scp rewards-images.tar user@server:/opt/
# 服务器
docker load -i /opt/rewards-images.tar && cd /opt/rewards && docker compose up -d
```

**B. 给 Docker 配代理（长期更省事）**
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/proxy.conf >/dev/null <<'EOF'
[Service]
Environment="HTTP_PROXY=http://proxy_host:port"
Environment="HTTPS_PROXY=http://proxy_host:port"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
cd /opt/rewards && bash scripts/up.sh
```

### 10. 换机 / 迁移

整目录打包带走即可（含 `.env` 与 `data/`）：
```bash
tar czf rewards.tar.gz rewards/     # 在 /opt 上级目录执行
```
新机器解压 → `bash scripts/setup.sh` → `docker compose up -d --build`。

> ⚠ 浏览器指纹会绑登录环境，**换服务器后首次可能需要重新手动登录一次**（会话失效时跑第六节）。

### 11. 部署后建议立刻做的三件事

1. `bash scripts/doctor.sh` 全绿再放行（尤其确认 bot `healthy`）。
2. 用面板「账户」页确认账号都识别到了、积分有数值；没有就 `bash scripts/logs.sh` 看登录环节。
3. 首次运行后确认钉钉/PushPlus 收到摘要（没收到把 `DINGTALK_MIN_LEVEL` 临时改成 `info` 验证）。

---

## 二十、与上游的关系 / 更新维护

### 20.1 这个仓库里到底是什么

严格说，本项目**不打包上游源码**，而是「**自研外壳 + 构建时拉上游**」：

```
本仓库（壳）
├── docker-compose.yml  ── 把两个服务编排到一起、共享网络与 ./data
├── bot/Dockerfile      ── 构建期 git clone chiihero@固定commit → npm ci → 打钉钉补丁 → npm run build
├── bot/patches/        ── 钉钉补丁（不改动上游逻辑，靠环境变量开关）
├── dashboard/          ── ★ 完全自研的中文面板（零 npm 依赖，源码随仓库走）
└── scripts/ docs/      ── 初始化 / 自检 / 部署 / 备份 / 手动登录
```

好处：上游仓库再大（`node_modules`、几千行 TS）也不用进你的 Git，仓库只有几百 KB、clone 秒开。

### 20.2 更新机器人（上游 chiihero 有新 commit 时）

`bot/Dockerfile` 里把 commit 换成新的即可：

```bash
git clone https://github.com/chiihero/Microsoft-Rewards-Script
cd Microsoft-Rewards-Script && git rev-parse HEAD      # 拿到新 commit
```

然后把 `bot/Dockerfile` 里的 `git clone … && git checkout <新commit>` 改掉，重新构建：

```bash
docker compose build --no-cache microsoft-rewards-script
docker compose up -d --force-recreate microsoft-rewards-script
```

> 只该动 commit，别把 "跟随最新" 改成浮动分支——上游一次破坏性改动的代价，
> 就是你某天早上醒来发现机器人全绿但一个积分都不涨。

### 20.3 更新面板（改了 `dashboard/` 之后）

```bash
docker compose build --no-cache rewards-dashboard      # ★ 必须 --no-cache
docker compose up -d --force-recreate rewards-dashboard
```

然后浏览器 **Ctrl+F5**。忘了禁用缓存/强制刷新，你会以为"改了没生效"，实际是代码和浏览器两层缓存。

### 20.4 把改动同步回 GitHub

```bash
cd rewards
git add -A
git commit -m "更新：面板排错手册 + 自检第 9 段 + README 同步"
git push origin main          # 或你的分支名
```

> `.env`、`data/`、`backups/`、`node_modules/` 都已在 `.gitignore` 里，**不会**被提交。
> 提交前确认一次：`git status --porcelain` 里不应该出现 `.env`。

### 20.5 建议的维护节奏

- 每次改动后跑 `bash scripts/doctor.sh`，有 ❌ 先修再构建。
- 每周 `bash scripts/backup.sh` 一次（`data/bot/sessions` 丢了就要重新手动登录所有账号）。
- 上游有新 commit 时按 20.2 更新；面板改完按 20.3 重建。

---

## 二十一、许可

本项目基于 **MIT 协议**开源，详见 [`LICENSE`](./LICENSE)。

```
MIT License
Copyright (c) 2026 since02
```

**三点说明**

1. 机器人主体（`bot/`）来自上游 [chiihero/Microsoft-Rewards-Script](https://github.com/chiihero/Microsoft-Rewards-Script)，
   沿用其原协议；本项目只做了 Docker 封装与钉钉补丁（`bot/patches/`），补丁以锚点方式插入、不改动上游逻辑。
2. 本项目**不提供任何绕过微软风控、验证码或反爬机制的能力**，仅做无人值守调度与可视化。
3. 使用者需自行遵守 [Microsoft Rewards 服务条款](https://rewards.bing.com/) 与所在地区的法律法规；
   本项目不对因违规使用导致的账号封停、积分清零或任何损失负责。

---

## 附：一句话总结

装好 Docker → 复制文件夹到服务器 → `sudo bash scripts/first-run.sh` →
浏览器打开它打印的 `http://<公网IP>:8890` → 填 `admin` + `.env` 里的 `DASHBOARD_PASSWORD`。
就是这个项目全部的运行方式。

