#!/usr/bin/env bash
# =============================================================================
# 备份：登录会话 + 机器人配置 + 面板历史数据库
#  - data/bot/sessions   登录 cookie / 浏览器指纹（丢了要重新登录 + 2FA！）
#  - data/bot/config     机器人 config.json / schedule.json
#  - data/dashboard      面板 dashboard.sqlite（积分历史 / 运行记录 / 面板调度）
#
# 用法：
#   bash scripts/backup.sh                     # 备份到 backups/，保留最近 10 个
#   bash scripts/backup.sh restore             # 列出最近备份并提示恢复命令
#   bash scripts/backup.sh restore <file>      # 恢复指定备份（会先自动存一份当前状态）
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-}"
KEEP=10
mkdir -p backups

if [ "$MODE" = "restore" ]; then
    TARGET="${2:-}"
    if [ -z "$TARGET" ]; then
        echo "==> 最近的备份（最新在前，最多 5 个）："
        ls -1t backups/rewards-backup-*.tar.gz 2>/dev/null | head -5 || true
        echo
        echo "恢复用法： bash scripts/backup.sh restore backups/rewards-backup-YYYYmmdd-HHMMSS.tar.gz"
        echo "注意：恢复前请先停止容器（docker compose down），恢复后再启动。"
        exit 0
    fi
    [ -f "$TARGET" ] || { echo "备份文件不存在：$TARGET"; exit 1; }
    # 恢复前先给当前状态留一份，避免误操作不可逆
    SAFE="backups/pre-restore-$(date +%Y%m%d-%H%M%S).tar.gz"
    tar -czf "$SAFE" data/bot/sessions data/bot/config data/dashboard 2>/dev/null || true
    echo "==> 已先把当前状态存为 $SAFE"
    tar -xzf "$TARGET"
    echo "==> 已从 $TARGET 恢复到 data/ 下"
    echo "    请执行 docker compose up -d 重新启动服务"
    exit 0
fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT="backups/rewards-backup-${TS}.tar.gz"
tar -czf "$OUT" data/bot/sessions data/bot/config data/dashboard
echo "==> 已备份到 $OUT"
echo "    包含：data/bot/sessions（登录会话）、data/bot/config（配置）、data/dashboard（面板历史库）"

# 仅保留最近 N 个备份
ls -1t backups/rewards-backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
echo "    已清理多余备份（保留最新 $KEEP 个）"
