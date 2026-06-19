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
            color: "#10b981".into(),
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
    pub system_status: Arc<Mutex<serde_json::Value>>,
}

impl DashboardState {
    pub fn new(telemetry: TelemetryStore) -> Self {
        // Default widget set
        let defaults = vec![
            WidgetConfig {
                id: "file_ops".into(),
                kind: "file_ops".into(),
                title: "File Operations".into(),
                color: "#10b981".into(),
                level: "window".into(),
                pane_uid: None,
                visible: true,
                order: 0,
            },
            WidgetConfig {
                id: "network".into(),
                kind: "network".into(),
                title: "Network Traffic".into(),
                color: "#38bdf8".into(),
                level: "window".into(),
                pane_uid: None,
                visible: true,
                order: 1,
            },
            WidgetConfig {
                id: "tokens".into(),
                kind: "tokens".into(),
                title: "Token Usage".into(),
                color: "#8b5cf6".into(),
                level: "window".into(),
                pane_uid: None,
                visible: true,
                order: 2,
            },
        ];
        
        let system_status = Arc::new(Mutex::new(serde_json::json!({
            "level": "none",
            "vram_gb": serde_json::Value::Null,
            "agent": {
                "provider": "none",
                "model": "none",
                "maximus_disabled": false,
            },
            "providers": {
                "anthropic": { "has_token": false },
                "openai":    { "has_token": false },
                "gemini":    { "has_token": false },
                "ollama":    {
                    "reachable": false,
                    "endpoint": "http://localhost:11434",
                    "models": Vec::<String>::new(),
                }
            },
            "ferricula": {
                "reachable": false,
                "base_url": "http://localhost:8765",
                "memory_count": serde_json::Value::Null,
            },
            "transcription": {
                "reachable": false,
                "base_url": "http://localhost:8767",
                "model": "None",
                "model_loaded": false,
                "gpu": false,
                "queue": {
                    "queued": 0,
                    "processing": 0,
                    "completed": 0,
                    "failed": 0,
                    "total": 0
                }
            }
        })));
        
        let system_status_clone = system_status.clone();
        
        // Spawn background diagnostics thread
        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(2000))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());
            
            loop {
                let status_payload = get_status_data(&client).await;
                if let Ok(mut lock) = system_status_clone.lock() {
                    *lock = status_payload;
                }
                tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            }
        });

        Self {
            telemetry,
            widgets: Arc::new(Mutex::new(defaults)),
            system_status,
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
    
    let telemetry_data = state.telemetry.snapshot_json(level, uid);
    let system_data = state.system_status.lock().unwrap().clone();
    
    axum::Json(serde_json::json!({
        "telemetry": telemetry_data,
        "system": system_data,
    }))
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

// Helper to query and construct the system diagnostic snapshot
async fn get_status_data(client: &reqwest::Client) -> serde_json::Value {
    let raw_cfg: serde_json::Value = crate::util::read_shared_config().unwrap_or(serde_json::Value::Null);

    let active_provider = raw_cfg["config"]["agent"]["provider"]
        .as_str()
        .unwrap_or("none")
        .trim()
        .to_string();
    let active_model = raw_cfg["config"]["agent"]["model"]
        .as_str()
        .unwrap_or("none")
        .trim()
        .to_string();

    let has_token = |name: &str| -> bool {
        let providers = &raw_cfg["config"]["providers"];
        if providers[name]["token"].as_str().map(|s| !s.is_empty()).unwrap_or(false) {
            return true;
        }
        let env_keys = match name {
            "anthropic" => vec!["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"],
            "openai" => vec!["OPENAI_API_KEY", "OPENAI_TOKEN"],
            "gemini" => vec!["GEMINI_API_KEY", "GEMINI_TOKEN"],
            _ => vec![],
        };
        for key in env_keys {
            if raw_cfg["config"]["env"][key].as_str().map(|s| !s.trim().is_empty()).unwrap_or(false) {
                return true;
            }
            if std::env::var(key).map(|s| !s.trim().is_empty()).unwrap_or(false) {
                return true;
            }
        }
        false
    };

    let has_anthropic = has_token("anthropic");
    let has_openai = has_token("openai");
    let has_gemini = has_token("gemini");
    let has_frontier = has_anthropic || has_openai || has_gemini;

    // Ollama probe
    let ollama_disabled = std::env::var("MAXIMUS_DISABLED")
        .map(|s| s.trim().to_lowercase() == "true" || s.trim() == "1")
        .unwrap_or(false)
        || raw_cfg["config"]["maximus"]["disabled"].as_bool().unwrap_or(false);

    let mut ollama_endpoint = raw_cfg["config"]["providers"]["ollama"]["endpoint"]
        .as_str()
        .unwrap_or("http://localhost:11434")
        .trim_end_matches('/')
        .to_string();
    if std::path::Path::new("/.dockerenv").exists() {
        if ollama_endpoint == "http://localhost:11434" || ollama_endpoint == "http://127.0.0.1:11434" {
            ollama_endpoint = "http://host.docker.internal:11434".to_string();
        }
    }

    let ollama_reachable = if ollama_disabled {
        false
    } else {
        client
            .get(format!("{}/api/version", ollama_endpoint))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    };

    let mut ollama_models = Vec::new();
    if ollama_reachable {
        if let Ok(resp) = client.get(format!("{}/api/tags", ollama_endpoint)).send().await {
            if let Ok(j) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = j["models"].as_array() {
                    for m in arr {
                        if let Some(n) = m["name"].as_str() {
                            ollama_models.push(n.to_string());
                        }
                    }
                }
            }
        }
    }

    // Ferricula probe
    let ferricula_base = raw_cfg["config"]["ferricula"]["url"]
        .as_str()
        .unwrap_or("http://localhost:8765")
        .trim_end_matches('/')
        .to_string();
    let ferricula_reachable = client
        .get(format!("{}/status", ferricula_base))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    let mut ferricula_memory_count = None;
    if ferricula_reachable {
        if let Ok(resp) = client.get(format!("{}/status", ferricula_base)).send().await {
            if let Ok(text) = resp.text().await {
                let count = text
                    .lines()
                    .find_map(|l| l.trim().strip_prefix("rows="))
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<u64>().ok());
                ferricula_memory_count = count;
            }
        }
    }

    // Transcription probe
    let transcription_base = "http://localhost:8767";
    let mut transcription_reachable = false;
    let mut transcription_model = "None".to_string();
    let mut transcription_model_loaded = false;
    let mut transcription_gpu = false;
    let mut transcription_queue = serde_json::json!({
        "queued": 0,
        "processing": 0,
        "completed": 0,
        "failed": 0,
        "total": 0
    });

    if let Ok(resp) = client.get(format!("{}/health", transcription_base)).send().await {
        if resp.status().is_success() {
            transcription_reachable = true;
            if let Ok(j) = resp.json::<serde_json::Value>().await {
                transcription_model = j["model_name"].as_str().unwrap_or("None").to_string();
                transcription_model_loaded = j["model_loaded"].as_bool().unwrap_or(false);
                transcription_gpu = j["gpu_available"].as_bool().unwrap_or(false);
                if let Some(q) = j.get("queue") {
                    transcription_queue = q.clone();
                }
            }
        }
    }

    let level = match (has_frontier, ollama_reachable) {
        (true, true) => "hybrid",
        (true, false) => "frontier",
        (false, true) => "local",
        (false, false) => "none",
    };

    let vram = crate::ghost::gpu::get_gpu_vram_gb();

    serde_json::json!({
        "level": level,
        "vram_gb": vram,
        "agent": {
            "provider": active_provider,
            "model": active_model,
            "maximus_disabled": ollama_disabled,
        },
        "providers": {
            "anthropic": { "has_token": has_anthropic },
            "openai":    { "has_token": has_openai },
            "gemini":    { "has_token": has_gemini },
            "ollama":    {
                "reachable": ollama_reachable,
                "endpoint": ollama_endpoint,
                "models": ollama_models,
            }
        },
        "ferricula": {
            "reachable": ferricula_reachable,
            "base_url": ferricula_base,
            "memory_count": ferricula_memory_count,
        },
        "transcription": {
            "reachable": transcription_reachable,
            "base_url": transcription_base,
            "model": transcription_model,
            "model_loaded": transcription_model_loaded,
            "gpu": transcription_gpu,
            "queue": transcription_queue,
        }
    })
}

