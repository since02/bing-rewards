#!/usr/bin/env bash
# =============================================================================
# 一键首装 —— 适用于「把 rewards/ 整个文件夹复制到 Debian/Ubuntu 服务器」的场景
#
# 用法（一条命令就够）：
#   bash scripts/first-run.sh              # 全流程：装 Docker → 清换行 → 生成 .env
#                                          #   → 引导填账号 → 修属主 → 自检 → 后台构建
#   bash scripts/first-run.sh --quick      # 跳过「交互式填账号」（.env 已配好账号时用）
#   bash scripts/first-run.sh --no-docker  # 服务器已有 Docker，别再装一遍
#
# 幂等：可重复执行。.env 已存在不会覆盖，只补齐缺失的随机密钥。
# 幂等提示：脚本内部 cd 到自身所在目录的上一级，所以在任意路径都能跑。
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

LOG_FILE=/tmp/rewards-firstrun.log
QUICK=0
SKIP_DOCKER=0
[ "$(id -u)" = "0" ] && SUDO="" || SUDO="sudo"

for a in "$@"; do
    case "$a" in
        --quick)     QUICK=1 ;;
        --no-docker) SKIP_DOCKER=1 ;;
        *) echo "未知参数：$a（可选 --quick / --no-docker）"; exit 1 ;;
    esac
done

ok()   { printf '  ✅ %s\n' "$1"; }
warn() { printf '  🟡 %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; }
step() { echo; echo "════════════════════════════════════════"; echo "  $*"; echo "════════════════════════════════════════"; }

# ------------------------------------------------------------------ 0. Docker
have_docker() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }

install_docker() {
    if ! command -v apt-get >/dev/null 2>&1; then
        bad "这台不是 Debian/Ubuntu（没找到 apt-get），请手动装 Docker：https://docs.docker.com/engine/install/"
        exit 1
    fi
    step "0/7 安装 Docker 引擎 + Compose 插件（约 2~3 分钟）"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq ca-certificates curl gnupg git
    $SUDO install -m 0755 -d /etc/apt/keyrings
    if curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.asc; then
        $SUDO install -m 0644 /tmp/docker.asc /etc/apt/keyrings/docker.asc
    else
        bad "下载 Docker 官方 GPG 失败（这台机器出不了 download.docker.com？）"
        echo "     可改用国内源或先配好代理后重跑本脚本。"
        exit 1
    fi
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
        | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    $SUDO usermod -aG docker "$(whoami)" 2>/dev/null || true
    ok "Docker 安装完成"
    warn "已把 $(whoami) 加入 docker 组 → 请**断开 SSH 重连一次**再执行本脚本"
    exit 0
}

step "0/7 检查环境（Docker / 内存）"
if [ "$SKIP_DOCKER" = "1" ]; then
    ok "按 --no-docker 跳过检查"
else
    if have_docker; then ok "Docker 与 Compose 已就绪"; else install_docker; fi
fi

MEM_GB="$(free -g 2>/dev/null | awk '/^Mem:/{print $2}' || true)"
if [ -n "$MEM_GB" ] && [ "$MEM_GB" -lt 2 ] 2>/dev/null; then
    warn "内存仅 ${MEM_GB}GB（< 2GB）→ 构建阶段 Chromium 很可能被 OOM kill"
    echo "     建议先加 swap："
    echo "     $ sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
fi
DF_GB="$(df -BG . | awk 'NR==2{gsub(/[^0-9]/,"",$4); print $4}' 2>/dev/null || true)"
if [ -n "$DF_GB" ] && [ "$DF_GB" -lt 25 ] 2>/dev/null; then
    warn "剩余磁盘 ${DF_GB}GB（< 25GB）→ 镜像很大，建议先清理再继续"
fi

# ------------------------------------------------------- 1. 换行 + 可执行位
step "1/7 修复换行符与执行权限（Windows 整包复制过来的关键一步）"
# Windows 整包复制的 shell 脚本常带 CRLF，直接跑会报 "bad interpreter: /bin/bash^M"
# ⚠ 不要用 $'\r'：部分 shell/环境下 ANSI-C 引用不展开。统一用 printf 生成 CR 字节。
# 统计用 tr 逐文件数 CR（grep 在部分环境会把 CR 当换行剥掉，导致假阴性）。
CR=$(printf '\r')
N_CRLF=0
while IFS= read -r f; do
    [ -f "$f" ] || continue
    n="$(tr -dc "${CR}" < "$f" 2>/dev/null | wc -c | tr -d ' ')"
    if [ -n "${n}" ] && [ "${n}" -gt 0 ] 2>/dev/null; then N_CRLF=$((N_CRLF + 1)); fi
done <<< "$(find scripts bot/scripts/docker -name '*.sh' 2>/dev/null)"
# 无条件执行（幂等，本来就是 LF 的文件无副作用）
find scripts bot/scripts/docker -name '*.sh' -exec sed -i "s/${CR}\$//" {} + 2>/dev/null || true
if [ "$N_CRLF" -gt 0 ]; then
    ok "发现并修复 $N_CRLF 个 CRLF 脚本（已改为 LF）"
