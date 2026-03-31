import type { FastifyInstance } from "fastify";

export function registerDashboardRoutes(app: FastifyInstance, apiKey?: string): void {
  app.get("/", async (request, reply) => {
    // Only inject the API key for requests from localhost to prevent credential leaks
    const remoteAddr = request.ip;
    const isLocal = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
    const injectKey = apiKey && isLocal;
    const safeKey = injectKey ? JSON.stringify(apiKey).replace(/</g, "\\u003c").replace(/>/g, "\\u003e") : null;
    const html = DASHBOARD_HTML.replace('/*__API_KEY_INJECT__*/', safeKey ? `window.__LANTERN_API_KEY__ = ${safeKey};` : '');
    // Dashboard has inline scripts/styles — use a permissive CSP for this page only.
    // API routes keep the strict `default-src 'none'` set globally.
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;"
    );
    return reply.type("text/html").send(html);
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lantern — Agent Observability</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #232734;
    --border: #2e3345;
    --text: #e1e4ed;
    --text-dim: #8b91a5;
    --accent: #6c8cff;
    --accent-dim: #3d5199;
    --green: #34d399;
    --red: #f87171;
    --yellow: #fbbf24;
    --orange: #fb923c;
    --purple: #a78bfa;
    --cyan: #22d3ee;
    --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.5; min-height: 100vh; }

  /* ── Header ── */
  header { display: flex; align-items: center; justify-content: space-between; padding: 16px 32px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .logo { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
  .logo-icon { width: 28px; height: 28px; background: linear-gradient(135deg, var(--accent), var(--purple)); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 16px; }
  nav { display: flex; gap: 4px; }
  nav button { padding: 8px 16px; border: none; background: none; color: var(--text-dim); font-size: 14px; font-family: var(--font); cursor: pointer; border-radius: 6px; transition: all 0.15s; }
  nav button:hover { background: var(--surface2); color: var(--text); }
  nav button.active { background: var(--accent-dim); color: #fff; }
  .health-badge { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-dim); }
  .health-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

  /* ── Layout ── */
  main { display: flex; height: calc(100vh - 61px); }
  .panel-left { width: 420px; min-width: 350px; border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .panel-right { flex: 1; overflow-y: auto; padding: 24px 32px; }
  .full-view { flex: 1; overflow-y: auto; padding: 24px 32px; }

  /* ── Stats bar ── */
  .stats-bar { display: flex; gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .stat-card { flex: 1; padding: 14px 16px; background: var(--surface); }
  .stat-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 22px; font-weight: 700; margin-top: 2px; }
  .stat-value.green { color: var(--green); } .stat-value.red { color: var(--red); }
  .stat-value.accent { color: var(--accent); } .stat-value.yellow { color: var(--yellow); }

  /* ── Filters ── */
  .filters { display: flex; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--surface); flex-wrap: wrap; }
  .filter-chip { padding: 4px 12px; border: 1px solid var(--border); border-radius: 16px; background: none; color: var(--text-dim); font-size: 12px; font-family: var(--font); cursor: pointer; transition: all 0.15s; }
  .filter-chip:hover { border-color: var(--accent); color: var(--text); }
  .filter-chip.active { border-color: var(--accent); background: var(--accent-dim); color: #fff; }
  .filter-sep { width: 1px; background: var(--border); margin: 0 4px; align-self: stretch; }

  /* ── Trace list ── */
  .trace-list { overflow-y: auto; flex: 1; }
  .trace-item { padding: 14px 16px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.1s; }
  .trace-item:hover { background: var(--surface2); }
  .trace-item.selected { background: var(--surface2); border-left: 3px solid var(--accent); }
  .trace-header { display: flex; justify-content: space-between; align-items: center; }
  .trace-agent { font-weight: 600; font-size: 14px; }
  .trace-status { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; text-transform: uppercase; }
  .trace-status.success { background: rgba(52,211,153,0.15); color: var(--green); }
  .trace-status.error { background: rgba(248,113,113,0.15); color: var(--red); }
  .trace-status.running { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .trace-meta { display: flex; gap: 12px; margin-top: 6px; font-size: 12px; color: var(--text-dim); flex-wrap: wrap; }
  .trace-meta span { display: flex; align-items: center; gap: 4px; }
  .source-tag { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: rgba(108,140,255,0.12); color: var(--accent); font-family: var(--mono); }

  /* ── Detail view ── */
  .detail-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-dim); font-size: 15px; }
  .detail-header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  .detail-title { font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
  .detail-id { font-family: var(--mono); font-size: 13px; color: var(--text-dim); margin-top: 4px; }
  .detail-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 16px; }
  .detail-stat { padding: 12px; background: var(--surface); border-radius: 8px; border: 1px solid var(--border); }
  .detail-stat-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .detail-stat-value { font-size: 18px; font-weight: 600; margin-top: 2px; }

  /* ── Source info in detail ── */
  .source-info { display: flex; gap: 12px; margin-top: 16px; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; flex-wrap: wrap; }
  .source-info-item { display: flex; flex-direction: column; }
  .source-info-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .source-info-value { font-size: 13px; font-family: var(--mono); }

  /* ── Span tree ── */
  .section-title { font-size: 15px; font-weight: 700; margin: 24px 0 12px; display: flex; align-items: center; gap: 8px; }
  .span-node { display: flex; align-items: stretch; margin-bottom: 2px; }
  .span-connector { width: 24px; display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
  .span-line { width: 2px; flex: 1; background: var(--border); }
  .span-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin: 4px 0; }
  .span-dot.llm_call { background: var(--accent); } .span-dot.tool_call { background: var(--purple); }
  .span-dot.retrieval { background: var(--cyan); } .span-dot.reasoning_step { background: var(--orange); }
  .span-dot.custom { background: var(--text-dim); }
  .span-card { flex: 1; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-left: 8px; margin-bottom: 4px; cursor: pointer; transition: border-color 0.15s; }
  .span-card:hover { border-color: var(--accent); }
  .span-card.expanded { border-color: var(--accent); }
  .span-card-header { display: flex; justify-content: space-between; align-items: center; }
  .span-type-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; font-family: var(--mono); }
  .span-type-badge.llm_call { background: rgba(108,140,255,0.15); color: var(--accent); }
  .span-type-badge.tool_call { background: rgba(167,139,250,0.15); color: var(--purple); }
  .span-type-badge.retrieval { background: rgba(34,211,238,0.15); color: var(--cyan); }
  .span-type-badge.reasoning_step { background: rgba(251,146,60,0.15); color: var(--orange); }
  .span-timing { font-size: 12px; color: var(--text-dim); font-family: var(--mono); }
  .span-model { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
  .span-tool { font-size: 13px; font-weight: 600; color: var(--purple); margin-top: 2px; }
  .span-error { font-size: 12px; color: var(--red); margin-top: 4px; display: flex; align-items: center; gap: 4px; }
  .span-content { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); display: none; }
  .span-card.expanded .span-content { display: block; }
  .span-io-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .span-io-block { background: var(--bg); border-radius: 6px; padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin-bottom: 10px; max-height: 200px; overflow-y: auto; color: var(--text); }
  .token-bar { display: flex; gap: 12px; font-size: 12px; color: var(--text-dim); margin-top: 6px; }
  .token-bar span { display: flex; align-items: center; gap: 4px; }

  /* ── Metrics / Sources shared ── */
  .metrics-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
  .metric-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
  .metric-card.full-width { grid-column: 1 / -1; }
  .metric-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
  .bar-chart { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: flex; align-items: center; gap: 10px; }
  .bar-label { width: 140px; font-size: 13px; color: var(--text-dim); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
  .bar-track { flex: 1; height: 20px; background: var(--bg); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s; display: flex; align-items: center; padding-left: 8px; font-size: 11px; font-weight: 600; }
  .bar-value { width: 70px; text-align: right; font-size: 13px; font-family: var(--mono); }
  .timeline { margin-top: 16px; }
  .timeline-row { display: flex; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .timeline-time { width: 80px; color: var(--text-dim); font-family: var(--mono); font-size: 12px; }
  .timeline-bar-area { flex: 1; height: 18px; position: relative; }
  .timeline-bar { position: absolute; height: 100%; border-radius: 3px; opacity: 0.8; min-width: 4px; }
  .timeline-agent { width: 140px; margin-left: 10px; }

  /* ── Source cards ── */
  .source-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 16px; margin-top: 16px; }
  .source-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; transition: border-color 0.15s; }
  .source-card:hover { border-color: var(--accent); }
  .source-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
  .source-name { font-size: 16px; font-weight: 700; }
  .source-badge { font-size: 11px; padding: 3px 10px; border-radius: 12px; font-weight: 600; }
  .source-badge.lantern { background: rgba(108,140,255,0.15); color: var(--accent); }
  .source-badge.console { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .source-badge.otlp { background: rgba(34,211,238,0.15); color: var(--cyan); }
  .source-details { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .source-detail { }
  .source-detail-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .source-detail-value { font-size: 14px; margin-top: 2px; }
  .source-agents { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
  .source-agents-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .agent-chip { display: inline-block; padding: 2px 8px; border-radius: 4px; background: var(--surface2); font-size: 12px; margin: 2px 4px 2px 0; font-family: var(--mono); }
  .env-chip { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin: 2px 4px 2px 0; font-weight: 600; }
  .env-chip.production { background: rgba(248,113,113,0.12); color: var(--red); }
  .env-chip.staging { background: rgba(251,191,36,0.12); color: var(--yellow); }
  .env-chip.dev { background: rgba(52,211,153,0.12); color: var(--green); }

  .loading { text-align: center; padding: 40px; color: var(--text-dim); }
  .page-header { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
  .page-sub { color: var(--text-dim); font-size: 14px; margin-bottom: 20px; }

  /* ── Ingest config ── */
  .config-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-top: 16px; }
  .config-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .config-row:last-child { border-bottom: none; }
  .config-key { font-size: 13px; color: var(--text-dim); }
  .config-val { font-size: 13px; font-family: var(--mono); }
</style>
</head>
<body>

<header>
  <div class="logo"><div class="logo-icon">&#9678;</div>Lantern</div>
  <nav>
    <button class="active" data-view="traces">Traces</button>
    <button data-view="metrics">Metrics</button>
    <button data-view="sources">Sources</button>
  </nav>
  <div class="health-badge"><div class="health-dot"></div><span id="health-text">Connecting...</span></div>
</header>

<main>
  <div id="traces-view" style="display:flex; width:100%;">
    <div class="panel-left">
      <div class="stats-bar" id="stats-bar"></div>
      <div class="filters" id="filters"></div>
      <div class="trace-list" id="trace-list"><div class="loading">Loading traces...</div></div>
    </div>
    <div class="panel-right" id="trace-detail"><div class="detail-empty">Select a trace to view details</div></div>
  </div>
  <div id="metrics-view" class="full-view" style="display:none;"></div>
  <div id="sources-view" class="full-view" style="display:none;"></div>
</main>

<script>
/*__API_KEY_INJECT__*/
function authHeaders() {
  const key = window.__LANTERN_API_KEY__;
  return key ? { 'Authorization': 'Bearer ' + key } : {};
}
const API = window.location.origin;
let allTraces = [];
let allSources = [];
let selectedTraceId = null;
let activeFilter = 'all';
let activeView = 'traces';

async function init() {
  await Promise.all([checkHealth(), loadTraces(), loadSources()]);
  setupNav();
  setInterval(checkHealth, 10000);
  setInterval(() => { loadTraces(); loadSources(); }, 5000);
}

async function checkHealth() {
  try {
    const r = await fetch(API + '/health');
    const h = await r.json();
    document.getElementById('health-text').textContent = h.status + ' \\u00b7 ' + h.traceCount + ' traces';
  } catch { document.getElementById('health-text').textContent = 'Disconnected'; }
}

function setupNav() {
  document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeView = btn.dataset.view;
      document.getElementById('traces-view').style.display = activeView === 'traces' ? 'flex' : 'none';
      document.getElementById('metrics-view').style.display = activeView === 'metrics' ? 'block' : 'none';
      document.getElementById('sources-view').style.display = activeView === 'sources' ? 'block' : 'none';
      if (activeView === 'metrics') renderMetrics();
      if (activeView === 'sources') renderSources();
    });
  });
}

// ── Load data ──
async function loadTraces() {
  try {
    const r = await fetch(API + '/v1/traces?limit=100', { headers: authHeaders() });
    const d = await r.json();
    allTraces = d.traces || [];
    renderStats(); renderFilters(); renderTraceList();
    if (activeView === 'metrics') renderMetrics();
  } catch {}
}

async function loadSources() {
  try {
    const r = await fetch(API + '/v1/sources', { headers: authHeaders() });
    const d = await r.json();
    allSources = d.sources || [];
  } catch {}
}

// ── Stats ──
function renderStats() {
  const total = allTraces.length;
  const success = allTraces.filter(t => t.status === 'success').length;
  const errors = allTraces.filter(t => t.status === 'error').length;
  const totalCost = allTraces.reduce((s, t) => s + t.estimatedCostUsd, 0);
  const avgDuration = total > 0 ? Math.round(allTraces.reduce((s, t) => s + (t.durationMs || 0), 0) / total) : 0;
  const sources = new Set(allTraces.map(t => t.source?.serviceName).filter(Boolean)).size;

  document.getElementById('stats-bar').innerHTML = [
    { label: 'Traces', value: total, cls: 'accent' },
    { label: 'Success', value: success, cls: 'green' },
    { label: 'Errors', value: errors, cls: 'red' },
    { label: 'Avg Latency', value: avgDuration + 'ms', cls: 'yellow' },
    { label: 'Cost', value: '\\$' + totalCost.toFixed(4), cls: 'accent' },
    { label: 'Sources', value: sources || '\\u2014', cls: 'accent' },
  ].map(s => '<div class="stat-card"><div class="stat-label">' + s.label + '</div><div class="stat-value ' + s.cls + '">' + s.value + '</div></div>').join('');
}

// ── Filters ──
function renderFilters() {
  const envs = [...new Set(allTraces.map(t => t.environment))].sort();
  const statuses = [...new Set(allTraces.map(t => t.status))].sort();
  const services = [...new Set(allTraces.map(t => t.source?.serviceName).filter(Boolean))].sort();

  let chips = [{ key: 'all', label: 'All' }];
  if (services.length > 0) {
    chips.push(...services.map(s => ({ key: 'svc:' + s, label: s })));
    chips.push({ key: '_sep1', label: '' });
  }
  chips.push(...envs.map(e => ({ key: 'env:' + e, label: e })));
  if (statuses.length > 1) {
    chips.push({ key: '_sep2', label: '' });
    chips.push(...statuses.map(s => ({ key: 'status:' + s, label: s })));
  }

  document.getElementById('filters').innerHTML = chips.map(c => {
    if (c.key.startsWith('_sep')) return '<div class="filter-sep"></div>';
    return '<button class="filter-chip' + (activeFilter === c.key ? ' active' : '') + '" data-filter="' + c.key + '">' + esc(c.label) + '</button>';
  }).join('');

  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => { activeFilter = btn.dataset.filter; renderFilters(); renderTraceList(); });
  });
}

