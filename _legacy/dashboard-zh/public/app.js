// =============================================================================
// Microsoft Rewards 中文面板前端
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
  if (n == null || Number.isNaN(n)) return "–";
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
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return "–";
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
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
    throw new Error((data && (data.error || data.message)) || `请求失败 (${res.status})`);
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
  }, 4000);
}

// ---------------------------------------------------------------------------
// 状态管理
// ---------------------------------------------------------------------------
const state = { summary: null, streamOpen: false, activeTab: null };
let refreshTimer = null;
const mounted = new Set();

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
  badge.classList.remove("status-unknown", "status-down", "status-warn", "status-live");
  if (!s) {
    badge.classList.add("status-unknown");
    els.statusText.textContent = "连接中…";
  } else if (!s.reachable) {
    badge.classList.add("status-down");
    els.statusText.textContent = "机器人离线";
  } else if (s.authOk === false) {
    badge.classList.add("status-warn");
    els.statusText.textContent = "令牌被拒绝";
  } else if (s.bot && s.bot.state && s.bot.state !== "idle") {
    badge.classList.add("status-live");
    els.statusText.textContent = "运行中";
  } else {
    badge.classList.add("status-live");
    els.statusText.textContent = "已连接";
  }
  els.footerStatus.textContent = !s
    ? "连接中…"
    : !s.reachable
    ? "已断开"
    : s.bot && s.bot.state && s.bot.state !== "idle"
    ? "运行中"
    : "已连接";
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
// 标签页
// ---------------------------------------------------------------------------
const VIEWS = [
  overview,
  accountsView,
  logsView,
  runsView,
  scheduleView,
  configView,
  pushView,
  sessionsView,
  diagnosticsView,
];

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
  window.addEventListener("hashchange", () =>
    activate(location.hash.slice(1)),
  );
  activate(location.hash.slice(1));
}

function activate(id) {
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  if (state.activeTab === view.id) return;
  state.activeTab = view.id;
  for (const v of VIEWS) {
    const on = v.id === view.id;
    $(`#tab-btn-${v.id}`).classList.toggle("tab--active", on);
    $(`#tab-panel-${v.id}`).hidden = !on;
  }
  const panel = $(`#tab-panel-${view.id}`);
  if (!mounted.has(view.id)) {
    view.mount(panel);
    mounted.add(view.id);
  }
  refreshActive(true);
  clearInterval(refreshTimer);
  if (view.interval)
    refreshTimer = setInterval(() => refreshActive(false), view.interval);
}

function currentView() {
  return VIEWS.find((v) => v.id === state.activeTab);
}
async function refreshActive(force) {
  const view = currentView();
  if (!view || !view.refresh) return;
  try {
    await view.refresh();
  } catch (e) {
    console.error(e);
  }
}

