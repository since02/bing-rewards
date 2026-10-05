#!/usr/bin/env bash
# =============================================================================
# 一键部署到 SSH 服务器：从本机上传项目源码 → 远程执行 setup / doctor / up
#
# 用法（在本机项目根目录执行）：
#   bash scripts/deploy-ssh.sh user@server                 # 默认目标 /opt/rewards
#   bash scripts/deploy-ssh.sh user@server /srv/rewards    # 指定远程目录
#   bash scripts/deploy-ssh.sh user@server /opt/rewards --no-build   # 只更新不重建
#
# 可选环境变量：
#   SSH_KEY=~/.ssh/id_ed25519      指定私钥
#   SSH_PORT=22                    非默认 SSH 端口
#   SKIP_UP=1                      只上传，不在远程执行任何命令
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SSH_HOST="${1:-}"
REMOTE_DIR="${2:-/opt/rewards}"
SKIP_BUILD=0
[ "${3:-}" = "--no-build" ] && SKIP_BUILD=1

if [ -z "$SSH_HOST" ]; then
    echo "用法: bash scripts/deploy-ssh.sh <user@host> [远程目录] [--no-build]"
    echo "示例: bash scripts/deploy-ssh.sh root@1.2.3.4 /opt/rewards"
    exit 1
fi

KEY_OPT=""
[ -n "${SSH_KEY:-}" ] && KEY_OPT="-i ${SSH_KEY}"
PORT_OPT=""
[ -n "${SSH_PORT:-}" ] && PORT_OPT="-p ${SSH_PORT}"
SSH="ssh ${KEY_OPT} ${PORT_OPT}"

# 传给远程 shell 的选项：禁用严格主机密钥检查（换 IP/重装系统后免确认），
# 并保持 UTF-8。用 sh -c 并把整段脚本经 stdin 传入，避免多层引号转义地狱。
REMOTE_SH="ssh -o StrictHostKeyChecking=accept-new ${KEY_OPT} ${PORT_OPT}"

EXCLUDES=(
    --exclude='.git'
    --exclude='data'
    --exclude='backups'
    --exclude='_legacy'
    --exclude='.env'
    --exclude='*.tar.gz'
    --exclude='.DS_Store'
)

echo "==> 目标：$SSH_HOST : $REMOTE_DIR"
echo "==> 本机项目根：$PWD"

# ---------------------------------------------------------------------------
# 1) 上传（有 rsync 用增量同步，没有则退化为 scp 全量拷贝）
# ---------------------------------------------------------------------------
if command -v rsync >/dev/null 2>&1; then
    echo "==> 上传（rsync 增量）"
    # 关键：结尾的 / 表示「同步目录内容」，否则会在远程多套一层 rewards/
    rsync -avz --delete "${EXCLUDES[@]}" --timeout=60 ./ "$SSH_HOST:$REMOTE_DIR/"
else
    echo "==> 上传（scp，未检测到 rsync）"
    TMPUP="$(mktemp -d)/rewards"
    mkdir -p "$TMPUP"
    tar czf "$TMPUP/rewards.tar.gz" \
        --exclude=.git --exclude=data --exclude=backups \
        --exclude=_legacy --exclude=.env --exclude='*.tar.gz' .
    scp ${KEY_OPT} "${TMPUP}/rewards.tar.gz" "$SSH_HOST:/tmp/" >/dev/null
    $REMOTE_SH "mkdir -p $REMOTE_DIR && tar xzf /tmp/rewards.tar.gz -C $REMOTE_DIR && rm -f /tmp/rewards.tar.gz && echo解压完成"
    rm -rf "$TMPUP"
fi

[ "${SKIP_UP:-0}" = "1" ] && { echo "==> SKIP_UP=1，已上传完成，不执行远程命令"; exit 0; }

# ---------------------------------------------------------------------------
# 2) 远程：安装依赖（缺失时）→ 初始化 → 自检 → 构建启动
# ---------------------------------------------------------------------------
REMOTE_CMD="cd $REMOTE_DIR"

echo "==> 远程检查 Docker"
$REMOTE_SH "$REMOTE_CMD && \\
  if ! docker compose version >/dev/null 2>&1; then \\
     echo '  未检测到 docker compose，请先执行 README 十八-1 安装 Docker'; exit 1; \\
  else \\
     docker compose version; fi"

echo "==> 远程创建持久化目录并补齐 .env"
$REMOTE_SH "$REMOTE_CMD && mkdir -p data/bot/config data/bot/sessions data/bot/logs data/dashboard backups && \\
  if [ ! -f .env ]; then cp .env.example .env; echo '  已生成 .env（请填账号）'; else echo '  .env 已存在，保留'; fi && \\
  mkdir -p data/bot/config && \\
  if [ -d data/bot/config/config.json ]; then echo '  ⚠ data/bot/config/config.json 是目录，执行 rmdir 修正'; fi"

echo "==> 远程自检 doctor.sh"
$REMOTE_SH "$REMOTE_CMD && bash scripts/doctor.sh || true"

if [ "$SKIP_BUILD" = "1" ]; then
    echo "==> 远程启动（不重新构建镜像）"
    $REMOTE_SH "$REMOTE_CMD && docker compose up -d"
else
    echo "==> 远程构建镜像（首次较慢，约 5~15 分钟；SSH 断开也不会中断）"
    # nohup + 后台 + 日志：避免 SSH 超时把构建打断
    $REMOTE_SH "$REMOTE_CMD && nohup bash -c 'docker compose up -d --build > /tmp/rewards-build.log 2>&1; echo DONE_RC=\$? >> /tmp/rewards-build.log' >/dev/null 2>&1 &"
    $REMOTE_SH "for i in \$(seq 1 12); do if docker compose ps --format '{{.Name}}' 2>/dev/null | grep -q microsoft-rewards-script; then break; fi; sleep 5; done; \\
      echo '--- 构建进度（实时查看：tail -f /tmp/rewards-build.log）---'; \\
      tail -5 /tmp/rewards-build.log 2>/dev/null || echo '  尚无构建日志，镜像可能仍在拉取基础层'"
fi

echo
echo "==================================================================="
echo " 部署已发起。下一步："
echo "   1) 看构建结果：ssh $SSH_HOST 'tail -f /tmp/rewards-build.log'"
echo "   2) 看容器状态：ssh $SSH_HOST 'cd $REMOTE_DIR && docker compose ps'"
echo "   3) 若 .env 还没填账号，先：ssh $SSH_HOST 'cd $REMOTE_DIR && nano .env'"
echo "   4) 面板地址：http://<服务器IP>:8890  （务必同时放行云安全组 + ufw）"
echo "==================================================================="