function filteredTraces() {
  if (activeFilter === 'all') return allTraces;
  const [type, ...rest] = activeFilter.split(':');
  const val = rest.join(':');
  if (type === 'env') return allTraces.filter(t => t.environment === val);
  if (type === 'status') return allTraces.filter(t => t.status === val);
  if (type === 'svc') return allTraces.filter(t => t.source?.serviceName === val);
  return allTraces;
}

// ── Trace list ──
function renderTraceList() {
  const traces = filteredTraces();
  if (traces.length === 0) { document.getElementById('trace-list').innerHTML = '<div class="loading">No traces found</div>'; return; }

  document.getElementById('trace-list').innerHTML = traces.map(t => {
    const time = new Date(t.startTime).toLocaleTimeString();
    const spans = (t.spans || []).length;
    const svc = t.source?.serviceName;
    return '<div class="trace-item' + (selectedTraceId === t.id ? ' selected' : '') + '" data-id="' + esc(t.id) + '">' +
      '<div class="trace-header"><span class="trace-agent">' + esc(t.agentName) + '</span><span class="trace-status ' + cls(t.status) + '">' + esc(t.status) + '</span></div>' +
      '<div class="trace-meta">' +
        (svc ? '<span class="source-tag">' + esc(svc) + '</span>' : '') +
        '<span>' + esc(t.environment) + '</span>' +
        '<span>' + (t.durationMs || '?') + 'ms</span>' +
        '<span>' + spans + ' span' + (spans !== 1 ? 's' : '') + '</span>' +
        '<span>\\$' + t.estimatedCostUsd.toFixed(4) + '</span>' +
        '<span>' + time + '</span>' +
      '</div></div>';
  }).join('');

  document.querySelectorAll('.trace-item').forEach(el => {
    el.addEventListener('click', () => selectTrace(el.dataset.id));
  });
}