// ===========================================================================
// 1) 概览
// ===========================================================================
function overview() {
  let root = null;
  let chartBuilt = false;
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
          <h2>积分趋势（每日合计）</h2>
          <div id="ovChart" class="chart"></div>
        </section>
        <section class="panel">
          <h2>账户积分</h2>
          <div id="ovAccounts" class="cards"></div>
        </section>`;
    },
    async refresh() {
      if (!root) return;
      const s = state.summary;
      const b = s?.bot;
      const botState = b?.state || "unknown";
      $("#ovStatus", root).innerHTML = `
        <div><dt>状态</dt><dd>${esc(stateLabel(botState))}</dd></div>
        <div><dt>版本</dt><dd>${esc(s?.version || "–")}</dd></div>
        <div><dt>运行时长</dt><dd>${fmtDuration(s?.uptimeSec)}</dd></div>
        <div><dt>最近检查</dt><dd>${fmtRelative(s?.checkedAt)}</dd></div>
        ${b?.run?.accountsTotal ? `<div><dt>本次进度</dt><dd>${b.run.accountsSeen || 0}/${b.run.accountsTotal} 个账户</dd></div>` : ""}
        ${b?.run?.collected != null ? `<div><dt>本次积分</dt><dd>${fmtNum(b.run.collected)}</dd></div>` : ""}
      `;
      // 账户卡片
      const acc = (s?.history?.accounts) || {};
      const byDay = s?.history?.pointsByDay || {};
      const emails = Object.keys(acc);
      const cards = emails.length
        ? emails
            .map((e) => {
              const lastDay = Object.keys(byDay).sort().pop();
              const pts = lastDay ? byDay[lastDay][e] : null;
              return `<div class="card">
                <div class="card-title">${esc(e)}</div>
                <div class="card-big">${fmtNum(pts)}</div>
                <div class="card-sub">${esc(acc[e].langCode || "")} · ${esc(acc[e].geoLocale || "")}</div>
              </div>`;
            })
            .join("")
        : '<p class="empty">暂无账户积分数据（需先运行一次）。</p>';
      $("#ovAccounts", root).innerHTML = cards;

      // 趋势图：每日所有账户合计
      const days = Object.keys(byDay).sort();
      const totals = days.map((d) =>
        Object.values(byDay[d]).reduce((a, b) => a + (Number(b) || 0), 0),
      );
      $("#ovChart", root).innerHTML = svgChart(days, totals);
    },
  };
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

function svgChart(labels, values) {
  if (!values.length) return '<p class="empty">暂无数据。</p>';
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
// 2) 账户管理（查看 / 添加 / 更新 / 删除 / 每账户代理）
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
          <p class="hint">添加或更新账户会写入项目 <code>.env</code>（ACCOUNT_N_*）并自动重启机器人以加载。带 <code>*</code> 为必填。</p>
          <form id="accForm" class="form-grid">
            <label>邮箱 *<input name="EMAIL" required placeholder="user@example.com"></label>
            <label>密码<input name="PASSWORD" type="password" placeholder="可留空（无密码/Authenticator）"></label>
            <label>TOTP 密钥<input name="TOTP_SECRET" placeholder="可选，自动填 2FA"></label>
            <label>恢复邮箱<input name="RECOVERY_EMAIL" placeholder="可选"></label>
            <label>语言代码<input name="LANG_CODE" placeholder="zh-CN / en"></label>
            <label>地区<input name="GEO_LOCALE" placeholder="CN / auto"></label>
            <label>代理开关(HTTP)<input name="PROXY_HTTP" placeholder="true / false"></label>
            <label>代理地址<input name="PROXY_URL" placeholder="http://1.2.3.4:8080"></label>
            <label>代理端口<input name="PROXY_PORT" placeholder="0"></label>
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
          refreshActive(true);
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
            ? `${esc(a.proxy.url || "")}${a.proxy.port ? ":" + a.proxy.port : ""}`
            : "无";
          return `<div class="card">
            <div class="card-title">${esc(a.email)} ${a.configured ? "" : '<span class="tag">未配置</span>'}</div>
            <div class="card-sub">${esc(a.langCode || "")} · ${esc(a.geoLocale || "")} · 积分 ${fmtNum(a.points)}</div>
            <div class="card-sub">代理：${proxy}</div>
            <div class="card-actions">
              <button class="btn btn-danger btn-small" data-del="${encodeURIComponent(a.email)}">删除</button>
            </div>
          </div>`;
        })
        .join("");
      $$("#accList [data-del]", root).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const email = decodeURIComponent(btn.dataset.del);
          if (!confirm(`确认删除账户 ${email}？将重启机器人。`)) return;
          try {
            const r = await api("/api/accounts/" + encodeURIComponent(email), {
              method: "DELETE",
            });
            toast(r.message, "success");
            refreshActive(true);
          } catch (err) {
            toast(err.message, "error");
          }
        }),
      );
    },
  };
}

// ===========================================================================
// 3) 日志（实时 SSE）
// ===========================================================================
function logsView() {
  let root = null;
  let es = null;
  let buffer = [];
  return {
    id: "logs",
    label: "日志",
    interval: 0,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-head">
            <h2>实时日志</h2>
            <div class="panel-sub">经机器人 /events 实时转发</div>
          </div>
          <pre id="logBox" class="logbox"></pre>
        </section>`;
      connect();
    },
    refresh() {},
    onState() {},
  };
  function connect() {
    if (es) return;
    es = new EventSource("/api/stream");
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        const line = entry.raw || entry.message || e.data;
        buffer.push(line);
        if (buffer.length > 800) buffer = buffer.slice(-800);
        const box = $("#logBox", root);
        if (box) box.textContent = buffer.join("\n");
      } catch {
        buffer.push(e.data);
      }
      const box = $("#logBox", root);
      if (box) box.scrollTop = box.scrollHeight;
    };
    es.onerror = () => {
      const box = $("#logBox", root);
      if (box) {
        buffer.push("[日志流中断，正在重连…]");
        box.textContent = buffer.join("\n");
      }
    };
  }
}

