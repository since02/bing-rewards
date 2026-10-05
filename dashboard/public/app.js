// =============================================================================
// Microsoft Rewards 中文面板 · 前端
// 所有字段名以 chiihero @ e0c15a6 的 scripts/api/server.js 实际返回为准。
// =============================================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNum(n) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return "–";
  return Number(n).toLocaleString("zh-CN");
}
function fmtDateTime(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleString("zh-CN", { hour12: false });
}
function fmtRelative(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
function fmtDuration(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return "–";
  const s = Math.round(Number(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { Accept: "application/json" },
    ...(opts || {}),
  });
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {}
    throw new Error(
      (data && (data.error || data.message)) || `请求失败 (${res.status})`,
    );
  }
  return res.json();
}
function botGet(p) {
  return api("/api/bot" + p);
}
async function botSend(method, p, body) {
  return api("/api/bot" + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

let toastHost = null;
function toast(msg, kind = "info") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-host";
    document.body.appendChild(toastHost);
  }
  const n = document.createElement("div");
  n.className = `toast toast--${kind}`;
  n.textContent = msg;
  toastHost.appendChild(n);
  setTimeout(() => {
    n.classList.add("toast--out");
    setTimeout(() => n.remove(), 200);
  }, 4200);
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const state = { summary: null };
const mounted = new Set();
let refreshTimer = null;

const els = {
  statusBadge: $("#statusBadge"),
  statusText: $("#statusText"),
  tabBar: $("#tabBar"),
  tabPanels: $("#tabPanels"),
  footerStatus: $("#footerStatus"),
  footerVersion: $("#footerVersion"),
};

function renderStatus() {
  const s = state.summary;
  const badge = els.statusBadge;
  badge.classList.remove(
    "status-unknown",
    "status-down",
    "status-warn",
    "status-live",
  );
  const busy = s?.bot?.state && s.bot.state !== "idle";
  let text = "连接中…";
  if (s) {
    if (!s.reachable) text = "机器人离线";
    else if (s.authOk === false) text = "令牌被拒绝";
    else if (s.docker === false) text = "已连接（Docker 未挂载）";
    else text = busy ? "运行中" : "已连接";
  }
  badge.classList.add(
    !s ? "status-unknown" : !s.reachable ? "status-down" : s.authOk === false ? "status-warn" : "status-live",
  );
  els.statusText.textContent = text;
  els.footerStatus.textContent = text;
  els.footerVersion.textContent = `机器人版本：${s?.version || "–"}`;
}

async function pollSummary() {
  try {
    state.summary = await api("/api/summary");
  } catch (e) {
    state.summary = { reachable: false, lastError: e.message };
  }
  renderStatus();
  currentView()?.onState?.(state.summary);
}

// ---------------------------------------------------------------------------
// 标签页框架
// ---------------------------------------------------------------------------
// 每个视图都是一个**工厂函数**（返回 {id,label,interval,mount,refresh} 对象，
// 因为 mount/refresh 需要各自的闭包变量 root），所以这里必须 .map(f => f()) 调用它们，
// 直接把函数塞进数组会让 v.id / v.label 全是 undefined —— 标签页渲染成
// "tab-btn-undefined"，activate() 里所有 view.id 相等互相覆盖，
// 结果就是「状态栏能显示已连接，但整个内容区一片空白」。
const VIEWS = [
  overview,
  controlsView,
  accountsView,
  runsView,
  logsView,
  scheduleView,
  pushView,
  sessionsView,
  configView,
  diagnosticsView,
].map((makeView) => makeView());

function initTabs() {
  els.tabBar.innerHTML = VIEWS.map(
    (v) =>
      `<button type="button" role="tab" class="tab" id="tab-btn-${v.id}" aria-controls="tab-panel-${v.id}" data-tab="${v.id}">${esc(v.label)}</button>`,
  ).join("");
  els.tabPanels.innerHTML = VIEWS.map(
    (v) =>
      `<div class="tab-panel" id="tab-panel-${v.id}" role="tabpanel" hidden></div>`,
  ).join("");

  els.tabBar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (btn) location.hash = btn.dataset.tab;
  });
  window.addEventListener("hashchange", () => activate(location.hash.slice(1)));
  activate(location.hash.slice(1));
}

function currentView() {
  return VIEWS.find((v) => v.id === state.activeTab);
}