// ── Trace detail ──
async function selectTrace(id) {
  selectedTraceId = id; renderTraceList();
  const panel = document.getElementById('trace-detail');
  panel.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const r = await fetch(API + '/v1/traces/' + id, { headers: authHeaders() });
    const trace = await r.json();
    renderTraceDetail(trace);
  } catch { panel.innerHTML = '<div class="detail-empty">Failed to load trace</div>'; }
}

function renderTraceDetail(t) {
  const panel = document.getElementById('trace-detail');
  const time = new Date(t.startTime).toLocaleString();

  let html = '<div class="detail-header">' +
    '<div class="detail-title"><span class="trace-status ' + cls(t.status) + '">' + esc(t.status) + '</span> ' +
    esc(t.agentName) + (t.agentVersion ? ' <span style="color:var(--text-dim);font-weight:400;font-size:14px">v' + esc(t.agentVersion) + '</span>' : '') +
    '</div><div class="detail-id">' + esc(t.id) + '</div>' +
    '<div class="detail-stats">' +
      detailStat('Environment', t.environment) +
      detailStat('Duration', (t.durationMs || '?') + 'ms') +
      detailStat('Input Tokens', t.totalInputTokens.toLocaleString()) +
      detailStat('Output Tokens', t.totalOutputTokens.toLocaleString()) +
      detailStat('Estimated Cost', '\\$' + t.estimatedCostUsd.toFixed(6)) +
      detailStat('Started', time) +
    '</div>';

  // Source info
  if (t.source) {
    html += '<div class="source-info">';
    html += srcItem('Service', t.source.serviceName);
    if (t.source.sdkVersion) html += srcItem('SDK Version', t.source.sdkVersion);
    if (t.source.exporterType) html += srcItem('Exporter', t.source.exporterType);
    html += srcItem('Session', t.sessionId.slice(0, 12) + '...');
    html += '</div>';
  }

  html += '</div>';

  // Metadata
  if (t.metadata && Object.keys(t.metadata).length > 0) {
    html += '<div class="section-title">Metadata</div>';
    html += '<div class="span-io-block">' + esc(JSON.stringify(t.metadata, null, 2)) + '</div>';
  }

  // Span tree
  html += '<div class="section-title">Reasoning Chain (' + (t.spans || []).length + ' spans)</div>';
  html += renderSpanTree(t.spans || []);

  panel.innerHTML = html;
  panel.querySelectorAll('.span-card').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('expanded'));
  });
}

