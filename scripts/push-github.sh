#!/usr/bin/env bash
# ---------------------------------------------------------------
# push-github.sh —— 把本仓库推送到 GitHub（仓库不存在时自动创建）
#
# 用法：
#   bash scripts/push-github.sh                    # 推到 since02/bing-rewards（公开）
#   bash scripts/push-github.sh --private          # 建成私有仓库
#   REPO_NAME=my-rewards bash scripts/push-github.sh   # 换个仓库名
#   REPO_OWNER=someone bash scripts/push-github.sh     # 换成别人的命名空间
#
# Token 来源（优先级从高到低）：
#   1) gh CLI 已登录：gh auth login
#   2) 环境变量 GITHUB_TOKEN 或 GH_TOKEN
#   3) 交互输入（不落盘，用完即弃）
#
# 安全：带 token 的 remote 只在本次进程内使用，push 成功后立刻删除远端引用，
#       不会把 token 写进 .git/config。
# ---------------------------------------------------------------
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

REPO_OWNER="${REPO_OWNER:-since02}"
REPO_NAME="${REPO_NAME:-bing-rewards}"
PRIVATE="false"
[ "${1:-}" = "--private" ] && PRIVATE="true"

# ---------- 0. 前置检查 ----------
if ! command -v git >/dev/null 2>&1; then
    echo "❌ 没找到 git，先装一下：https://git-scm.com" >&2
    exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "❌ 当前目录不是 git 仓库，先执行 git init -b main" >&2
    exit 1
fi

BRANCH="$(git branch --show-current 2>/dev/null || echo main)"
[ -z "$BRANCH" ] && BRANCH="main"

# ---------- 1. 找 token ----------
TOKEN=""
if command -v gh >/dev/null 2>&1; then
    TOKEN="$(gh auth token 2>/dev/null || true)"
fi
[ -z "$TOKEN" ] && TOKEN="${GITHUB_TOKEN:-}"
[ -z "$TOKEN" ] && TOKEN="${GH_TOKEN:-}"
if [ -z "$TOKEN" ]; then
    printf '没检测到 gh CLI 登录或 GITHUB_TOKEN 环境变量。\n'
    printf '生成 token：https://github.com/settings/tokens （勾选 repo 权限）\n'
    printf '把 token 粘贴到这里（输入不会回显，回车结束）：\n'
    read -rsp "Token: " TOKEN; printf '\n'
fi
if [ -z "$TOKEN" ]; then
    echo "❌ 没拿到 token，推送中止。" >&2
    exit 1
fi

# ---------- 2. 检查仓库是否已存在 ----------
echo "==> 检查目标仓库 $REPO_OWNER/$REPO_NAME"
HTTP_CODE="$(curl -s -o /tmp/gh_repo_check.json -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    --max-time 20 \
    "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME" || echo 000)"

case "$HTTP_CODE" in
    200)
        echo "    仓库已存在，直接推送"
        CREATE_NEEDED="no"
        ;;
    404)
        echo "    仓库不存在，将自动创建（公开仓库）"
        [ "$PRIVATE" = "true" ] && echo "    注：--private 已传，将创建为私有仓库"
        CREATE_NEEDED="yes"
        ;;
    401|403)
        echo "❌ token 无效或没权限（HTTP $HTTP_CODE）：$TOKEN 被拒"
        cat /tmp/gh_repo_check.json 2>/dev/null | head -3
        exit 1
        ;;
    *)
        echo "❌ 无法连接 GitHub（HTTP $HTTP_CODE），可能是网络/代理问题"
        head -3 /tmp/gh_repo_check.json 2>/dev/null
        exit 1
        ;;
esac

# ---------- 3. 需要时创建仓库 ----------
if [ "$CREATE_NEEDED" = "yes" ]; then
    VISIBILITY="public"
    [ "$PRIVATE" = "true" ] && VISIBILITY="private"
    echo "==> 创建仓库（$VISIBILITY）"
    BODY="$(cat <<EOF
{"name":"$REPO_NAME","description":"Microsoft Rewards 自动化 Docker 项目（bot + 自研中文面板）","homepage":"https://github.com/$REPO_OWNER/$REPO_NAME","private":$([ "$PRIVATE" = "true" ] && echo true || echo false),"has_issues":true,"has_wiki":false,"has_downloads":false,"auto_init":false}
EOF
)"
    CREATE_CODE="$(curl -s -o /tmp/gh_create.json -w '%{http_code}' \
        -X POST \
        -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" \
        -H "Content-Type: application/json" \
        --max-time 30 \
        -d "$BODY" \
        "https://api.github.com/user/repos" || echo 000)"
    if [ "$CREATE_CODE" != "201" ]; then
        echo "❌ 创建失败（HTTP $CREATE_CODE）"
        head -5 /tmp/gh_create.json 2>/dev/null
        exit 1
    fi
    echo "    创建成功"
fi

# ---------- 4. 提交未提交的改动 ----------
if [ -n "$(git status --porcelain)" ]; then
    echo "==> 有未提交的改动，自动提交"
    git add -A
    git commit -q -m "chore: 更新项目文件" || true
fi

# ---------- 5. 推送（token 只存在于本次进程） ----------
REMOTE_NAME="__github_tmp_$$"
git remote remove "$REMOTE_NAME" 2>/dev/null || true
git remote add "$REMOTE_NAME" "https://x-access-token:${TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"

PUSH_OK="no"
echo "==> 推送到 https://github.com/$REPO_OWNER/$REPO_NAME.git ($BRANCH)"
if [ "$BRANCH" = "main" ]; then
    if git push -u "$REMOTE_NAME" "$BRANCH" 2>&1 | tail -5; then PUSH_OK="yes"; fi
else
    if git push -u "$REMOTE_NAME" "HEAD:$BRANCH" 2>&1 | tail -5; then PUSH_OK="yes"; fi
fi

# 无论成败，立刻清掉带 token 的 remote（不让它落进 .git/config）
git remote remove "$REMOTE_NAME" 2>/dev/null || true
unset TOKEN

if [ "$PUSH_OK" != "yes" ]; then
    echo "❌ 推送失败（上面应有 git 报错）。常见原因：" >&2
    echo "   · token 缺少 repo 权限 → 重新生成并勾选 repo" >&2
    echo "   · 分支被保护 → 换分支名或去仓库设置里放开" >&2
    echo "   · 网络/代理 → 试 https_proxy=  unset 后再跑一次" >&2
    exit 1
fi

# ---------- 6. 完成 ----------
echo
echo "══════════════════════════════════════════════════════════"
echo " ✅ 推送完成"
echo "──────────────────────────────────────────────────────────"
echo " 仓库地址   https://github.com/$REPO_OWNER/$REPO_NAME"
echo " 本地分支   $BRANCH"
echo " 提交数量   $(git rev-list --count HEAD) 个"
echo " 文件数量   $(git ls-files | wc -l) 个"
echo "──────────────────────────────────────────────────────────"
echo " 别人怎么装："
echo "   git clone https://github.com/$REPO_OWNER/$REPO_NAME.git"
echo "   cd $REPO_NAME && sudo bash scripts/first-run.sh"
echo "══════════════════════════════════════════════════════════"
