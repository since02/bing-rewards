"use strict";

// =============================================================================
// Microsoft Rewards 中文面板（自建，零运行时依赖）
// - 代理机器人 Control API（Bearer 鉴权），复用其全部端点
// - 实时日志：代理 bot 的 /events SSE
// - 账户管理：写入项目 .env（ACCOUNT_N_*）+ 重启 bot 容器（docker.sock）
// - 手动登录：docker run 同镜像的 noVNC 容器，浏览器打开即可完成 2FA
// - 会话管理：查看 / 清除会话
// =============================================================================

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const docker = require("./lib/dockerSocket");

const PORT = Number(process.env.PORT || 8890);
const CONTROL_API_URL = String(
  process.env.CONTROL_API_URL || "http://microsoft-rewards-script:3010",
).replace(/\/+$/, "");
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN || "";
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const AUTH_ENABLED = Boolean(DASHBOARD_USERNAME && DASHBOARD_PASSWORD);
const TZ = process.env.TZ || "UTC";
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 5000));
const LOG_REPLAY = Number(process.env.LOG_REPLAY || 200);
const BOT_CONTAINER = process.env.BOT_CONTAINER || "microsoft-rewards-script";
const ENV_FILE = process.env.ENV_FILE || "/shared/env/.env";
const MANUAL_LOGIN_IMAGE =
  process.env.MANUAL_LOGIN_IMAGE || "ms-rewards-bot:china";
const MANUAL_LOGIN_PORT = Number(process.env.MANUAL_LOGIN_PORT || 7900);
const SESSIONS_VOLUME =
  process.env.SESSIONS_VOLUME || "rewards_bot_sessions";
const CONFIG_VOLUME = process.env.CONFIG_VOLUME || "rewards_bot_config";
const DATA_DIR = process.env.DATA_DIR || "/data";
const PUBLIC_DIR = path.join(__dirname, "public");

const HISTORY_FILE = path.join(DATA_DIR, "history.json");

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function botHeaders(extra) {
  const h = { Accept: "application/json", ...(extra || {}) };
  if (CONTROL_API_TOKEN) h.Authorization = `Bearer ${CONTROL_API_TOKEN}`;
  return h;
}

