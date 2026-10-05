"use strict";

// =============================================================================
// Microsoft Rewards 中文面板 · 后端
// - 代理机器人 Control API（Bearer 鉴权）：/health /status /points /accounts /
//   /history /sessions /diagnostics /config /schedule /events /start /stop …
// - 实时日志：代理机器人的 /events（SSE），并**保留事件名**（log / status / hello）
// - 账户管理：写入项目 .env（ACCOUNT_N_*）+ 重启机器人容器（经 docker.sock）
// - 手动登录：docker run 同镜像的临时容器（noVNC），浏览器完成 2FA 后自动存会话
// - 会话管理：查看 / 按账号清除
// 字段均以 chiihero @ e0c15a6 的 scripts/api/server.js 实际返回结构为准。
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
const TZ = process.env.TZ || "Asia/Shanghai";
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 5000));
const LOG_REPLAY = Number(process.env.LOG_REPLAY || 200);
// 以下 PANEL_* 都是**面板自有**变量（不是给机器人的 CONFIG_* 覆盖）。
// 加 PANEL_ 前缀是为了和上游白名单的 CONFIG_* 彻底区分开 ——
// 否则 doctor.sh 的变量名校验会把它们误判成"拼错的 CONFIG_*"。
// 机器人容器名（面板经 docker.sock 重启它）
const BOT_CONTAINER = process.env.PANEL_BOT_CONTAINER || "microsoft-rewards-script";
// 项目根 .env 在面板容器内的挂载路径（面板需能回写：增删账户、钉钉配置）
const ENV_FILE = process.env.PANEL_ENV_FILE || "/shared/env/.env";
// 手动登录容器使用的镜像与 noVNC 宿主机端口
const MANUAL_LOGIN_IMAGE =
  process.env.PANEL_MANUAL_LOGIN_IMAGE || "ms-rewards-bot:china";
const MANUAL_LOGIN_PORT = Number(process.env.PANEL_MANUAL_LOGIN_PORT || 7900);
// 会话 / 配置目录：手动登录容器必须挂到与机器人**完全相同**的位置，
// 否则登录成功的会话会落到临时卷里、重启即丢。
//   优先用 bind mount（绝对路径）；为空时回退成命名卷名。
const SESSIONS_BIND = process.env.PANEL_SESSIONS_BIND || "";
const CONFIG_BIND = process.env.PANEL_CONFIG_BIND || "";
const SESSIONS_VOLUME =
  process.env.PANEL_SESSIONS_VOLUME || "rewards_bot_sessions";
const CONFIG_VOLUME = process.env.PANEL_CONFIG_VOLUME || "rewards_bot_config";
// 会话与配置在手动登录容器内的挂载点（与 bot 镜像内路径一致）
const SESSION_MOUNT = "/usr/src/microsoft-rewards-script/sessions";
const CONFIG_MOUNT = "/usr/src/microsoft-rewards-script/config";
const MANUAL_LOGIN_SCRIPT =
  "/usr/src/microsoft-rewards-script/scripts/docker/manual-login.sh";
const DATA_DIR = process.env.DATA_DIR || "/data";
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------------------------------------------------------------------
// 兜底：Node >=15 默认 unhandled rejection 会让进程直接退出（容器随之不断 Restarting，
// 表现为「面板时好时坏 / 一会儿就打不开」）。这里统一兜住并记日志，让面板活着。
// 日志里搜 unhandledRejection / uncaughtException 就能看到真凶。
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack ? reason.stack : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
  // 已经建立的连接大概率还能继续服务；真不行由 Docker healthcheck 重启
});

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
    body !== undefined ? { "Content-Type": "application/json" } : {},
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
  // 读 body 也可能抛（连接被重置 / 上游挂断）——必须自己兜住，
  // 否则这里的 rejection 会一路冒泡把整个面板进程干掉。
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
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
  return x.length === y.length && crypto.timingSafeEqual(x, y);
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
  return (
    safeEqual(decoded.slice(0, sep), DASHBOARD_USERNAME) &&
    safeEqual(decoded.slice(sep + 1), DASHBOARD_PASSWORD)
  );
}

