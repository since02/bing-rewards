#!/usr/bin/env bash
# =============================================================================
# Docker 内手动登录（适合开启 2FA / Authenticator 的账号）
#
# 用法：
#   bash scripts/manual-login.sh <邮箱> [platform: mobile|desktop|both] [--fresh]
#
# 示例：
#   bash scripts/manual-login.sh you@example.com both
#   bash scripts/manual-login.sh you@example.com mobile --fresh   # 丢弃旧 cookie 重登
#
# 流程：启动一个一次性容器，开 noVNC，你在本机浏览器打开
#       http://localhost:7900/vnc.html 完成登录；在 rewards.bing.com 停留满 5 秒后
#       脚本自动把会话写进 data/bot/sessions（SQLite），与自动运行共用。
# 注意：该邮箱必须已在 .env 里配置为某个 ACCOUNT_N_EMAIL。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

EMAIL="${1:-}"
PLATFORM="${2:-both}"
EXTRA_ARGS=()

# 第三个参数起：只接受 --fresh（丢弃已有 cookie 重新登录，指纹仍复用）
if [ $# -gt 2 ]; then shift 2; else set --; fi
for a in "$@"; do
    case "$a" in
        --fresh) EXTRA_ARGS+=("--fresh") ;;
        *) echo "未知参数：$a（目前只支持 --fresh）"; exit 1 ;;
    esac
done

[ -n "$EMAIL" ] || { echo "用法: bash scripts/manual-login.sh <邮箱> [mobile|desktop|both] [--fresh]"; exit 1; }
[ -f .env ] || { echo "请先 bash scripts/setup.sh 生成 .env 并填写账号"; exit 1; }

# 目标邮箱必须已在 .env 中配置，否则上游 manualLogin 找不到账号
if ! grep -Eq "^[[:space:]]*ACCOUNT_[0-9]+_EMAIL=[[:space:]]*${EMAIL}[[:space:]]*$" .env; then
    echo "⚠ .env 里没有找到 ACCOUNT_N_EMAIL=${EMAIL}"
    echo "  请先在 .env 添加该账号，否则手动登录无法保存会话。"
    exit 1
fi

IMG=ms-rewards-bot:china
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo "镜像 $IMG 不存在，请先构建： bash scripts/up.sh"
    exit 1
fi

# 上一次登录若没退干净，7900 会被占住导致这次打不开页面
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'ms-rewards-manual-login'; then
    echo "⚠ 检测到同名容器仍在运行，先清理再启动…"
    docker rm -f ms-rewards-manual-login >/dev/null 2>&1 || true
fi

mkdir -p data/bot/config data/bot/sessions data/bot/logs

# Docker Desktop（Windows/macOS）需要 Windows 风格绝对路径；Git Bash 的 $PWD 是
# /e/xxx 形式，含中文或空格的目录极易挂载失败，这里统一转换。
PROJ_DIR="$PWD"
if command -v cygpath >/dev/null 2>&1; then
    PROJ_DIR="$(cygpath -w "$PWD")"
elif [ -x /usr/bin/wslpath ]; then
    PROJ_DIR="$(wslpath -w "$PWD")" 2>/dev/null || PROJ_DIR="$PWD"
fi

echo "==> 启动手动登录容器（noVNC 端口映射到本机 7900）"
echo "    账号：$EMAIL    平台：${PLATFORM}${EXTRA_ARGS:+  （--fresh：丢弃旧 cookie）}"
echo "    挂载目录：$PROJ_DIR/data/bot/{config,sessions,logs}"
echo "    请在本机浏览器打开 http://localhost:7900/vnc.html 完成登录"
echo "    完成后容器自动退出；Ctrl+C 可中止（不会保存未完成的登录）"
echo

docker run --rm -it \
    --name ms-rewards-manual-login \
    --env-file .env \
    -e API_MODE=false \
    -e RUN_ON_START=false \
    -e ML_EMAIL="$EMAIL" \
    -e ML_PLATFORM="$PLATFORM" \
    -v "${PROJ_DIR}/data/bot/config:/usr/src/microsoft-rewards-script/config" \
    -v "${PROJ_DIR}/data/bot/sessions:/usr/src/microsoft-rewards-script/sessions" \
    -v "${PROJ_DIR}/data/bot/logs:/usr/src/microsoft-rewards-script/logs" \
    -p 7900:7900 \
    --entrypoint scripts/docker/manual-login.sh \
    "$IMG" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