// ===========================================================================
// 4) 运行记录
// ===========================================================================
function runsView() {
  let root = null;
  return {
    id: "runs",
    label: "运行记录",
    interval: 15000,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>历史运行（机器人退出记录）</h2>
          <div id="runsList" class="table-wrap"></div>
        </section>`;
    },
    async refresh() {
      if (!root) return;
      let exits = [];
      try {
        const data = await botGet("/history?limit=50");
        exits = data.runs || [];
      } catch (e) {
        $("#runsList", root).innerHTML = `<p class="empty">获取失败：${esc(e.message)}</p>`;
        return;
      }
      if (!exits.length) {
        $("#runsList", root).innerHTML = '<p class="empty">暂无运行记录。</p>';
        return;
      }
      $("#runsList", root).innerHTML = `<table class="tbl">
        <thead><tr><th>时间</th><th>账户数</th><th>获得积分</th><th>旧余额</th><th>新余额</th><th>耗时(分)</th></tr></thead>
        <tbody>${exits
          .map(
            (r) => `<tr>
            <td>${esc(fmtDateTime(r.endedAt || r.startedAt))}</td>
            <td>${fmtNum(r.accountsProcessed)}</td>
            <td>${fmtNum(r.pointsGained)}</td>
            <td>${fmtNum(r.previousBalance)}</td>
            <td>${fmtNum(r.currentBalance)}</td>
            <td>${esc(r.runtimeMinutes ?? "–")}</td>
          </tr>`,
          )
          .join("")}</tbody>
      </table>`;
    },
  };
}

// ===========================================================================
// 5) 调度
// ===========================================================================
function scheduleView() {
  let root = null;
  return {
    id: "schedule",
    label: "调度",
    interval: 0,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>运行调度（Cron）</h2>
          <p class="hint">格式：分 时 日 月 周。例如 <code>0 9 * * *</code> 表示每天 09:00。</p>
          <div class="form-grid">
            <label>启用<input type="checkbox" id="schEnabled" style="width:auto"></label>
            <label>Cron 表达式<input id="schCron" placeholder="0 9 * * *"></label>
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
        const msg = $("#schMsg", root);
        try {
          await botSend("PUT", "/schedule", { enabled, cron });
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
        const data = await botGet("/schedule");
        const remote = data.remote;
        if (remote && remote.cron) {
          $("#schCron", root).value = remote.cron;
          $("#schEnabled", root).checked = remote.enabled;
          $("#schDesc", root).textContent =
            "说明：" +
            (remote.description || remote.cron) +
            (remote.nextRunAt ? "；下次运行：" + fmtDateTime(remote.nextRunAt) : "");
        }
      } catch {}
    },
  };
}

// ===========================================================================
// 6) 配置（bot config.json 编辑器）
// ===========================================================================
function configView() {
  let root = null;
  let loaded = null;
  return {
    id: "config",
    label: "配置",
    interval: 0,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <div class="panel-head">
            <h2>机器人配置（config.json）</h2>
            <div class="panel-sub">仅发送你修改过的字段，下一次运行生效</div>
          </div>
          <p id="cfgMsg" class="notice" hidden></p>
          <textarea id="cfgEditor" class="editor" spellcheck="false"></textarea>
          <div class="form-actions">
            <button class="btn btn-primary" id="cfgSave">保存配置</button>
            <button class="btn" id="cfgReload">重新加载</button>
          </div>
        </section>`;
      $("#cfgReload", root).addEventListener("click", () => this.refresh());
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
          loaded = edited;
          showMsg("配置已保存，下次运行生效。", "ok");
          toast("配置已保存", "success");
        } catch (e) {
          showMsg(e.message, "err");
        }
      });
    },
    async refresh() {
      if (!root) return;
      try {
        const data = await botGet("/config?reveal=1");
        loaded = data.config;
        $("#cfgEditor", root).value = JSON.stringify(loaded, null, 2);
      } catch (e) {
        $("#cfgEditor", root).value = "";
        showMsg("加载配置失败：" + e.message, "err");
      }
    },
  };
  function showMsg(m, kind) {
    const el = $("#cfgMsg", root);
    el.hidden = false;
    el.className = `notice notice--${kind === "ok" ? "info" : "warn"}`;
    el.textContent = m;
  }
}

