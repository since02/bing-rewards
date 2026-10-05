#!/usr/bin/env bash
# =============================================================================
# 部署自检（doctor）：一次性检查配置、数据目录、容器状态与服务连通性。
# 幂等可重跑，不修改任何数据。
#
# 用法：  bash scripts/doctor.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; WARN=0; FAIL=0
ok()   { printf '  ✅ %s\n' "$1"; PASS=$((PASS+1)); }
warn() { printf '  🟡 %s\n' "$1"; WARN=$((WARN+1)); }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }
info() { printf '     %s\n' "$1"; }

echo "==================================================================="
echo " Microsoft Rewards · 部署自检"
echo "==================================================================="

# ---------------------------------------------------------------- 1. 依赖环境
echo
echo "[1/9] 依赖环境"
for c in docker git; do
    if command -v "$c" >/dev/null 2>&1; then ok "$c 可用"
    else bad "缺少 $c"; fi
done
if docker compose version >/dev/null 2>&1; then
    ok "Docker Compose v2：$(docker compose version --short 2>/dev/null)"
    DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    warn "检测到旧版 docker-compose（v1），建议升级到 Compose v2"
    DC="docker-compose"
else
    bad "未找到 docker compose / docker-compose"
    DC="docker compose"
fi
docker info >/dev/null 2>&1 && ok "Docker daemon 可访问" || bad "Docker daemon 不可访问（Docker Desktop 是否已启动？）"

# ------------------------------------------------------------------ 2. 配置文件
echo
echo "[2/9] 配置文件"
if [ -f .env ]; then ok ".env 存在"; else bad ".env 不存在，请先 bash scripts/setup.sh"; fi
if [ -f docker-compose.yml ]; then ok "docker-compose.yml 存在"; else bad "docker-compose.yml 不存在"; fi

if [ -f .env ]; then
    TOKEN="$(grep -E '^[[:space:]]*API_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '\r')"
    if [ -n "$TOKEN" ] && [ "$TOKEN" != '""' ]; then
        info "API_TOKEN 长度 ${#TOKEN}"
        [ "${#TOKEN}" -ge 32 ] && ok "API_TOKEN 已设置且长度足够" || warn "API_TOKEN 偏短（建议 ≥32 字符）"
    else
        bad "API_TOKEN 为空：面板将无法访问 Control API"
    fi

    PW="$(grep -E '^[[:space:]]*DASHBOARD_PASSWORD=' .env | head -1 | cut -d= -f2- | tr -d '\r')"
    [ -n "$PW" ] && ok "面板已启用登录保护" || warn "DASHBOARD_PASSWORD 为空：面板免登录即可访问（仅限可信内网）"

    DING="$(grep -E '^[[:space:]]*DINGTALK_WEBHOOK=' .env | head -1 | cut -d= -f2- | tr -d '\r')"
    [ -n "$DING" ] && ok "DINGTALK_WEBHOOK 已配置" || warn "DINGTALK_WEBHOOK 为空：钉钉不会推送（不影响运行）"
fi

# -------------------------------------------------------------------- 3. 账号
echo
echo "[3/9] 账号配置"
if [ -f .env ]; then
    mapfile -t EMAILS < <(grep -E '^[[:space:]]*ACCOUNT_[0-9]+_EMAIL=.+' .env | sed 's/^[[:space:]]*//' | cut -d= -f2- | tr -d '\r')
    if [ "${#EMAILS[@]}" -gt 0 ]; then
        ok "检测到 ${#EMAILS[@]} 个账号"
        for e in "${EMAILS[@]}"; do
            case "$e" in
                *example.com|*" "@*) warn "账号 '$e' 看起来仍是模板占位值，请替换为真实邮箱" ;;
                *) info "· $e" ;;
            esac
        done
    else
        bad "没有任何已启用的 ACCOUNT_N_EMAIL，bot 启动后将无账号可跑"
    fi
else
    bad "无 .env，跳过账号检查"