function detailStat(label, value) {
  return '<div class="detail-stat"><div class="detail-stat-label">' + esc(label) + '</div><div class="detail-stat-value">' + esc(value) + '</div></div>';
}

function srcItem(label, value) {
  return '<div class="source-info-item"><div class="source-info-label">' + label + '</div><div class="source-info-value">' + esc(value) + '</div></div>';
}

// ── Span tree ──
function renderSpanTree(spans) {
  const roots = spans.filter(s => !s.parentSpanId);
  return '<div class="span-tree">' + roots.map(s => renderSpanNode(s, spans, 0)).join('') + '</div>';
}

function renderSpanNode(span, allSpans, depth) {
  const children = allSpans.filter(s => s.parentSpanId === span.id);
  const indent = depth * 28;

  let inputText = '';
  if (span.input) {
    if (span.input.messages) inputText = span.input.messages.map(m => m.role + ': ' + m.content).join('\\n\\n');
    else if (span.input.prompt) inputText = span.input.prompt;
    else if (span.input.args) inputText = JSON.stringify(span.input.args, null, 2);
  }
  let outputText = '';
  if (span.output) {
    if (span.output.content) outputText = span.output.content;
    if (span.output.toolCalls) outputText += (outputText ? '\\n\\n' : '') + 'Tool calls: ' + JSON.stringify(span.output.toolCalls, null, 2);
  }

  let html = '<div class="span-node" style="margin-left:' + indent + 'px">' +
    '<div class="span-connector"><div class="span-line"></div><div class="span-dot ' + cls(span.type) + '"></div><div class="span-line"></div></div>' +
    '<div class="span-card"><div class="span-card-header">' +
      '<span class="span-type-badge ' + cls(span.type) + '">' + esc(span.type.replace('_', ' ')) + '</span>' +
      '<span class="span-timing">' + (span.durationMs || '?') + 'ms</span></div>' +
      (span.model ? '<div class="span-model">' + esc(span.model) + '</div>' : '') +
      (span.toolName ? '<div class="span-tool">' + esc(span.toolName) + '</div>' : '') +
      (span.error ? '<div class="span-error">&#10007; ' + esc(span.error) + '</div>' : '') +
      '<div class="span-content">';

  if (inputText) html += '<div class="span-io-label">Input</div><div class="span-io-block">' + esc(inputText) + '</div>';
  if (outputText) html += '<div class="span-io-label">Output</div><div class="span-io-block">' + esc(outputText) + '</div>';
  if (span.inputTokens != null || span.outputTokens != null) {
    html += '<div class="token-bar">';
    if (span.inputTokens != null) html += '<span>In: ' + span.inputTokens.toLocaleString() + ' tokens</span>';
    if (span.outputTokens != null) html += '<span>Out: ' + span.outputTokens.toLocaleString() + ' tokens</span>';
    if (span.estimatedCostUsd != null) html += '<span>Cost: \\$' + span.estimatedCostUsd.toFixed(6) + '</span>';
    html += '</div>';
  }
  html += '</div></div></div>';
  html += children.map(c => renderSpanNode(c, allSpans, depth + 1)).join('');
  return html;
}