async function botRequest(method, apiPath, body, timeoutMs = 12000) {
  const url = CONTROL_API_URL + apiPath;
  const headers = botHeaders(
    body !== undefined
      ? { "Content-Type": "application/json" }
      : {},
  );
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(`无法连接机器人 Control API：${e.message}`);
    err.statusCode = 502;
    throw err;
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = new Error(
      (data && (data.error || data.message)) || `请求失败 (${res.status})`,
    );
    err.statusCode = res.status;
    err.body = data;
    throw err;
  }
  return data ?? {};
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function readJsonBody(req, limitBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        req.destroy();
        reject(new Error("请求体过大"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON 格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return (
    x.length === y.length && crypto.timingSafeEqual(x, y)
  );
}

function isAuthorized(req) {
  if (!AUTH_ENABLED) return true;
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return false;
  const m = auth.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  return safeEqual(
    decoded.slice(0, sep),
    DASHBOARD_USERNAME,
  ) && safeEqual(decoded.slice(sep + 1), DASHBOARD_PASSWORD);
}

function requireAuth(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Rewards 面板", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("需要登录");
}

// ---------------------------------------------------------------------------
// Docker 集成（通过挂载的 /var/run/docker.sock，使用 Docker HTTP API）
// ---------------------------------------------------------------------------
function dockerAvailable() {
  return docker.available();
}

function dockerRestartBot() {
  try {
    docker.restartContainer(BOT_CONTAINER);
    return true;
  } catch (e) {
    throw new Error(`重启机器人容器失败：${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// .env 账户管理
// ---------------------------------------------------------------------------
const ACCOUNT_FIELDS = [
  "EMAIL",
  "PASSWORD",
  "TOTP_SECRET",
  "RECOVERY_EMAIL",
  "LANG_CODE",
  "GEO_LOCALE",
  "PROXY_HTTP",
  "PROXY_URL",
  "PROXY_PORT",
  "PROXY_USERNAME",
  "PROXY_PASSWORD",
  "SAVE_FINGERPRINT_MOBILE",
  "SAVE_FINGERPRINT_DESKTOP",
];

function readEnvLines() {
  try {
    return fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

// 返回 { lines, maxIndex }；maxIndex 为当前最大的 ACCOUNT_N_ 编号（无则 0）
function parseEnv(lines) {
  const maxIndex = { value: 0 };
  for (const ln of lines) {
    const m = /^ACCOUNT_([1-9]\d*)_EMAIL=/i.exec(ln);
    if (m) maxIndex.value = Math.max(maxIndex.value, Number(m[1]));
  }
  return maxIndex;
}

function findAccountIndex(lines, email) {
  for (const ln of lines) {
    const m = /^ACCOUNT_([1-9]\d*)_EMAIL=(.*)$/i.exec(ln);
    if (m && m[2].trim().toLowerCase() === String(email).trim().toLowerCase())
      return Number(m[1]);
  }
  return null;
}

function isAccountLine(ln, index) {
  return new RegExp(`^ACCOUNT_${index}_`, "i").test(ln);
}

function buildAccountBlock(index, acc) {
  const block = [];
  for (const f of ACCOUNT_FIELDS) {
    let key = `ACCOUNT_${index}_${f}`;
    let val = acc[f];
    if (f === "PROXY_HTTP") key = `ACCOUNT_${index}_PROXY_HTTP`;
    if (val === undefined || val === null || val === "")
      continue; // 空值不写，沿用默认
    block.push(`${key}=${String(val)}`);
  }
  return block;
}

// 新增或更新账户；返回写入后的新编号（新增）或已有编号（更新）
function upsertAccount(acc) {
  if (!acc || !acc.EMAIL)
    throw new Error("缺少账号邮箱（EMAIL）");
  const email = String(acc.EMAIL).trim();
  const lines = readEnvLines();
  let index = findAccountIndex(lines, email);
  const isNew = index === null;
  if (isNew) {
    index = parseEnv(lines).value + 1;
    // 找一个干净的位置：删除任何残留的同编号行，再追加
    const filtered = lines.filter((l) => !isAccountLine(l, index));
    const newLines = [...filtered];
    if (newLines.length && newLines[newLines.length - 1].trim() !== "")
      newLines.push("");
    newLines.push(`# Account ${index} (added via dashboard)`);
    newLines.push(...buildAccountBlock(index, { ...acc, EMAIL: email }));
    newLines.push("");
    fs.writeFileSync(ENV_FILE, newLines.join("\n"), "utf8");
  } else {
    const filtered = lines.filter((l) => !isAccountLine(l, index));
    const idxPos = filtered.findIndex((l) =>
      new RegExp(`^#\\s*Account\\s*${index}\\b`, "i").test(l),
    );
    const newLines = [...filtered];
    const block = buildAccountBlock(index, { ...acc, EMAIL: email });
    if (idxPos >= 0) {
      newLines.splice(idxPos + 1, 0, ...block);
    } else {
      newLines.push(`# Account ${index} (updated via dashboard)`);
      newLines.push(...block);
    }
    fs.writeFileSync(ENV_FILE, newLines.join("\n"), "utf8");
  }
  return { index, isNew };
}

function removeAccount(email) {
  const lines = readEnvLines();
  const index = findAccountIndex(lines, email);
 if (index === null)
    throw new Error(`未找到账号 ${email}`);
  const filtered = lines.filter(
    (l) => !isAccountLine(l, index) &&
      !new RegExp(`^#\\s*Account\\s*${index}\\b`, "i").test(l),
  );
  fs.writeFileSync(ENV_FILE, filtered.join("\n"), "utf8");
  return index;
}

// ---------------------------------------------------------------------------
// 历史数据存储（每日积分快照，用于概览图表）
// ---------------------------------------------------------------------------
let history = { accounts: {}, pointsByDay: {} };
function loadHistory() {
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (!history.accounts) history.accounts = {};
    if (!history.pointsByDay) history.pointsByDay = {};
  } catch {
    history = { accounts: {}, pointsByDay: {} };
  }
}
function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), "utf8");
  } catch (e) {
    console.warn(`[server] 无法写入历史文件: ${e.message}`);
  }
}
function recordSnapshot(accounts) {
  const today = new Date().toISOString().slice(0, 10);
  if (!history.pointsByDay[today]) history.pointsByDay[today] = {};
  for (const a of accounts || []) {
    if (!a.email) continue;
    history.accounts[a.email] = {
      email: a.email,
      langCode: a.langCode,
      geoLocale: a.geoLocale,
    };
    if (typeof a.points === "number")
      history.pointsByDay[today][a.email] = a.points;
  }
  saveHistory();
}