function activate(id) {
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  if (!view) return;
  if (state.activeTab === view.id) return;
  state.activeTab = view.id;
  for (const v of VIEWS) {
    const on = v.id === view.id;
    const btn = $(`#tab-btn-${v.id}`);
    const panel = $(`#tab-panel-${v.id}`);
    if (btn) btn.classList.toggle("tab--active", on);
    if (panel) panel.hidden = !on;
  }
  const panel = $(`#tab-panel-${view.id}`);
  if (!panel) return;
  if (!mounted.has(view.id)) {
    try {
      view.mount(panel);
    } catch (e) {
      panel.innerHTML = `<p class="empty">该模块渲染失败：${esc(e.message)}</p>`;
      console.error(`[tab:${view.id}] mount 失败`, e);
    }
    mounted.add(view.id);
  }
  refreshActive(true);
  clearInterval(refreshTimer);
  if (view.interval)
    refreshTimer = setInterval(() => refreshActive(false), view.interval);
}

async function refreshActive() {
  const view = currentView();
  if (!view || !view.refresh) return;
  try {
    await view.refresh();
  } catch (e) {
    console.error(e);
  }
}

function stateLabel(k) {
  return (
    {
      idle: "空闲",
      running: "运行中",
      starting: "启动中",
      stopping: "停止中",
      unknown: "未知",
    }[k] || k
  );
}

// ===========================================================================
// 1) 概览
// ===========================================================================
function overview() {
  let root = null;
  return {
    id: "overview",
    label: "概览",
    interval: 10000,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>机器人状态</h2>
          <div id="ovStatus" class="kv"></div>
        </section>
        <section class="panel">
          <h2>账户积分（实时）</h2>
          <div id="ovPoints" class="cards"></div>
        </section>
        <section class="panel">
          <h2>积分余额趋势（每日快照）</h2>
          <div id="ovChart" class="chart"></div>
        </section>`;
    },
    async refresh() {
      if (!root) return;
      const s = state.summary;
      const b = s?.bot;
      const run = b?.run;
      $("#ovStatus", root).innerHTML = `
        <div><dt>运行状态</dt><dd>${esc(stateLabel(b?.state))}</dd></div>
        <div><dt>版本</dt><dd>${esc(s?.version || "–")}</dd></div>
        <div><dt>运行时长</dt><dd>${fmtDuration(s?.uptimeSec)}</dd></div>
        <div><dt>开始于</dt><dd>${esc(fmtRelative(b?.startedAt))}</dd></div>
        ${run?.accountsTotal ? `<div><dt>本次进度</dt><dd>${run.accountsSeen || 0}/${run.accountsTotal} 个账户</dd></div>` : ""}
        ${run?.collected != null ? `<div><dt>本次已赚</dt><dd>${fmtNum(run.collected)}</dd></div>` : ""}
        ${b?.lastExit ? `<div><dt>上次退出码</dt><dd>${esc(b.lastExit.code ?? "–")}</dd></div>` : ""}
      `;

      const pts = s?.points?.accounts || [];
      $("#ovPoints", root).innerHTML = pts.length
        ? pts
            .map(
              (a) => `<div class="card">
                <div class="card-title">${esc(a.email)}</div>
                <div class="card-big">${fmtNum(a.balance)}</div>
                <div class="card-sub">今日 +${fmtNum(a.collected)}${a.success === false ? " · <span style=\"color:var(--err)\">失败</span>" : ""}</div>
              </div>`,
            )
            .join("")
        : '<p class="empty">当前无进行中的账户积分数据（仅在运行期间可见，历史见「运行记录」）。</p>';

      const byDay = s?.history?.pointsByDay || {};
      const days = Object.keys(byDay).sort();
      const totals = days.map((d) =>
        Object.values(byDay[d]).reduce((x, y) => x + (Number(y) || 0), 0),
      );
      $("#ovChart", root).innerHTML = svgChart(days, totals);
    },
  };
}

function svgChart(labels, values) {
  if (!values.length) return '<p class="empty">暂无数据，运行一次后开始记录。</p>';
  const w = 720,
    h = 200,
    pad = 30;
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i) => pad + (i * (w - pad * 2)) / Math.max(1, n - 1);
  const y = (v) => h - pad - (v / max) * (h - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const bars = values
    .map((v, i) => {
      const bw = Math.max(4, (w - pad * 2) / n - 6);
      return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad - y(v)).toFixed(1)}" class="bar"></rect>`;
    })
    .join("");
  const last = values[values.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" class="svg-chart" preserveAspectRatio="none">
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" class="axis"/>
    ${bars}
    <polyline points="${pts}" class="line"/>
    <text x="${x(n - 1)}" y="${(y(last) - 6).toFixed(1)}" class="ptlabel">${fmtNum(last)}</text>
  </svg>
  <div class="chart-legend">${labels.map((l) => `<span>${esc(l)}</span>`).join("")}</div>`;
}

// ===========================================================================
// 2) 运行控制
// ===========================================================================
function controlsView() {
  let root = null;
  return {
    id: "controls",
    label: "运行控制",
    interval: 8000,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>手动运行</h2>
          <p class="hint">立即触发一次任务（走机器人的 /start，不受随机等待影响）。运行前若含多账户，会按 .env 中的顺序依次处理。</p>
          <div class="form-actions">
            <button class="btn btn-primary" id="ctlStart">立即运行</button>
            <button class="btn btn-danger" id="ctlStop">停止运行</button>
            <span id="ctlMsg" class="hint"></span>
          </div>
          <div id="ctlState" class="kv" style="margin-top:14px"></div>
        </section>`;
      $("#ctlStart", root).addEventListener("click", async () => {
        const msg = $("#ctlMsg", root);
        try {
          const r = await botSend("POST", "/start", {});
          msg.textContent = `已触发：${esc(JSON.stringify(r))}`.slice(0, 160);
          toast("已触发运行", "success");
        } catch (e) {
          msg.textContent = e.message;
          toast(e.message, "error");
        }
      });
      $("#ctlStop", root).addEventListener("click", async () => {
        if (!confirm("确认停止当前运行？未完成的账户会被中断。")) return;
        try {
          await botSend("POST", "/stop", {});
          toast("已发送停止指令", "success");
        } catch (e) {
          toast(e.message, "error");
        }
      });
    },
    async refresh() {
      if (!root) return;
      const s = state.summary;
      const b = s?.bot;
      $("#ctlState", root).innerHTML = `
        <div><dt>当前状态</dt><dd>${esc(stateLabel(b?.state))}</dd></div>
        <div><dt>已处理账户</dt><dd>${fmtNum(b?.run?.accountsSeen)} / ${fmtNum(b?.run?.accountsTotal)}</dd></div>
        <div><dt>本次积分</dt><dd>${fmtNum(b?.run?.collected)}</dd></div>
        <div><dt>预计结束</dt><dd>${esc(b?.run?.finished ? "已完成" : "未结束")}</dd></div>`;
    },
  };
}