// ===========================================================================
// 7) 推送通知
// ===========================================================================
function pushView() {
  let root = null;
  let cfg = null;
  return {
    id: "push",
    label: "推送通知",
    interval: 0,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>推送渠道配置</h2>
          <p class="hint">PushPlus / Server酱 / Telegram / Discord / ntfy 直接写入机器人 config.json；钉钉为环境变量（保存后会重启机器人）。</p>
          <div class="form-grid">
            <label>PushPlus 启用<input type="checkbox" id="ppEnabled" style="width:auto"></label>
            <label>PushPlus 令牌<input id="ppToken" placeholder="pushplus.plus 的 token"></label>
            <label>PushPlus 标题<input id="ppTitle" placeholder="Microsoft Rewards"></label>
            <label>Server酱 启用<input type="checkbox" id="scEnabled" style="width:auto"></label>
            <label>Server酱 SendKey<input id="scKey" placeholder="sct.ftqq.com 的 key"></label>
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
        const data = await botGet("/config?reveal=1");
        cfg = data.config || {};
        const wh = cfg.webhook || {};
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
      // 钉钉单独保存（环境变量）
      await api("/api/push/dingtalk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: $("#dtEnabled", root).checked,
          webhook: $("#dtWebhook", root).value.trim(),
          secret: $("#dtSecret", root).value.trim(),
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
    interval: 15000,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>手动登录（2FA / 验证码账号）</h2>
          <p class="hint">启动一个带 noVNC 的临时容器，在浏览器里像平时一样完成微软登录（含 2FA），登录后关闭即可。目标账号需已在 .env 配置。</p>
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
          box.innerHTML = `${esc(r.message)}<br>打开：<a href="${esc(r.vncUrl)}" target="_blank" rel="noopener">${esc(r.vncUrl)}</a>`;
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
      } catch (e) {
        $("#sessList", root).innerHTML = `<p class="empty">获取会话失败：${esc(e.message)}</p>`;
        return;
      }
      if (!sessions.length) {
        $("#sessList", root).innerHTML = '<p class="empty">暂无会话。</p>';
        return;
      }
      $("#sessList", root).innerHTML = sessions
        .map(
          (s) => `<div class="card">
          <div class="card-title">${esc(s.email || s.account || "未知")}</div>
          <div class="card-sub">${esc(s.platform || "")} · ${esc(s.valid ? "有效" : "失效")}</div>
          <div class="card-actions">
            <button class="btn btn-danger btn-small" data-clr="${encodeURIComponent(s.email || s.account || "")}">清除会话</button>
          </div>
        </div>`,
        )
        .join("");
      $$("#sessList [data-clr]", root).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const email = decodeURIComponent(btn.dataset.clr);
          if (!email) return;
          try {
            await botSend("DELETE", "/sessions/" + encodeURIComponent(email));
            toast("会话已清除", "success");
            refreshActive(true);
          } catch (e) {
            toast(e.message, "error");
          }
        }),
      );
    },
  };
}

// ===========================================================================
// 9) 诊断
// ===========================================================================
function diagnosticsView() {
  let root = null;
  return {
    id: "diagnostics",
    label: "诊断",
    interval: 0,
    mount(panel) {
      root = panel;
      panel.innerHTML = `
        <section class="panel">
          <h2>诊断文件</h2>
          <p class="hint">运行出错时机器人会保存截图 / 错误页 / HTML dump，用于排查登录或任务失败原因。</p>
          <div id="diagList" class="cards"></div>
        </section>`;
    },
    async refresh() {
      if (!root) return;
      let diags = [];
      try {
        const data = await botGet("/diagnostics");
        diags = data.diagnostics || [];
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
          const name = esc(d.name || d);
          return `<div class="card">
            <div class="card-title">${name}</div>
            <div class="card-actions">
              <a class="btn btn-small" href="/api/bot/diagnostics/${encodeURIComponent(d.name || d)}/screenshot.png" target="_blank">截图</a>
              <a class="btn btn-small" href="/api/bot/diagnostics/${encodeURIComponent(d.name || d)}/error.txt" target="_blank">错误</a>
              <a class="btn btn-small" href="/api/bot/diagnostics/${encodeURIComponent(d.name || d)}/dump.html" target="_blank">页面</a>
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
