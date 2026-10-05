#!/usr/bin/env bash
# =============================================================================
# 首次部署初始化：生成 .env、补充分享密钥与面板密码、建好持久化目录。
# 用法：  bash scripts/setup.sh
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> [1/5] 检查依赖"
for c in git docker; do command -v "$c" >/dev/null 2>&1 || { echo "缺少 $c，请先安装 Docker / Git"; exit 1; }; done
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
echo "     使用：$DC"

echo "==> [2/5] 生成 .env"
if [ -f .env ]; then
    echo "     .env 已存在，跳过复制（如需重置请先删除 .env）"
else
    cp .env.example .env
    echo "     已从 .env.example 复制生成 .env"
fi

# 生成 32 字节十六进制随机串
gen_token() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

echo "==> [3/5] 补齐 API_TOKEN（机器人/面板共享密钥）"
if grep -q '^API_TOKEN=$' .env; then
    TKN="$(gen_token)"
    sed -i "s/^API_TOKEN=.*/API_TOKEN=${TKN}/" .env
    echo "     已生成 API_TOKEN"
else
    echo "     已有 API_TOKEN，保留"
fi

echo "==> [4/5] 补齐面板密码（DASHBOARD_PASSWORD）"
if grep -q '^DASHBOARD_PASSWORD=$' .env; then
    PW="$(gen_token)"
    sed -i "s/^DASHBOARD_PASSWORD=.*/DASHBOARD_PASSWORD=${PW}/" .env
    echo "     已生成随机面板密码"
else
    echo "     已有 DASHBOARD_PASSWORD，保留"
fi

echo "==> [5/5] 创建持久化目录"
mkdir -p data/bot/config data/bot/sessions data/bot/logs data/dashboard backups
# Bot 的 entrypoint 在 config/config.json 是「目录」时会直接报错退出：
# 这是 Docker 自动创建空目录导致的常见坑，这里提前探测并提示。
if [ -d data/bot/config/config.json ]; then
    echo "     ⚠ 发现 data/bot/config/config.json 是目录（Docker 自动创建），bot 将无法启动。"
    echo "       执行 rmdir data/bot/config/config.json 后再启动。"
fi
echo "     完成"

echo
echo "==> 端口占用检查"
# ⚠ 加 `|| true`：端口**没**被占用时 grep 返回 1，配 pipefail 会让函数返回 1，
#   进而被 set -e 当成失败 → 脚本在末尾提前退出、退出码 1（后续提示全部丢失，
#   调用方会误判为初始化失败）。这是必须在 Debian 上修的真 bug。
check_port() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | grep -q ":$port " && echo "     ⚠ 端口 $port 已被占用" || true
    elif command -v netstat >/dev/null 2>&1; then
        netstat -ltn 2>/dev/null | grep -q ":$port " && echo "     ⚠ 端口 $port 已被占用" || true
    else echo "     （未找到 ss/netstat，跳过检查）"; fi
}
check_port 8890
check_port 3010

echo
echo "==> 账号配置检查"
if grep -Eq '^[[:space:]]*ACCOUNT_[0-9]+_EMAIL=.+' .env; then
    echo "     检测到至少一个已启用的 ACCOUNT_N_EMAIL ✓"
else
    echo "     ⚠ 未检测到任何已启用（未注释且非空）的 ACCOUNT_N_EMAIL，bot 启动后会无账号可跑。"
fi

echo
echo "==================================================================="
echo " 初始化完成！下一步："
echo "   1) 编辑 .env，至少填一个账号：ACCOUNT_1_EMAIL / ACCOUNT_1_PASSWORD"
echo "   2) 如需推送，在 docker-compose.yml 取消对应渠道注释，并在 .env 填令牌"
echo "   3) 启动：  bash scripts/up.sh"
echo "   4) 面板：  http://<本机IP>:8890   (账号 admin / 见 .env 的 DASHBOARD_PASSWORD)"
echo "   5) 日志：  bash scripts/logs.sh"
echo "==================================================================="