// ===========================================================================
// 3) 账户管理（新增 / 更新 / 删除 / 每账户代理）
// ===========================================================================
function accountsView() {
  let root = null;
  return {
    id: "accounts",
    label: "账户管理",
    interval: 10000,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>添加 / 更新账户</h2>
          <p class="hint">写入项目 <code>.env</code> 的 <code>ACCOUNT_N_*</code> 并自动重启机器人生效。留空即不改动该字段；带 <code>*</code> 为必填。</p>
          <form id="accForm" class="form-grid">
            <label>邮箱 *<input name="EMAIL" required placeholder="user@example.com"></label>
            <label>密码<input name="PASSWORD" type="password" placeholder="可留空（微软账户/Authenticator）"></label>
            <label>TOTP 密钥<input name="TOTP_SECRET" placeholder="可选，自动填 2FA 验证码"></label>
            <label>恢复邮箱<input name="RECOVERY_EMAIL" placeholder="可选"></label>
            <label>语言代码<input name="LANG_CODE" placeholder="zh-CN / en（默认 en）"></label>
            <label>地区<input name="GEO_LOCALE" placeholder="CN / auto（默认 auto）"></label>
            <label>启用代理<input name="PROXY_HTTP" placeholder="true / false"></label>
            <label>代理地址 *<input name="PROXY_URL" placeholder="http://1.2.3.4:8080"></label>
            <label>代理端口<input name="PROXY_PORT" placeholder="8080"></label>
            <label>代理用户<input name="PROXY_USERNAME" placeholder="可选"></label>
            <label>代理密码<input name="PROXY_PASSWORD" type="password" placeholder="可选"></label>
            <label>保存移动指纹<input name="SAVE_FINGERPRINT_MOBILE" placeholder="true/false"></label>
            <label>保存桌面指纹<input name="SAVE_FINGERPRINT_DESKTOP" placeholder="true/false"></label>
            <div class="form-actions" style="grid-column:1/-1">
              <button type="submit" class="btn btn-primary">保存账户</button>
              <span id="accFormMsg" class="hint"></span>
            </div>
          </form>
        </section>
        <section class="panel">
          <h2>已配置账户</h2>
          <div id="accList" class="cards"></div>
        </section>`;

      $("#accForm", root).addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = {};
        for (const [k, v] of fd.entries()) {
          const val = String(v).trim();
          if (val !== "") body[k] = val;
        }
        const msg = $("#accFormMsg", root);
        try {
          const r = await api("/api/accounts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          msg.textContent = r.message;
          msg.style.color = "var(--ok)";
          toast(r.message, "success");
          e.target.reset();
          refreshActive();
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = "var(--err)";
          toast(err.message, "error");
        }
      });
    },
    async refresh() {
      if (!root) return;
      let list = [];
      try {
        const data = await botGet("/accounts");
        list = data.accounts || [];
      } catch (e) {
        $("#accList", root).innerHTML = `<p class="empty">获取账户失败：${esc(e.message)}</p>`;
        return;
      }
      if (!list.length) {
        $("#accList", root).innerHTML = '<p class="empty">暂无账户，请在上方添加。</p>';
        return;
      }
      $("#accList", root).innerHTML = list
        .map((a) => {
          const proxy = a.proxy
            ? `${esc(a.proxy.url || "")}${a.proxy.port ? ":" + esc(a.proxy.port) : ""}${a.proxy.hasCredentials ? "（含账号）" : ""}`
            : "无";
          const tags = [
            a.hasTotp ? "2FA 已配置" : "无 TOTP",
            a.hasRecoveryEmail ? "有恢复邮箱" : "无恢复邮箱",
            a.successStreak ? `连续成功 ${a.successStreak}` : null,
          ]
            .filter(Boolean)
            .map((t) => `<span class="tag">${esc(t)}</span>`)
            .join("");
          return `<div class="card">
            <div class="card-title">#${esc(a.index)} ${esc(a.email)}</div>
            <div class="card-sub">${esc(a.langCode || "–")} · ${esc(a.geoLocale || "–")} · 累计 +${fmtNum(a.totalCollected)} · ${fmtNum(a.runs)} 次运行</div>
            <div class="card-sub">代理：${proxy}</div>
            <div class="card-sub">最近运行 ${esc(fmtRelative(a.lastRunAt))} · 上次赚 ${fmtNum(a.lastCollected)} · ${a.lastSuccess === false ? '<span style="color:var(--err)">上次失败</span>' : "上次成功"}</div>
            <div class="card-sub">${tags}</div>
            ${a.lastError ? `<div class="card-sub" style="color:var(--err)">${esc(a.lastError)}</div>` : ""}
            <div class="card-actions">
              <button class="btn btn-danger btn-small" data-del="${encodeURIComponent(a.email)}">删除该账户</button>
            </div>
          </div>`;
        })
        .join("");
      $$("#accList [data-del]", root).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const email = decodeURIComponent(btn.dataset.del);
          if (!confirm(`确认删除账户 ${email}？将同时移除其 .env 配置并重启机器人。`)) return;
          try {
            const r = await api("/api/accounts/" + encodeURIComponent(email), {
              method: "DELETE",
            });
            toast(r.message, "success");
            refreshActive();
          } catch (err) {
            toast(err.message, "error");
          }
        }),
      );
    },
  };
}

// ===========================================================================
// 4) 运行记录
// ===========================================================================
function runsView() {
  let root = null;
  return {
    id: "runs",
    label: "运行记录",
    interval: 20000,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-head">
            <h2>历史运行</h2>
            <div class="panel-sub">机器人内存中的最近记录（重启后会清空）</div>
          </div>
          <div id="runsList" class="table-wrap"></div>
        </section>`;
    },
    async refresh() {
      if (!root) return;
      let runs = [];
      try {
        const data = await botGet("/history?limit=50");
        runs = data.runs || [];
      } catch (e) {
        $("#runsList", root).innerHTML = `<p class="empty">获取失败：${esc(e.message)}</p>`;
        return;
      }
      if (!runs.length) {
        $("#runsList", root).innerHTML = '<p class="empty">暂无运行记录。</p>';
        return;
      }
      $("#runsList", root).innerHTML = `<table class="tbl">
        <thead><tr><th>开始</th><th>结束</th><th>退出码</th><th>版本</th><th>共赚</th><th>账户明细</th></tr></thead>
        <tbody>${runs
          .map((r) => {
            const accs = (r.accounts || [])
              .map(
                (a) =>
                  `${esc(a.email)}：+${fmtNum(a.collected)} ${a.success ? "✓" : '<span style="color:var(--err)">✗</span>'}`,
              )
              .join("<br>");
            return `<tr>
            <td>${esc(fmtDateTime(r.startedAt))}</td>
            <td>${esc(fmtDateTime(r.endedAt))}</td>
            <td>${esc(r.exit ?? "–")}</td>
            <td>${esc(r.version ?? "–")}</td>
            <td>${fmtNum(r.collected)}</td>
            <td>${accs || "–"}</td>
          </tr>`;
          })
          .join("")}</tbody>
      </table>`;
    },
  };
}