fi

# ---------------------------------------------------------------- 4. 数据目录
echo
echo "[4/9] 数据目录"
for d in data/bot/config data/bot/sessions data/bot/logs data/dashboard; do
    [ -d "$d" ] && ok "$d 存在" || warn "$d 不存在（首次启动会自动创建，建议先跑 setup.sh）"
done
[ -d data/bot/config/config.json ] && bad "data/bot/config/config.json 是目录！bot 的 entrypoint 会拒绝启动，请执行： rmdir data/bot/config/config.json" \
                                  || ok "config.json 无目录陷阱"
[ -f data/bot/config/config.json ] && ok "bot 配置已生成" || info "bot 配置尚未生成（首次启动由 entrypoint 生成）"

# ---------------------------------------------------------------- 5. 容器状态
echo
echo "[5/9] 容器状态"
if ! docker info >/dev/null 2>&1; then
    bad "Docker daemon 不可访问，跳过容器检查"
else
    if $DC ps --format '{{.Name}}\t{{.Status}}' 2>/dev/null | grep -q .; then
        $DC ps --format '     · {{.Name}} : {{.Status}}'
        for name in microsoft-rewards-script rewards-dashboard; do
            st="$($DC ps --format '{{.Name}} {{.Status}}' 2>/dev/null | awk -v n="$name" '$1==n {print $2}')"
            if [ -z "$st" ]; then warn "$name 未运行（执行 bash scripts/up.sh 启动）"
            else
                case "$st" in
                    *healthy*)  ok "$name 健康 ($st)" ;;
                    *starting*) warn "$name 仍在启动周期" ;;
                    *Up*)       warn "$name 运行中但健康检查未通过 ($st)" ;;
                    *)          bad "$name 状态异常：${st:-未知}" ;;
                esac
            fi
        done
    else
        warn "没有任何服务在运行"
        info "启动： bash scripts/up.sh"
    fi
fi

# ---------------------------------------------------------------- 6. 服务连通
echo
echo "[6/9] 服务连通性"
# Control API 需要 Bearer Token，401 也算「活着」
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3010/health 2>/dev/null || echo 000)"
case "$code" in
    200) ok "Control API :3010 正常响应" ;;
    401) ok "Control API :3010 可达（未带令牌，符合预期）" ;;
    000) warn "Control API :3010 无响应（容器未运行或端口未映射）" ;;
    200|401) : ;;
    *)   warn "Control API :3010 返回 $code（若本机有 HTTP 代理，请先临时关闭再自检）" ;;
esac
pcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8890/api/health 2>/dev/null || echo 000)"
case "$pcode" in
    200) ok "面板 :8890 可访问" ;;
    401) ok "面板 :8890 可达（已启用 Basic Auth）" ;;
    000) warn "面板 :8890 无响应" ;;
    *)   warn "面板 :8890 返回 $pcode（若本机有 HTTP 代理，请先临时关闭再自检）" ;;
esac

# ------------------------------------------------ 7. CONFIG_* 变量名白名单
echo
echo "[7/9] CONFIG_* 变量名校验"
# 上游只认白名单里的 CONFIG_*；拼错的名字会被静默忽略（不报错、也不生效）。
WL="docs/config-overrides.txt"
if [ ! -f "$WL" ]; then
    warn "缺少白名单文件 $WL，跳过变量名校验"
else
    mapfile -t USED < <(grep -oE '(^|[[:space:]#])CONFIG_[A-Z0-9_]+' docker-compose.yml \
                        | sed 's/^[^A-Z]*//' | sort -u)
    if [ "${#USED[@]}" -eq 0 ]; then
        info "compose 中未使用 CONFIG_* 覆盖"
    else
        BADVARS=0
        for v in "${USED[@]}"; do
            if grep -qE "^${v}([[:space:]]|$)" "$WL"; then
                :
            else
                bad "CONFIG 变量名不在上游白名单：${v}（会被静默忽略，配置不会生效）"
                BADVARS=$((BADVARS+1))
            fi
        done
        [ "$BADVARS" -eq 0 ] && ok "compose 中 ${#USED[@]} 个 CONFIG_* 变量全部命中上游白名单"
    fi