// ---------------------------------------------------------------------------
// Redesigned self-contained HTML dashboard
// ---------------------------------------------------------------------------

fn dashboard_html(initial_widgets_json: &str) -> String {
    let raw_html = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hyperia Control Deck</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-dark: #050508;
    --bg-panel: rgba(13, 14, 24, 0.65);
    --border-subtle: rgba(255, 255, 255, 0.05);
    --border-active: rgba(99, 102, 241, 0.3);
    
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    
    --clr-primary: #6366f1; /* Electric Indigo */
    --clr-success: #10b981; /* Neon Emerald */
    --clr-fail: #f43f5e;    /* Vibrant Rose */
    --clr-accent: #06b6d4;  /* Bright Cyan */
    --clr-warning: #eab308; /* Neon Gold */
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
    background-color: var(--bg-dark);
    color: var(--text-primary);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Custom Scrollbar */
  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  header {
    height: 70px;
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 32px;
    background: rgba(5, 5, 8, 0.85);
    backdrop-filter: blur(10px);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  header h1 {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: 2px;
    text-transform: uppercase;
    background: linear-gradient(135deg, #fff 0%, #94a3b8 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .system-live-badge {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.2);
    color: var(--clr-success);
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 20px;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .pulse-dot {
    width: 6px;
    height: 6px;
    background: var(--clr-success);
    border-radius: 50%;
    box-shadow: 0 0 12px var(--clr-success);
    animation: pulse 1.8s infinite;
  }

  @keyframes pulse {
    0% { transform: scale(0.9); opacity: 0.6; }
    50% { transform: scale(1.2); opacity: 1; box-shadow: 0 0 16px var(--clr-success); }
    100% { transform: scale(0.9); opacity: 0.6; }
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .btn-group {
    display: flex;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 3px;
  }

  .controls button {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    padding: 6px 16px;
    font-size: 12px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .controls button:hover {
    color: #fff;
  }

  .controls button.active {
    background: var(--clr-primary);
    color: #fff;
    box-shadow: 0 0 14px rgba(99, 102, 241, 0.45);
  }

  .action-btn {
    border: 1px solid var(--border-subtle) !important;
    background: rgba(255, 255, 255, 0.02) !important;
    border-radius: 8px !important;
  }

  .action-btn:hover {
    background: rgba(255, 255, 255, 0.08) !important;
  }

  /* Main Workspace Layout */
  .dashboard-wrapper {
    display: flex;
    min-height: calc(100vh - 70px);
    width: 100vw;
  }

  /* Sidebar styling */
  .sidebar {
    width: 380px;
    border-right: 1px solid var(--border-subtle);
    padding: 24px;
    background: rgba(10, 10, 15, 0.4);
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .panel-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 1.5px;
    text-transform: uppercase;
    margin-bottom: 8px;
  }

  /* Glassmorphic card design */
  .card {
    background: var(--bg-panel);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    transition: transform 0.3s, border-color 0.3s, box-shadow 0.3s;
  }

  .card:hover {
    border-color: var(--border-active);
    box-shadow: 0 4px 30px rgba(99, 102, 241, 0.12);
  }

  .level-display {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }

  .level-val {
    font-size: 32px;
    font-weight: 800;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--clr-warning);
    text-shadow: 0 0 16px rgba(234, 179, 8, 0.25);
  }

  .model-badge {
    font-family: 'Fira Code', monospace;
    font-size: 11px;
    color: var(--text-secondary);
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border-subtle);
    padding: 4px 8px;
    border-radius: 6px;
    margin-top: 4px;
    word-break: break-all;
    display: inline-block;
  }

  /* Checklist status lamps */
  .service-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .service-item {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }

  .status-lamp {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-top: 5px;
    transition: background-color 0.3s, box-shadow 0.3s;
  }

  .status-lamp.ok {
    background-color: var(--clr-success);
    box-shadow: 0 0 10px var(--clr-success);
  }

  .status-lamp.fail {
    background-color: var(--clr-fail);
    box-shadow: 0 0 10px var(--clr-fail);
  }

  .status-lamp.disabled {
    background-color: var(--text-muted);
    box-shadow: none;
  }

  .service-details {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .service-name {
    font-size: 14px;
    font-weight: 600;
    color: #fff;
  }

  .service-meta {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .service-sub {
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 2px;
    font-family: 'Fira Code', monospace;
  }

  /* Model list tags */
  .model-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }

  .model-tag {
    font-family: 'Fira Code', monospace;
    font-size: 9px;
    background: rgba(56, 189, 248, 0.08);
    border: 1px solid rgba(56, 189, 248, 0.15);
    color: #38bdf8;
    padding: 1px 4px;
    border-radius: 4px;
  }

  /* Hardware Info */
  .hardware-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .progress-container {
    width: 100%;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--border-subtle);
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    margin-top: 6px;
  }

  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, var(--clr-primary), var(--clr-accent));
    border-radius: 4px;
    width: 0%;
    transition: width 0.8s ease-in-out;
  }

  /* Main Grid Panel */
  .content-panel {
    flex-grow: 1;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .pane-selector {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .pane-btn {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    padding: 6px 14px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    transition: all 0.2s;
  }

  .pane-btn:hover {
    border-color: rgba(255, 255, 255, 0.15);
    color: #fff;
  }

  .pane-btn.active {
    border-color: var(--clr-accent);
    color: var(--clr-accent);
    background: rgba(6, 182, 212, 0.05);
    box-shadow: 0 0 10px rgba(6, 182, 212, 0.15);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 20px;
  }

  .widget {
    background: var(--bg-panel);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: 280px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    transition: all 0.3s;
  }

  .widget:hover {
    transform: translateY(-2px);
  }

  .widget-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .big-number-container {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 16px;
  }

  .big-number {
    font-size: 38px;
    font-weight: 800;
    color: #fff;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .sub-label {
    font-size: 11px;
    color: var(--text-muted);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  .sparkline-canvas {
    width: 100%;
    height: 50px;
    margin-bottom: 16px;
  }

  .metrics-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .metric-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    font-size: 13px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.02);
  }

  .metric-row:last-child {
    border-bottom: none;
  }

  .metric-label {
    color: var(--text-secondary);
  }

  .metric-value {
    color: #fff;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* Token Ratio Bar */
  .ratio-bar {
    display: flex;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    margin: 8px 0;
    background: rgba(255, 255, 255, 0.05);
  }

  .ratio-in {
    background: var(--clr-primary);
    height: 100%;
  }

  .ratio-out {
    background: var(--clr-accent);
    height: 100%;
  }

  /* Uptime clock */
  .uptime-display {
    font-family: 'Fira Code', monospace;
    font-size: 12px;
    color: var(--text-secondary);
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--border-subtle);
    padding: 6px 12px;
    border-radius: 8px;
    letter-spacing: 0.5px;
  }

  /* Hover tags for network hosts */
  .hosts-box {
    max-height: 50px;
    overflow-y: auto;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
</style>
</head>
<body>
<header>
  <div class="header-left">
    <h1>Hyperia Control Deck</h1>
    <div class="system-live-badge">
      <div class="pulse-dot"></div>
      <span>System Live</span>
    </div>
  </div>
  <div class="controls">
    <div class="uptime-display" id="uptime">UPTIME 00:00:00</div>
    <div class="btn-group">
      <button id="btn-level-window" class="active" onclick="setLevel('window')">Window</button>
      <button id="btn-level-pane" onclick="setLevel('pane')">Pane</button>
    </div>
    <button class="action-btn" id="btn-toggle" onclick="toggleTelemetry()">Pause</button>
    <button class="action-btn" onclick="resetTelemetry()">Reset</button>
  </div>
</header>

<div class="dashboard-wrapper">
  <!-- System Diagnostics Sidebar -->
  <aside class="sidebar">
    <!-- Card 1: Agent Context -->
    <div class="card">
      <div class="panel-title">Agent Status</div>
      <div class="level-display">
        <span class="level-val" id="agent-level">...</span>
        <span class="sub-label">Cognitive Mode</span>
      </div>
      <div>
        <div style="font-size:12px; color:var(--text-secondary)">Active model:</div>
        <div class="model-badge" id="agent-model">...</div>
      </div>
      <div style="margin-top:12px; font-size:12px; display:flex; justify-content:space-between">
        <span style="color:var(--text-secondary)">Maximus Compressor:</span>
        <span id="maximus-status" style="font-weight:600">...</span>
      </div>
    </div>

    <!-- Card 2: Core Services checklist -->
    <div class="card" style="flex-grow:1">
      <div class="panel-title">Core Services</div>
      <div class="service-list">
        <!-- Ollama -->
        <div class="service-item">
          <div class="status-lamp" id="lamp-ollama"></div>
          <div class="service-details">
            <span class="service-name">Ollama (Local LLM)</span>
            <span class="service-meta" id="meta-ollama">Connecting...</span>
            <div class="model-tags" id="models-ollama"></div>
          </div>
        </div>

        <!-- Ferricula -->
        <div class="service-item">
          <div class="status-lamp" id="lamp-ferricula"></div>
          <div class="service-details">
            <span class="service-name">Ferricula (Memory Index)</span>
            <span class="service-meta" id="meta-ferricula">Connecting...</span>
          </div>
        </div>

        <!-- Transcription -->
        <div class="service-item">
          <div class="status-lamp" id="lamp-transcription"></div>
          <div class="service-details">
            <span class="service-name">Whisper Transcription</span>
            <span class="service-meta" id="meta-transcription">Connecting...</span>
            <span class="service-sub" id="sub-transcription"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- Card 3: Hardware Diagnostics -->
    <div class="card">
      <div class="panel-title">Hardware Diagnostics</div>
      <div class="hardware-grid">
        <div>
          <div style="display:flex; justify-content:space-between; font-size:13px">
            <span style="color:var(--text-secondary)">VRAM allocation</span>
            <span style="color:#fff; font-weight:600" id="vram-val">...</span>
          </div>
          <div class="progress-container">
            <div class="progress-bar" id="vram-progress"></div>
          </div>
        </div>
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase" id="platform-info">
          hyperia sidecar v__VERSION__
        </div>
      </div>
    </div>
  </aside>

  <!-- Main Telemetry Workdesk -->
  <main class="content-panel">
    <div id="pane-selector" class="pane-selector" style="display:none;"></div>
    <div id="grid" class="grid"></div>
  </main>
</div>

<script>
const widgets = __WIDGETS_JSON__;
let level = 'window';
let selectedPane = null;
let data = {};
let system = {};
let paused = false;
const startTime = Date.now();

// Sparkline history buffers
const sparklinesHistory = {
  file_ops: [],
  network: [],
  tokens: []
};

function updateUptime() {
  const diff = Date.now() - startTime;
  const secs = Math.floor((diff / 1000) % 60).toString().padStart(2, '0');
  const mins = Math.floor((diff / (1000 * 60)) % 60).toString().padStart(2, '0');
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24).toString().padStart(2, '0');
  document.getElementById('uptime').textContent = `UPTIME ${hours}:${mins}:${secs}`;
}
setInterval(updateUptime, 1000);

function setLevel(l) {
  level = l;
  document.getElementById('btn-level-window').className = l === 'window' ? 'active' : '';
  document.getElementById('btn-level-pane').className = l === 'pane' ? 'active' : '';
  document.getElementById('pane-selector').style.display = l === 'pane' ? 'flex' : 'none';
  refresh();
}

async function toggleTelemetry() {
  paused = !paused;
  document.getElementById('btn-toggle').textContent = paused ? 'Resume' : 'Pause';
  await fetch('/api/telemetry/toggle', {
    method: 'POST',
    body: JSON.stringify({ enabled: !paused })
  });
}

async function resetTelemetry() {
  await fetch('/api/telemetry/reset', { method: 'POST' });
  sparklinesHistory.file_ops = [];
  sparklinesHistory.network = [];
  sparklinesHistory.tokens = [];
  refresh();
}

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}

function fmtNum(n) {
  return n.toLocaleString();
}

function updateSparkline(canvasId, values, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  // Set logical size equal to display size to avoid blur
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  if (values.length < 2) return;
  
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  
  const max = Math.max(...values, 1);
  const dx = canvas.width / (values.length - 1);
  
  for (let i = 0; i < values.length; i++) {
    const x = i * dx;
    const y = canvas.height - (values[i] / max) * (canvas.height - 8) - 4;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  
  // Fill gradient below path
  ctx.lineTo(canvas.width, canvas.height);
  ctx.lineTo(0, canvas.height);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, color + '2a');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.fill();
}

function updateSystemUI() {
  if (!system) return;

  // 1. Agent level
  const lvlEl = document.getElementById('agent-level');
  lvlEl.textContent = system.level || 'NONE';
  lvlEl.className = 'level-val';
  if (system.level === 'hybrid') {
    lvlEl.style.color = 'var(--clr-success)';
    lvlEl.style.textShadow = '0 0 16px rgba(16, 185, 129, 0.25)';
  } else if (system.level === 'frontier') {
    lvlEl.style.color = 'var(--clr-accent)';
    lvlEl.style.textShadow = '0 0 16px rgba(6, 182, 212, 0.25)';
  } else if (system.level === 'local') {
    lvlEl.style.color = 'var(--clr-primary)';
    lvlEl.style.textShadow = '0 0 16px rgba(99, 102, 241, 0.25)';
  } else {
    lvlEl.style.color = 'var(--clr-warning)';
    lvlEl.style.textShadow = '0 0 16px rgba(234, 179, 8, 0.25)';
  }

  // 2. Active Model
  const modelText = system.agent ? `${system.agent.provider} / ${system.agent.model}` : 'None';
  document.getElementById('agent-model').textContent = modelText;

  // 3. Maximus Compressor
  const maxEl = document.getElementById('maximus-status');
  if (system.agent && system.agent.maximus_disabled) {
    maxEl.textContent = 'DISABLED';
    maxEl.style.color = 'var(--clr-warning)';
  } else {
    maxEl.textContent = 'ACTIVE';
    maxEl.style.color = 'var(--clr-success)';
  }

  // 4. Ollama Service
  const lampOllama = document.getElementById('lamp-ollama');
  const metaOllama = document.getElementById('meta-ollama');
  const modelsOllama = document.getElementById('models-ollama');
  
  if (system.providers && system.providers.ollama) {
    const oll = system.providers.ollama;
    if (oll.reachable) {
      lampOllama.className = 'status-lamp ok';
      metaOllama.textContent = 'Reachable: ' + (oll.endpoint || 'http://localhost:11434');
      
      modelsOllama.innerHTML = '';
      if (oll.models && oll.models.length > 0) {
        oll.models.forEach(m => {
          const span = document.createElement('span');
          span.className = 'model-tag';
          span.textContent = m;
          modelsOllama.appendChild(span);
        });
      } else {
        modelsOllama.innerHTML = '<span style="font-size:10px; color:var(--text-muted)">No models pulled</span>';
      }
    } else {
      lampOllama.className = 'status-lamp fail';
      metaOllama.textContent = 'Unreachable / Not running';
      modelsOllama.innerHTML = '';
    }
  }

  // 5. Ferricula Service
  const lampFerricula = document.getElementById('lamp-ferricula');
  const metaFerricula = document.getElementById('meta-ferricula');
  if (system.ferricula) {
    const fer = system.ferricula;
    if (fer.reachable) {
      lampFerricula.className = 'status-lamp ok';
      const rows = fer.memory_count !== null ? fmtNum(fer.memory_count) : '0';
      metaFerricula.textContent = `Live: ${fer.base_url} (${rows} rows)`;
    } else {
      lampFerricula.className = 'status-lamp fail';
      metaFerricula.textContent = `Unreachable (expected on port 8765)`;
    }
  }

  // 6. Transcription Service
  const lampTrans = document.getElementById('lamp-transcription');
  const metaTrans = document.getElementById('meta-transcription');
  const subTrans = document.getElementById('sub-transcription');
  if (system.transcription) {
    const tr = system.transcription;
    if (tr.reachable) {
      lampTrans.className = 'status-lamp ok';
      metaTrans.textContent = `Live: Model ${tr.model} (GPU=${tr.gpu})`;
      
      const q = tr.queue || {};
      const activeText = q.processing > 0 ? ` [Processing job]` : '';
      subTrans.textContent = `Queue: ${q.queued} queued, ${q.processing} active, ${q.completed} done${activeText}`;
    } else {
      lampTrans.className = 'status-lamp fail';
      metaTrans.textContent = 'Unreachable (expected on port 8767)';
      subTrans.textContent = '';
    }
  }

  // 7. Hardware Diagnostics VRAM
  const vramVal = document.getElementById('vram-val');
  const vramProgress = document.getElementById('vram-progress');
  if (system.vram_gb !== undefined && system.vram_gb !== null) {
    const v = system.vram_gb;
    vramVal.textContent = `${v} GB`;
    
    // Scale progress up to 24GB VRAM
    const percent = Math.min((v / 24) * 100, 100);
    vramProgress.style.width = percent + '%';
  } else {
    vramVal.textContent = 'No Dedicated GPU';
    vramProgress.style.width = '0%';
  }
}

function renderWidgets() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  
  // Sort and filter visible widgets
  const sorted = [...widgets].filter(w => w.visible).sort((a, b) => a.order - b.order);
  
  for (const w of sorted) {
    const el = document.createElement('div');
    el.className = 'widget';
    el.style.border = `1px solid ${w.color}25`;
    el.style.boxShadow = `0 4px 24px ${w.color}0b`;
    
    let content = '';
    let canvasId = 'canvas-' + w.id;
    let bigNum = '0';
    let subText = '';
    let metricBlock = '';
    
    if (w.kind === 'file_ops') {
      const d = data || {};
      const total = (d.file_creates||0) + (d.file_writes||0) + (d.file_deletes||0) + (d.file_renames||0) + (d.file_reads||0);
      bigNum = fmtNum(total);
      subText = 'total file operations';
      
      // Update historical array
      sparklinesHistory.file_ops.push(total);
      if (sparklinesHistory.file_ops.length > 30) sparklinesHistory.file_ops.shift();
      
      metricBlock = `
        <div class="metric-row"><span class="metric-label">Reads</span><span class="metric-value">${fmtNum(d.file_reads||0)}</span></div>
        <div class="metric-row"><span class="metric-label">Writes</span><span class="metric-value">${fmtNum(d.file_writes||0)}</span></div>
        <div class="metric-row"><span class="metric-label">Creates</span><span class="metric-value">${fmtNum(d.file_creates||0)}</span></div>
        <div class="metric-row"><span class="metric-label">Bytes written</span><span class="metric-value">${fmt(d.file_bytes_written||0)}</span></div>
      `;
    } else if (w.kind === 'network') {
      const d = data || {};
      const traffic = (d.net_inbound_bytes||0) + (d.net_outbound_bytes||0);
      bigNum = fmt(traffic);
      subText = 'network traffic';
      
      // Update historical array
      sparklinesHistory.network.push(traffic);
      if (sparklinesHistory.network.length > 30) sparklinesHistory.network.shift();
      
      const hosts = d.net_hosts || [];
      const hostsList = hosts.length > 0 
        ? `<div class="hosts-box">` + hosts.map(h => `<span class="model-tag" style="background:rgba(99,102,241,0.06); border-color:rgba(99,102,241,0.15); color:#a5b4fc">${h}</span>`).join('') + `</div>`
        : '<span class="metric-value">None</span>';
        
      metricBlock = `
        <div class="metric-row"><span class="metric-label">Inbound</span><span class="metric-value">${fmt(d.net_inbound_bytes||0)}</span></div>
        <div class="metric-row"><span class="metric-label">Outbound</span><span class="metric-value">${fmt(d.net_outbound_bytes||0)}</span></div>
        <div class="metric-row" style="flex-direction:column; align-items:flex-start; border-bottom:none">
          <span class="metric-label" style="margin-bottom:4px">Connected Hosts:</span>
          ${hostsList}
        </div>
      `;
    } else if (w.kind === 'tokens') {
      const d = data || {};
      const total = (d.tokens_in||0) + (d.tokens_out||0);
      bigNum = fmtNum(total);
      subText = 'tokens processed';
      
      // Update historical array
      sparklinesHistory.tokens.push(total);
      if (sparklinesHistory.tokens.length > 30) sparklinesHistory.tokens.shift();
      
      const ratioIn = total > 0 ? ((d.tokens_in || 0) / total) * 100 : 50;
      const ratioOut = total > 0 ? ((d.tokens_out || 0) / total) * 100 : 50;
      
      metricBlock = `
        <div class="metric-row"><span class="metric-label">Input tokens</span><span class="metric-value">${fmtNum(d.tokens_in||0)}</span></div>
        <div class="metric-row"><span class="metric-label">Output tokens</span><span class="metric-value">${fmtNum(d.tokens_out||0)}</span></div>
        <div class="ratio-bar">
          <div class="ratio-in" style="width:${ratioIn}%"></div>
          <div class="ratio-out" style="width:${ratioOut}%"></div>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--text-muted)">
          <span>IN (${Math.round(ratioIn)}%)</span>
          <span>OUT (${Math.round(ratioOut)}%)</span>
        </div>
      `;
    } else {
      subText = 'Custom Widget';
      metricBlock = `<div class="sub-label">Kind: ${w.kind}</div>`;
    }
    
    el.innerHTML = `
      <div>
        <div class="widget-title" style="color:${w.color}">
          <span>${w.title}</span>
          <span style="font-size:9px; background:${w.color}15; padding:2px 6px; border-radius:4px; font-weight:600">${w.level}</span>
        </div>
        <div class="big-number-container">
          <div class="big-number">${bigNum}</div>
          <div class="sub-label">${subText}</div>
        </div>
      </div>
      
      <canvas class="sparkline-canvas" id="${canvasId}"></canvas>
      
      <div class="metrics-box">
        ${metricBlock}
      </div>
    `;
    
    grid.appendChild(el);
    
    // Render sparkline chart
    setTimeout(() => {
      let historyVal = [];
      if (w.kind === 'file_ops') historyVal = sparklinesHistory.file_ops;
      else if (w.kind === 'network') historyVal = sparklinesHistory.network;
      else if (w.kind === 'tokens') historyVal = sparklinesHistory.tokens;
      updateSparkline(canvasId, historyVal, w.color);
    }, 50);
  }
}

async function refresh() {
  try {
    let url = '/api/telemetry/snapshot?level=' + level;
    if (level === 'pane' && selectedPane) url += '&uid=' + selectedPane;
    
    const resp = await fetch(url);
    const json = await resp.json();
    
    data = json.telemetry || {};
    system = json.system || {};
    
    // Update pane selector if in pane mode and we don't have it locked
    if (level === 'pane') {
      const rawPanes = json.telemetry || {};
      const sel = document.getElementById('pane-selector');
      
      // If we are looking at window snapshot, but level is pane, the server returns the window agg.
      // So we need to re-query with level=pane to get the list of panes
      const paneListResp = await fetch('/api/telemetry/snapshot?level=pane');
      const paneListData = await paneListResp.json();
      const panes = paneListData.telemetry || {};
      
      sel.innerHTML = '';
      const uids = Object.keys(panes);
      
      if (uids.length > 0) {
        if (!selectedPane || !uids.includes(selectedPane)) selectedPane = uids[0];
        
        uids.forEach(uid => {
          const btn = document.createElement('button');
          btn.className = 'pane-btn' + (uid === selectedPane ? ' active' : '');
          btn.textContent = 'PANE ' + uid.substring(0, 6).toUpperCase();
          btn.onclick = () => { selectedPane = uid; refresh(); };
          sel.appendChild(btn);
        });
      } else {
        sel.innerHTML = '<span style="font-size:12px; color:var(--text-muted); padding:6px 0">No active panes tracked</span>';
        selectedPane = null;
      }
    }

    updateSystemUI();
    renderWidgets();
  } catch (e) {
    console.error('Refresh error:', e);
  }
}

// Poll every 2 seconds
setInterval(refresh, 2000);
refresh();
</script>
</body>
</html>"##;
    raw_html
        .replace("__WIDGETS_JSON__", initial_widgets_json)
        .replace("__VERSION__", env!("CARGO_PKG_VERSION"))
}