// ===========================================================================
// 5) 实时日志（SSE，监听 log / status 事件）
// ===========================================================================
function logsView() {
  let root = null;
  let es = null;
  let buffer = [];
  return {
    id: "logs",
    label: "实时日志",
    interval: 0,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-head">
            <h2>实时日志</h2>
            <div class="panel-sub">经机器人 <code>/events</code> 转发（含登录验证码提示）</div>
          </div>
          <pre id="logBox" class="logbox"></pre>
        </section>`;
      connect();
    },
    refresh() {},
    onState() {},
  };

  function push(line) {
    buffer.push(line);
    if (buffer.length > 1000) buffer = buffer.slice(-1000);
    const box = $("#logBox", root);
    if (box) {
      box.textContent = buffer.join("\n");
      box.scrollTop = box.scrollHeight;
    }
  }
  function connect() {
    if (es) return;
    es = new EventSource("/api/stream");
    // ⚠ 机器人发送的是具名事件（event: log / status / hello），
    //   用 es.onmessage 收不到，必须 addEventListener。
    es.addEventListener("hello", () => push("[已连接日志流]"));
    es.addEventListener("log", (e) => {
      try {
        const d = JSON.parse(e.data);
        const lvl = d.level ? `[${d.level}]` : "";
        const msg = d.message ?? d.raw ?? e.data;
        push(`${fmtDateTime(d.timestamp || d.ts)} ${lvl} ${msg}`);
      } catch {
        push(e.data);
      }
    });
    es.addEventListener("status", () => {});
    es.onerror = () => push("[日志流中断，正在重连…]");
  }
}

// ===========================================================================
// 6) 调度
// ===========================================================================
function scheduleView() {
  let root = null;
  return {
    id: "schedule",
    label: "调度",
    interval: 15000,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>定时调度（Cron）</h2>
          <p class="hint">格式：<code>分 时 日 月 周</code>，例 <code>0 9 * * *</code> = 每天 09:00（按容器时区）。面板写入 <code>schedule.json</code>，与容器内 cron 互斥。</p>
          <div class="form-grid">
            <label>启用调度<input type="checkbox" id="schEnabled" style="width:auto"></label>
            <label>Cron 表达式<input id="schCron" placeholder="0 9 * * *"></label>
            <label>运行中跳过<input type="checkbox" id="schSkip" style="width:auto"></label>
            <div class="form-actions" style="grid-column:1/-1">
              <button class="btn btn-primary" id="schSave">保存调度</button>
              <span id="schMsg" class="hint"></span>
            </div>
          </div>
          <p id="schDesc" class="hint"></p>
        </section>`;
      $("#schSave", root).addEventListener("click", async () => {
        const cron = $("#schCron", root).value.trim();
        const enabled = $("#schEnabled", root).checked;
        const skipIfRunning = $("#schSkip", root).checked;
        const msg = $("#schMsg", root);
        try {
          await botSend("PUT", "/schedule", { enabled, cron, skipIfRunning });
          msg.textContent = "调度已保存。";
          msg.style.color = "var(--ok)";
          toast("调度已保存", "success");
        } catch (e) {
          msg.textContent = e.message;
          msg.style.color = "var(--err)";
        }
      });
    },
    async refresh() {
      if (!root) return;
      try {
        const d = await botGet("/schedule");
        $("#schEnabled", root).checked = !!d.enabled;
        $("#schCron", root).value = d.cron || "";
        $("#schSkip", root).checked = d.skipIfRunning !== false;
        $("#schDesc", root).textContent =
          (d.writable === false
            ? "⚠ 当前禁止写入调度（需 API_ALLOW_SCHEDULE_WRITE=true）。"
            : "说明：调度写在 schedule.json，与容器 cron 二选一；") +
          ` 时区 ${d.timezone || "–"}；下次运行 ${fmtRelative(d.nextRunAt)}`;
      } catch (e) {
        $("#schDesc", root).textContent = "读取调度失败：" + e.message;
      }
    },
  };
}

