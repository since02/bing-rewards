#!/usr/bin/env bash
# =============================================================================
# 实时查看服务日志（Ctrl+C 退出）
#
# 用法：
#   bash scripts/logs.sh              # 全部服务
#   bash scripts/logs.sh bot          # 只看机器人
#   bash scripts/logs.sh dash         # 只看面板
#   bash scripts/logs.sh bot 500      # 机器人，回溯 500 行（默认 200）
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

SVC="${1:-}"
TAIL="${2:-200}"

case "$SVC" in
    bot|micro|microsoft-rewards-script) TARGET=("microsoft-rewards-script") ;;
    dash|dashboard|rewards-dashboard)   TARGET=("rewards-dashboard") ;;
    "")                                 TARGET=() ;;
    *) echo "未知服务：$SVC（可选 bot / dash）"; exit 1 ;;
esac

if [ "${#TARGET[@]}" -gt 0 ]; then
    $DC logs -f --tail="$TAIL" "${TARGET[@]}"
else
    $DC logs -f --tail="$TAIL"
fi
