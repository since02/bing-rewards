// 在固定 commit 的源码上打「钉钉补丁」：
//  1) 在 src/logging/Logger.ts 引入并调用 sendDingTalk（仅在 webhook 分支内）
//  2) 把钉钉纳入 hasWebhook 判断，否则只开钉钉时函数会提前 return
//  3) 复制 patches/DingTalk.ts -> src/logging/DingTalk.ts（随 tsc 编译进 dist）
// 本脚本在 Docker builder 阶段、npm run build 之前执行；锚点文本来自固定 commit，
// 若上游更新导致不匹配，脚本会报错（fail-fast），便于及时发现并调整。
import fs from 'node:fs'

const loggerPath = 'src/logging/Logger.ts'
let s = fs.readFileSync(loggerPath, 'utf8')
// 统一换行符为 LF，避免仓库 CRLF 导致多行锚点匹配失败（Linux 构建通常已是 LF，这里兜底）
s = s.replace(/\r\n/g, '\n')

// 1) 引入 DingTalk
const importAnchor = "import { sendTelegram } from './Telegram'"
if (!s.includes("import { sendDingTalk } from './DingTalk'")) {
    s = s.replace(importAnchor, `${importAnchor}\nimport { sendDingTalk } from './DingTalk'`)
}

// 2) hasWebhook 增加钉钉判断
const hasWebhookAnchor =
    '            (config.webhook.telegram?.enabled && config.webhook.telegram.botToken && config.webhook.telegram.chatId)\n        )'
if (!s.includes('DINGTALK_ENABLED')) {
    const replaced = s.replace(
        hasWebhookAnchor,
        "            (config.webhook.telegram?.enabled && config.webhook.telegram.botToken && config.webhook.telegram.chatId) ||\n            (process.env.DINGTALK_ENABLED === 'true' && Boolean(process.env.DINGTALK_WEBHOOK || process.env.DINGTALK_ACCESS_TOKEN))\n        )"
    )
    if (replaced === s) {
        throw new Error('[patch] 未找到 hasWebhook 锚点，上游 Logger.ts 可能已变更，请检查补丁。')
    }
    s = replaced
}

// 3) 在 telegram 发送后调用钉钉
const sendAnchor = 'sendTelegram(config.webhook.telegram, cleanMsg, level)'
if (!s.includes('sendDingTalk(cleanMsg, level)')) {
    const replaced = s.replace(
        sendAnchor,
        `${sendAnchor}\n                if (process.env.DINGTALK_ENABLED === 'true') {\n                    sendDingTalk(cleanMsg, level)\n                }`
    )
    if (replaced === s) {
        throw new Error('[patch] 未找到 sendTelegram 调用锚点，上游 Logger.ts 可能已变更，请检查补丁。')
    }
    s = replaced
}

fs.writeFileSync(loggerPath, s)

// 4) 复制 DingTalk.ts 到源码目录（随 tsc 编译）
fs.copyFileSync('patches/DingTalk.ts', 'src/logging/DingTalk.ts')
console.log('[patch] DingTalk 集成已应用（Logger.ts 引入 + 调用 + src/logging/DingTalk.ts）')