// ===========================================================================
// 7) 推送通知
// ===========================================================================
function pushView() {
  let root = null;
  return {
    id: "push",
    label: "推送通知",
    interval: 0,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>推送渠道</h2>
          <p class="hint">PushPlus / Server酱 / Telegram / Discord / ntfy 写入机器人 <code>config.json</code> 的 <code>webhook.*</code>；钉钉为环境变量（保存后自动重启机器人）。</p>
          <div class="form-grid">
            <label>PushPlus 启用<input type="checkbox" id="ppEnabled" style="width:auto"></label>
            <label>PushPlus 令牌<input id="ppToken" placeholder="pushplus.plus 的 token"></label>
            <label>PushPlus 标题<input id="ppTitle" placeholder="Microsoft Rewards"></label>
            <label>Server酱 启用<input type="checkbox" id="scEnabled" style="width:auto"></label>
            <label>Server酱 SendKey<input id="scKey" placeholder="sct.ftqq.com 的 sendkey"></label>
            <label>Telegram 启用<input type="checkbox" id="tgEnabled" style="width:auto"></label>
            <label>Telegram Token<input id="tgToken"></label>
            <label>Telegram ChatID<input id="tgChat"></label>
            <label>Discord 启用<input type="checkbox" id="dcEnabled" style="width:auto"></label>
            <label>Discord Webhook<input id="dcUrl"></label>
            <label>ntfy 启用<input type="checkbox" id="ntfyEnabled" style="width:auto"></label>
            <label>ntfy 服务器<input id="ntfyUrl" placeholder="https://ntfy.sh"></label>
            <label>ntfy 主题<input id="ntfyTopic"></label>
          </div>
          <h3 class="sub">钉钉（环境变量）</h3>
          <div class="form-grid">
            <label>钉钉 启用<input type="checkbox" id="dtEnabled" style="width:auto"></label>
            <label>钉钉 Webhook<input id="dtWebhook" placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"></label>
            <label>钉钉 加签密钥<input id="dtSecret" placeholder="开启加签时填写"></label>
            <label>最低级别<input id="dtLevel" style="width:auto">
              <select id="dtLevelSel">
                <option value="error">仅 error</option>
                <option value="warn">warn 及以上</option>
                <option value="info">info 及以上</option>
              </select>
            </label>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" id="pushSave">保存推送配置</button>
            <span id="pushMsg" class="hint"></span>
          </div>
        </section>`;
      $("#pushSave", root).addEventListener("click", save);
    },
    async refresh() {
      if (!root) return;
      try {
        const d = await botGet("/config?reveal=1");
        const wh = (d.config && d.config.webhook) || {};
        const set = (id, v) => {
          const el = $(id, root);
          if (el) el.value = v ?? "";
        };
        const chk = (id, v) => {
          const el = $(id, root);
          if (el) el.checked = !!v;
        };
        chk("#ppEnabled", wh.pushplus?.enabled);
        set("#ppToken", wh.pushplus?.token);
        set("#ppTitle", wh.pushplus?.title);
        chk("#scEnabled", wh.serverchan?.enabled);
        set("#scKey", wh.serverchan?.sendKey);
        chk("#tgEnabled", wh.telegram?.enabled);
        set("#tgToken", wh.telegram?.botToken);
        set("#tgChat", wh.telegram?.chatId);
        chk("#dcEnabled", wh.discord?.enabled);
        set("#dcUrl", wh.discord?.url);
        chk("#ntfyEnabled", wh.ntfy?.enabled);
        set("#ntfyUrl", wh.ntfy?.url);
        set("#ntfyTopic", wh.ntfy?.topic);
      } catch (e) {
        toast("加载推送配置失败：" + e.message, "error");
      }
    },
  };
  async function save() {
    const patch = {
      webhook: {
        pushplus: {
          enabled: $("#ppEnabled", root).checked,
          token: $("#ppToken", root).value.trim(),
          title: $("#ppTitle", root).value.trim() || "Microsoft Rewards",
        },
        serverchan: {
          enabled: $("#scEnabled", root).checked,
          sendKey: $("#scKey", root).value.trim(),
        },
        telegram: {
          enabled: $("#tgEnabled", root).checked,
          botToken: $("#tgToken", root).value.trim(),
          chatId: $("#tgChat", root).value.trim(),
        },
        discord: {
          enabled: $("#dcEnabled", root).checked,
          url: $("#dcUrl", root).value.trim(),
        },
        ntfy: {
          enabled: $("#ntfyEnabled", root).checked,
          url: $("#ntfyUrl", root).value.trim(),
          topic: $("#ntfyTopic", root).value.trim(),
        },
      },
    };
    const msg = $("#pushMsg", root);
    try {
      await botSend("PATCH", "/config", patch);
      await api("/api/push/dingtalk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: $("#dtEnabled", root).checked,
          webhook: $("#dtWebhook", root).value.trim(),
          secret: $("#dtSecret", root).value.trim(),
          minLevel: $("#dtLevelSel", root).value,
        }),
      });
      msg.textContent = "推送配置已保存（钉钉已重启机器人）。";
      msg.style.color = "var(--ok)";
      toast("推送配置已保存", "success");
    } catch (e) {
      msg.textContent = e.message;
      msg.style.color = "var(--err)";
    }
  }
}

// ===========================================================================
// 8) 会话与登录
// ===========================================================================
function sessionsView() {
  let root = null;
  return {
    id: "sessions",
    label: "会话与登录",
    interval: 20000,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>手动登录（2FA / 验证码账号）</h2>
          <p class="hint">启动一个带 noVNC 的临时容器，在浏览器里像平时一样完成微软登录（含 2FA）。会话会写入与机器人同一份目录，保存后关闭页面即可。目标账号需已在「账户管理」配置。</p>
          <div class="form-grid">
            <label>目标账号邮箱<input id="mlEmail" placeholder="user@example.com"></label>
            <label>范围<select id="mlScope">
              <option value="both">桌面 + 移动</option>
              <option value="desktop">仅桌面</option>
              <option value="mobile">仅移动</option>
            </select></label>
            <div class="form-actions" style="grid-column:1/-1">
              <button class="btn btn-primary" id="mlStart">启动手动登录</button>
              <span id="mlMsg" class="hint"></span>
            </div>
          </div>
          <div id="mlResult" class="notice" hidden></div>
        </section>
        <section class="panel">
          <h2>已保存会话</h2>
          <div id="sessList" class="cards"></div>
        </section>`;
      $("#mlStart", root).addEventListener("click", async () => {
        const email = $("#mlEmail", root).value.trim();
        const scope = $("#mlScope", root).value;
        if (!email) {
          toast("请填写目标账号邮箱", "warn");
          return;
        }
        try {
          const r = await api("/api/manual-login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, scope }),
          });
          const box = $("#mlResult", root);
          box.hidden = false;
          box.className = "notice notice--info";
          box.innerHTML = `${esc(r.message)}<br><a href="${esc(r.vncUrl)}" target="_blank" rel="noopener">${esc(r.vncUrl)}</a>`;
          toast("手动登录容器已启动", "success");
        } catch (e) {
          toast(e.message, "error");
        }
      });
    },
    async refresh() {
      if (!root) return;
      let sessions = [];
      try {
        const data = await botGet("/sessions");
        sessions = data.sessions || [];
        if (!data.databaseExists)
          throw new Error("会话库不存在（机器人尚未生成）");
      } catch (e) {
        $("#sessList", root).innerHTML = `<p class="empty">获取会话失败：${esc(e.message)}</p>`;
        return;
      }
      if (!sessions.length) {
        $("#sessList", root).innerHTML = '<p class="empty">暂无会话。</p>';
        return;
      }
      $("#sessList", root).innerHTML = sessions
        .map((s) => {
          const ok = s.hasStorageState;
          return `<div class="card">
            <div class="card-title">${esc(s.email || "未知")} · ${esc(s.platform || "–")}</div>
            <div class="card-sub">${ok ? '<span style="color:var(--ok)">已存登录态</span>' : '<span style="color:var(--err)">缺登录态</span>'} · ${s.hasFingerprint ? "含指纹" : "无指纹"} · ${fmtNum(s.cookieCount)} 个 cookie</div>
            <div class="card-sub">更新于 ${esc(fmtRelative(s.updatedAt))}</div>
            <div class="card-actions">
              <button class="btn btn-danger btn-small" data-clr="${encodeURIComponent(s.email || "")}">清除该账号会话</button>
            </div>
          </div>`;
        })
        .join("");
      $$("#sessList [data-clr]", root).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const email = decodeURIComponent(btn.dataset.clr);
          if (!email || !confirm(`确认清除 ${email} 的登录会话？下次运行需重新登录。`)) return;
          try {
            await botSend("DELETE", "/sessions/" + encodeURIComponent(email));
            toast("会话已清除", "success");
            refreshActive();
          } catch (e) {
            toast(e.message, "error");
          }
        }),
      );
    },
  };
}

