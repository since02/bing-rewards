# 部署到 SSH 服务器（Debian / Ubuntu）· 详细流程

> 适用：你有了一台能 SSH 登录的 Linux 服务器（腾讯云 / 阿里云 / 华为云 / 自建 VPS / 群晖 Docker 主机 等）。
> 目标：在服务器上常驻运行「机器人 + 中文面板」，从外网浏览器访问 `http://<服务器IP>:8890`。
>
> 全程命令分两类：**在本机敲**（标 🖥️ 本机）和 **在服务器敲**（标 🖥️ 服务器）。
> 把示例里的 `user@server` 换成你的 SSH 地址（如 `root@1.2.3.4` 或 `ubuntu@8.8.8.8`）。

---

## 0. 部署前先确认这几件事（3 分钟，能省掉后面两小时）

| 项目 | 要求 | 怎么看 |
|---|---|---|
| 内存 | **≥ 2 GB**（建议 4 GB） | 服务器 `free -h` |
| 磁盘 | **≥ 25 GB 可用** | 服务器 `df -h /` |
| 系统 | Debian 11/12、Ubuntu 20.04/22.04/24.04 | 服务器 `cat /etc/os-release \| head -2` |
| 架构 | x86_64（arm64 也能跑，但构建更慢） | 服务器 `uname -m` |
| 出网 | 构建时要能连 **GitHub + npm**（离线方案见 §11） | 服务器 `git ls-remote https://github.com/chiihero/Microsoft-Rewards-Script V4-china \| head -1` |
| 端口 | 8890（面板）、7900（手动登录，临时） | 见 §6 |

> ⚠️ **最常被忽略的一点**：内存 < 2G 的小鸡跑 Chromium 会被 OOM 杀掉，
> 表现为「面板能打开，机器人一直 restarting」。先加 swap（§1.4）再继续。

确认 SSH 能连（如果这一步都不过，先去云控制台开 22 端口）：

```bash
# 🖥️ 本机
ssh user@server "uname -a && free -h && df -h /"
```

---

## 1. 服务器初始化

### 1.1 建一个非 root 用户（推荐，别一直用 root）

```bash
# 🖥️ 服务器（用 root 登录执行）
adduser rewards            # 按提示设密码
usermod -aG sudo rewards
```

之后本机改用新用户登录：**必须重新登录一次**（`docker` 组权限才生效）：

```bash
# 🖥️ 本机
ssh user@server            # 用新用户；若之前用 sudo docker 加了组，先 exit 再重连
# 或者不想重连，在服务器里执行（当前会话生效）：
newgrp docker
```

### 1.2 装基础工具 + 防火墙

```bash
# 🖥️ 服务器
sudo apt update
sudo apt install -y curl git ca-certificates ufw unzip
```

### 1.3 安装 Docker 与 Compose（官方源，一键）

复制整段执行（Debian 11/12、Ubuntu 20.04+ 通用）：

```bash
# 🖥️ 服务器
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
| sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

验证（**重开一个 SSH 会话**再验证，否则会报权限不足）：

```bash
# 🖥️ 服务器（新开一个终端窗口）
docker compose version          # 期望输出 v2.x
```

> 想省事也可直接 `sudo apt install -y docker.io docker-compose`，Debian 12 自带 Compose v2，能跑通，
> 但版本较旧、构建时可能踩坑，**官方源更稳**。

### 1.4 内存小的机器先加 swap（2G 内存必做）

```bash
# 🖥️ 服务器
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h        # 看到 swap 那一行有数字就成了
```

---

## 2. 把项目传到服务器

三种方式，**按你手上最顺手的一种来**。目录统一用 `/opt/rewards`（不建议放 root 家目录，
有些系统家目录有 noexec 或配额限制）。

### 方式 A：rsync（推荐，可重复执行，只传增量）

在**本机**项目根目录执行。注意 `rewards/` 后面那个 `/` 不能少，少了会在远程多套一层目录。

```bash
# 🖥️ 本机（Git Bash / Linux / macOS 都行；Windows 装了 Git 就有 rsync）
rsync -avz --delete \
  --exclude='.git' --exclude='data' --exclude='backups' \
  --exclude='_legacy' --exclude='.env' --exclude='*.tar.gz' \
  ./ user@server:/opt/rewards/
