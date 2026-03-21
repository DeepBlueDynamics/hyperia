//! Serves the telemetry dashboard at /dashboard and widget JSON at /api/telemetry/*.
//! The HTML page is self-contained with inline JS that polls the JSON endpoints.
//! Widgets are programmable: POST /api/dashboard/widgets to reconfigure on the fly.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Html;
use crate::telemetry::TelemetryStore;
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Widget config — programmable on the fly
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetConfig {
    pub id: String,
    pub kind: String,       // "file_ops", "network", "tokens", "custom"
    pub title: String,
    pub color: String,       // hex color for the widget frame
    pub level: String,       // "window", "pane"
    pub pane_uid: Option<String>,
    pub visible: bool,
    pub order: u32,
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            id: "default".into(),
            kind: "file_ops".into(),
            title: "File Operations".into(),
            color: "#22c55e".into(),
            level: "window".into(),
            pane_uid: None,
            visible: true,
            order: 0,
        }
    }
}

#[derive(Clone)]
pub struct DashboardState {
    pub telemetry: TelemetryStore,
    pub widgets: Arc<Mutex<Vec<WidgetConfig>>>,
}

impl DashboardState {
    pub fn new(telemetry: TelemetryStore) -> Self {
        // Default widget set
        let defaults = vec![
            WidgetConfig {
                id: "file_ops".into(),
                kind: "file_ops".into(),
                title: "File Operations".into(),
                color: "#22c55e".into(),
                level: "window".into(),
                pane_uid: None,
                visible: true,
                order: 0,
            },
            WidgetConfig {
                id: "network".into(),
                kind: "network".into(),
                title: "Network Traffic".into(),
                color: "#468cff".into(),
                level: "window".into(),
                pane_uid: None,
                visible: true,
                order: 1,
            },
            WidgetConfig {
                id: "tokens".into(),
                kind: "tokens".into(),
                title: "Token Usage".into(),
                color: "#a050ff".into(),
                level: "window".into(),
                pane_uid: None,
                visible: true,
                order: 2,
            },
        ];
        Self {
            telemetry,
            widgets: Arc::new(Mutex::new(defaults)),
        }
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /dashboard — serves the self-contained HTML dashboard
pub async fn get_dashboard(State(state): State<DashboardState>) -> Html<String> {
    let widgets = state.widgets.lock().unwrap().clone();
    let widgets_json = serde_json::to_string(&widgets).unwrap_or_else(|_| "[]".into());
    Html(dashboard_html(&widgets_json))
}

/// GET /api/telemetry/snapshot?level=window|pane&uid=optional
pub async fn get_telemetry_snapshot(
    State(state): State<DashboardState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::Json<serde_json::Value> {
    let level = params.get("level").map(|s| s.as_str()).unwrap_or("window");
    let uid = params.get("uid").map(|s| s.as_str());
    axum::Json(state.telemetry.snapshot_json(level, uid))
}

/// GET /api/dashboard/widgets — current widget config
pub async fn get_widgets(State(state): State<DashboardState>) -> axum::Json<Vec<WidgetConfig>> {
    let widgets = state.widgets.lock().unwrap().clone();
    axum::Json(widgets)
}

/// POST /api/dashboard/widgets — replace widget config on the fly
pub async fn post_widgets(
    State(state): State<DashboardState>,
    body: String,
) -> (StatusCode, String) {
    match serde_json::from_str::<Vec<WidgetConfig>>(&body) {
        Ok(new_widgets) => {
            *state.widgets.lock().unwrap() = new_widgets;
            (StatusCode::OK, "ok".into())
        }
        Err(e) => (StatusCode::BAD_REQUEST, format!("Bad widget config: {e}")),
    }
}

/// POST /api/telemetry/toggle — enable/disable telemetry collection
pub async fn post_telemetry_toggle(
    State(state): State<DashboardState>,
    body: String,
) -> axum::Json<serde_json::Value> {
    let enabled = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["enabled"].as_bool())
        .unwrap_or(!state.telemetry.is_enabled());
    let new_state = state.telemetry.set_enabled(enabled);
    axum::Json(serde_json::json!({"enabled": new_state}))
}

/// POST /api/telemetry/reset — clear all counters
pub async fn post_telemetry_reset(
    State(state): State<DashboardState>,
) -> &'static str {
    state.telemetry.reset();
    "ok"
}

/// POST /api/telemetry/event — ingest a telemetry event for a pane
pub async fn post_telemetry_event(
    State(state): State<DashboardState>,
    body: String,
) -> (StatusCode, String) {
    #[derive(Deserialize)]
    struct Envelope {
        pane_uid: String,
        #[serde(flatten)]
        event: crate::telemetry::TelemetryEvent,
    }
    match serde_json::from_str::<Envelope>(&body) {
        Ok(env) => {
            state.telemetry.record(&env.pane_uid, env.event);
            (StatusCode::OK, "ok".into())
        }
        Err(e) => (StatusCode::BAD_REQUEST, format!("Bad event: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Self-contained HTML dashboard
// ---------------------------------------------------------------------------

fn dashboard_html(initial_widgets_json: &str) -> String {
    format!(r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hyperia Dashboard</title>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
  background: #0a0a0f;
  color: #ccc;
  min-height: 100vh;
}}
header {{
  padding: 16px 24px;
  border-bottom: 1px solid #1a1a2e;
  display: flex;
  justify-content: space-between;
  align-items: center;
}}
header h1 {{ font-size: 18px; color: #fff; letter-spacing: 1px; }}
.controls {{ display: flex; gap: 10px; }}
.controls button {{
  background: #1a1a2e;
  border: 1px solid #333;
  color: #aaa;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}}
.controls button:hover {{ background: #222; color: #fff; }}
.controls button.active {{ border-color: #22c55e; color: #22c55e; }}
.grid {{
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
  padding: 20px 24px;
}}
.widget {{
  background: #0b0b0f;
  border-radius: 10px;
  padding: 14px;
  transition: box-shadow 0.3s;
}}
.widget-title {{
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  letter-spacing: 1px;
  margin-bottom: 12px;
  text-transform: uppercase;
}}
.metric-row {{
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px solid #111;
}}
.metric-row:last-child {{ border-bottom: none; }}
.metric-label {{ color: #888; }}
.metric-value {{ color: #fff; font-variant-numeric: tabular-nums; }}
.big-number {{
  font-size: 32px;
  font-weight: bold;
  color: #fff;
  margin: 8px 0;
}}
.sub-label {{ font-size: 11px; color: #666; }}
.status-dot {{
  width: 8px; height: 8px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 6px;
}}
.pane-selector {{
  display: flex; gap: 6px; padding: 10px 24px; flex-wrap: wrap;
}}
.pane-btn {{
  background: #111;
  border: 1px solid #222;
  color: #888;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}}
.pane-btn.active {{ border-color: #468cff; color: #468cff; }}
</style>
</head>
<body>
<header>
  <h1>HYPERIA TELEMETRY</h1>
  <div class="controls">
    <button id="btn-level-window" class="active" onclick="setLevel('window')">Window</button>
    <button id="btn-level-pane" onclick="setLevel('pane')">Pane</button>
    <button id="btn-toggle" onclick="toggleTelemetry()">Pause</button>
    <button onclick="resetTelemetry()">Reset</button>
  </div>
</header>
<div id="pane-selector" class="pane-selector" style="display:none;"></div>
<div id="grid" class="grid"></div>

<script>
let widgets = {initial_widgets_json};
let level = 'window';
let selectedPane = null;
let data = {{}};
let paused = false;

function setLevel(l) {{
  level = l;
  document.getElementById('btn-level-window').className = l === 'window' ? 'active' : '';
  document.getElementById('btn-level-pane').className = l === 'pane' ? 'active' : '';
  document.getElementById('pane-selector').style.display = l === 'pane' ? 'flex' : 'none';
  refresh();
}}

async function toggleTelemetry() {{
  paused = !paused;
  document.getElementById('btn-toggle').textContent = paused ? 'Resume' : 'Pause';
  await fetch('/api/telemetry/toggle', {{
    method: 'POST',
    body: JSON.stringify({{ enabled: !paused }})
  }});
}}

async function resetTelemetry() {{
  await fetch('/api/telemetry/reset', {{ method: 'POST' }});
  refresh();
}}

function fmt(n) {{
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}}

function fmtNum(n) {{
  return n.toLocaleString();
}}

function renderWidgets() {{
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  const sorted = [...widgets].filter(w => w.visible).sort((a, b) => a.order - b.order);
  for (const w of sorted) {{
    const el = document.createElement('div');
    el.className = 'widget';
    el.style.border = `1px solid ${{w.color}}55`;
    el.style.boxShadow = `0 0 24px ${{w.color}}22`;
    let content = '';
    if (w.kind === 'file_ops') {{
      const d = data || {{}};
      content = `
        <div class="big-number">${{fmtNum((d.file_creates||0) + (d.file_writes||0) + (d.file_deletes||0) + (d.file_renames||0) + (d.file_reads||0))}}</div>
        <div class="sub-label">total operations</div>
        <div class="metric-row"><span class="metric-label">Creates</span><span class="metric-value">${{fmtNum(d.file_creates||0)}}</span></div>
        <div class="metric-row"><span class="metric-label">Writes</span><span class="metric-value">${{fmtNum(d.file_writes||0)}}</span></div>
        <div class="metric-row"><span class="metric-label">Deletes</span><span class="metric-value">${{fmtNum(d.file_deletes||0)}}</span></div>
        <div class="metric-row"><span class="metric-label">Reads</span><span class="metric-value">${{fmtNum(d.file_reads||0)}}</span></div>
        <div class="metric-row"><span class="metric-label">Bytes written</span><span class="metric-value">${{fmt(d.file_bytes_written||0)}}</span></div>
      `;
    }} else if (w.kind === 'network') {{
      const d = data || {{}};
      content = `
        <div class="big-number">${{fmt((d.net_inbound_bytes||0) + (d.net_outbound_bytes||0))}}</div>
        <div class="sub-label">total traffic</div>
        <div class="metric-row"><span class="metric-label">Inbound</span><span class="metric-value">${{fmt(d.net_inbound_bytes||0)}}</span></div>
        <div class="metric-row"><span class="metric-label">Outbound</span><span class="metric-value">${{fmt(d.net_outbound_bytes||0)}}</span></div>
        <div class="metric-row"><span class="metric-label">Hosts</span><span class="metric-value">${{(d.net_hosts||[]).length}}</span></div>
      `;
    }} else if (w.kind === 'tokens') {{
      const d = data || {{}};
      const total = (d.tokens_in||0) + (d.tokens_out||0);
      content = `
        <div class="big-number">${{fmtNum(total)}}</div>
        <div class="sub-label">total tokens</div>
        <div class="metric-row"><span class="metric-label">Input</span><span class="metric-value">${{fmtNum(d.tokens_in||0)}}</span></div>
        <div class="metric-row"><span class="metric-label">Output</span><span class="metric-value">${{fmtNum(d.tokens_out||0)}}</span></div>
        <div class="metric-row"><span class="metric-label">Cache hits</span><span class="metric-value">${{fmtNum(d.tokens_cache||0)}}</span></div>
      `;
    }} else {{
      content = `<div class="sub-label">Custom widget: ${{w.kind}}</div>`;
    }}
    el.innerHTML = `
      <div class="widget-title" style="color:${{w.color}}"><span>${{w.title}}</span></div>
      ${{content}}
    `;
    grid.appendChild(el);
  }}
}}

async function refresh() {{
  try {{
    let url = '/api/telemetry/snapshot?level=' + level;
    if (level === 'pane' && selectedPane) url += '&uid=' + selectedPane;
    const resp = await fetch(url);
    data = await resp.json();

    // Update pane selector if in pane mode
    if (level === 'pane' && !selectedPane) {{
      // data is a map of pane_uid → metrics
      const sel = document.getElementById('pane-selector');
      sel.innerHTML = '';
      for (const uid of Object.keys(data)) {{
        const btn = document.createElement('button');
        btn.className = 'pane-btn' + (uid === selectedPane ? ' active' : '');
        btn.textContent = uid.substring(0, 8);
        btn.onclick = () => {{ selectedPane = uid; refresh(); }};
        sel.appendChild(btn);
      }}
    }}

    renderWidgets();
  }} catch (e) {{
    console.error('Refresh error:', e);
  }}
}}

// Poll every 2 seconds
setInterval(refresh, 2000);
refresh();
</script>
</body>
</html>"##)
}