// ---------------------------------------------------------------------------
// 实时状态轮询（供 /api/summary 使用，并定期记录历史）
// ---------------------------------------------------------------------------
const backend = {
  reachable: false,
  authOk: true,
  bot: null,
  version: null,
  uptimeSec: null,
  checkedAt: null,
  lastError: null,
};
let lastHistoryDay = null;

async function pollOnce() {
  try {
    const health = await botRequest("GET", "/health");
    backend.reachable = true;
    backend.authOk = true;
    backend.version = health.version || null;
    backend.uptimeSec =
      typeof health.uptimeSec === "number" ? health.uptimeSec : null;
    backend.lastError = null;
    backend.checkedAt = new Date().toISOString();
    backend.bot = await botRequest("GET", "/status");
    try {
      const acc = await botRequest("GET", "/accounts");
      const list = (acc.accounts || []).map((x) => ({
        email: x.email,
        points: x.points,
        langCode: x.langCode,
        geoLocale: x.geoLocale,
        configured: x.configured,
      }));
      recordSnapshot(list);
      const day = new Date().toISOString().slice(0, 10);
      if (day !== lastHistoryDay) {
        lastHistoryDay = day;
      }
    } catch {
      // 账户接口失败时不影响状态
    }
  } catch (e) {
    backend.reachable = false;
    backend.bot = null;
    backend.lastError = e.message;
    backend.checkedAt = new Date().toISOString();
    backend.authOk = e.statusCode === 401 ? false : true;
  }
}