// ===========================================================================
// 9) 机器人配置（config.json）
// ===========================================================================
function configView() {
  let root = null;
  return {
    id: "config",
    label: "机器人配置",
    interval: 0,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-head">
            <h2>config.json 编辑器</h2>
            <div class="panel-sub">仅提交你改过的字段，下一次运行生效</div>
          </div>
          <p id="cfgMsg" class="notice" hidden></p>
          <textarea id="cfgEditor" class="editor" spellcheck="false"></textarea>
          <div class="form-actions">
            <button class="btn btn-primary" id="cfgSave">保存配置</button>
            <button class="btn" id="cfgReload">重新加载</button>
          </div>
        </section>`;
      $("#cfgReload", root).addEventListener("click", () => refreshActive());
      $("#cfgSave", root).addEventListener("click", async () => {
        let edited;
        try {
          edited = JSON.parse($("#cfgEditor", root).value);
        } catch (e) {
          showMsg("JSON 格式错误：" + e.message, "err");
          return;
        }
        try {
          await botSend("PATCH", "/config", edited);
          showMsg("配置已保存，下次运行生效。", "ok");
          toast("配置已保存", "success");
        } catch (e) {
          showMsg(e.message, "err");
        }
      });
      function showMsg(m, kind) {
        const el = $("#cfgMsg", root);
        el.hidden = false;
        el.className = `notice notice--${kind === "ok" ? "info" : "warn"}`;
        el.textContent = m;
      }
    },
    async refresh() {
      if (!root) return;
      try {
        const d = await botGet("/config?reveal=1");
        $("#cfgEditor", root).value = JSON.stringify(d.config || {}, null, 2);
      } catch (e) {
        $("#cfgEditor", root).value = "";
        showMsgErr("加载配置失败：" + e.message);
      }
    },
  };
  function showMsgErr(m) {
    const el = $("#cfgMsg", root);
    el.hidden = false;
    el.className = "notice notice--warn";
    el.textContent = m;
  }
}

// ===========================================================================
// 10) 诊断
// ===========================================================================
function diagnosticsView() {
  let root = null;
  return {
    id: "diagnostics",
    label: "诊断",
    interval: 20000,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>诊断文件</h2>
          <p class="hint">运行出错时机器人会保存截图 / 错误页 / HTML dump，用于排查登录或任务失败原因。需 <code>CONFIG_ERROR_DIAGNOSTICS=true</code>。</p>
          <div id="diagList" class="cards"></div>
        </section>`;
    },
    async refresh() {
      if (!root) return;
      let diags = [];
      try {
        const d = await botGet("/diagnostics");
        diags = d.diagnostics || [];
      } catch (e) {
        $("#diagList", root).innerHTML = `<p class="empty">获取失败：${esc(e.message)}</p>`;
        return;
      }
      if (!diags.length) {
        $("#diagList", root).innerHTML = '<p class="empty">暂无诊断文件。</p>';
        return;
      }
      $("#diagList", root).innerHTML = diags
        .map((d) => {
          const name = String(d.name || d);
          const enc = encodeURIComponent(name);
          return `<div class="card">
            <div class="card-title">${esc(name)}</div>
            <div class="card-actions">
              <a class="btn btn-small" href="/api/bot/diagnostics/${enc}/screenshot.png" target="_blank">截图</a>
              <a class="btn btn-small" href="/api/bot/diagnostics/${enc}/error.txt" target="_blank">错误</a>
              <a class="btn btn-small" href="/api/bot/diagnostics/${enc}/dump.html" target="_blank">页面</a>
            </div>
          </div>`;
        })
        .join("");
    },
  };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
initTabs();
pollSummary();
setInterval(pollSummary, 5000);