// ── Sources view ──
function renderSources() {
  const container = document.getElementById('sources-view');

  let html = '<div class="page-header">Data Sources</div>' +
    '<div class="page-sub">Services sending traces to this Lantern instance</div>';

  // Ingest server config
  html += '<div class="config-card"><div class="metric-title">Ingest Configuration</div>' +
    '<div class="config-row"><span class="config-key">Endpoint</span><span class="config-val">' + API + '/v1/traces</span></div>' +
    '<div class="config-row"><span class="config-key">Protocol</span><span class="config-val">HTTP POST (JSON)</span></div>' +
    '<div class="config-row"><span class="config-key">Storage</span><span class="config-val">SQLite (local)</span></div>' +
    '</div>';

  if (allSources.length === 0) {
    html += '<div class="loading" style="margin-top:40px;">No sources detected yet. Instrument an agent with <code>@openlantern-ai/sdk</code> to start sending traces.</div>';
    container.innerHTML = html;
    return;
  }

  // Source cards
  html += '<div class="source-grid">';
  for (const src of allSources) {
    const exporterCls = src.exporterType || 'lantern';
    const lastSeen = new Date(src.lastSeen).toLocaleString();

    html += '<div class="source-card">' +
      '<div class="source-card-header">' +
        '<div class="source-name">' + esc(src.serviceName) + '</div>' +
        '<span class="source-badge ' + cls(exporterCls) + '">' + esc(src.exporterType || 'unknown') + '</span>' +
      '</div>' +
      '<div class="source-details">' +
        '<div class="source-detail"><div class="source-detail-label">Traces</div><div class="source-detail-value">' + src.traceCount + '</div></div>' +
        '<div class="source-detail"><div class="source-detail-label">Last Seen</div><div class="source-detail-value">' + lastSeen + '</div></div>' +
        (src.sdkVersion ? '<div class="source-detail"><div class="source-detail-label">SDK Version</div><div class="source-detail-value">' + esc(src.sdkVersion) + '</div></div>' : '') +
        '<div class="source-detail"><div class="source-detail-label">Exporter</div><div class="source-detail-value">' + esc(src.exporterType || 'unknown') + '</div></div>' +
      '</div>' +
      '<div class="source-agents"><div class="source-agents-label">Environments</div>';
    for (const env of src.environments) {
      html += '<span class="env-chip ' + cls(env) + '">' + esc(env) + '</span>';
    }
    html += '</div><div class="source-agents" style="border-top:none;padding-top:8px;"><div class="source-agents-label">Agents</div>';
    for (const agent of src.agents) {
      html += '<span class="agent-chip">' + esc(agent) + '</span>';
    }
    html += '</div></div>';
  }
  html += '</div>';

  // SDK quickstart
  html += '<div class="config-card" style="margin-top:24px;"><div class="metric-title">Connect a New Source</div>' +
    '<div class="span-io-block" style="max-height:none;">' +
    esc('import { LanternTracer, LanternExporter } from "@openlantern-ai/sdk";\\n\\nconst tracer = new LanternTracer({\\n  serviceName: "my-service",\\n  environment: "production",\\n  exporter: new LanternExporter({\\n    endpoint: "' + API + '",\\n  }),\\n});') +
    '</div></div>';

  container.innerHTML = html;
}