else
    ok "脚本换行符已是 LF，无需修复"
fi
# 补执行位（Windows 复制过来没有 x 位）
find scripts bot/scripts/docker -name '*.sh' -exec chmod +x {} + 2>/dev/null || true
if command -v bash >/dev/null && bash -n scripts/up.sh 2>/dev/null; then
    ok "脚本语法自检通过（up.sh 等）"
else
    warn "脚本语法自检未通过，仍会继续但请留意后续报错"
fi

# ------------------------------------------------------------- 2. 生成 .env
step "2/7 生成 .env（若已存在则保留，只补随机密钥）"
if [ -f .env ]; then
    ok ".env 已存在，保留原值"
else
    [ -f .env.example ] || { bad "缺少 .env.example，项目文件不完整"; exit 1; }
    cp .env.example .env
    ok "已从 .env.example 生成 .env"
fi
SETUP_LOG=/tmp/rewards-setup.log
if bash scripts/setup.sh > "$SETUP_LOG" 2>&1; then
    ok "setup.sh 执行完成（已补齐 API_TOKEN / 面板密码 / 数据目录）"
else
    bad "setup.sh 执行失败！报错如下："
    tail -n 12 "$SETUP_LOG" 2>/dev/null | sed 's/^/     /'
    echo
    echo "     常见原因：这台机器没装 git 或 docker（setup.sh 会直接退出）。装完重跑本脚本。"
    exit 1
fi

# ---------------------------------------------------- 3. 引导填写第一个账号
step "3/7 配置账号"
# 写 .env：只有「未注释的同名行」存在时才原地替换，否则追加到末尾。
# ⚠ 不要顺手删「注释占位行」（例如 #ACCOUNT_1_PASSWORD=your_password）：
#   那样会让 seen=1 却不写入 → 键被静默丢掉（排查极痛苦）。
#   注释占位留着无害：Docker env_file / dotenv 都以**最后出现**的那行为准。
upsert_env() {
    local k="$1" v="$2" tmp
    tmp="$(mktemp)"
    awk -v k="$k" -v v="$v" '
        { if (index($0, k "=") == 1) { print k "=" v; live = 1 } else print }
        END { if (!live) printf "\n%s=%s\n", k, v }
    ' .env > "$tmp" && cat "$tmp" > .env
    rm -f "$tmp"
}

# 是否已有「真账号」：.env.example 里 ACCOUNT_1_EMAIL=email@example.com
# 是**未注释的占位值**，直接判非空会误判成已配置，从而跳过交互引导。
has_real_account() {
    local v
    while IFS= read -r v; do
        [ -z "$v" ] && continue
        case "$v" in
            *example.com|*your_*|*xxx*|*changeme*|*placeholder*|*test@|*user@) continue ;;
            *) return 0 ;;
        esac
    done < <(grep -E '^[[:space:]]*ACCOUNT_[0-9]+_EMAIL=' .env 2>/dev/null | cut -d= -f2-)
    return 1
}

if has_real_account; then
    ok "已检测到账号配置，跳过"
elif [ "$QUICK" = "1" ]; then
    warn "--quick 已跳过：启动后 bot 无账号可跑，记得 nano .env 补 ACCOUNT_1_EMAIL/PASSWORD"
else
    printf '   >>> 未配置任何账号，bot 启动后会「无账号可跑」。\n'
    printf '       （非交互式环境或想稍后自己填，直接回车跳过即可）\n\n'
    printf '   邮箱: '; read -r EMAIL || EMAIL=""
    if [ -z "${EMAIL:-}" ]; then
        warn "已跳过；稍后执行 nano .env 手动填 ACCOUNT_1_EMAIL / ACCOUNT_1_PASSWORD"
    else
        read -r -s -p "   密码: " PASS; echo
        upsert_env "ACCOUNT_1_EMAIL" "$EMAIL"
        upsert_env "ACCOUNT_1_PASSWORD" "${PASS:-}"
        ok "已写入 .env: ACCOUNT_1_EMAIL / ACCOUNT_1_PASSWORD"
        printf '       提示：开了验证码登录(2FA)还要加 ACCOUNT_1_TOTP_SECRET=xxx\n'
        printf '       多账号继续加 ACCOUNT_2_* ...（也可在面板「账户管理」里网页添加）\n'
    fi
fi

# ----------------------------------------------------------- 4. 目录属主
step "4/7 修复目录属主（漏了会「会话每次都丢」）"
$SUDO chown -R "$(whoami)":"$(id -gn)" . 2>/dev/null \
    && ok "属主已设为 $(whoami)（容器内才能写 data/bot/sessions）" \
    || warn "chown 失败（非本机文件系统？）；若出现会话丢失请手动 sudo chown -R \$USER ."