function startPolling() {
  (async function loop() {
    for (;;) {
      await pollOnce();
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();
}

// ---------------------------------------------------------------------------
// 静态文件 + 主题
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("未找到");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// SSE 代理：把 bot 的 /events 实时日志流转发给浏览器
// ---------------------------------------------------------------------------
async function proxyStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  let upstream;
  try {
    upstream = await fetch(
      `${CONTROL_API_URL}/events?replay=${LOG_REPLAY}`,
      { headers: botHeaders({ Accept: "text/event-stream" }) },
    );
    if (!upstream.ok || !upstream.body) throw new Error("上游 SSE 不可用");
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
    return res.end();
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // 直接转发 bot 的 SSE 帧（已是正确的 text/event-stream 格式）
      res.write(buf);
      buf = "";
    }
  };
  try {
    await pump();
  } catch (e) {
    console.warn(`[server] SSE 上游中断: ${e.message}`);
  } finally {
    try {
      res.end();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || "GET";

  if (pathname === "/api/stream" && method === "GET") {
    return proxyStream(req, res);
  }

  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      controlApi: backend.reachable,
      controlApiAuthOk: backend.authOk,
      docker: dockerAvailable(),
    });
  }

  if (pathname === "/api/summary" && method === "GET") {
    return sendJson(res, 200, {
      reachable: backend.reachable,
      authOk: backend.authOk,
      lastError: backend.lastError,
      checkedAt: backend.checkedAt,
      version: backend.version,
      uptimeSec: backend.uptimeSec,
      bot: backend.bot,
      history,
      timezone: TZ,
    });
  }

  // 账户管理（写入 .env + 重启 bot）
  if (pathname === "/api/accounts" && method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!dockerAvailable())
      return sendJson(res, 503, {
        error: "Docker 不可用：面板需挂载 docker.sock 才能管理账户。",
      });
    try {
      const r = upsertAccount(body);
      dockerRestartBot();
      return sendJson(res, 200, {
        ok: true,
        index: r.index,
        isNew: r.isNew,
        message: `账户已${r.isNew ? "添加" : "更新"}（ACCOUNT_${r.index}），机器人已重启以加载新账户。`,
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (
    pathname.startsWith("/api/accounts/") &&
    method === "DELETE"
  ) {
    const email = decodeURIComponent(pathname.slice("/api/accounts/".length));
    if (!dockerAvailable())
      return sendJson(res, 503, {
        error: "Docker 不可用：面板需挂载 docker.sock 才能管理账户。",
      });
    try {
      const idx = removeAccount(email);
      dockerRestartBot();
      return sendJson(res, 200, {
        ok: true,
        message: `已移除 ACCOUNT_${idx}（${email}），机器人已重启。`,
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 手动登录（docker run noVNC 容器）
  if (pathname === "/api/manual-login" && method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const email = String(body.email || "").trim();
    const scope = String(body.scope || "both");
    if (!email)
      return sendJson(res, 400, { error: "缺少目标账号邮箱。" });
    if (!dockerAvailable())
      return sendJson(res, 503, {
        error: "Docker 不可用：手动登录需在可访问 docker.sock 的环境运行。",
      });
    try {
      // 找到该邮箱对应的 ACCOUNT_N_ 编号，传入容器以便复用配置
      const lines = readEnvLines();
      const idx = findAccountIndex(lines, email);
      const envPass = [];
      if (idx != null) {
        for (const ln of lines) {
          const m = new RegExp(`^ACCOUNT_${idx}_([A-Z_]+)=(.*)$`, "i").exec(ln);
          if (m) envPass.push(`${m[1]}=${m[2]}`);
        }
      }
      const containerName = `ms-rewards-manual-login`;
      await docker.removeContainer(containerName);
      await docker.runManualLogin({
        name: containerName,
        image: MANUAL_LOGIN_IMAGE,
        email,
        scope,
        envPass,
        sessionsVolume: SESSIONS_VOLUME,
        configVolume: CONFIG_VOLUME,
        port: MANUAL_LOGIN_PORT,
      });
      return sendJson(res, 200, {
        ok: true,
        container: containerName,
        vncUrl: `http://localhost:${MANUAL_LOGIN_PORT}/vnc.html`,
        message: `手动登录容器已启动。请在浏览器打开 vncUrl 完成登录（含 2FA）。登录成功后关闭页面即可，会话会自动保存。`,
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 钉钉推送：写入 .env 的 DINGTALK_* 并重启 bot（钉钉为环境变量驱动，不在 config.json 内）
  if (pathname === "/api/push/dingtalk" && method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!dockerAvailable())
      return sendJson(res, 503, {
        error: "Docker 不可用：保存钉钉配置需重启机器人容器。",
      });
    try {
      const enabled = body.enabled ? "true" : "false";
      const webhook = String(body.webhook || "").trim();
      const secret = String(body.secret || "").trim();
      const title = String(body.title || "Microsoft Rewards").trim();
      const minLevel = String(body.minLevel || "warn").trim();
      const lines = readEnvLines().filter(
        (l) => !/^DINGTALK_/i.test(l),
      );
      const newLines = [...lines];
      if (newLines.length && newLines[newLines.length - 1].trim() !== "")
        newLines.push("");
      newLines.push("# 钉钉推送（via dashboard）");
      newLines.push(`DINGTALK_ENABLED=${enabled}`);
      newLines.push(`DINGTALK_WEBHOOK=${webhook}`);
      newLines.push(`DINGTALK_SECRET=${secret}`);
      newLines.push(`DINGTALK_TITLE=${title}`);
      newLines.push(`DINGTALK_MIN_LEVEL=${minLevel}`);
      newLines.push("");
      fs.writeFileSync(ENV_FILE, newLines.join("\n"), "utf8");
      dockerRestartBot();
      return sendJson(res, 200, {
        ok: true,
        message: "钉钉配置已保存，机器人已重启。",
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 透传机器人其余端点
  if (pathname.startsWith("/api/bot/") && method === "GET") {
    const apiPath = pathname.slice("/api/bot".length) + url.search;
    try {
      const data = await botRequest("GET", apiPath);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, e.statusCode || 502, {
        error: e.message,
        hint:
          e.statusCode === 401
            ? "Control API 拒绝了令牌：CONTROL_API_TOKEN 必须与机器人的 API_TOKEN 一致。"
            : undefined,
      });
    }
  }

  if (pathname.startsWith("/api/bot/") && (method === "PUT" || method === "PATCH" || method === "POST" || method === "DELETE")) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const apiPath = pathname.slice("/api/bot".length) + url.search;
    try {
      const data = await botRequest(method, apiPath, body);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, e.statusCode || 502, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: "未找到接口", path: pathname });
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) return requireAuth(res);
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, url).catch((e) => {
      console.error(`[server] 请求失败: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
  }
  return serveStatic(res, pathname);
});

server.listen(PORT, () => {
  console.log(`[server] 中文面板已启动，监听 :${PORT}`);
  console.log(`[server] Control API: ${CONTROL_API_URL}${CONTROL_API_TOKEN ? " (令牌已设置)" : " (无令牌)"}`);
  console.log(`[server] 登录保护: ${AUTH_ENABLED ? `已启用 (用户: ${DASHBOARD_USERNAME})` : "未启用"}`);
  console.log(`[server] Docker: ${dockerAvailable() ? "可用" : "不可用（账户管理/手动登录将受限）"}`);
  loadHistory();
  startPolling();
});

function shutdown() {
  console.log("[server] 正在关闭…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
