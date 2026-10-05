#!/usr/bin/env bash
# 容器侧：Docker 内手动登录封装
# 作用：生成 config.json → 启动虚拟桌面(Xvfb) + noVNC → 运行 manualLogin（可见浏览器）
# 用户在本机浏览器打开 http://localhost:7900/vnc.html 完成微软登录（含 2FA / 验证码），
# 停留在 rewards.bing.com 满 5 秒后自动保存会话并退出。会话与自动运行共用，落盘到 sessions/。
set -euo pipefail

export PLAYWRIGHT_BROWSERS_PATH=0
export DISPLAY=:99
export FORCE_HEADLESS=0
SCRIPT_DIR=/usr/src/microsoft-rewards-script
cd "$SCRIPT_DIR"

echo "[manual-login] 生成 config.json（如已存在则应用 CONFIG_* 覆盖）..."
node dist/util/ConfigSync.js sync --config config/config.json --example config.example.json
node dist/util/ConfigEnvOverrides.js apply --config config/config.json
ln -sf config/config.json config.json

echo "[manual-login] 启动虚拟桌面 Xvfb :99 ..."
Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2

echo "[manual-login] 启动 noVNC（本机浏览器访问 http://localhost:7900/vnc.html）..."
x11vnc -display :99 -nopw -forever -rfbport 5900 >/dev/null 2>&1 &
X11VNC_PID=$!
websockify --web=/usr/share/novnc 7900 localhost:5900 >/dev/null 2>&1 &
WS_PID=$!
sleep 2

cleanup() {
    kill "$XVFB_PID" "$X11VNC_PID" "$WS_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "=================================================================="
echo " 请在【本机】浏览器打开： http://localhost:7900/vnc.html"
echo " 在弹出的 Chromium 窗口里手动完成微软登录（含 2FA / 验证码）。"
echo " 一旦停留在 rewards.bing.com 满 5 秒，脚本会自动保存会话并退出。"
echo " 目标邮箱: ${ML_EMAIL:-（未设置，请用 -e ML_EMAIL= 传入）}"
echo " 会话平台: ${ML_PLATFORM:-both}  （mobile / desktop / both）"
echo "=================================================================="

: "${ML_EMAIL:?必须通过 -e ML_EMAIL=邮箱 指定要登录的账号}"
# "$@" 透传额外开关（例如 --fresh 丢弃旧 cookie 重新登录）
node "$SCRIPT_DIR/scripts/main/manualLogin.js" --email "$ML_EMAIL" --platform "${ML_PLATFORM:-both}" "$@"
RC=$?
if [ "$RC" -eq 0 ]; then
    echo "[manual-login] 会话已保存，写入 sessions/ 下的 SQLite（与自动运行共用）。"
else
    echo "[manual-login] 登录未完成或出错（退出码 $RC），会话未写入。"
fi
exit "$RC"