// ── Metrics view ──
function renderMetrics() {
  const container = document.getElementById('metrics-view');
  if (allTraces.length === 0) { container.innerHTML = '<div class="page-header">Metrics</div><div class="loading">No data yet</div>'; return; }

  const costByAgent = {}, tokensByAgent = {}, countByEnv = {}, countByStatus = {}, costByService = {};
  allTraces.forEach(t => {
    costByAgent[t.agentName] = (costByAgent[t.agentName] || 0) + t.estimatedCostUsd;
    tokensByAgent[t.agentName] = (tokensByAgent[t.agentName] || 0) + t.totalInputTokens + t.totalOutputTokens;
    countByEnv[t.environment] = (countByEnv[t.environment] || 0) + 1;
    countByStatus[t.status] = (countByStatus[t.status] || 0) + 1;
    const svc = t.source?.serviceName || 'unknown';
    costByService[svc] = (costByService[svc] || 0) + t.estimatedCostUsd;
  });

  let html = '<div class="page-header">Metrics</div><div class="page-sub">Cost attribution, token usage, and trace breakdown</div><div class="metrics-grid">';

  html += barCard('Cost by Agent', costByAgent, 'var(--accent)', v => '\\$' + v.toFixed(4));
  html += barCard('Tokens by Agent', tokensByAgent, 'var(--purple)', v => v.toLocaleString());
  html += barCard('Traces by Environment', countByEnv, 'var(--green)', v => v);
  html += barCard('Cost by Source', costByService, 'var(--cyan)', v => '\\$' + v.toFixed(4));

  // Status
  const statusColors = { success: 'var(--green)', error: 'var(--red)', running: 'var(--yellow)' };
  const maxStatus = Math.max(...Object.values(countByStatus));
  html += '<div class="metric-card"><div class="metric-title">Status Breakdown</div><div class="bar-chart">';
  for (const [status, count] of Object.entries(countByStatus)) {
    const pct = maxStatus > 0 ? (count / maxStatus * 100) : 0;
    html += '<div class="bar-row"><div class="bar-label">' + esc(status) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + (statusColors[status] || 'var(--text-dim)') + '"></div></div><div class="bar-value">' + count + '</div></div>';
  }
  html += '</div></div>';

  // Timeline
  html += '<div class="metric-card full-width"><div class="metric-title">Trace Timeline</div><div class="timeline">';
  const sorted = [...allTraces].sort((a, b) => a.startTime - b.startTime);
  const minT = sorted[0]?.startTime || 0;
  const maxT = Math.max(...sorted.map(t => (t.endTime || t.startTime + (t.durationMs || 0))));
  const range = maxT - minT || 1;
  for (const t of sorted) {
    const left = ((t.startTime - minT) / range * 100);
    const width = Math.max(2, ((t.durationMs || 100) / range * 100));
    const color = t.status === 'error' ? 'var(--red)' : 'var(--accent)';
    html += '<div class="timeline-row"><div class="timeline-time">' + new Date(t.startTime).toLocaleTimeString() + '</div>' +
      '<div class="timeline-bar-area"><div class="timeline-bar" style="left:' + left + '%;width:' + width + '%;background:' + color + '"></div></div>' +
      '<div class="timeline-agent">' + esc(t.agentName) + '</div></div>';
  }
  html += '</div></div></div>';
  container.innerHTML = html;
}

function barCard(title, data, color, fmt) {
  const max = Math.max(...Object.values(data));
  let html = '<div class="metric-card"><div class="metric-title">' + title + '</div><div class="bar-chart">';
  for (const [k, v] of Object.entries(data).sort((a, b) => b[1] - a[1])) {
    const pct = max > 0 ? (v / max * 100) : 0;
    html += '<div class="bar-row"><div class="bar-label">' + esc(k) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div><div class="bar-value">' + fmt(v) + '</div></div>';
  }
  return html + '</div></div>';
}

function esc(s) { if (s == null) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function cls(s) { return String(s || '').replace(/[^a-z0-9_-]/gi, ''); }

init();
</script>
</body>
</html>`;
