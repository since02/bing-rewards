#!/usr/bin/env bash
set -euo pipefail

BRANCH="V4-china"
REPO="https://github.com/chiihero/Microsoft-Rewards-Script.git"
DIR="/root/rewards/Microsoft-Rewards-Script"
ACCOUNT_EMAIL="${ACCOUNT_1_EMAIL:-since02@163.com}"
ACCOUNT_PASS="${ACCOUNT_1_PASSWORD:-since002}"

echo "==> [1/6] 检查依赖"
for c in git docker python3; do command -v "$c" >/dev/null 2>&1 || { echo "缺少 $c，请先安装"; exit 1; }; done
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

echo "==> [2/6] 获取代码 ($BRANCH)"
if [ -d "$DIR/.git" ]; then ( cd "$DIR" && git pull ); else git clone -b "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR"

echo "==> [3/6] 写入账号 .env"
[ -f .env ] || cp env.example .env
sed -i "s|^ACCOUNT_1_EMAIL=.*|ACCOUNT_1_EMAIL=${ACCOUNT_EMAIL}|" .env
sed -i "s|^#ACCOUNT_1_PASSWORD=.*|ACCOUNT_1_PASSWORD=${ACCOUNT_PASS}|" .env
sed -i "s|^ACCOUNT_1_LANG_CODE=.*|ACCOUNT_1_LANG_CODE=zh-CN|" .env
sed -i "s|^ACCOUNT_1_GEO_LOCALE=.*|ACCOUNT_1_GEO_LOCALE=CN|" .env

echo "==> [4/6] 写入 DingTalk 通知模块 (src/logging/DingTalk.ts)"
cat > src/logging/DingTalk.ts <<'DT_EOF'
import { httpRequest } from '../util/Http'
import type { HttpRequestConfig } from '../util/Http'
import PQueue from 'p-queue'
import { flushQueue } from './Queue'
import { createHmac } from 'crypto'

const dingTalkQueue = new PQueue({ interval: 1000, intervalCap: 2, carryoverConcurrencyCount: true })

function buildSign(secret: string, timestamp: number): string {
    const stringToSign = `${timestamp}\n${secret}`
    return createHmac('sha256', secret).update(stringToSign).digest('base64')
}

export async function sendDingTalk(_config: unknown, content: string): Promise<void> {
    const token = process.env.DINGTALK_TOKEN
    const secret = process.env.DINGTALK_SECRET
    if (!token) return
    const timestamp = Date.now()
    const sign = secret ? encodeURIComponent(buildSign(secret, timestamp)) : ''
    const url = `https://oapi.dingtalk.com/robot/send?access_token=${token}${secret ? `&timestamp=${timestamp}&sign=${sign}` : ''}`
    const request: HttpRequestConfig = {
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        data: { msgtype: 'text', text: { content } },
        timeout: 10000
    }
    await dingTalkQueue.add(async () => {
        try {
            await httpRequest(request)
        } catch (err) {
            const status = (err as { response?: { status?: number } })?.response?.status
            if (status === 429) return
            console.error('[DingTalk] 发送失败:', err instanceof Error ? err.message : String(err))
        }
    })
}

export function flushDingTalkQueue(timeoutMs = 5000): Promise<void> {
    return flushQueue(dingTalkQueue, timeoutMs)
}
DT_EOF

echo "==> [5/6] 给 index.ts 打补丁（已用真实源码校验插入点）"
git checkout -- src/index.ts 2>/dev/null || true
python3 - <<'PY'
import io
p = 'src/index.ts'
s = io.open(p, encoding='utf-8').read()
assert 'sendDingTalkSummary' not in s, '已打过补丁，请勿重复运行'
a1 = "import { sendClawBot, flushClawBotQueue, ensureClawBotReady } from './logging/ClawBot'"
assert s.count(a1) == 1, 'anchor1'
s = s.replace(a1, a1 + "\nimport { sendDingTalk, flushDingTalkQueue } from './logging/DingTalk'")
a2 = "        flushClawBotQueue(timeoutMs)"
assert s.count(a2) == 1, 'anchor2'
s = s.replace(a2, "        flushClawBotQueue(timeoutMs),\n        flushDingTalkQueue(timeoutMs)")
a3 = "                await this.sendClawBotSummary(allAccountStats, runStartTime, hadWorkerFailure)\n                await flushAllWebhooks()"
assert s.count(a3) == 1, 'anchor3'
s = s.replace(a3, "                await this.sendClawBotSummary(allAccountStats, runStartTime, hadWorkerFailure)\n                await this.sendDingTalkSummary(allAccountStats, runStartTime, hadWorkerFailure)\n                await flushAllWebhooks()")
a4 = "            await this.sendClawBotSummary(accountStats, runStartTime, hadFailure)\n            await flushAllWebhooks()"
assert s.count(a4) == 1, 'anchor4'
s = s.replace(a4, "            await this.sendClawBotSummary(accountStats, runStartTime, hadFailure)\n            await this.sendDingTalkSummary(accountStats, runStartTime, hadFailure)\n            await flushAllWebhooks()")
a5 = "        const content = this.buildSummaryMessage(accountStats, runStartTime, hadWorkerFailure)\n        await sendClawBot(clawbot, content)\n    }"
assert s.count(a5) == 1, 'anchor5'
method = (
    "\n"
    "    private async sendDingTalkSummary(\n"
    "        accountStats: AccountStats[],\n"
    "        runStartTime: number,\n"
    "        hadWorkerFailure: boolean\n"
    "    ): Promise<void> {\n"
    "        const token = process.env.DINGTALK_TOKEN\n"
    "        if (!token) {\n"
    "            return\n"
    "        }\n"
    "\n"
    "        const content = this.buildSummaryMessage(accountStats, runStartTime, hadWorkerFailure)\n"
    "        await sendDingTalk(null, content)\n"
    "    }\n"
)
s = s.replace(a5, a5 + method)
io.open(p, 'w', encoding='utf-8').write(s)
print('index.ts 补丁已应用')
PY

echo "==> [6/6] 向 compose.yaml 注入 PushPlus + 钉钉（幂等）"
if ! grep -q 'DINGTALK_TOKEN' compose.yaml; then
python3 - <<'PY'
import io
p = 'compose.yaml'
s = io.open(p, encoding='utf-8').read()
anchor = "            #CONFIG_CLAWBOT_AUTHFILE: ''             # 凭证路径，默认项目根 clawbot-auth.json"
assert s.count(anchor) == 1, 'compose anchor 未找到'
block = anchor + (
    "\n"
    "            # ── 钉钉推送（本仓库补丁：DingTalk.ts 直接读环境变量）──\n"
    "            DINGTALK_TOKEN: '1a2f3aafa01849d24c03df5fefb29c82d89b181ee121b81d372cf4c269faacca'\n"
    "            DINGTALK_SECRET: 'SECd9a364c482b914a16f2b9a5bb9dbfb8e4c6709b748c962e9ad0b13ccdc3039cb'\n"
    "            # PushPlus 微信推送\n"
    "            CONFIG_PUSHPLUS_ENABLED: 'true'\n"
    "            CONFIG_PUSHPLUS_TOKEN: '11d88ed4d46b4459a7638e3c2c19ebab'\n"
)
s = s.replace(anchor, block)
io.open(p, 'w', encoding='utf-8').write(s)
print('compose.yaml 已注入 PushPlus + 钉钉')
PY
else
    echo "compose.yaml 已含 DINGTALK_TOKEN，跳过注入"
fi

echo "==> 重新构建并启动"
$DC up -d --build
echo "完成。查看日志: $DC logs -f"