if [ -d data/bot/config/config.json ]; then
    bad "data/bot/config/config.json 是目录（Docker 自动创建的坑），bot 会起不来"
    echo "     执行：rmdir data/bot/config/config.json"
fi

# -------------------------------------- 5. 放行面板端口（真正执行，不是只打印一行提示）
step "5/7 放行面板端口 8890（容器起来了外网还打不开，八成就是这儿没放行）"
if command -v ufw >/dev/null 2>&1; then
    # 先放行 SSH：万一后面手滑 ufw enable，别把自己关在门外
    $SUDO ufw allow 22/tcp comment 'SSH' >/dev/null 2>&1 || true
    $SUDO ufw allow 8890/tcp comment 'Rewards dashboard' >/dev/null 2>&1 || true
    if ufw status 2>/dev/null | head -1 | grep -qi inactive; then
        ok "已加 ufw 放行规则（22 + 8890）；ufw 当前未启用，先不会拦人"
        info "你后面若执行 sudo ufw enable，规则已就位、会立即生效"
    else
        ok "ufw 已生效放行 22 + 8890/tcp"
    fi
else
    info "未安装 ufw（多数云厂商走控制台安全组），跳过"
fi
info "注意：云控制台「安全组/防火墙」必须自己手开 TCP 8890，脚本代劳不了 —— 大部分「面板打不开」就是漏了这步"

# ------------------------------------------------------------- 6. 自检
step "6/7 部署自检 doctor.sh（有 ❌ 先修，别急着构建）"
bash scripts/doctor.sh 2>&1 | tail -n 40

# ------------------------------------------------------------- 7. 构建启动
step "7/7 后台构建并启动（首次 5~15 分钟，SSH 断开也不影响）"
nohup bash scripts/up.sh > "$LOG_FILE" 2>&1 &
disown 2>/dev/null || true
sleep 3

# 取「公网 IP」优先，且只要 IPv4：
#  ① 云服务器上 hostname -I 多半返回内网 IP，直接拿它拼面板地址 = 打开一个根本不通的地址（头号原因）
#  ② IPv6 拼进 URL 会变成一坨冒号，浏览器同样打不开
IPV4RE='[0-9]{1,3}(\.[0-9]{1,3}){3}'
IP="$(curl -s -4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
if [ -z "$IP" ]; then IP="$(curl -s -4 --max-time 5 http://ifconfig.me/ip 2>/dev/null || true)"; fi
if [ -z "$IP" ]; then
    IP="$(hostname -I 2>/dev/null || true)"
fi
IP="$(printf '%s' "$IP" | grep -oE "$IPV4RE" | head -1 || true)"
# 抓到的是内网 IP 就别拿它当面板地址骗人
case "$IP" in
    10.*|172.1[6789].*|172.2[0-9].*|172.3[01].*|192.168.*|127.*|169.254.*|'')
        IP='<服务器公网IP>' ;;
esac
[ -z "$IP" ] && IP='<服务器公网IP>'
_dusr_raw="$(grep -E '^[[:space:]]*DASHBOARD_USERNAME=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' | tr -d '"' || true)"
DASH_USER="${_dusr_raw//\'/}"          # 顺手去掉可能存在的单引号（参数展开，别用 '\'' 那套）
DASH_USER="${DASH_USER// /}"
[ -z "$DASH_USER" ] && DASH_USER="admin"
if [ "$IP" = '<服务器公网IP>' ]; then
    info "没能自动识别公网 IP（无出网或被 NAT）：请到云控制台看实例公网 IP，把下面的 <服务器公网IP> 换掉"
fi
cat <<EOF

构建已在后台启动，日志：$LOG_FILE
实时查看：tail -f $LOG_FILE
构建完成后确认：docker compose ps

──────────────────────────────────────────────────────────────
 面板地址   http://${IP}:8890
 登录账号   ${DASH_USER}
 登录密码   见 .env 里的 DASHBOARD_PASSWORD
 端口放行   第 5 步已自动放行 ufw(8890)；云控制台安全组仍需手开 8890
 看日志     bash scripts/logs.sh
 手动登录    bash scripts/manual-login.sh 邮箱 both （2FA 账号）
──────────────────────────────────────────────────────────────
EOF
echo
echo "打不开面板时按顺序查这三条（别急着重装）："
echo "  1) 云控制台安全组有没有放行 TCP 8890（最常见）"
echo "  2) 浏览器有没有开代理/系统代理 —— 访问 http://IP:8890 会走代理，先关掉"
echo "  3) ssh 隧道绕过一切：ssh -N -L 8890:127.0.0.1:8890 user@\${IP} 后开 http://localhost:8890"
EOF
echo
echo "⚠ 构建跑到「两个 Up」才算完成；期间别关终端。中途有报错把 $LOG_FILE 贴出来。"
echo "   极简排错：bash scripts/doctor.sh  →  bash scripts/logs.sh bot"