```

### 方式 B：scp（最通用，任何系统都有）

先在本机打包（用上面同一份排除清单），再传：

```bash
# 🖥️ 本机
cd ..                                   # 进到 rewards 的上一级
tar czf rewards.tar.gz \
  --exclude=.git --exclude=data --exclude=backups \
  --exclude=_legacy --exclude=.env --exclude='*.tar.gz' \
  rewards/
scp rewards.tar.gz user@server:/tmp/
rm rewards.tar.gz

# 🖥️ 服务器
sudo mkdir -p /opt/rewards && sudo chown "$USER":"$USER" /opt/rewards
tar xzf /tmp/rewards.tar.gz -C /opt && rm -f /tmp/rewards.tar.gz
```

### 方式 C：git clone（如果你想以后方便升级）

把项目代码推到自己的私有仓库（Gitee / 私有 Git / GitHub 私有仓都行），然后：

```bash
# 🖥️ 服务器
sudo git clone https://<你的仓库>.git /opt/rewards
sudo chown -R "$USER":"$USER" /opt/rewards
```

> 注意：本项目 **面板 `dashboard/` 是本地自研源码，不在任何上游仓库里**，
> 所以「用 git 同步面板」这条路不行——面板文件必须用方式 A/B 传上去。
> 简化做法：**Git 只用来管 bot/编排脚本，面板走 rsync 单独传**（或直接整体用 A/B）。

### 2.1 传完之后核对（必须做）

```bash
# 🖥️ 服务器
cd /opt/rewards
ls -la
# 期望看到：docker-compose.yml  .env.example  README.md
#           bot/  dashboard/  docs/  scripts/
find dashboard -type f | sort
# 期望 7 个文件：Dockerfile .dockerignore package.json server.js
#               lib/dockerSocket.js public/{index.html,app.js,style.css}
```

> ⚠ `dashboard/` 八个文件必须齐全——面板是自研的，**不再从 GitHub 克隆**。
> 少一个 `public/app.js` 面板就会白屏。
> 也**不要**把 `_legacy/`、`data/`、`.env` 传上去（`.env` 由 `setup.sh` 生成，历史 `data` 传上去反而容易和容器里的权限打架）。

### 2.2 修正目录属主（非常关键）

```bash
# 🖥️ 服务器
cd /opt/rewards
sudo chown -R "$USER":"$USER" /opt/rewards
```

> 不做的后果：`data/bot/sessions` 等目录变成 `root:root`，容器内用户（uid 1000 之类）**写不进去**，
> 表现为登录会话保存失败、每轮重新登录。

---

## 3. 初始化项目（生成 .env）

### 3.0 整包复制来的？直接跑这一条

如果你是把 `rewards/` **整个文件夹复制到服务器**（而不是 rsync/git 同步），往下一条命令就够了，
它串起后面第 3~6 章（生成 `.env` → 填账号 → 修属主 → 自检 → 后台构建），缺 Docker 时还会自动装：

```bash
# 🖥️ 服务器（路径换成你放的位置）
cd /opt/rewards
sudo bash scripts/first-run.sh

