#!/usr/bin/env bash
# =============================================================================
# 构建并拉起所有服务（bot + dashboard）
#
# 用法：
#   bash scripts/up.sh                # 构建并启动（默认）
#   bash scripts/up.sh --no-build     # 不重新构建，直接启动（改了 .env 后常用）
#   bash scripts/up.sh --build-only   # 只构建镜像，不启动
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

[ -f .env ] || { echo "缺少 .env，请先 bash scripts/setup.sh"; exit 1; }

case "${1:-}" in
    --no-build)
        $DC up -d
        ;;
    --build-only)
        $DC build
        echo "==> 构建完成，未启动"
        exit 0
        ;;
    "")
        $DC up -d --build
        ;;
    *)
        echo "未知参数：$1（可选 --no-build / --build-only）"; exit 1
        ;;
esac

echo "==> 服务状态"
$DC ps
echo
echo "面板: http://localhost:8890   控制API: http://127.0.0.1:3010"
echo "查看日志: bash scripts/logs.sh"
echo "部署自检: bash scripts/doctor.sh"
