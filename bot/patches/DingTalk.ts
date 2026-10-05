// DingTalk（钉钉）自定义通知渠道 —— 通过环境变量启用，不依赖上游 config 类型，
// 也不污染上游源码（仅在 Logger 内插入一个调用）。
//
// 环境变量：
//   DINGTALK_ENABLED   : 'true' 才发送
//   DINGTALK_WEBHOOK   : 完整 webhook URL，或仅填 access_token（自动拼 oapi 地址）
//   DINGTALK_SECRET    : 机器人「加签」密钥（可选）；填了会自动带 timestamp+sign
//   DINGTALK_TITLE     : 消息标题前缀（默认 Microsoft Rewards）
//   DINGTALK_MIN_LEVEL : 最低发送级别 info|warn|error（默认 warn）
//   DINGTALK_KEYWORDS  : 额外关键词（逗号分隔），命中即发送（与级别叠加过滤噪音）
//
// 设计：内置过滤，默认只发 error 与含关键摘要词的 info/warn，避免在钉钉里刷屏。

import https from 'node:https'
import crypto from 'node:crypto'

const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function isEnabled(): boolean {
    return process.env.DINGTALK_ENABLED === 'true' &&
        Boolean(process.env.DINGTALK_WEBHOOK || process.env.DINGTALK_ACCESS_TOKEN)
}

function buildUrl(): string {
    const raw = process.env.DINGTALK_WEBHOOK || process.env.DINGTALK_ACCESS_TOKEN || ''
    const url = raw.startsWith('http') ? raw : `https://oapi.dingtalk.com/robot/send?access_token=${raw}`
    const secret = process.env.DINGTALK_SECRET
    if (!secret) return url
    const timestamp = Date.now()
    const sign = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
}

function shouldSend(level: string, message: string): boolean {
    const minLevel = process.env.DINGTALK_MIN_LEVEL || 'warn'
    const rank = LEVEL_RANK[level] ?? 1
    if (rank >= (LEVEL_RANK[minLevel] ?? 2)) return true
    const kws = (process.env.DINGTALK_KEYWORDS ||
        '完成,SUCCESS,collected,points,积分,earned,streak,签到,签退,daily,punch,failed,error,blocked')
        .split(',').map(k => k.trim()).filter(Boolean)
    const lower = message.toLowerCase()
    return kws.some(k => lower.includes(k.toLowerCase()))
}

export function sendDingTalk(message: string, level: string): void {
    if (!isEnabled()) return
    if (!shouldSend(level, message)) return
    const title = process.env.DINGTALK_TITLE || 'Microsoft Rewards'
    const emoji = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅'
    const text =
        `#### ${title} ${emoji}\n\n` +
        `> ${message.replace(/\r?\n/g, '\n> ')}\n\n` +
        `> 时间：${new Date().toLocaleString()}`
    const payload = JSON.stringify({ msgtype: 'markdown', markdown: { title, text } })
    let url: string
    try {
        url = buildUrl()
    } catch {
        return
    }
    let u: URL
    try {
        u = new URL(url)
    } catch {
        return
    }
    const req = https.request({
        hostname: u.hostname,
        protocol: u.protocol ?? 'https:',
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => { res.resume() })
    req.on('error', () => {})
    req.write(payload)
    req.end()
}