# 已有 Docker 的机器：跳过安装检查，快一点
bash scripts/first-run.sh --no-docker
# 不想交互式填账号（.env 已经配好了）
bash scripts/first-run.sh --no-docker --quick
```

它会按序做 7 件事：**0** 检查/安装 Docker + 内存/磁盘预警 → **1** 把 CRLF 脚本改成 LF 并补执行位
→ **2** 生成 `.env` 并补齐随机密钥 → **3** 交互式引导填第一个账号（可直接回车跳过）→ **4** `chown -R $USER` →
**5** 跑 `doctor.sh` 自检 → **6** `nohup` 后台构建并打印面板地址与登录信息。
全程幂等，中途失败再跑一次即可（`sudo bash scripts/first-run.sh`）。

> ⚠️ 第 1 步「修 CRLF」不能省：Windows 整包复制的 `.sh` 带 `\r\n`，直接执行会报
> `bad interpreter: /bin/bash^M`。`--quick` 会跳过交互式填账号，其余步骤照跑。

跑完后看构建进度：`tail -f /tmp/rewards-firstrun.log`，两个容器 `Up` 就是成了。

---

### 3.1 手动版（想知道每一步在干嘛）

```bash
# 🖥️ 服务器
cd /opt/rewards
bash scripts/setup.sh
```

它会做五件事：检查环境 → 复制 `.env.example`

> 实际动作：检查 git/docker → 从 `.env.example` 生成 `.env` → 自动生成 32 字节随机 `API_TOKEN`
> → 给 `DASHBOARD_PASSWORD` 生成随机密码 → 创建 `data/*` 目录 → 端口占用预检 → 检查有没有填账号。

### 3.2 填账号

```bash
# 🖥️ 服务器
nano .env
```

至少要填一组：

```bash
ACCOUNT_1_EMAIL=you@example.com
ACCOUNT_1_PASSWORD=你的明文密码        # 可留空：留空走「无密码登录」，按日志提示手动批准
ACCOUNT_1_LANG_CODE=zh-CN
ACCOUNT_1_GEO_LOCALE=CN
```

其他常用项：

| 想做什么 | 改 `.env` 里… |
|---|---|
| 加第二个账号 | 复制 `ACCOUNT_1_*` 那几行，把 `1` 改成 `2` |
| 账号开了 Authenticator | 填 `ACCOUNT_1_TOTP_SECRET=...`（自动填 2FA 验证码） |
| 账号开 2FA 但没 TOTP 密钥 | 密码留空，用 §8 的手动登录 |
| 多账号要防关联 | 每行前面加 `#` 注释掉，另加 `ACCOUNT_2_PROXY_URL=http://...` 等（见 README 第七节） |
| PushPlus / 钉钉推送 | `.env` 填 `PUSHPLUS_TOKEN=` / `DINGTALK_WEBHOOK=`（compose 里已默认开） |

保存退出：`Ctrl+O` → 回车 → `Ctrl+X`。（`nano` 操作；`vim` 用户自己知道怎么存。）

> 💡 `setup.sh` 已经把面板登录密码随机生成好了。随时可查：
> ```bash
> grep DASHBOARD_PASSWORD .env
> ```

---

## 4. 部署自检（跑一遍，问题在这一步暴露）

```bash
# 🖥️ 服务器
cd /opt/rewards
bash scripts/doctor.sh
```

8 段检查：依赖环境 / 配置文件 / 账号配置 / 数据目录 / 容器状态 / 服务连通性 /
`CONFIG_*` 变量名白名单 / 面板与 Docker 集成。

**看到这些就是正常的**：
- 第 3 段「检测到至少一个已启用的 ACCOUNT_N_EMAIL ✓」
- 第 7 段 `CONFIG_SEARCH_QUERY_ENGINES` 等全部命中白名单（拼错变量名会被**静默忽略**，这段必须全绿）

**看到 ❌ 按提示修**，重点几项：
- `[❌] .env 不存在` → 先跑 `bash scripts/setup.sh`
- `[❌] 未找到任何 ACCOUNT_EMAIL` → 去 §3.1 填账号
- `[❌] docker 不可用` → 回 §1.3
- `[🟡] data/bot/config/config.json 是目录` → `rmdir data/bot/config/config.json`

---

## 5. 构建并启动（首次较慢，别让 SSH 超时打断）

```bash
# 🖥️ 服务器
cd /opt/rewards
nohup bash -c 'docker compose up -d --build > /tmp/rewards-build.log 2>&1; echo "BUILD_RC=$?" >> /tmp/rewards-build.log' >/dev/null 2>&1 &
```

用 `nohup` + 后台是因为首次构建要拉基础镜像、装 Node、编译 TS、下载 **Patchright Chromium**，
通常 **5~15 分钟**。直接前台跑，中途 SSH 一断构建就黄了。

另开一个终端盯进度：

```bash
# 🖥️ 服务器（新窗口）
tail -f /tmp/rewards-build.log
```

看到 `BUILD_RC=0` 才是真成功：

```bash
# 🖥️ 服务器
grep -E "BUILD_RC=|DONE" /tmp/rewards-build.log
docker compose ps
```

期望：

```
NAME                         SERVICE                  STATUS
microsoft-rewards-script     microsoft-rewards-script  Up (healthy)      # 或 Up，等几秒转 healthy
rewards-dashboard            rewards-dashboard         Up (healthy)
```

> bot 的 `HEALTHCHECK` 确认的是 API 活着；真正把 Chromium 跑起来还要 1~2 分钟，
> `Up` 没转 `healthy` 也别急，先看 `bash scripts/logs.sh`。

### 5.1 首次构建最可能失败的三个点

| 现象 | 原因 | 处理 |
|---|---|---|
| `fatal: unable to access 'https://github.com/...'`：Could not resolve host / 超时 | 服务器连不上 GitHub | 用 §11 离线方案，**或**给 Docker 配代理 |
| 钉钉补丁报 `ANCHOR MISMATCH` | 上游 `Logger.ts` 改了，补丁锚点对不上 | 按报错里的提示改 `bot/patches/apply_patch.mjs` 的锚点，或先 `docker compose build --no-cache bot` 单服务重试 |
| `Page crashed!` / 容器反复 restarting | `/dev/shm` 太小或内存不足 | compose 已设 `shm_size:1gb` 且 §1.4 加了 swap；还不行就加内存 |

---

## 6. 放行面板端口 ★最容易被云厂商拦住的一步

**两处都要开，缺一不可**：

### 6.1 系统防火墙 ufw

```bash
# 🖥️ 服务器
sudo ufw allow 8890/tcp comment 'Rewards dashboard'
sudo ufw allow 22/tcp comment 'SSH'          # 确认 SSH 在白名单里，别把自己关外面
sudo ufw --force enable
sudo ufw status numbered                      # 确认 8890 在列
```

> 如果你之前没启用过 ufw，其实跳过也行——云安全组开就够了。但建议开，双保险。

### 6.2 云控制台安全组（**99% 的「面板打不开」是卡在这里**）

去你云厂商的控制台，找到「安全组 / 防火墙」，**入站规则**加一条：

| 协议 | 端口 | 来源 | 说明 |
|---|---|---|---|
| TCP | 8890 | 你的电脑公网 IP（最安全）或 `0.0.0.0/0`（图省事但裸奔） | 面板 |

- 腾讯云：**控制台 → 云服务器 → 实例 → 安全组 → 配置规则 → 入站规则 → 添加**
- 阿里云：**控制台 → ECS → 网络与安全 → 安全组 → 配置规则 → 添加**
- 华为云 / 火山 / Oracle / Hetzner：同样在「安全组 / Firewall」里加

### 6.3 验证端口真的通了（从本机测）

```bash
# 🖥️ 本机
curl -sS -o /dev/null -w "%{http_code}\n" http://<服务器IP>:8890
```

- 返回 `200` / `401`（401 说明 Basic Auth 生效，也很正常）→ 通了
- 返回超时 / 000 → 安全组或 ufw 没开，回去看 6.1 和 6.2

**更安全的做法（三选一，推荐第一个）**：

```bash
# ① 只给你自己的 IP 开（最稳）
sudo ufw allow from <你的本机公网IP> to any port 8890

# ② SSH 隧道，8890 完全不暴露到公网（本机执行，不碰安全组）
ssh -N -L 8890:127.0.0.1:8890 user@server
# 然后本机浏览器开 http://localhost:8890
```

> 查本机公网 IP：`curl ifconfig.me`

**浏览器侧也有坑（容易误判成「服务器没起来」）**：

- **系统代理**：你若挂了代理软件（Clash / v2ray 等），浏览器访问 `http://公网IP:8890` 会**走代理出去**，代理访问内网 IP 必然失败。
  - 关掉系统代理，或给代理加绕过规则 `localhost;127.0.0.1;<服务器IP>`（Clash：`配置 → 系统代理设置 → 绕过`)
  - 判断方法：手机流量（无代理）打开同一个地址，能开就是代理问题。
- **填错 IP**：`127.0.0.1` / `172.x` / `10.x` 这类内网 IP 在浏览器里必然打不开，
  必须是**云控制台实例列表里看到的公网 IP**。
- 打开的若是**登录框**（要填账号密码）说明服务一切正常，不是故障。

> ⚠️ 面板容器挂了 `/var/run/docker.sock`（能控制整台机器的容器），所以
> **务必设 `DASHBOARD_USERNAME` + `DASHBOARD_PASSWORD`**（`setup.sh` 已自动生成随机密码），
> 千万别让 8890 裸奔到公网。

---

## 7. 打开面板

本机浏览器访问：

```
http://<服务器IP>:8890
```

出现登录框就填：

- 用户名：`admin`（或 `.env` 里 `DASHBOARD_USERNAME`）
- 密码：`.env` 里 `DASHBOARD_PASSWORD`（`grep DASHBOARD_PASSWORD /opt/rewards/.env`）

进去之后 10 个中文标签页：概览 / 账户 / 运行 / 日志 / 调度 / 配置 / 推送 / 会话登录 / 诊断 / 备份。

**第一件事**：看「账户」页——每个账号有没有读到积分数字。
空的话看「日志」页，大概率卡在登录环节（接着看 §8）。

---

## 8. 首次登录（新账号 / 开了 2FA 的账号）

`RUN_ON_START=true` 已设好，容器起来就会**自动跑一次**。密码直接写在 `.env` 里的账号，
这一步一般就过了——面板日志会显示登录成功 + 各任务进度。

### 登录失败 / 卡在验证码 / 开了手机端二次验证 → 用手动登录

noVNC 的桌面只监听在**服务器自己**的 7900 端口，你在外网直接打不着。
所以要先做 SSH 端口转发，把服务器的 7900 映射到你本机：

**第 1 步**：本机开端口转发（保持这个窗口开着）

```bash
# 🖥️ 本机（新窗口，别关）
ssh -N -L 7900:127.0.0.1:7900 user@server
```

**第 2 步**：服务器上启动一次性登录容器

```bash
# 🖥️ 服务器
cd /opt/rewards
bash scripts/manual-login.sh you@example.com both
```

**第 3 步**：本机浏览器开 `http://localhost:7900/vnc.html`

像平时登录微软账号一样操作（含手机验证 / Authenticator 批准）。
停在 `rewards.bing.com` 页面**满 5 秒**，脚本会自动保存会话、容器自动退出。

> 如果 `.env` 里配了 `ACCOUNT_1_TOTP_SECRET`，其实不用手动登录——上游会自动填 TOTP 验证码。

---

## 9. 确认跑通

```bash
# 🖥️ 服务器
cd /opt/rewards
bash scripts/logs.sh            # 跟日志；bot 500 看机器人最近 500 行
docker compose ps               # 两个容器都要 Up
```

面板里看三处：
1. **账户**页：每个账号积分有数值 → 登录成功
2. **日志**页：实时流能看到搜索/打卡任务在动
3. **运行**页：有一行运行记录，`exit` 为 0 或者积分增量 > 0

推送（PushPlus / 钉钉默认已在 compose 里开启）：跑完一轮应该收到摘要。
没收到 → 检查 `.env` 令牌是否填了、compose 里对应渠道 enabled 是否为 true；
想立刻验证可把 `DINGTALK_MIN_LEVEL` 临时改成 `info`。

---

## 10. 长期运行的两件事：开机自启 + 定时备份

### 10.1 开机自启（服务器重启后自动拉起）

compose 里两个服务都是 `restart: unless-stopped`，**容器级自启已经有了**；
但**服务器重启后 Docker 服务会先起、容器跟着起**——这在 Docker 默认配置下是成立的，
所以通常什么都不用做。保险起见加一条 cron：

```bash
# 🖥️ 服务器
(crontab -l 2>/dev/null; echo "@reboot cd /opt/rewards && docker compose up -d") | crontab -
crontab -l     # 确认有这两行
```

### 10.2 每天 03:00 备份会话 + 面板历史

```bash
# 🖥️ 服务器
(crontab -l 2>/dev/null; echo "0 3 * * * cd /opt/rewards && bash scripts/backup.sh") | crontab -
```

> 备份必须含 `data/bot/sessions`（登录会话，丢了要重走登录+2FA）
> **和** `data/dashboard`（积分曲线，丢了补不回来）。
> 恢复：`bash scripts/backup.sh restore`（先 `docker compose down` 再恢复再 `up -d`）。

---

## 11. 服务器不能直连 GitHub / npm（离线构建）

两个 Dockerfile 构建时要 `git clone` + `npm ci`，不通外网直接失败。两条路：

### A. 本机构建好镜像 → 导出 → 上传 → 只 up 不 build

```bash
# 🖥️ 本机（能上网的机器，装了 Docker 才行）cd 到 rewards
docker compose build
docker save ms-rewards-bot:china ms-rewards-dashboard:latest -o rewards-images.tar
scp rewards-images.tar user@server:/opt/

# 🖥️ 服务器
docker load -i /opt/rewards-images.tar && rm -f /opt/rewards-images.tar
cd /opt/rewards && docker compose up -d
```

### B. 给 Docker 配代理（长期更省事）

```bash
# 🖥️ 服务器
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/proxy.conf >/dev/null <<'EOF'
[Service]
Environment="HTTP_PROXY=http://<代理IP>:<端口>"
Environment="HTTPS_PROXY=http://<代理IP>:<端口>"
Environment="NO_PROXY=localhost,127.0.0.1,.myqcloud.com"
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
cd /opt/rewards && bash scripts/up.sh
```

---

## 12. 日常运维速查

| 我想… | 命令 |
|---|---|
| 看容器在不在 | `docker compose ps`（服务器） |
| 看实时日志 | `bash scripts/logs.sh` / `bash scripts/logs.sh bot 500` |
| 改完 `.env` 让它生效 | `bash scripts/up.sh --no-build`（不重建镜像，快） |
| 改了 Dockerfile / compose | `bash scripts/up.sh --build` |
| 只重启面板 | `docker compose restart rewards-dashboard` |
| 只重启机器人 | `docker compose restart microsoft-rewards-script` |
| 手动跑一次 | 面板「运行控制」→「立即运行」；或 `curl -X POST -H "Authorization: Bearer $(grep '^API_TOKEN=' .env \| cut -d= -f2-)" http://127.0.0.1:3010/start` |
| 改调度 | 面板「调度」页直接改 cron（已开 `API_ALLOW_SCHEDULE_WRITE`） |
| 备份 | `bash scripts/backup.sh` |
| 恢复 | `bash scripts/backup.sh restore` |
| 彻底停掉（数据在 `./data`，不丢） | `docker compose down` |
| 升级这个项目 | 传新代码（§2 方式 A）→ `bash scripts/doctor.sh` → `bash scripts/up.sh --build` |
| 一键重来（本机发起） | `bash scripts/deploy-ssh.sh user@server /opt/rewards` |

---

## 13. 排错表（贴报错之前先这儿看看）

| 症状 | 原因 | 处理 |
|---|---|---|
| 本机打开 `http://服务器IP:8890` 一直转圈 / 打不开 | 云安全组没开 8890 | §6.2，99% 是这个 |
| 同上，但关掉代理之后就好了 | 系统代理把 `IP:8890` 也代理出去了 | §6.3「浏览器侧也有坑」 |
| 打不开且地址是 `2408:...` 这种冒号串 | 拿到的是 IPv6，浏览器不认 | `curl -4 -s https://api.ipify.org` 取 IPv4 |
| 打不开但地址是 `10.x / 172.x / 192.168.x` | 用的是内网 IP，不是公网 IP | 云控制台实例列表看公网 IP |
| 打开后弹账号密码框 | **不是故障**，面板 Basic Auth 生效了 | `admin` + `.env` 的 `DASHBOARD_PASSWORD` |
| 面板 502 / Bad Gateway | 面板连不上机器人 | `docker compose logs rewards-dashboard`；确认 `API_TOKEN` 两边一致 |
| 机器人一直 `Restarting` | 内存不足 /dev/shm | §1.4 加 swap；`docker compose logs microsoft-rewards-script \| tail -50` |
| 机器人 `unhealthy` 但一直没转 healthy | API 起慢了 | 等 1~2 分钟；再看 `curl http://127.0.0.1:3010/status` |
| 日志里 `Page crashed!` | shm 太小 | compose 已设 `shm_size:1gb`；内存 <2G 还得加 swap |
| 每次都重新登录（会话丢了） | 挂载目录属主不对或被 root 占用 | §2.2 `sudo chown -R $USER:$USER /opt/rewards` |
| 手动登录后过一会又掉线 | 手动登录容器挂的不是同一份会话目录 | 检查 compose 面板段 `PANEL_SESSIONS_BIND='${PWD}/data/bot/sessions'` |
| 面板「日志」页空白 | —— 已修：机器人 SSE 发的是具名事件 `event: log` | 清缓存刷新（面板端用 `addEventListener`） |
| `docker compose` 报 permission denied | 用户不在 docker 组 / 没重连 | §1.1，重开 SSH 或 `newgrp docker` |
| 钉钉 / PushPlus 收不到 | `.env` 令牌空 / compose 渠道未开 / 等级过滤 | README 第八节 + §9 |
| 到点了没跑 | `run_daily.sh` 有随机等待（默认 5~30 分钟，防风控） | `docker compose logs microsoft-rewards-script \| grep -i sleep` |
| 换了台服务器，会话失效 | 浏览器指纹绑登录环境 | 跑一次 §8 手动登录即可 |

---

## 14. 换机 / 迁移

整目录打包带走（含 `.env` 和 `data/`）：

```bash
# 🖥️ 服务器（在 /opt 的上一级执行）
tar czf rewards-backup.tar.gz rewards/
scp rewards-backup.tar.gz user@newserver:/opt/
```

新机器：解压 → `bash scripts/setup.sh`（若已有 `.env` 会跳过，不会覆盖）→ `bash scripts/up.sh`。

> ⚠️ 指纹绑环境，**换服务器后首次大概率要重新手动登录一次**（§8）。

---

## 附：一句不落的全流程（可以直接照抄）

```bash
# ══════════ 🖥️ 本机（一次性） ══════════
rsync -avz --delete --exclude='.git' --exclude='data' --exclude='backups' \
  --exclude='_legacy' --exclude='.env' --exclude='*.tar.gz' \
  ./ user@server:/opt/rewards/
ssh user@server "sudo ufw allow 22/tcp; sudo ufw allow 8890/tcp; sudo ufw --force enable"

# ══════════ 🖥️ 服务器 ══════════
# （§1.3 装 Docker 后重连一次 SSH）
cd /opt/rewards
bash scripts/setup.sh
nano .env                      # 至少填 ACCOUNT_1_EMAIL / ACCOUNT_1_PASSWORD
bash scripts/doctor.sh
nohup bash -c 'docker compose up -d --build > /tmp/rewards-build.log 2>&1; echo BUILD_RC=$? >> /tmp/rewards-build.log' >/dev/null 2>&1 &
tail -f /tmp/rewards-build.log  # 另开窗口看；BUILD_RC=0 即成功
(crontab -l 2>/dev/null; echo "0 3 * * * cd /opt/rewards && bash scripts/backup.sh") | crontab -
grep DASHBOARD_PASSWORD .env    # 面板密码

# ══════════ 🖥️ 本机（可选） ══════════
# 有 2FA 账号时开隧道再上服务器跑 manual-login.sh
# ssh -N -L 7900:127.0.0.1:7900 user@server
```

浏览器打开 `http://<服务器IP>:8890` 就完事了。