// ⚠️ WWW-Authenticate 的 realm **必须是纯 ASCII**。
// Node 的 storeHeader() 会用 /[^\t\x20-\x7E\x80-\xFF]/ 校验 header 内容，
// realm 里一旦出现中文（这里曾是 `Rewards 面板`），写入响应头时抛
//   TypeError [ERR_INVALID_CHAR]: Invalid character in header content ["WWW-Authenticate"]
// 而该异常发生在 http.Server 的 'request' 事件回调里，等于**每次有人访问面板就把进程打死**
// → 容器不断 Restarting，docker-proxy 还占着端口但转发不到后端，
//   宿主机 curl 127.0.0.1:8890 直接 000，浏览器完全打不开。
// 教训：HTTP header 只能放 ASCII，中文一律放响应体。
function requireAuth(res) {
  try {
    res.writeHead(401, {
      // eslint-disable-next-line no-control-regex
      "WWW-Authenticate": 'Basic realm="Rewards Dashboard", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("需要登录，请在弹出的账号密码框中输入面板账号");
  } catch (err) {
    // 兜底：绝不允许鉴权失败把整个面板带崩
    console.error("[auth] 写 WWW-Authenticate 失败:", err && err.message);
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Docker 集成（经挂载的 /var/run/docker.sock 调 Docker HTTP API）
// ---------------------------------------------------------------------------
function dockerAvailable() {
  return docker.available();
}

async function dockerRestartBot() {
  try {
    await docker.restartContainer(BOT_CONTAINER);
    return true;
  } catch (e) {
    throw new Error(`重启机器人容器失败：${e.message}`);
  }
}

// 手动登录容器的会话/配置挂载：bind mount 优先（可持久化到 ./data），
// 其次才是命名卷。两者都写成 Docker 可接受的 source。
// 注意：compose 里 SESSIONS_BIND 用 ${PWD} 拼绝对路径；若插值失败会变成
// 形如 "/data/bot/sessions" 的"像绝对路径"的值，必须拦掉，
// 否则会挂出一个空目录、登录成功的会话立刻丢失（表现为"登录完又掉线"）。
function isAbsHostPath(p) {
  return (
    typeof p === "string" &&
    (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) &&
    p !== "/" &&
    !p.startsWith("/data") &&
    !p.startsWith("\\data")
  );
}
function sessionBinds() {
  const binds = [];
  if (isAbsHostPath(SESSIONS_BIND)) binds.push(`${SESSIONS_BIND}:${SESSION_MOUNT}`);
  else {
    if (SESSIONS_BIND)
      console.warn(`[server] 忽略无效的 SESSIONS_BIND="${SESSIONS_BIND}"，回退到命名卷。`);
    binds.push(`${SESSIONS_VOLUME}:${SESSION_MOUNT}`);
  }
  if (isAbsHostPath(CONFIG_BIND)) binds.push(`${CONFIG_BIND}:${CONFIG_MOUNT}`);
  else {
    if (CONFIG_BIND)
      console.warn(`[server] 忽略无效的 CONFIG_BIND="${CONFIG_BIND}"，回退到命名卷。`);
    binds.push(`${CONFIG_VOLUME}:${CONFIG_MOUNT}`);
  }
  return binds;
}

// ---------------------------------------------------------------------------
// .env 账户管理
// 变量名单取自 chiihero 实际读取的 ACCOUNT_N_*（拼错会被静默忽略）
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
  } catch (e) {
    throw new Error(`读取 .env 失败（${ENV_FILE}）：${e.message}`);
  }
}

function maxAccountIndex(lines) {
  let max = 0;
  for (const ln of lines) {
    const m = /^ACCOUNT_([1-9]\d*)_EMAIL=/i.exec(ln);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function findAccountIndex(lines, email) {
  const want = String(email || "").trim().toLowerCase();
  for (const ln of lines) {
    const m = /^ACCOUNT_([1-9]\d*)_EMAIL=(.*)$/i.exec(ln);
    if (m && m[2].trim().toLowerCase() === want) return Number(m[1]);
  }
  return null;
}

function isAccountLine(ln, index) {
  return new RegExp(`^ACCOUNT_${index}_`, "i").test(ln);
}

function accountComment(index) {
  return `ACCOUNT ${index} (via dashboard)`;
}

function buildAccountBlock(index, acc) {
  const block = [`${accountComment(index)}`];
  for (const f of ACCOUNT_FIELDS) {
    const val = acc[f];
    if (val === undefined || val === null || String(val).trim() === "")
      continue; // 留空即不写，沿用原值/默认
    block.push(`ACCOUNT_${index}_${f}=${String(val).trim()}`);
  }
  return block;
}

async function upsertAccount(acc) {
  if (!acc || !acc.EMAIL) throw new Error("缺少账号邮箱（EMAIL）");
  const email = String(acc.EMAIL).trim();
  const lines = readEnvLines();
  const index = findAccountIndex(lines, email);
  const isNew = index === null;
  let finalIndex;
  let out;

  if (isNew) {
    finalIndex = maxAccountIndex(lines) + 1;
    const filtered = lines.filter((l) => !isAccountLine(l, finalIndex));
    const next = [...filtered];
    if (next.length && next[next.length - 1].trim() !== "") next.push("");
    next.push(...buildAccountBlock(finalIndex, { ...acc, EMAIL: email }));
    next.push("");
    out = next;
  } else {
    const filtered = lines.filter((l) => !isAccountLine(l, index));
    const idxPos = filtered.findIndex((l) =>
      new RegExp(`^#?\\s*${accountComment(index)}`, "i").test(l),
    );
    const next = [...filtered];
    const block = buildAccountBlock(index, { ...acc, EMAIL: email });
    if (idxPos >= 0) next.splice(idxPos, 1, ...block);
    else next.push("", ...block);
    out = next;
    finalIndex = index;
  }
  fs.writeFileSync(ENV_FILE, out.join("\n"), "utf8");
  return { index: finalIndex, isNew };
}

async function removeAccount(email) {
  const lines = readEnvLines();
  const index = findAccountIndex(lines, email);
  if (index === null) throw new Error(`未找到账号 ${email}`);
  const out = lines.filter(
    (l) =>
      !isAccountLine(l, index) &&
      !new RegExp(`^#?\\s*${accountComment(index)}`, "i").test(l),
  );
  fs.writeFileSync(ENV_FILE, out.join("\n"), "utf8");
  return index;
}

// ---------------------------------------------------------------------------
// 历史积分快照（用于概览趋势图；机器人自身的 /history 只留在内存里）
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
// 用 /points 的账户余额作为当日快照（机器人重启后会失效，故只做趋势参考）
function recordSnapshot(points) {
  const today = new Date().toISOString().slice(0, 10);
  if (!history.pointsByDay[today]) history.pointsByDay[today] = {};
  for (const a of points || []) {
    const email = a.email;
    if (!email) continue;
    history.accounts[email] = { email };
    if (typeof a.balance === "number")
      history.pointsByDay[today][email] = a.balance;
  }
  saveHistory();
}

// ---------------------------------------------------------------------------
// 后端状态轮询
// ---------------------------------------------------------------------------
const backend = {
  reachable: false,
  authOk: true,
  bot: null,
  points: null,
  version: null,
  uptimeSec: null,
  checkedAt: null,
  lastError: null,
};

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
      backend.points = await botRequest("GET", "/points");
      if (backend.points && Array.isArray(backend.points.accounts))
        recordSnapshot(backend.points.accounts);
    } catch {
      /* 积分接口失败不影响状态 */
    }
  } catch (e) {
    backend.reachable = false;
    backend.bot = null;
    backend.points = null;
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
// 静态文件
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
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
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
// SSE 代理：把机器人的 /events 转发给浏览器（保留 log / status / hello 事件名）
// ---------------------------------------------------------------------------
async function proxyStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
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
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      // 机器人在 SSE 中间隔发 "# 注释行"（keep-alive），需原样透传
      res.write(chunk);
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
      bindMode: SESSIONS_BIND ? "bind" : "volume",
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
      points: backend.points,
      history,
      timezone: TZ,
      docker: dockerAvailable(),
    });
  }

  // 账户：新增 / 更新（写 .env + 重启机器人）
  if (pathname === "/api/accounts" && method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!dockerAvailable())
      return sendJson(res, 503, {
        error: "Docker 不可用：面板需挂载 docker.sock 才能写入账户。",
      });
    try {
      const r = await upsertAccount(body);
      await dockerRestartBot();
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

  // 账户：删除
  if (pathname.startsWith("/api/accounts/") && method === "DELETE") {
    const email = decodeURIComponent(pathname.slice("/api/accounts/".length));
    if (!dockerAvailable())
      return sendJson(res, 503, {
        error: "Docker 不可用：面板需挂载 docker.sock 才能删除账户。",
      });
    try {
      const idx = await removeAccount(email);
      await dockerRestartBot();
      return sendJson(res, 200, {
        ok: true,
        message: `已移除 ACCOUNT_${idx}（${email}），机器人已重启。`,
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 手动登录：拉起一次性 noVNC 容器
  if (pathname === "/api/manual-login" && method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const email = String(body.email || "").trim();
    const scope = String(body.scope || "both").trim() || "both";
    if (!email) return sendJson(res, 400, { error: "缺少目标账号邮箱。" });
    if (!dockerAvailable())
      return sendJson(res, 503, {
        error: "Docker 不可用：手动登录需在能访问 docker.sock 的环境运行。",
      });
    try {
      // 把该账号的 ACCOUNT_N_* 原样传进登录容器（含代理，保证出口一致）
      const lines = readEnvLines();
      const idx = findAccountIndex(lines, email);
      const envPass = [];
      if (idx != null) {
        for (const ln of lines) {
          const m = new RegExp(`^ACCOUNT_${idx}_([A-Z_]+)=(.*)$`, "i").exec(ln);
          if (m) envPass.push(`${m[1]}=${m[2]}`);
        }
      }
      const name = "ms-rewards-manual-login";
      await docker.removeContainer(name);
      const id = await docker.runManualLogin({
        name,
        image: MANUAL_LOGIN_IMAGE,
        email,
        scope,
        envPass,
        binds: sessionBinds(),
        port: MANUAL_LOGIN_PORT,
      });
      return sendJson(res, 200, {
        ok: true,
        container: name,
        id: String(id).slice(0, 12),
        vncUrl: `http://<宿主机IP>:${MANUAL_LOGIN_PORT}/vnc.html`,
        message:
          "手动登录容器已启动。请在浏览器打开上面的 noVNC 地址完成微软登录（含 2FA）；" +
          "脚本会在 rewards.bing.com 停留 5 秒后自动保存会话并退出，关闭页面即可。",
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 钉钉推送：钉钉是环境变量驱动，不在 config.json 内 → 写 .env 并重启
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
      const lines = readEnvLines().filter((l) => !/^DINGTALK_/i.test(l));
      const next = [...lines];
      if (next.length && next[next.length - 1].trim() !== "") next.push("");
      next.push("# 钉钉推送（via dashboard）", `DINGTALK_ENABLED=${enabled}`, `DINGTALK_WEBHOOK=${webhook}`, `DINGTALK_SECRET=${secret}`, `DINGTALK_TITLE=${title}`, `DINGTALK_MIN_LEVEL=${minLevel}`, "");
      fs.writeFileSync(ENV_FILE, next.join("\n"), "utf8");
      await dockerRestartBot();
      return sendJson(res, 200, { ok: true, message: "钉钉配置已保存，机器人已重启。" });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // 机器人控制：立即运行 / 停止（透传 Control API）
  if (/^\/api\/bot\/(start|stop|restart)$/.test(pathname) && method === "POST") {
    try {
      const data = await botRequest("POST", pathname.slice("/api/bot".length));
      return sendJson(res, 200, data ?? { ok: true });
    } catch (e) {
      return sendJson(res, e.statusCode || 502, {
        error: e.message,
        hint:
          e.statusCode === 409
            ? "机器人当前状态不允许该操作（可能正在运行或未启动）。"
            : undefined,
      });
    }
  }

  // 其余 GET 透传
  if (pathname.startsWith("/api/bot/") && method === "GET") {
    const apiPath = pathname.slice("/api/bot".length) + (searchParams ? url.search : "");
    try {
      return sendJson(res, 200, await botRequest("GET", apiPath));
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

  // 其余写操作透传
  if (
    pathname.startsWith("/api/bot/") &&
    (method === "PUT" || method === "PATCH" || method === "DELETE")
  ) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const apiPath = pathname.slice("/api/bot".length) + (searchParams ? url.search : "");
    try {
      return sendJson(res, 200, await botRequest(method, apiPath, body));
    } catch (e) {
      return sendJson(res, e.statusCode || 502, { error: e.message });
    }
  }

  return sendJson(res, 404, { error: "未找到接口", path: pathname });
}

// =============================================================================
// 请求入口：**任何**同步抛错都不允许打死进程。
// 之前 requireAuth 里 realm 写了中文 → res.writeHead 抛 ERR_INVALID_CHAR，
// 而这个回调是 http.Server 'request' 事件的同步监听器，抛出的异常无人接，
// 直接把 node 干掉 → 容器 Restarting → docker-proxy 占着端口但后端已死 →
// 宿主机 curl 127.0.0.1:8890 得 000，浏览器完全打不开。
// 这里整体包一层 try/catch：单次请求失败最多断开该连接，面板继续服务。
// =============================================================================
const server = http.createServer((req, res) => {
  try {
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
  } catch (err) {
    console.error(
      "[server] 请求处理异常（已兜住，面板继续运行）:",
      err && err.stack ? err.stack : err,
    );
    try {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("面板内部错误，请查看 docker compose logs rewards-dashboard");
      } else {
        res.destroy();
      }
    } catch {
      /* 连接已断，忽略 */
    }
  }
});

server.listen(PORT, () => {
  console.log(`[server] 中文面板已启动，监听 :${PORT}`);
  console.log(`[server] Control API: ${CONTROL_API_URL}${CONTROL_API_TOKEN ? " (令牌已设置)" : " (无令牌)"}`);
  console.log(`[server] 登录保护: ${AUTH_ENABLED ? `已启用 (${DASHBOARD_USERNAME})` : "未启用"}`);
  console.log(`[server] Docker: ${dockerAvailable() ? "可用" : "不可用（账户/手动登录受限）"}`);
  console.log(`[server] 会话持久化: ${sessionBinds().join("  ")}`);
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