fi

# --------------------------------------------- 8. 面板（中文面板）完整性
echo
echo "[8/9] 面板与 Docker 集成"
for f in dashboard/server.js dashboard/lib/dockerSocket.js \
         dashboard/public/index.html dashboard/public/app.js \
         dashboard/public/style.css dashboard/package.json dashboard/Dockerfile; do
    [ -f "$f" ] && ok "$f" || bad "面板文件缺失：$f（面板将构建失败）"
done

# --- 响应头非 ASCII 静态扫描（真实踩过的坑，别删）-----------------------------
# Node 的 storeHeader() 只接受 ASCII/latin1，HTTP 响应头里出现中文会抛
# ERR_INVALID_CHAR；因为它发生在 'request' 事件回调里（无人接），
# 会**直接把面板进程打死** → 容器 Restarting → 端口有人监听但后端已死
# → 宿主机 curl 得 000、浏览器完全打不开。历史事故：WWW-Authenticate 的
# realm 写成了 'Basic realm="Rewards 面板"'。这里静态扫出来，别等线上崩。
BAD_HDR=""
for jf in dashboard/server.js dashboard/lib/*.js; do
    [ -f "$jf" ] || continue
    # 找形如 setHeader/writeHead 的调用行，若同一行含非 ASCII 字节即可疑。
    # 先剥掉行注释（`//` 之后）与字符串字面量里的中文注释，避免"注释里有中文"被误报。
    # 注意两点（都踩过）：
    #   1) grep -E **不支持 \s**，POSIX ERE 要用 [[:space:]]
    #   2) 键名常带引号写成 "WWW-Authenticate":，所以引号也要一起吃掉
    HIT="$(grep -nE '(res\.)?(setHeader|writeHead)\(|(WWW-Authenticate|Content-Disposition|Location)[[:space:]"]*[:=]' "$jf" 2>/dev/null \
           | sed 's://.*::' \
           | LC_ALL=C grep -P '[^\x00-\x7F]' || true)"
    [ -n "$HIT" ] && BAD_HDR="$BAD_HDR
  $jf -> $HIT"
done
if [ -z "$BAD_HDR" ]; then
    ok "面板响应头均为 ASCII（无 ERR_INVALID_CHAR 崩溃风险）"
else
    bad "响应头含非 ASCII 字符，会触发 ERR_INVALID_CHAR 直接打死面板进程（中文只能放响应体）：$BAD_HDR"
fi

if grep -q 'docker.sock:/var/run/docker.sock' docker-compose.yml 2>/dev/null; then
    ok "面板已挂载 /var/run/docker.sock（可增删账户 / 拉起手动登录）"
else
    warn "面板未挂载 docker.sock：面板内「账户管理」「手动登录」将不可用"
fi

if grep -qE '\./\.env:/shared/env/\.env' docker-compose.yml 2>/dev/null; then
    ok "面板已挂载 .env 到 /shared/env/.env"
else
    bad "面板未挂载 .env：面板保存账户/钉钉配置会失败（找不到 ENV_FILE）"
fi

# 从「锚点往下 N 行」里取某个键的值，剥掉引号（避免把行尾注释当成值的一部分）
pick_val() {   # $1=锚点  $2=目标键  $3=向下查找行数
    grep -A "$3" "$1" docker-compose.yml 2>/dev/null \
      | grep -m1 "[[:space:]]$2:" \
      | awk '{print $2}' | tr -d "\"'" | tr -d '\r'
}
BOTIMG="$(pick_val 'context: ./bot' image 3)"
MLIMG="$(pick_val 'PANEL_MANUAL_LOGIN_IMAGE:' PANEL_MANUAL_LOGIN_IMAGE 1)"
if [ -n "$BOTIMG" ] && [ -n "$MLIMG" ] && [ "$BOTIMG" = "$MLIMG" ]; then
    ok "手动登录镜像与机器人一致（$MLIMG）"
else
    warn "手动登录镜像与机器人不一致：bot=$BOTIMG login=$MLIMG（会导致手动登录容器起不来）"
fi

if [ -f .env ]; then
    REG="$(grep -E '^[[:space:]]*PANEL_SESSIONS_BIND=' docker-compose.yml 2>/dev/null | head -1)"
    case "$REG" in
        *'${PWD}'*) info "手动登录会话目录：${REG#*PANEL_SESSIONS_BIND=}（由 \$PWD 插值；插值失败会自动回退命名卷）" ;;
        *"/"*)      ok "面板已使用显式绝对路径：${REG#*PANEL_SESSIONS_BIND=}" ;;
        *)          warn "未指定 PANEL_SESSIONS_BIND：手动登录容器会挂命名卷，会话可能不持久化" ;;
    esac
fi

# ------------------------------------------- 9. 对外访问（打不开面板时重点看）
echo
echo "[9/9] 对外访问可达性"
# 面板只在 127.0.0.1 监听时，外网一定打不开；先确认监听地址
if command -v ss >/dev/null 2>&1; then
    LIS="$(ss -tlnp 2>/dev/null | grep ':8890' | head -1 || true)"
    if [ -n "$LIS" ]; then
        case "$LIS" in
            *0.0.0.0:8890*) ok "面板监听 0.0.0.0:8890（所有网卡，外网可进）" ;;
            *127.0.0.1:8890*) bad "面板只监听 127.0.0.1:8890 → 外网必打不开；docker-compose.yml 需为 '8890:8890'" ;;
            *) warn "面板监听情况：${LIS}" ;;
        esac
    else
        warn "ss 里查不到 :8890 监听（容器没跑，或端口没映射到宿主机）"
    fi
fi

# ufw 放行情况（ufw 未启用时不会拦人，只会提醒别在启用后忘了开 8890）
if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | head -1 | grep -qi inactive; then
        info "ufw 当前未启用（不会拦 8890）；若你后面执行了 ufw enable，请先跑：sudo ufw allow 8890/tcp"
    else
        if ufw status numbered 2>/dev/null | grep -q '8890/tcp'; then
            ok "ufw 已放行 8890/tcp"
        else
            bad "ufw 已启用但没放行 8890 → 外网请求会被拦；执行：sudo ufw allow 8890/tcp"
        fi
    fi
else
    info "未安装 ufw（多数云厂商走控制台安全组），跳过"
fi

# 浏览器该敲哪个 IP（只认 IPv4：IPv6 拼进 URL 会变成一坨冒号，浏览器打不开）
PUBIP="$(curl -s -4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
[ -z "$PUBIP" ] && PUBIP="$(curl -s -4 --max-time 5 http://ifconfig.me/ip 2>/dev/null || true)"
[ -z "$PUBIP" ] && PUBIP="$(hostname -I 2>/dev/null | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | head -1 || true)"
PUBIP="$(printf '%s' "$PUBIP" | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | head -1 || true)"
if [ -n "$PUBIP" ]; then
    ok "面板对外地址：http://${PUBIP}:8890"
    info "同时去云控制台「安全组/防火墙」入站放行 TCP 8890 —— 99% 的「面板打不开」是这里没开"
else
    info "取不到公网 IP（服务器无出网或在 NAT 后），请自行确认服务器公网 IP 再拼 :8890"
fi

echo
echo "==================================================================="
echo " 自检完成：✅ 通过 $PASS 项 · 🟡 警告 $WARN 项 · ❌ 失败 $FAIL 项"
if [ "$FAIL" -gt 0 ]; then
    echo " 存在必须处理的问题，请按上面的 ❌ 提示修复后再 bash scripts/up.sh"
    exit 1
fi
echo "==================================================================="
