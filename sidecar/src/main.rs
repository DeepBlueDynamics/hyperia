#![allow(dead_code, unused_imports, unused_variables)]

mod audio;
mod audit;
mod bridge;
mod bugs;
mod consent_log;
mod dashboard;
mod doors;
mod identity;
mod fsnav;
mod ghost;
mod render;
mod logs;
mod mcp;
/// Agent-facing prose, keyed and per-locale — see `messages/mod.rs`.
mod messages;
mod models;
mod perms;
mod process;
mod lume_store;
mod screen;
mod stream;
mod util;
mod workspace;
mod settings;
mod snapshot_image;
mod telemetry;
#[cfg(feature = "tts")]
mod tts;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use clap::Parser;
use serde::Deserialize;
use tracing_subscriber::EnvFilter;

use bridge::Bridge;

#[derive(Parser, Debug)]
#[command(name = "hyperia-sidecar")]
#[command(about = "Rust sidecar for Hyperia: agent engine, MCP, HTTP bridge")]
struct Args {
    /// HTTP API port (Electron connects here)
    #[arg(long, default_value = "9800")]
    port: u16,

    /// IP to bind the HTTP listener to. Default: 0.0.0.0 on Linux, 127.0.0.1 on
    /// Windows/macOS.
    ///
    /// On native Linux Docker a loopback-only sidecar is INVISIBLE to nemesis8
    /// containers: they reach the host via the docker gateway
    /// (host.docker.internal → 172.17.0.1) and nothing listens there. So on Linux
    /// we bind all interfaces by default, so containers connect with zero setup.
    /// Windows/macOS keep loopback — Docker Desktop's VM forwards
    /// host.docker.internal to the host loopback, so containers reach it anyway.
    /// Override with HYPERIA_BIND: 127.0.0.1 to restrict to this host, 172.17.0.1
    /// for the docker gateway only (containers yes, wider LAN no), or 0.0.0.0
    /// everywhere.
    #[arg(long, env = "HYPERIA_BIND")]
    bind: Option<std::net::IpAddr>,

    /// Run as MCP stdio server
    #[arg(long)]
    mcp: bool,
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) bridge: Bridge,
    log_buffer: logs::LogBuffer,
    telemetry: telemetry::TelemetryStore,
    pub(crate) render: render::RenderStore,
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct PaneAddress {
    window: Option<u32>,
    tab: Option<String>,
    pane: Option<String>,
    quiet_ms: Option<u64>,
    /// When true on /api/type, bypass the human-activity lockout and deliver
    /// keys immediately — used to interrupt a running process (e.g. Ctrl-C)
    /// even while the human is active in the pane. Ignored by other routes.
    interrupt: Option<bool>,
    /// When true on /api/type or /api/type-and-collect, send the request
    /// body verbatim — DO NOT unescape `\r`, `\n`, `\t`, `\x..` etc. This
    /// is required for `terminal_run`, whose payload is a normal shell
    /// command string that may contain Windows paths like `\research` —
    /// the default unescape behavior would turn `\r` into a literal CR
    /// and shred the path. `terminal_keys` keeps raw=false (default) so
    /// `\x03` still maps to Ctrl-C.
    raw: Option<bool>,
    /// When true, prepend a "From: <your pane>:" header so the recipient agent
    /// knows who's messaging it. Opt-in (default off) — the caller decides; Hyperia
    /// fills in the caller's origin pane, so you never specify it yourself. Only
    /// applied when the target is an agent/AI pane (a prefix would corrupt a shell
    /// command).
    attribute: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct NotesQuery {
    q: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct FsDirsQuery {
    /// Directory to list. Omit/empty/nonexistent → the user's home directory.
    path: Option<String>,
}

/// List the visible subdirectories of a path (home if absent). Backs the pane
/// directory navigator — the filtering rules (dirs only, no hidden/$system)
/// live in Rust (fsnav), not in the renderer.
async fn get_fs_dirs(Query(q): Query<FsDirsQuery>) -> Json<crate::fsnav::DirListing> {
    Json(crate::fsnav::list_dirs(q.path.as_deref()))
}

#[derive(serde::Deserialize)]
struct TabImageQuery {
    window: Option<u32>,
    tab: Option<String>,
}

#[derive(serde::Deserialize)]
struct SearchQuery {
    q: String,
    /// For shell search: restrict to one session uid. Omit to search all shells.
    uid: Option<String>,
    limit: Option<usize>,
    context_lines: Option<usize>,
}

/// BM25 search across per-shell logs (lume). `uid` restricts to one shell.
async fn get_search_shell(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> Json<serde_json::Value> {
    let limit = q.limit.unwrap_or(20).clamp(1, 200);
    let context_lines = q.context_lines.unwrap_or(0);
    let hits = state.bridge.lume().search_shell(q.uid.as_deref(), &q.q, limit, context_lines).await;
    Json(serde_json::json!({ "query": q.q, "hits": hits }))
}

#[derive(serde::Deserialize)]
struct ScrollbackQuery {
    window: Option<u32>,
    tab: Option<String>,
    pane: Option<String>,
    lines: Option<usize>,
}

/// Last N contiguous lines of a pane's shell scrollback (lume per-shell log),
/// newest last, ANSI already stripped — the read surface #38 asks for. Addresses
/// the pane by window/tab/pane like /api/screen.
async fn get_scrollback(
    State(state): State<AppState>,
    Query(q): Query<ScrollbackQuery>,
) -> (StatusCode, String) {
    let n = q.lines.unwrap_or(100).clamp(1, 2000);
    let uid = match state
        .bridge
        .resolve_pane_uid(q.window, q.tab.as_deref(), q.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into()),
    };
    match state.bridge.lume().tail_shell(&uid, n).await {
        Some((lines, total)) => {
            let mut out = String::new();
            if total > lines.len() {
                out.push_str(&format!(
                    "[Scrollback: showing last {} of {} lines. Use lines=2000 for more.]\n",
                    lines.len(),
                    total
                ));
            }
            out.push_str(&lines.join("\n"));
            (StatusCode::OK, out)
        }
        None => (
            StatusCode::OK,
            "[Scrollback: no history captured for this pane yet.]".into(),
        ),
    }
}

/// BM25 search across sticky notes (lume, reads notes.json fresh).
async fn get_search_sticky(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> Json<serde_json::Value> {
    let limit = q.limit.unwrap_or(20).clamp(1, 200);
    let hits = state.bridge.lume().search_stickies(&q.q, limit).await;
    Json(serde_json::json!({ "query": q.q, "hits": hits }))
}

/// Render the requested tab's layout as a B&W PNG. Same data path as the MCP
/// `tab_image` tool, exposed over HTTP so a human can open it in the browser
/// for visual debugging. Returns image/png bytes (no JSON wrapper).
#[derive(Deserialize)]
struct WindowImageQuery {
    window: Option<u32>,
    max_width: Option<u32>,
}

/// GET /api/window/image?window=&max_width= — real-pixels PNG of an entire
/// Hyperia window (chrome + terminals + stickies + native web panes), captured
/// app-side via desktopCapturer. Read-class like terminal_screen.
async fn get_window_image(
    State(state): State<AppState>,
    Query(q): Query<WindowImageQuery>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let cmd = serde_json::json!({
        "type": "CaptureWindow",
        "windowId": q.window,
        "maxWidth": q.max_width.unwrap_or(1200),
    });
    let raw = match state.bridge.send_command(cmd).await {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    if v["ok"].as_bool() != Some(true) {
        let err = v["error"].as_str().unwrap_or("capture failed").to_string();
        return (StatusCode::BAD_GATEWAY, err).into_response();
    }
    use base64::Engine as _;
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(v["png_base64"].as_str().unwrap_or(""))
    else {
        return (StatusCode::BAD_GATEWAY, "bad image payload".to_string()).into_response();
    };
    ([(axum::http::header::CONTENT_TYPE, "image/png")], bytes).into_response()
}

async fn get_tab_image(
    State(state): State<AppState>,
    Query(q): Query<TabImageQuery>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let status = state.bridge.get_status().await;
    let windows = status["windows"].as_array().cloned().unwrap_or_default();
    let win = if let Some(wid) = q.window {
        windows.iter().find(|w| w["id"].as_u64() == Some(wid as u64)).cloned()
    } else {
        windows.iter().find(|w| w["focused"].as_bool() == Some(true)).cloned()
            .or_else(|| windows.first().cloned())
    };
    let Some(win) = win else {
        return (StatusCode::NOT_FOUND, "no matching window").into_response();
    };
    let tabs = win["tabs"].as_array().cloned().unwrap_or_default();
    let tab = if let Some(name) = q.tab.as_deref() {
        tabs.iter().find(|t| t["name"].as_str() == Some(name)).cloned()
    } else {
        tabs.iter().find(|t| t["active"].as_bool() == Some(true)).cloned()
            .or_else(|| tabs.first().cloned())
    };
    let Some(tab) = tab else {
        return (StatusCode::NOT_FOUND, "no matching tab").into_response();
    };
    let tab_name = tab["name"].as_str().unwrap_or("(untitled)").to_string();
    let panes_json = tab["panes"].as_array().cloned().unwrap_or_default();
    struct Owned {
        label: String, kind: String, title: String, subtitle: String,
        x: f32, y: f32, w: f32, h: f32,
    }
    let owned: Vec<Owned> = panes_json.iter().map(|p| Owned {
        label: p["label"].as_str().unwrap_or("").to_string(),
        kind: "shell".to_string(),
        title: p["title"].as_str().filter(|s| !s.is_empty())
            .or_else(|| p["process"].as_str().filter(|s| !s.is_empty()))
            .or_else(|| p["shell"].as_str())
            .unwrap_or("").to_string(),
        subtitle: p["cwd"].as_str().filter(|s| !s.is_empty()).unwrap_or("").to_string(),
        x: p["bspX"].as_f64().unwrap_or(0.0) as f32,
        y: p["bspY"].as_f64().unwrap_or(0.0) as f32,
        w: p["bspW"].as_f64().unwrap_or(0.0) as f32,
        h: p["bspH"].as_f64().unwrap_or(0.0) as f32,
    }).collect();
    let cells: Vec<crate::snapshot_image::PaneCell> = owned.iter().map(|o| {
        crate::snapshot_image::PaneCell {
            label: &o.label, kind: &o.kind, title: &o.title, subtitle: &o.subtitle,
            bsp_x: o.x, bsp_y: o.y, bsp_w: o.w, bsp_h: o.h,
        }
    }).collect();
    let png = crate::snapshot_image::render_tab_png(&tab_name, &cells);
    ([("content-type", "image/png")], png).into_response()
}

/// Serve the Hyperia Python MCP tool file. Nemesis8 fetches this at container startup.
async fn get_mcp_python() -> impl axum::response::IntoResponse {
    const SRC: &str = include_str!("../assets/hyperia-mcp.py");
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        SRC,
    )
}

async fn get_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    enforce_identified(&state, &headers).await?;
    let lines = state.log_buffer.lock().unwrap();
    Ok(Json(lines.iter().cloned().collect()))
}

#[derive(serde::Deserialize)]
struct ClientLogRequest {
    level: Option<String>,
    message: String,
}

/// `POST /api/tts` — speak a short text aloud on the host via the local Kokoro
/// model. Body: `{ "text": "...", "voice"?: "af_heart", "speed"?: 1.0 }`.
#[derive(Deserialize)]
#[cfg_attr(not(feature = "tts"), allow(dead_code))]
struct TtsRequest {
    text: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    speed: Option<f32>,
    /// Radio-transmission framing. Default true; set false to speak the raw text
    /// with no callsign preamble/sign-off.
    #[serde(default)]
    frame: Option<bool>,
}

/// TTS-less builds (Intel macOS — ort ships no prebuilt ONNX Runtime there):
/// the route exists but reports the capability as unavailable.
#[cfg(not(feature = "tts"))]
async fn post_tts(Json(_req): Json<TtsRequest>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": false,
        "error": "TTS is not built into this binary (unavailable on Intel macOS)"
    }))
}

#[cfg(feature = "tts")]
async fn post_tts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TtsRequest>,
) -> Json<serde_json::Value> {
    let voice = req
        .voice
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());

    // Caller's spokenable callsign — resolved from the request identity (mirrors
    // maybe_attribute): a pane's friendly codename, or an external agent's name.
    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    let caller_raw = match &id {
        identity::CallerIdentity::Pane { pane, .. } => {
            state.bridge.pane_display_name(pane).await.unwrap_or_default()
        }
        identity::CallerIdentity::Agent { name, .. } => name.clone(),
        _ => String::new(),
    };
    let caller = match tts::spokenable_name(&caller_raw) {
        s if s.is_empty() => "station".to_string(),
        s => s,
    };

    // Recipient callsign from config (config.tts.recipient), default "base".
    let recipient_raw = ghost::api::read_shared_config()["config"]["tts"]["recipient"]
        .as_str()
        .unwrap_or("base")
        .to_string();
    let recipient = match tts::spokenable_name(&recipient_raw) {
        s if s.is_empty() => "base".to_string(),
        s => s,
    };

    let spoken = if req.frame == Some(false) {
        req.text.trim().to_string()
    } else {
        tts::radio_wrap(&recipient, &caller, &req.text)
    };
    match tts::speak(&spoken, voice, req.speed).await {
        // `spoken` echoes the EXACT transcript delivered to the user (frame
        // included) so callers can see the wrapper already carries the
        // callsigns + "Over and out" and don't add their own radio phrases.
        Ok(secs) => {
            dashboard::mark_tts_spoke();
            Json(serde_json::json!({
                "ok": true, "duration_secs": secs, "caller": caller, "recipient": recipient,
                "spoken": spoken
            }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

// ── Agent audio endpoints (epic #162) ──────────────────────────────────────
// Raw PCM/clip playback on the host, consent-gated via enforce_audio (the
// `__audio__` sentinel). Feature-gated on `tts` — that feature owns rodio.

#[derive(Deserialize)]
#[cfg_attr(not(feature = "tts"), allow(dead_code))]
struct AudioPlayJson {
    /// Base64 WAV file (PCM16 or float32, mono/stereo, 8-48kHz).
    #[serde(default)]
    wav_base64: Option<String>,
    /// Base64 raw PCM; requires format/rate/channels.
    #[serde(default)]
    pcm_base64: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    rate: Option<u32>,
    #[serde(default)]
    channels: Option<u16>,
}

#[derive(Deserialize)]
struct AudioMuteRequest {
    muted: bool,
}

#[cfg(not(feature = "tts"))]
async fn post_audio_play(_body: axum::body::Bytes) -> (StatusCode, String) {
    (
        StatusCode::NOT_IMPLEMENTED,
        "audio requires the tts feature (rodio) — this build has no audio output".to_string(),
    )
}

#[cfg(feature = "tts")]
async fn post_audio_play(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> (StatusCode, String) {
    if !audio::audio_enabled() {
        return (StatusCode::FORBIDDEN, "audio is disabled (config.audio.enabled = false)".into());
    }
    if body.len() > 32 * 1024 * 1024 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "clip too large (32MB cap)".into());
    }
    let name = match enforce_audio(&state, &headers, bearer_token(&headers).as_deref()).await {
        Ok(n) => n,
        Err((code, msg)) => return (code, msg),
    };
    if audio::MUTED.load(std::sync::atomic::Ordering::Relaxed) {
        return (
            StatusCode::OK,
            serde_json::json!({"ok": false, "muted": true, "message": "audio is muted on the host — the clip was dropped"}).to_string(),
        );
    }
    // Decode: JSON body (base64 WAV or raw PCM) or raw WAV bytes.
    let looks_json = body.first() == Some(&b'{');
    let parsed: Result<(audio::StreamSpec, Vec<f32>), String> = if looks_json {
        match serde_json::from_slice::<AudioPlayJson>(&body) {
            Ok(req) => {
                use base64::Engine as _;
                let b64 = base64::engine::general_purpose::STANDARD;
                if let Some(wav) = req.wav_base64.as_deref() {
                    b64.decode(wav)
                        .map_err(|e| format!("wav_base64: {e}"))
                        .and_then(|bytes| audio::decode_any(&bytes))
                } else if let Some(pcm) = req.pcm_base64.as_deref() {
                    let spec = audio::StreamSpec::from_json(&serde_json::json!({
                        "format": req.format.as_deref().unwrap_or("s16le"),
                        "rate": req.rate.unwrap_or(24000),
                        "channels": req.channels.unwrap_or(1),
                    }));
                    match spec {
                        Ok(s) => b64
                            .decode(pcm)
                            .map_err(|e| format!("pcm_base64: {e}"))
                            .map(|bytes| (s, audio::decode_frame(&s, &bytes))),
                        Err(e) => Err(e),
                    }
                } else {
                    Err("JSON body needs wav_base64 or pcm_base64".into())
                }
            }
            Err(e) => Err(format!("bad JSON body: {e}")),
        }
    } else {
        audio::decode_any(&body)
    };
    let (spec, samples) = match parsed {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, e),
    };
    let secs = spec.secs(samples.len());
    if secs > 120.0 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("clip is {secs:.0}s — one-shot clips cap at 120s; use the ws stream for longer audio"),
        );
    }
    let slot = match audio::StreamSlot::claim() {
        Ok(s) => s,
        Err(e) => return (StatusCode::TOO_MANY_REQUESTS, e),
    };
    let player = match audio::StreamPlayer::spawn(spec) {
        Ok(p) => p,
        Err(e) => return (StatusCode::SERVICE_UNAVAILABLE, e),
    };
    // Attribution toast stays up for the clip's duration; the end notice
    // (paired by id) dismisses it once playback has drained.
    let notice_id = audio::next_notice_id();
    let _ = state
        .bridge
        .notify(serde_json::json!({
            "type": "AudioNotice", "id": notice_id, "name": name, "active": true
        }))
        .await;
    // Feed in ~0.5s chunks, then hold the slot until the clip has drained.
    let chunk = (spec.rate as usize * spec.channels as usize) / 2;
    let bridge = state.bridge.clone();
    tokio::spawn(async move {
        for c in samples.chunks(chunk.max(1)) {
            if !player.send(c.to_vec()) {
                break;
            }
        }
        drop(player);
        tokio::time::sleep(std::time::Duration::from_secs_f64(secs + 0.5)).await;
        let _ = bridge
            .notify(serde_json::json!({"type": "AudioNotice", "id": notice_id, "active": false}))
            .await;
        drop(slot);
    });
    (
        StatusCode::OK,
        serde_json::json!({"ok": true, "secs": secs, "attribution": name}).to_string(),
    )
}

/// Consent probe + connection info for the streaming path. Doing the consent
/// here means the human prompt happens at tool time, not mid-handshake.
async fn post_audio_probe(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, String) {
    if !audio::audio_enabled() {
        return (StatusCode::FORBIDDEN, "audio is disabled (config.audio.enabled = false)".into());
    }
    match enforce_audio(&state, &headers, bearer_token(&headers).as_deref()).await {
        Ok(name) => {
            let host = headers
                .get(axum::http::header::HOST)
                .and_then(|h| h.to_str().ok())
                .unwrap_or("localhost:9800");
            (
                StatusCode::OK,
                serde_json::json!({
                    "ok": true,
                    "attribution": name,
                    "ws": format!("ws://{host}/ws/audio"),
                    "muted": audio::MUTED.load(std::sync::atomic::Ordering::Relaxed),
                    "protocol": {
                        "auth": "Authorization: Bearer <token> header, or ?token=<token> query param",
                        "hello": {"format": "s16le | f32le", "rate": "8000-48000", "channels": "1-2"},
                        "then": "binary frames of raw PCM in the declared format; pace to realtime (>0.6s backlog is dropped)",
                        "server_frames": "{\"ok\":true} after hello; {\"muted\":bool} on mute changes; {\"dropped\":n} when pacing is off"
                    }
                })
                .to_string(),
            )
        }
        Err((code, msg)) => (code, msg),
    }
}

/// Global audio mute. Muting is the safe direction — any identified caller may
/// set it; only the system token (the app / the human) may clear it.
async fn post_audio_mute(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AudioMuteRequest>,
) -> (StatusCode, String) {
    use identity::CallerIdentity;
    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    let allowed = match (&id, req.muted) {
        (CallerIdentity::Anonymous, _) => false,
        (CallerIdentity::System, _) => true,
        (_, true) => true,   // anyone identified may mute
        (_, false) => false, // only the human/system unmutes
    };
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            "muting is open to identified callers; UNmuting is the human's call (system token only)".into(),
        );
    }
    audio::MUTED.store(req.muted, std::sync::atomic::Ordering::Relaxed);
    (
        StatusCode::OK,
        serde_json::json!({"ok": true, "muted": req.muted}).to_string(),
    )
}

#[cfg(not(feature = "tts"))]
async fn ws_audio() -> (StatusCode, String) {
    (
        StatusCode::NOT_IMPLEMENTED,
        "audio requires the tts feature (rodio) — this build has no audio output".to_string(),
    )
}

#[cfg(feature = "tts")]
async fn ws_audio(
    ws: axum::extract::ws::WebSocketUpgrade,
    Query(params): Query<std::collections::HashMap<String, String>>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !audio::audio_enabled() {
        return (StatusCode::FORBIDDEN, "audio is disabled (config.audio.enabled = false)").into_response();
    }
    // ws clients that can't set headers pass ?token= instead.
    let token = bearer_token(&headers).or_else(|| params.get("token").cloned());
    let name = match enforce_audio(&state, &headers, token.as_deref()).await {
        Ok(n) => n,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let slot = match audio::StreamSlot::claim() {
        Ok(s) => s,
        Err(e) => return (StatusCode::TOO_MANY_REQUESTS, e).into_response(),
    };
    let bridge = state.bridge.clone();
    ws.on_upgrade(move |socket| audio::ws_loop(socket, bridge, name, slot))
}

async fn post_client_log(
    State(state): State<AppState>,
    Json(req): Json<ClientLogRequest>,
) -> &'static str {
    let msg = format!("[ghost-client] {}", req.message);
    match req.level.as_deref().unwrap_or("info") {
        "error" => tracing::error!("{}", msg),
        "warn"  => tracing::warn!("{}", msg),
        _       => tracing::info!("{}", msg),
    }
    "ok"
}

async fn get_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(state.bridge.get_status().await)
}

// (Removed: load_lockout_config + check_human_activity_lockout.) The
// server used to hard-block agent calls when "human activity" was recent
// in a pane and reply with an error code. That was wrong on two axes:
// (1) the other caller might be another agent, not a human, so the
//     "human priority" framing was bogus;
// (2) blocking with an error trained agents to give up instead of
//     deciding for themselves whether to defer or proceed.
// Recency is still observable: terminal_status exposes per-pane
// userActiveSecsAgo so callers that care can read it and decide.

async fn get_screen(State(state): State<AppState>, Query(addr): Query<PaneAddress>) -> (StatusCode, String) {
    let Some(uid) = state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    else {
        let session_count = state.bridge.session_count().await;
        // Demoted from warn! to debug!: pollers (dashboard widgets, agent
        // probes, stale subscriptions to closed tabs) routinely call
        // get_screen with addresses that no longer exist. At warn! these
        // miss-lookups flooded the tracing pipeline and serialized every
        // real MCP call behind the shared log writer — 858 of 1000
        // recent log entries were a single repeated 404 for a long-closed
        // Mac tab. The 404 status is still returned to the caller; only
        // the log line is downgraded.
        tracing::debug!("get_screen 404: window={:?} tab={:?} pane={:?} (sessions={})",
            addr.window, addr.tab, addr.pane, session_count);
        return (StatusCode::NOT_FOUND, format!(
            "No pane at that address (window={:?} tab={:?} pane={:?}, {} sessions registered). \
The pane field accepts either a split label (for example 'a' or 'b') or a paneId from terminal_status. \
If the pane label is empty, use paneId.",
            addr.window, addr.tab, addr.pane, session_count
        ));
    };
    // No human-activity gate: reading the screen never stomps on input.
    let screen = state.bridge.get_screen_text_by_uid(&uid).await;
    if let Some((tab, pane, win)) = state.bridge.pane_address_for_log(&uid).await {
        tracing::info!(
            "screen win={} tab={:?} pane={} bytes={}",
            win, tab, pane, screen.len()
        );
    }
    (StatusCode::OK, screen)
}

async fn post_auto_describe(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
) -> (StatusCode, String) {
    let Some(uid) = state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    else {
        return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into());
    };

    let screen = state.bridge.get_screen_text_by_uid(&uid).await;
    if screen.trim().is_empty() {
        return (StatusCode::OK, "empty".into());
    }

    // Hit local ollama to describe what's happening in this terminal
    let ollama_url = std::env::var("OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".into());
    let prompt = format!(
        "In 10 words or fewer, describe what this terminal is doing:\n\n{}",
        crate::util::safe_prefix(&screen, 2000)
    );
    let body = serde_json::json!({
        "model": "gemma2:9b",
        "prompt": prompt,
        "stream": false,
    });

    let client = reqwest::Client::new();
    match client.post(format!("{}/api/generate", ollama_url)).json(&body).send().await {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(json) => {
                // Strip everything quote-like, punctuation-like, and whitespace
                // from both ends in one pass. Ollama models routinely emit
                // smart quotes, trailing periods, and stacked quote/punct
                // sequences like `Hard Finch'.` or `"Hard Finch'""` that
                // the old chained trim_matches calls couldn't unwind past
                // an interior period. trim_matches with a closure handles
                // it all in a single scan.
                let description = json["response"]
                    .as_str()
                    .unwrap_or("")
                    .trim_matches(|c: char| {
                        c.is_whitespace()
                            || c == '\'' || c == '"' || c == '`'
                            || c == '\u{2018}' || c == '\u{2019}'   // curly single quotes
                            || c == '\u{201C}' || c == '\u{201D}'   // curly double quotes
                            || c == '.' || c == ',' || c == ':' || c == ';' || c == '!' || c == '?'
                    })
                    .to_string();
                // Update the session description in the bridge
                state.bridge.set_description_by_uid(&uid, &description).await;
                (StatusCode::OK, description)
            }
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Parse: {e}")),
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("Ollama: {e}")),
    }
}

/// Unescape backslash sequences so MCP tools can send Enter, Tab, Esc, etc.
fn unescape_keys(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            out.push('\r');
        } else if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\r'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('e') => out.push('\x1b'),
                Some('\\') => out.push('\\'),
                Some('x') => {
                    let mut hex = String::new();
                    if let Some(&h1) = chars.peek() {
                        if h1.is_ascii_hexdigit() {
                            chars.next();
                            hex.push(h1);
                            if let Some(&h2) = chars.peek() {
                                if h2.is_ascii_hexdigit() {
                                    chars.next();
                                    hex.push(h2);
                                }
                            }
                        }
                    }
                    if !hex.is_empty() {
                        if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                            out.push(byte as char);
                        } else {
                            out.push('\\');
                            out.push('x');
                            out.push_str(&hex);
                        }
                    } else {
                        out.push('\\');
                        out.push('x');
                    }
                }
                Some('u') => {
                    let mut hex = String::new();
                    for _ in 0..4 {
                        if let Some(&h) = chars.peek() {
                            if h.is_ascii_hexdigit() {
                                chars.next();
                                hex.push(h);
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    if hex.len() == 4 {
                        if let Ok(val) = u32::from_str_radix(&hex, 16) {
                            if let Some(ch) = std::char::from_u32(val) {
                                out.push(ch);
                            } else {
                                out.push('\\');
                                out.push('u');
                                out.push_str(&hex);
                            }
                        } else {
                            out.push('\\');
                            out.push('u');
                            out.push_str(&hex);
                        }
                    } else {
                        out.push('\\');
                        out.push('u');
                        out.push_str(&hex);
                    }
                }
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    
    // Process control character combinations like ctrl+X, Ctrl+X, C-x, c-X, CTRL+X
    let mut result = out;
    let prefixes = ["ctrl+", "Ctrl+", "CTRL+", "c-", "C-"];
    for prefix in prefixes {
        while let Some(pos) = result.to_lowercase().find(&prefix.to_lowercase()) {
            if pos + prefix.len() < result.len() {
                let ch = result.as_bytes()[pos + prefix.len()];
                let ch_upper = (ch as char).to_ascii_uppercase();
                if ch_upper >= 'A' && ch_upper <= 'Z' {
                    let ctrl_char = ((ch_upper as u8) - b'A' + 1) as char;
                    result = format!(
                        "{}{}{}",
                        &result[..pos],
                        ctrl_char,
                        &result[pos + prefix.len() + 1..]
                    );
                } else if ch as char == '[' {
                    result = format!(
                        "{}{}{}",
                        &result[..pos],
                        '\x1b',
                        &result[pos + prefix.len() + 1..]
                    );
                } else {
                    result = format!(
                        "{}{}",
                        &result[..pos],
                        &result[pos + prefix.len()..]
                    );
                }
            } else {
                break;
            }
        }
    }
    result
}

/// Insert a "From: <caller>: " attribution header. If the payload is wrapped in
/// bracketed paste, insert it INSIDE the paste (so it's ingested with the body);
/// otherwise prepend it. Same line (no newline) so it doesn't prematurely submit
/// in an Ink TUI.
fn attribute_keys(keys: &str, from_label: &str) -> String {
    let prefix = format!("From: {from_label}: ");
    const BP_START: &str = "\u{1b}[200~";
    if let Some(rest) = keys.strip_prefix(BP_START) {
        format!("{BP_START}{prefix}{rest}")
    } else {
        format!("{prefix}{keys}")
    }
}

/// Auto-attribution: when text is injected INTO an agent/Ink pane, stamp it with
/// "From: <caller>:" so the recipient knows who poked it. Off for shells (a prefix
/// would corrupt a command) and for System/anonymous callers (no meaningful From).
async fn maybe_attribute(state: &AppState, headers: &HeaderMap, uid: &str, keys: &str) -> String {
    if !state.bridge.is_agent_pane(uid).await {
        return keys.to_string();
    }
    let id = state.bridge.resolve_caller(bearer_token(headers).as_deref()).await;
    let from = match &id {
        identity::CallerIdentity::Pane { pane, .. } => state
            .bridge
            .pane_display_name(pane)
            .await
            .unwrap_or_else(|| "a pane".into()),
        identity::CallerIdentity::Agent { name, .. } => format!("{name} (external agent)"),
        _ => return keys.to_string(),
    };
    attribute_keys(keys, &from)
}

async fn post_type(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "Empty body".into());
    }
    // A write must name its target. Refuse to default to the human's focused
    // pane — that's how stray keystrokes end up typed into whatever the human is
    // using. Require an explicit window/tab/pane (see focus-never-steal).
    if addr.window.is_none() && addr.tab.is_none() && addr.pane.is_none() {
        return (StatusCode::BAD_REQUEST, "No pane addressed. Keystrokes will NOT default to the focused pane (that risks typing into whatever the human is using). Pass an explicit window/tab/pane — pane is a name or paneId from terminal_status.".into());
    }
    // raw=true sends the body byte-for-byte. raw=false (default) treats the
    // body as containing escape sequences (\x03 → Ctrl-C etc.). terminal_run
    // uses raw=true so Windows paths like `\research` aren't shredded by the
    // `\r` → CR rule; terminal_keys uses raw=false so \x.. still works.
    let keys = if addr.raw.unwrap_or(false) { body.clone() } else { unescape_keys(&body) };
    let uid = match state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => {
            let session_count = state.bridge.session_count().await;
            tracing::warn!("post_type 404: window={:?} tab={:?} pane={:?} (sessions={})",
                addr.window, addr.tab, addr.pane, session_count);
            return (StatusCode::NOT_FOUND, format!(
                "No pane at that address (window={:?} tab={:?} pane={:?}; {} panes registered). \
A paneId is NOT stable across restarts: a pane that closed — or an agent that restarted — comes back \
with a NEW paneId (and a new name), so a held id stops resolving. Call terminal_status to get current ids. \
For a long-running or restartable agent, address by window+tab and OMIT pane — that always targets that \
tab's current active pane, no matter how many times the pane inside it has restarted.",
                addr.window, addr.tab, addr.pane, session_count
            ));
        }
    };
    // Opt-in attribution: stamp "From: <caller>:" only when the caller asked
    // (attribute=true). Applied before hold/send so held/flushed and the immediate
    // send stay consistent. Hyperia fills in the caller's origin pane.
    let keys = if addr.attribute.unwrap_or(false) {
        maybe_attribute(&state, &headers, &uid, &keys).await
    } else {
        keys
    };
    if let Err(resp) = enforce_drive(&state, &headers, &uid).await {
        // Pending (202): the human hasn't decided yet. HOLD these keys so they
        // flush to the pane automatically the instant they approve — the agent
        // does NOT need to re-call (see pending_202's message).
        if resp.0 == StatusCode::ACCEPTED {
            let requester = state
                .bridge
                .resolve_caller(bearer_token(&headers).as_deref())
                .await
                .label();
            state.bridge.hold_action(&uid, &requester, &keys).await;
        }
        return resp;
    }
    let interrupt = addr.interrupt.unwrap_or(false);
    // The human-activity gate now lives in the renderer (enqueueOrWrite): when
    // the human is active in this pane it QUEUES the keys and replies with a
    // "queued — resend with interrupt=true" notice instead of silently
    // swallowing them. interrupt=true bypasses the queue and writes now (for
    // Ctrl-C and other take-overs). We forward the flag and let the renderer
    // decide, so the agent always gets an honest result.
    if let Some((tab, pane, win)) = state.bridge.pane_address_for_log(&uid).await {
        tracing::info!(
            "type win={} tab={:?} pane={} bytes={} interrupt={} preview={:?}",
            win, tab, pane, keys.len(), interrupt, crate::util::safe_prefix(&keys, 120)
        );
    }
    // Deterministic submit (Bridge::deliver_keys): text ending in Enter is
    // delivered as body-then-isolated-CR so an Ink TUI can't eat the terminator
    // inside a paste burst (the "sometimes it just sits there" race). Control
    // sequences, bare terminators, and interrupt take-overs pass through
    // unchanged on the legacy path.
    let body_text = keys.trim_end_matches(['\r', '\n']);
    if !interrupt && body_text.len() < keys.len() && !body_text.is_empty() {
        let notice = state.bridge.deliver_keys(&uid, body_text, true).await;
        return (StatusCode::OK, notice);
    }
    let cmd = serde_json::json!({"type": "Keys", "uid": uid, "keys": keys, "interrupt": interrupt});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_type_and_collect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, "Empty body".into());
    }
    if addr.window.is_none() && addr.tab.is_none() && addr.pane.is_none() {
        return (StatusCode::BAD_REQUEST, "No pane addressed. Keystrokes will NOT default to the focused pane (that risks typing into whatever the human is using). Pass an explicit window/tab/pane — pane is a name or paneId from terminal_status.".into());
    }
    let uid = match state
        .bridge
        .resolve_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Some(u) => u,
        None => {
            return (
                StatusCode::NOT_FOUND,
                "No pane at that address. A paneId is not stable across restarts (a closed/restarted pane comes back with a new id) — call terminal_status to refresh, or address by window+tab and omit pane to always hit that tab's current active pane.".into(),
            );
        }
    };
    if let Err(resp) = enforce_drive(&state, &headers, &uid).await {
        return resp;
    }
    // No activity gate: another caller (human OR agent) being active is not
    // grounds to refuse this call. Agents can see per-pane userActiveSecsAgo
    // via terminal_status and decide for themselves whether to defer/warn.
    let quiet_ms = addr.quiet_ms.unwrap_or(400).clamp(100, 10_000);
    // raw=true: send body verbatim (no \r/\n/\x.. interpretation). Needed
    // for terminal_run so Windows paths with `\research`, `\new`, `\test`
    // aren't shredded by the unescape rule.
    let keys = if addr.raw.unwrap_or(false) { body.clone() } else { unescape_keys(&body) };
    // Opt-in attribution (attribute=true) — stamp "From: <caller>:" only on request.
    let keys = if addr.attribute.unwrap_or(false) {
        maybe_attribute(&state, &headers, &uid, &keys).await
    } else {
        keys
    };
    let log_addr = state.bridge.pane_address_for_log(&uid).await;
    if let Some((tab, pane, win)) = &log_addr {
        tracing::info!(
            "type-and-collect ▶ win={} tab={:?} pane={} quiet_ms={} bytes_in={} preview={:?}",
            win, tab, pane, quiet_ms, keys.len(), crate::util::safe_prefix(&keys, 120)
        );
    }
    let output = state.bridge.type_and_collect(&uid, &keys, quiet_ms).await;
    if let Some((tab, pane, win)) = &log_addr {
        tracing::info!(
            "type-and-collect ◀ win={} tab={:?} pane={} bytes_out={}",
            win, tab, pane, output.len()
        );
    }
    (StatusCode::OK, output)
}

async fn post_split(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    // No human-activity lockout: a split creates a NEW pane; it doesn't
    // stomp on whatever the human is typing in the active pane. Blocking
    // it just made splits silently fail with 409 while the user was busy.
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let direction = parsed["direction"].as_str().unwrap_or("vertical").to_string();
    let profile = parsed["profile"].as_str().unwrap_or("").to_string();
    let command = parsed["command"].as_str().unwrap_or("").to_string();

    // Resolve the split target to a session uid. #119: even when window/tab/pane
    // are ALL omitted we now resolve to sane defaults — the focused window's
    // active tab's active pane — instead of passing a null uid and letting the
    // renderer pick from its own (possibly divergent) UI focus. An explicitly
    // named address that matches nothing is a hard 404; an omitted address that
    // resolves to nothing (no sessions yet) falls back to null so the renderer
    // can bootstrap the very first pane.
    let addressed =
        parsed["window"].is_u64() || parsed["tab"].is_string() || parsed["pane"].is_string();
    let target_uid = match state
        .bridge
        .resolve_pane_uid(
            parsed["window"].as_u64().map(|v| v as u32),
            parsed["tab"].as_str(),
            parsed["pane"].as_str(),
        )
        .await
    {
        Some(u) => Some(u),
        None if addressed => {
            return (
                StatusCode::NOT_FOUND,
                "No pane at that window/tab/pane address".into(),
            );
        }
        None => None,
    };

    let url = parsed["url"].as_str().unwrap_or("").to_string();

    let cmd = serde_json::json!({
        "type": "Split",
        "direction": direction,
        "profile": profile,
        "command": command,
        "uid": target_uid,
        "url": url
    });
    // Consent AFTER building the command so a pending prompt can HOLD the split
    // itself — approving then EXECUTES it (parity with held keystrokes) instead
    // of granting a permission the agent has to come back and re-use.
    if let Err(resp) = enforce_create(&state, &headers, "create_pane").await {
        if resp.0 == StatusCode::ACCEPTED {
            let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
            state.bridge.hold_create(&id.label(), cmd).await;
        }
        return resp;
    }
    match state.bridge.send_command(cmd).await {
        Ok(r) => {
            stamp_created_pane(&state, &headers, &r).await;
            (StatusCode::OK, r)
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// After a split/new-tab returns its `{ "paneId": ... }`, record the identified
/// caller as the owner so they can drive the pane they just created without
/// asking. Anonymous creators stamp nothing.
async fn stamp_created_pane(state: &AppState, headers: &HeaderMap, result: &str) {
    let id = state.bridge.resolve_caller(bearer_token(headers).as_deref()).await;
    if id.is_anonymous() {
        return;
    }
    if let Some(pane) = serde_json::from_str::<serde_json::Value>(result)
        .ok()
        .and_then(|v| v["paneId"].as_str().map(|s| s.to_string()))
    {
        state.bridge.perms().stamp_owner(&pane, &id.label()).await;
    }
}

async fn post_focus(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    // force=true is the ONLY way to actually move the human's view. Default false
    // honors focus-never-steal: agent focus must not yank the human's screen.
    let force = parsed["force"].as_bool().unwrap_or(false);

    // Resolve the target pane uid: explicit sessionUid, else window/tab/pane.
    let uid: Option<String> = if let Some(u) = parsed["sessionUid"].as_str() {
        Some(u.to_string())
    } else if parsed["window"].is_u64() || parsed["tab"].is_string() || parsed["pane"].is_string() {
        state
            .bridge
            .resolve_pane_uid(
                parsed["window"].as_u64().map(|v| v as u32),
                parsed["tab"].as_str(),
                parsed["pane"].as_str(),
            )
            .await
    } else {
        return (StatusCode::BAD_REQUEST, "Missing sessionUid or window/tab/pane".into());
    };
    let uid = match uid {
        Some(u) => u,
        None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into()),
    };

    if force {
        // The human asked to be taken here — actually move the active view.
        let cmd = serde_json::json!({"type": "Focus", "uid": uid});
        return match state.bridge.send_command(cmd).await {
            Ok(r) => (StatusCode::OK, r),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        };
    }

    // Default: DON'T steal the view. Bell the target tab so it's noticeable in
    // the bar, and report where the human currently is so the agent can decide
    // whether forcing is warranted.
    let _ = state
        .bridge
        .send_command(serde_json::json!({"type": "TabBell", "uid": uid}))
        .await;
    let human = state.bridge.human_focus_report().await;
    let resp = serde_json::json!({
        "focused": false,
        "belled": true,
        "human": human,
        "message": "Did NOT move the human's view (focus-never-steal) — flashed the target tab instead. `human` shows where their keyboard is right now and whether Hyperia is the foreground app (they may be in Chrome or another app). To actually pull their screen to this pane, call again with force:true — only when the human asked to be taken here."
    });
    (StatusCode::OK, resp.to_string())
}

/// Proactively request the human's consent to act on a pane (the "ask for perms"
/// verb agents kept failing to find). Resolves the target pane (window/tab/pane,
/// or the focused pane), then runs the SAME gate a real drive uses — which raises
/// the consent prompt and WAITS for the human's decision — and reports the
/// outcome. This separates ACCESS (consent on a pane) from IDENTITY (who you are):
/// the caller is already identified via its token; this asks to be let in.
async fn post_request_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let uid = if parsed["window"].is_u64() || parsed["tab"].is_string() || parsed["pane"].is_string() {
        match state
            .bridge
            .resolve_pane_uid(
                parsed["window"].as_u64().map(|v| v as u32),
                parsed["tab"].as_str(),
                parsed["pane"].as_str(),
            )
            .await
        {
            Some(u) => u,
            None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into()),
        }
    } else {
        match state.bridge.focused_pane().await {
            Some(u) => u,
            None => return (StatusCode::NOT_FOUND, "No focused pane to request access to.".into()),
        }
    };
    // Since this is an explicit request for access (e.g. from the request_access tool),
    // clear any recent denial cooldown to allow prompting the user again (re-authentication).
    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    let label = id.label();
    state.bridge.perms().clear_denial(&label, &uid).await;

    // Same gate as a real drive: Allow / RefuseHome / SoftWall(401) / Denied(403)
    // / NeedConsent → raises the prompt and waits ~15s for the human, returning
    // the real decision (Ok once approved) instead of a fire-and-forget 202.
    // Thread the caller's `purpose` onto the prompt so the human sees WHY.
    let purpose = parsed["purpose"].as_str().unwrap_or("");
    match enforce_drive_with_purpose(&state, &headers, &uid, purpose).await {
        Ok(()) => (
            StatusCode::OK,
            serde_json::json!({
                "granted": true,
                "pane": uid,
                "message": "Access granted — you can now drive this pane (terminal_run / terminal_keys / split / close)."
            })
            .to_string(),
        ),
        Err((status, msg)) => (status, msg),
    }
}

// ---------------------------------------------------------------------------
// Cross-pane permissions — consent prompts + grants.
//
// Flow: a caller that wants to drive a pane it doesn't own POSTs /request,
// which parks a pending prompt and pushes it to the renderer (the target
// pane's band slides a consent panel down). The human's choice comes back via
// /respond, which records a grant (scope + duration) and dismisses the panel.
// /state is a debug/test surface; /check answers "am I allowed?" for the
// (future) enforcement layer. Grants are revoked when the pane closes.
// ---------------------------------------------------------------------------

/// Friendly display name for a consent prompt's requester: a pane caller's
/// codename (e.g. "Severe Booby 🥐") instead of the ledger label
/// ("pane 372a9448"). DISPLAY-ONLY — the grant ledger stays keyed by
/// `id.label()`, so this must never feed back into perms matching.
async fn requester_display_name(
    state: &AppState,
    id: &identity::CallerIdentity,
) -> Option<String> {
    match id {
        identity::CallerIdentity::Pane { pane, .. } => {
            state.bridge.pane_display_name(pane).await
        }
        _ => None,
    }
}

/// Received-facts description of WHY a request resolved to Anonymous. Errors
/// must report what the server RECEIVED, never diagnose the caller — "you have
/// no identity" sent two agents theory-building (token tiers, config quests)
/// when the actual fact was "the header never arrived" (#135).
fn anon_reason(headers: &HeaderMap) -> String {
    match bearer_token(headers) {
        None => messages::text(messages::Msg::AnonNoAuthHeader).to_string(),
        Some(t) => {
            let prefix: String = t.chars().take(10).collect();
            let len = t.chars().count().to_string();
            messages::render(
                messages::Msg::AnonUnknownToken,
                &[("prefix", &prefix), ("len", &len)],
            )
        }
    }
}

/// Does this request look like it came from inside a container? Containers reach
/// the sidecar through their runtime's host gateway, so the Host header they send
/// is that gateway's name or IP — never loopback. Used only to steer recovery
/// advice, never to grant or deny: a containerized agent that hand-edits its own
/// MCP config loses the edit on the next container reset (#135).
fn caller_via_container(headers: &HeaderMap) -> bool {
    let raw = headers
        .get(axum::http::header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    // Strip the :port, and the brackets around a v6 literal.
    let host = raw
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(raw)
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host.is_empty() || host == "localhost" || host == "127.0.0.1" || host == "::1" {
        return false;
    }
    host.contains("host.docker.internal")
        || host.contains("host.containers.internal")
        || host.starts_with("172.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
}

/// Recovery instructions appended to every "you're anonymous" refusal. Branches
/// on WHERE the caller runs, because the correct fix is completely different and
/// the wrong one is actively harmful:
///
/// - In a container, editing MCP config in-place is wasted work — the filesystem
///   is ephemeral, so the fix vanishes on the next reset and the following agent
///   re-debugs it from scratch. The durable fix lives in the orchestrator on the
///   host (for nemesis8: mcp-servers/hyperia.toml + the HYPERIA_URL it injects).
/// - On the host, the fix is real but the failure is almost always config
///   PRECEDENCE, not a missing token — a project-scoped entry silently shadows a
///   perfectly good global one. Saying "check your config" without saying that
///   sends agents to audit the wrong block (#135).
fn identity_recovery(headers: &HeaderMap) -> String {
    let key = if caller_via_container(headers) {
        messages::Msg::RecoveryContainer
    } else {
        messages::Msg::RecoveryHost
    };
    messages::text(key).to_string()
}

/// Extract a bearer token from an `Authorization` header (case-insensitive
/// scheme, tolerant of a bare token without the "Bearer " prefix).
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .trim();
    let tok = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .unwrap_or(raw)
        .trim();
    if tok.is_empty() {
        None
    } else {
        Some(tok.to_string())
    }
}

// ---------------------------------------------------------------------------
// Identity — persistent external-agent tokens + "who am I" resolution.
//
// An external agent (e.g. Claude Code in a terminal) is never spawned inside a
// pane, so it gets no injected token. Instead it carries a persistent agent
// token in its Authorization header; the sidecar resolves it to a stable named
// identity that survives restarts (unlike pane tokens, which die with panes).
// ---------------------------------------------------------------------------

async fn post_identity_agent(State(state): State<AppState>, body: String) -> (StatusCode, String) {
    let p = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let name = p["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "name required".into());
    }
    let rec = state.bridge.identity().mint(&name).await;
    (
        StatusCode::OK,
        serde_json::json!({"name": rec.name, "token": rec.token, "createdMs": rec.created_ms}).to_string(),
    )
}

async fn get_identity_whoami(State(state): State<AppState>, headers: HeaderMap) -> Json<serde_json::Value> {
    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    Json(serde_json::json!({
        "kind": id.kind(),
        "label": id.label(),
        "anonymous": id.is_anonymous(),
    }))
}

/// Middleware: resolve the caller identity from the Authorization header for
/// EVERY request (including the nested `/mcp` MCP service), stash it in request
/// extensions for downstream handlers, and log non-anonymous calls so MCP tool
/// traffic is attributable. Enforcement (refusing/ gating) lands in #59.
fn extract_token_from_query(query: &str) -> Option<String> {
    for part in query.split('&') {
        let mut key_val = part.splitn(2, '=');
        if let (Some(k), Some(v)) = (key_val.next(), key_val.next()) {
            if k == "token" {
                if let Ok(decoded) = urlencoding::decode(v) {
                    return Some(decoded.into_owned());
                }
            }
        }
    }
    None
}

async fn identity_mw(
    State(bridge): State<Bridge>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    // If the Authorization header is missing/empty, try to extract token from query parameter
    let auth_header_missing = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().is_empty())
        .unwrap_or(true);

    if auth_header_missing {
        if let Some(query) = req.uri().query() {
            if let Some(tok) = extract_token_from_query(query) {
                if let Ok(header_val) = axum::http::HeaderValue::from_str(&format!("Bearer {}", tok)) {
                    req.headers_mut().insert(axum::http::header::AUTHORIZATION, header_val);
                }
            }
        }
    }
    let bearer = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            let s = s.trim();
            s.strip_prefix("Bearer ")
                .or_else(|| s.strip_prefix("bearer "))
                .unwrap_or(s)
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty());
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let id = bridge.resolve_caller(bearer.as_deref()).await;
    let (label, kind, anon) = (id.label(), id.kind(), id.is_anonymous());
    if !anon {
        tracing::info!("call from {label} ({kind}) -> {path}");
    }
    req.extensions_mut().insert(id);
    let resp = next.run(req).await;
    // Audit: every identified call, plus every mutation attempt (non-GET) — but
    // not anonymous GET polls (renderer status/log polling), /health, or /ws.
    let auditable = (path.starts_with("/api/") || path.starts_with("/mcp"))
        && path != "/health"
        && (!anon || method != "GET");
    if auditable {
        crate::audit::record_call(&label, kind, &method, &path, resp.status().as_u16());
    }
    resp
}

async fn get_identity_agents(State(state): State<AppState>) -> Json<serde_json::Value> {
    let agents = state.bridge.identity().list().await;
    let list: Vec<_> = agents
        .iter()
        .map(|a| serde_json::json!({"name": a.name, "token": a.token, "createdMs": a.created_ms}))
        .collect();
    Json(serde_json::json!({"agents": list}))
}

/// Toggle the master enforcement switch (default off).
async fn post_perm_enforce(State(state): State<AppState>, body: String) -> (StatusCode, String) {
    let p = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let enabled = p["enabled"].as_bool().unwrap_or(false);
    state.bridge.perms().set_enforce(enabled);
    tracing::info!("perms enforcement {}", if enabled { "ENABLED" } else { "disabled" });
    (StatusCode::OK, serde_json::json!({"ok": true, "enforce": enabled}).to_string())
}

/// Gate a drive action (type / keys) on the caller's identity. Returns Ok to
/// proceed, or an Err((status, body)) the handler should return directly. When
/// enforcement is off this is always Ok. NeedConsent auto-raises the consent
/// prompt in the target pane and returns 202.
async fn enforce_drive(
    state: &AppState,
    headers: &HeaderMap,
    target_uid: &str,
) -> Result<(), (StatusCode, String)> {
    enforce_drive_with_purpose(state, headers, target_uid, "").await
}

// Like enforce_drive, but carries a caller-supplied `purpose` onto the consent
// prompt + audit (used by request_access). Normal drives pass "".
async fn enforce_drive_with_purpose(
    state: &AppState,
    headers: &HeaderMap,
    target_uid: &str,
    purpose: &str,
) -> Result<(), (StatusCode, String)> {
    use identity::CallerIdentity;
    use perms::AuthDecision;
    let id = state.bridge.resolve_caller(bearer_token(headers).as_deref()).await;
    match state.bridge.authorize_drive(&id, target_uid).await {
        AuthDecision::Allow => Ok(()),
        AuthDecision::RefuseHome => Err((
            StatusCode::FORBIDDEN,
            messages::text(messages::Msg::DriveRefuseHome).to_string(),
        )),
        AuthDecision::SoftWall => Err((
            StatusCode::UNAUTHORIZED,
            messages::render(
                messages::Msg::DriveSoftWall,
                &[
                    ("facts", &anon_reason(&headers)),
                    ("recovery", &identity_recovery(&headers)),
                ],
            ),
        )),
        AuthDecision::Denied => Err((
            StatusCode::FORBIDDEN,
            "Access to this pane was denied by the user. If you want to request permission again (re-authenticate), run the 'request_access' tool (or call POST /api/perms/request-access) with this pane and a purpose to prompt the user again."
                .to_string(),
        )),
        AuthDecision::NeedConsent => {
            let label = id.label();
            // Raise the consent prompt once; a retry arriving while one is
            // already pending skips re-raising and just resumes waiting below.
            if !state.bridge.perms().has_pending(&label, target_uid).await {
                let requester_pane = match &id {
                    CallerIdentity::Pane { pane, .. } => pane.clone(),
                    _ => String::new(),
                };
                let req = state
                    .bridge
                    .perms()
                    .create_request(&label, &requester_pane, target_uid, "drive", purpose)
                    .await;
                let requester_name = requester_display_name(&state, &id)
                    .await
                    .unwrap_or_else(|| req.requester.clone());
                consent_log::record_request(
                    &req.id, &req.requester, &requester_name, id.kind(),
                    &req.action, &req.target_pane, &req.purpose,
                );
                let _ = state
                    .bridge
                    .notify(serde_json::json!({
                        "type": "PermissionRequest",
                        "id": req.id,
                        "requester": req.requester,
                        "requesterName": requester_name,
                        "requesterPane": req.requester_pane,
                        "targetPane": req.target_pane,
                        "purpose": req.purpose,
                    }))
                    .await;
            }
            // Wait for the human's decision so THIS call completes instead of
            // bouncing the agent with a bare "pending" it has to guess how to
            // poll. ~15s covers a prompt approval; on timeout we 202 with
            // explicit retry guidance so the agent knows exactly what to do.
            for _ in 0..16 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                match state.bridge.authorize_drive(&id, target_uid).await {
                    AuthDecision::Allow => return Ok(()),
                    AuthDecision::Denied => {
                        return Err((
                            StatusCode::FORBIDDEN,
                            "Access to this pane was denied by the user. If you want to request permission again (re-authenticate), run the 'request_access' tool (or call POST /api/perms/request-access) with this pane and a purpose to prompt the user again."
                                .to_string(),
                        ))
                    }
                    _ => {}
                }
            }
            Err(pending_202())
        }
    }
}

// ── Agent audio consent (epic #162) ────────────────────────────────────────
// Raw audio is gated drive-style on the sentinel target `__audio__` (same
// pattern as `__create__` for creates): grants and denials persist per
// identity, `request_access` with pane "__audio__" re-prompts after a deny.
// EXPLICIT CARVE-OUT: hyperia_spoken_summary (TTS) stays ungated — its radio
// framing is already self-attributing. This gate covers raw PCM/clips only.

const AUDIO_SENTINEL: &str = "__audio__";

/// The caller's human-facing name for audio attribution toasts.
async fn audio_caller_name(state: &AppState, id: &identity::CallerIdentity) -> String {
    requester_display_name(state, id)
        .await
        .unwrap_or_else(|| id.label())
}

/// Enforce audio consent. On success returns the caller's display name so
/// handlers can attribute the sound without re-resolving identity.
async fn enforce_audio(
    state: &AppState,
    headers: &HeaderMap,
    token: Option<&str>,
) -> Result<String, (StatusCode, String)> {
    use identity::CallerIdentity;
    use perms::AuthDecision;
    let id = state.bridge.resolve_caller(token).await;
    match state.bridge.authorize_drive(&id, AUDIO_SENTINEL).await {
        AuthDecision::Allow | AuthDecision::RefuseHome => Ok(audio_caller_name(state, &id).await),
        AuthDecision::SoftWall => Err((
            StatusCode::UNAUTHORIZED,
            format!(
                "Audio needs an identity — sound on the human's machine is never anonymous. {}",
                identity_recovery(headers)
            ),
        )),
        AuthDecision::Denied => Err((
            StatusCode::FORBIDDEN,
            "Audio was denied by the user. To ask again, run request_access with pane \"__audio__\" and a purpose."
                .to_string(),
        )),
        AuthDecision::NeedConsent => {
            let label = id.label();
            if !state.bridge.perms().has_pending(&label, AUDIO_SENTINEL).await {
                let requester_pane = match &id {
                    CallerIdentity::Pane { pane, .. } => pane.clone(),
                    _ => String::new(),
                };
                let req = state
                    .bridge
                    .perms()
                    .create_request(&label, &requester_pane, AUDIO_SENTINEL, "audio", "play audio on this machine")
                    .await;
                let requester_name = audio_caller_name(state, &id).await;
                consent_log::record_request(
                    &req.id, &req.requester, &requester_name, id.kind(),
                    &req.action, &req.target_pane, &req.purpose,
                );
                let _ = state
                    .bridge
                    .notify(serde_json::json!({
                        "type": "PermissionRequest",
                        "id": req.id,
                        "requester": req.requester,
                        "requesterName": requester_name,
                        "requesterPane": req.requester_pane,
                        "targetPane": req.target_pane,
                        "purpose": req.purpose,
                    }))
                    .await;
            }
            for _ in 0..16 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                match state.bridge.authorize_drive(&id, AUDIO_SENTINEL).await {
                    AuthDecision::Allow => return Ok(audio_caller_name(state, &id).await),
                    AuthDecision::Denied => {
                        return Err((
                            StatusCode::FORBIDDEN,
                            "Audio was denied by the user. To ask again, run request_access with pane \"__audio__\" and a purpose."
                                .to_string(),
                        ))
                    }
                    _ => {}
                }
            }
            Err((
                StatusCode::ACCEPTED,
                serde_json::json!({
                    "ok": false,
                    "pending": true,
                    "message": "The human is considering your audio request in the Hyperia approval prompt. \
                                Wait a moment and call this again — the grant persists once approved."
                })
                .to_string(),
            ))
        }
    }
}

/// The 202 returned when the human hasn't decided within the wait window. The
/// keys are HELD server-side and flush automatically on approval, so the agent
/// must simply WAIT — not re-call, not improvise a workaround.
fn pending_202() -> (StatusCode, String) {
    (
        StatusCode::ACCEPTED,
        serde_json::json!({
            "ok": false,
            "pending": true,
            "message": "The human is considering your request in the Hyperia approval prompt — give them \
                        a moment (set a short timer and check back). Your command is HELD and will run \
                        AUTOMATICALLY the instant they approve (you'll see it execute in the pane), or be \
                        dropped if they deny. Do NOT re-call this tool and do NOT try a workaround — just \
                        wait. To see the result, read the pane after a bit with terminal_screen."
        })
        .to_string(),
    )
}

/// Gate a CREATE action (split / new tab / window / web-pane / sticky) on the
/// caller's identity + create grant. System bypasses; anonymous is soft-walled;
/// a denial reports back; otherwise it raises a create-consent toast and 202s.
async fn enforce_create(
    state: &AppState,
    headers: &HeaderMap,
    action: &str,
) -> Result<(), (StatusCode, String)> {
    use identity::CallerIdentity;
    use perms::AuthDecision;
    let id = state.bridge.resolve_caller(bearer_token(headers).as_deref()).await;
    match state.bridge.authorize_create(&id).await {
        AuthDecision::Allow => Ok(()),
        AuthDecision::RefuseHome => Ok(()), // n/a to create
        AuthDecision::SoftWall => Err((
            StatusCode::UNAUTHORIZED,
            messages::render(
                messages::Msg::CreateSoftWall,
                &[
                    ("facts", &anon_reason(headers)),
                    ("recovery", &identity_recovery(headers)),
                ],
            ),
        )),
        AuthDecision::Denied => Err((
            StatusCode::FORBIDDEN,
            "Creating panes/tabs was denied by the user. Don't retry — ask the user directly."
                .to_string(),
        )),
        AuthDecision::NeedConsent => {
            let label = id.label();
            // Reuse the pending request if one exists (dedupe), but ALWAYS
            // (re-)notify the toast: the renderer's prompt collapses after 45s,
            // and the old silent-resume meant a retry could never bring it back
            // — the human stood at the window with nothing to click while the
            // agent waited forever. Re-notify is idempotent renderer-side
            // (setToast by id revives a collapsed pill into the full prompt).
            let req = match state.bridge.perms().pending_create_for(&label).await {
                Some(existing) => existing,
                None => {
                    let focus = state.bridge.focused_pane().await.unwrap_or_default();
                    let requester_pane = match &id {
                        CallerIdentity::Pane { pane, .. } => pane.clone(),
                        _ => String::new(),
                    };
                    let fresh = state
                        .bridge
                        .perms()
                        .create_request(&label, &requester_pane, &focus, action, "")
                        .await;
                    let requester_name = requester_display_name(&state, &id)
                        .await
                        .unwrap_or_else(|| fresh.requester.clone());
                    consent_log::record_request(
                        &fresh.id, &fresh.requester, &requester_name, id.kind(),
                        &fresh.action, &fresh.target_pane, &fresh.purpose,
                    );
                    fresh
                }
            };
            let requester_name = requester_display_name(&state, &id)
                .await
                .unwrap_or_else(|| req.requester.clone());
            let _ = state
                .bridge
                .notify(serde_json::json!({
                    "type": "AgentToast",
                    "id": req.id,
                    "requester": req.requester,
                    "requesterName": requester_name,
                    "action": req.action,
                }))
                .await;
            // Wait for the human's decision so the create COMPLETES on approval
            // instead of returning a bare 202 the agent has to chase.
            for _ in 0..16 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                // A FAST click resolves the REQUEST one-shot without necessarily
                // minting a durable grant — authorize_create alone never saw it,
                // so an immediate approval used to burn this whole 8s window and
                // then silently DROP the command (the decision handler had
                // already consumed the approval before the hold landed).
                if let Some(allow) = state.bridge.take_resolved_create(&id.label()).await {
                    if allow {
                        return Ok(());
                    }
                    return Err((
                        StatusCode::FORBIDDEN,
                        "Creating panes/tabs was denied by the user. Don't retry — ask the user directly."
                            .to_string(),
                    ));
                }
                match state.bridge.authorize_create(&id).await {
                    AuthDecision::Allow | AuthDecision::RefuseHome => return Ok(()),
                    AuthDecision::Denied => {
                        return Err((
                            StatusCode::FORBIDDEN,
                            "Creating panes/tabs was denied by the user. Don't retry — ask the user directly."
                                .to_string(),
                        ))
                    }
                    _ => {}
                }
            }
            Err(pending_202())
        }
    }
}

/// Soft-wall anonymous callers from sensitive reads (sidecar logs, audit log).
/// Any non-anonymous identity (system / agent / pane) passes. Respects the
/// global enforcement toggle — when enforcement is off, these reads are open. (#96)
async fn enforce_identified(state: &AppState, headers: &HeaderMap) -> Result<(), (StatusCode, String)> {
    if !state.bridge.perms().enforced() {
        return Ok(());
    }
    let id = state.bridge.resolve_caller(bearer_token(headers).as_deref()).await;
    if id.is_anonymous() {
        return Err((
            StatusCode::UNAUTHORIZED,
            "This read requires identity. Send 'Authorization: Bearer <token>' — your pane/agent \
             token is in the HYPERIA_AGENT_TOKEN env var (external agents: a persistent hyp_agent_… \
             token in the MCP client's Authorization header)."
                .to_string(),
        ));
    }
    Ok(())
}

/// Gate a named capability action (file edit / settings / web-eval / manage /
/// …) on the caller's identity + capability grant. Mirrors enforce_create.
async fn enforce_capability(
    state: &AppState,
    headers: &HeaderMap,
    cap: &str,
) -> Result<(), (StatusCode, String)> {
    use identity::CallerIdentity;
    use perms::AuthDecision;
    let id = state.bridge.resolve_caller(bearer_token(headers).as_deref()).await;
    match state.bridge.authorize_capability(&id, cap).await {
        AuthDecision::Allow | AuthDecision::RefuseHome => Ok(()),
        AuthDecision::SoftWall => Err((
            StatusCode::UNAUTHORIZED,
            messages::render(
                messages::Msg::CapabilitySoftWall,
                &[
                    ("facts", &anon_reason(headers)),
                    ("cap", cap),
                    ("recovery", &identity_recovery(headers)),
                ],
            ),
        )),
        AuthDecision::Denied => Err((
            StatusCode::FORBIDDEN,
            format!("The '{cap}' capability was denied by the user. Don't retry."),
        )),
        AuthDecision::NeedConsent => {
            let label = id.label();
            // Raise the capability-consent toast once; a retry while one is
            // already pending skips re-raising and resumes waiting below.
            if !state.bridge.perms().has_pending_cap(&label, cap).await {
                let focus = state.bridge.focused_pane().await.unwrap_or_default();
                let requester_pane = match &id {
                    CallerIdentity::Pane { pane, .. } => pane.clone(),
                    _ => String::new(),
                };
                let req = state
                    .bridge
                    .perms()
                    .create_request(&label, &requester_pane, &focus, &format!("cap:{cap}"), "")
                    .await;
                let requester_name = requester_display_name(&state, &id)
                    .await
                    .unwrap_or_else(|| req.requester.clone());
                consent_log::record_request(
                    &req.id, &req.requester, &requester_name, id.kind(),
                    &req.action, &req.target_pane, &req.purpose,
                );
                let _ = state
                    .bridge
                    .notify(serde_json::json!({
                        "type": "AgentToast", "id": req.id, "requester": req.requester,
                        "requesterName": requester_name, "action": req.action,
                    }))
                    .await;
            }
            // Wait for the human's decision so the action COMPLETES on approval.
            for _ in 0..16 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                match state.bridge.authorize_capability(&id, cap).await {
                    AuthDecision::Allow | AuthDecision::RefuseHome => return Ok(()),
                    AuthDecision::Denied => {
                        return Err((
                            StatusCode::FORBIDDEN,
                            format!("The '{cap}' capability was denied by the user. Don't retry — ask the user directly."),
                        ))
                    }
                    _ => {}
                }
            }
            Err(pending_202())
        }
    }
}

/// Enforce access permission to a specific sticky note ID.
async fn enforce_note_access(
    state: &AppState,
    headers: &HeaderMap,
    note_id: &str,
) -> Result<(), (StatusCode, String)> {
    use identity::CallerIdentity;
    use perms::AuthDecision;

    let id = state.bridge.resolve_caller(bearer_token(headers).as_deref()).await;
    
    // Bypass if enforcement is off or it's the system (human GUI)
    if !state.bridge.perms().enforced() || id.is_system() {
        return Ok(());
    }

    // Resolve note creator (owner)
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let mut creator: Option<String> = None;
    if let Some(home) = home {
        let path = std::path::PathBuf::from(home)
            .join(".hyperia")
            .join("stickys")
            .join("notes.json");
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(notes) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                if let Some(note) = resolve_note(&notes, note_id) {
                    creator = note["creator"].as_str().map(String::from);
                }
            }
        }
    }

    let caller_label = id.label();

    // Unowned note → no owner to protect, so anyone may edit it. A note created
    // WITHOUT a presented identity is stamped creator="anonymous" (or nothing);
    // no token-bearing identity can ever match that, so the very agent that
    // created the note gets locked out of its own note (the endless consent
    // loop). Treat anonymous/empty creators as unowned and allow.
    let owner = creator.as_deref().filter(|c| !c.is_empty() && *c != "anonymous");
    if owner.is_none() {
        return Ok(());
    }

    // Check if caller is the owner
    if owner == Some(caller_label.as_str()) {
        return Ok(());
    }

    // Check if caller has sticky:list_all capability (full read/write for all stickies)
    if let AuthDecision::Allow | AuthDecision::RefuseHome = state.bridge.authorize_capability(&id, "sticky:list_all").await {
        return Ok(());
    }

    // Enforce capability sticky:access:<note_id> (this prompts the user if needed)
    let cap = format!("sticky:access:{}", note_id);
    enforce_capability(state, headers, &cap).await
}

async fn post_perm_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let p = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    // Prefer the authenticated caller identity; fall back to an explicit body
    // requester (test/manual), then a generic label.
    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    let requester = if id.is_anonymous() {
        p["requester"].as_str().unwrap_or("Unknown agent").to_string()
    } else {
        id.label()
    };
    let requester_pane = match &id {
        identity::CallerIdentity::Pane { pane, .. } => pane.clone(),
        _ => p["requesterPane"].as_str().unwrap_or("").to_string(),
    };
    let target = p["targetPane"].as_str().unwrap_or("").to_string();
    if target.is_empty() {
        return (StatusCode::BAD_REQUEST, "targetPane required".into());
    }
    let purpose = p["purpose"].as_str().unwrap_or("");
    let req = state
        .bridge
        .perms()
        .create_request(&requester, &requester_pane, &target, "drive", purpose)
        .await;
    let requester_name = requester_display_name(&state, &id)
        .await
        .unwrap_or_else(|| req.requester.clone());
    consent_log::record_request(
        &req.id, &req.requester, &requester_name, id.kind(),
        &req.action, &req.target_pane, &req.purpose,
    );
    let _ = state
        .bridge
        .notify(serde_json::json!({
            "type": "PermissionRequest",
            "id": req.id,
            "requester": req.requester,
            "requesterName": requester_name,
            "requesterPane": req.requester_pane,
            "targetPane": req.target_pane,
            "purpose": req.purpose,
        }))
        .await;
    (StatusCode::OK, serde_json::json!({"ok": true, "id": req.id}).to_string())
}

async fn post_perm_respond(State(state): State<AppState>, body: String) -> (StatusCode, String) {
    let p = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let id = p["id"].as_str().unwrap_or("");
    let allow = p["decision"].as_str().unwrap_or("deny") == "allow";
    let scope = p["scope"].as_str().unwrap_or("pane");
    let duration_secs = p["durationSecs"].as_u64();
    match state.bridge.perms().respond(id, allow, scope, duration_secs).await {
        Some(req) => {
            consent_log::record_decision(
                &req.id,
                if allow { "allow" } else { "deny" },
                scope,
                &req.requester,
                &req.action,
                &req.target_pane,
            );
            // Flush or drop any keystrokes the agent had held pending this decision.
            if allow {
                if let Some(mut keys) = state.bridge.take_action(&req.target_pane).await {
                    // Guarantee the held command runs: terminal_run keys already end
                    // with Enter, terminal_keys may not — append a CR only if needed.
                    if !keys.ends_with('\n') && !keys.ends_with('\r') {
                        keys.push('\r');
                    }
                    // interrupt=true: the human just approved, so write immediately
                    // even if they're currently active in the target pane.
                    let _ = state
                        .bridge
                        .send_command(serde_json::json!({
                            "type": "Keys",
                            "uid": req.target_pane,
                            "keys": keys,
                            "interrupt": true,
                        }))
                        .await;
                }
            } else {
                let _ = state.bridge.take_action(&req.target_pane).await;
            }
            // A held CREATE (split/new-tab/web-pane) executes on approval — the
            // human said "ok, that's fine", so DO the thing, don't just grant
            // permission the agent has to come back and re-use. Denial drops it.
            if req.action.starts_with("create") {
                if allow {
                    if let Some(cmd) = state.bridge.take_create(&req.requester).await {
                        if let Ok(r) = state.bridge.send_command(cmd).await {
                            // Stamp the ORIGINAL requester as the new pane's owner
                            // (mirrors stamp_created_pane, but the HTTP caller here
                            // is the human's consent response, not the agent).
                            if let Some(pane) = serde_json::from_str::<serde_json::Value>(&r)
                                .ok()
                                .and_then(|v| v["paneId"].as_str().map(|s| s.to_string()))
                            {
                                state.bridge.perms().stamp_owner(&pane, &req.requester).await;
                            }
                        }
                    } else {
                        // Nothing held: the human clicked BEFORE the agent's
                        // inline wait gave up (fast approval). Park the decision
                        // for that in-flight wait to consume — it executes the
                        // create itself within 500ms. Without this, a fast click
                        // cost the whole 8s window and dropped the command.
                        state.bridge.resolve_create_early(&req.requester, true).await;
                    }
                } else if state.bridge.take_create(&req.requester).await.is_none() {
                    state.bridge.resolve_create_early(&req.requester, false).await;
                }
            }
            let _ = state
                .bridge
                .notify(serde_json::json!({
                    "type": "PermissionResolved",
                    "id": req.id,
                    "targetPane": req.target_pane,
                    "decision": if allow { "allow" } else { "deny" },
                }))
                .await;
            (StatusCode::OK, serde_json::json!({"ok": true}).to_string())
        }
        None => (
            StatusCode::NOT_FOUND,
            serde_json::json!({"ok": false, "error": "unknown request id"}).to_string(),
        ),
    }
}

/// Arm a one-shot (capped) idle callback on the CALLER'S OWN pane: when it next
/// goes running->idle, the keys are delivered back to it. Self-only — only an
/// in-pane agent (pane token) can arm one; external agents have no pane to target.
async fn post_pane_on_idle(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    let pane = match &id {
        identity::CallerIdentity::Pane { pane, .. } => pane.clone(),
        _ => {
            return (
                StatusCode::FORBIDDEN,
                "pane_on_idle is self-only: it schedules a poke to YOUR OWN pane when you next go idle. Only an in-pane agent (with a HYPERIA_AGENT_TOKEN pane token) can arm one — external agents have no pane to target. Use pane_pulse_set for another pane.".into(),
            )
        }
    };
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let keys = parsed["keys"].as_str().unwrap_or("").to_string();
    if keys.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "keys (the prompt to deliver when you go idle) is required".into(),
        );
    }
    let life = parsed["max_lifetime_secs"].as_u64().unwrap_or(900);
    let max_fires = parsed["max_fires"].as_u64().unwrap_or(1) as u32;
    let (cb_id, replaced) = match state
        .bridge
        .register_idle_callback(&pane, &keys, life, max_fires, &id.label())
        .await
    {
        Ok(v) => v,
        Err(msg) => return (StatusCode::TOO_MANY_REQUESTS, msg),
    };
    // Say the load-bearing things OUT LOUD: replace semantics (fresh ids made
    // an agent believe callbacks stack) and the cancel path (its absence made
    // the same agent believe pokes were uncancellable).
    let replaced_note = replaced
        .map(|r| format!(" This REPLACED this pane's previous callback ({r}) — ONE callback per pane, they never stack."))
        .unwrap_or_default();
    (
        StatusCode::OK,
        serde_json::json!({
            "ok": true,
            "id": cb_id,
            "message": format!(
                "Armed. The next time this pane goes idle, the prompt is delivered to it (edge-triggered, capped, expires within 1h, min 60s between fires).{replaced_note} To CANCEL: pane_pulse_clear with this id, or re-arm with max_lifetime_secs=1."
            )
        })
        .to_string(),
    )
}

/// Self-reported liveness from an agent or its in-container monitor (e.g.
/// nemesis8 samples CPU/net/proc and reports it can't see from the screen).
/// state=busy marks the pane busy for ttl_secs (OVERRIDES the screen heuristic,
/// suppressing pokes); state=idle clears it. The Bearer pane token identifies
/// the pane — self-reported, so no other-pane spoofing.
async fn post_pane_liveness(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    let pane = match &id {
        identity::CallerIdentity::Pane { pane, .. } => pane.clone(),
        _ => {
            return (
                StatusCode::FORBIDDEN,
                "Liveness is self-reported: send Authorization: Bearer <HYPERIA_AGENT_TOKEN> (your pane token, forwarded into the container env) so we know which pane. The token IS the correlation key — you don't need to send a pane id.".into(),
            )
        }
    };
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let busy = parsed["state"].as_str().unwrap_or("busy") != "idle";
    let ttl = parsed["ttl_secs"].as_u64().unwrap_or(10);
    state.bridge.set_liveness(&pane, busy, ttl).await;
    (
        StatusCode::OK,
        serde_json::json!({
            "ok": true,
            "pane": pane,
            "state": if busy { "busy" } else { "idle" },
            "ttl_secs": ttl
        })
        .to_string(),
    )
}

/// Set a recurring pulse on a pane (cross-pane; consent-gated at set-time, self
/// blocked by RefuseHome). Re-submits `keys` on the interval, idle-gated by default.
async fn post_pulse_set(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let window = parsed["window"].as_u64().map(|v| v as u32);
    let tab = parsed["tab"].as_str();
    let pane = parsed["pane"].as_str();
    if window.is_none() && tab.is_none() && pane.is_none() {
        return (StatusCode::BAD_REQUEST, "No pane addressed. Pass window/tab/pane — the pane to pulse.".into());
    }
    let uid = match state.bridge.resolve_pane_uid(window, tab, pane).await {
        Some(u) => u,
        None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address.".into()),
    };
    let keys = parsed["keys"].as_str().unwrap_or("").to_string();
    if keys.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "keys (the prompt to re-submit) is required".into());
    }
    // Cross-pane consent at set-time. Self-pulse loop is blocked here (RefuseHome).
    if let Err(resp) = enforce_drive(&state, &headers, &uid).await {
        return resp;
    }
    let interval = parsed["interval_secs"].as_u64().unwrap_or(60);
    let idle_only = parsed["idle_only"].as_bool().unwrap_or(true);
    let submit = parsed["submit"].as_bool().unwrap_or(true);
    let life = parsed["max_lifetime_secs"].as_u64().unwrap_or(3600);
    let max_fires = parsed["max_fires"].as_u64().map(|v| v as u32);
    let creator = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await.label();
    let label = state.bridge.pane_display_name(&uid).await.unwrap_or_else(|| uid.clone());
    // Address the pulse by window+tab so it re-binds to the tab's current active
    // pane across restarts (and persists across a Hyperia restart).
    let (window_id, tab_name) = match state.bridge.pane_window_tab(&uid).await {
        Some(wt) => wt,
        None => return (StatusCode::NOT_FOUND, "Could not resolve the pane's window/tab.".into()),
    };
    let id = state
        .bridge
        .register_pulse(window_id, &tab_name, &uid, &label, &keys, interval, idle_only, submit, life, max_fires, &creator)
        .await;
    (
        StatusCode::OK,
        serde_json::json!({
            "ok": true,
            "id": id,
            "pane": uid,
            "interval_secs": interval.max(20),
            "idle_only": idle_only,
            "message": "Pulse set. It re-submits on the interval (idle-gated if idle_only), never steals focus, and auto-expires within 1h."
        })
        .to_string(),
    )
}

/// Clear pulse(s) by id, or by addressing the pane (window/tab/pane).
async fn post_pulse_clear(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let key = if let Some(id) = parsed["id"].as_str() {
        id.to_string()
    } else {
        let window = parsed["window"].as_u64().map(|v| v as u32);
        match state
            .bridge
            .resolve_pane_uid(window, parsed["tab"].as_str(), parsed["pane"].as_str())
            .await
        {
            Some(u) => u,
            None => return (StatusCode::BAD_REQUEST, "Pass id, or a window/tab/pane that resolves.".into()),
        }
    };
    let n = state.bridge.clear_pulse(&key).await;
    // cleared:0 with a bare ok:true read as "success, nothing to see" and sent
    // an agent to the conclusion that pokes are uncancellable. Say what was
    // searched and what a valid handle looks like.
    let body = if n == 0 {
        serde_json::json!({
            "ok": true,
            "cleared": 0,
            "message": format!(
                "Nothing matched '{key}'. This clears BOTH pulses (ids pulse_N) and pane_on_idle callbacks (ids cb_N), by id or by pane uid. Check pane_pulse_status for pulses; an idle callback may already have fired out or expired."
            )
        })
    } else {
        serde_json::json!({"ok": true, "cleared": n})
    };
    (StatusCode::OK, body.to_string())
}

/// Pause/resume a pulse by id.
async fn post_pulse_pause(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let id = parsed["id"].as_str().unwrap_or("");
    let paused = parsed["paused"].as_bool().unwrap_or(true);
    if state.bridge.pause_pulse(id, paused).await {
        (StatusCode::OK, serde_json::json!({"ok": true, "paused": paused}).to_string())
    } else {
        (StatusCode::NOT_FOUND, serde_json::json!({"ok": false, "error": "unknown pulse id"}).to_string())
    }
}

async fn get_pulse_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(state.bridge.pulse_status().await)
}

async fn get_perm_state(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(state.bridge.perms().snapshot().await)
}

/// Search the audit log (read-only). Filters: identity, path (substrings),
/// status, since_ms, limit.
async fn get_audit_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    enforce_identified(&state, &headers).await?;
    let identity = params.get("identity").map(|s| s.as_str());
    let path_q = params.get("path").map(|s| s.as_str());
    // Generic substring filter over the whole entry — previously `q` was
    // silently IGNORED (unknown params dropped), returning unfiltered rows and
    // looking like a working search that "found" unrelated results (#135).
    let any_q = params.get("q").map(|s| s.as_str());
    let status = params.get("status").and_then(|s| s.parse::<u16>().ok());
    let since = params.get("since_ms").and_then(|s| s.parse::<u64>().ok());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .min(2000);
    let results = audit::search(identity, path_q, any_q, status, since, limit);
    Ok(Json(serde_json::json!({ "count": results.len(), "results": results })))
}

/// GET /api/consent/log — the first-class consent ledger (#135): who asked,
/// for what, on which target, and what was decided. `q` substring-filters the
/// whole entry; identified callers only (same gate as the audit trail).
async fn get_consent_log(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    enforce_identified(&state, &headers).await?;
    let q = params.get("q").map(|s| s.as_str());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .min(2000);
    let results = consent_log::search(q, limit);
    Ok(Json(serde_json::json!({ "count": results.len(), "results": results })))
}

#[derive(serde::Deserialize)]
struct BugReportBody {
    title: String,
    #[serde(default)]
    details: String,
    #[serde(default)]
    tool: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    context: String,
}

/// POST /api/bug — file an agent bug report (#141). Deliberately OPEN to any
/// caller (we *want* reports, including from anonymous ones); the reporter's
/// identity is recorded when present. The human triages these into fixes.
async fn post_bug(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BugReportBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let title = req.title.trim();
    if title.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "title is required" })),
        );
    }
    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    let (reporter, kind) = match &id {
        identity::CallerIdentity::Pane { pane, .. } => (
            state.bridge.pane_display_name(pane).await.unwrap_or_else(|| "a pane".into()),
            "pane",
        ),
        identity::CallerIdentity::Agent { name, .. } => (name.clone(), "agent"),
        _ => ("anonymous".to_string(), "anonymous"),
    };
    let bug_id = bugs::record(
        &reporter,
        kind,
        title,
        &req.details,
        &req.tool,
        &req.error,
        &req.context,
        env!("CARGO_PKG_VERSION"),
    );
    tracing::info!(
        target: "bugs",
        "bug filed {} by {} ({}): {}",
        bug_id, reporter, kind, crate::util::safe_prefix(title, 100)
    );
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "id": bug_id, "reporter": reporter })),
    )
}

/// GET /api/bug/log — list filed bug reports, newest first. `q` substring-filters.
async fn get_bug_log(
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let q = params.get("q").map(|s| s.as_str());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100)
        .min(2000);
    let results = bugs::search(q, limit);
    Json(serde_json::json!({ "count": results.len(), "results": results }))
}

/// Mint/return the access token for a pane. The pane menu copies this and the
/// human hands it to an external agent (→ MCP Authorization header).
async fn get_perm_token(
    State(state): State<AppState>,
    Query(addr): Query<PaneAddress>,
) -> (StatusCode, String) {
    let pane = addr.pane.unwrap_or_default();
    if pane.is_empty() {
        return (StatusCode::BAD_REQUEST, "pane required".into());
    }
    let token = state.bridge.perms().token_for(&pane).await;
    (StatusCode::OK, serde_json::json!({"pane": pane, "token": token}).to_string())
}

async fn post_perm_check(State(state): State<AppState>, body: String) -> (StatusCode, String) {
    let p = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let requester = p["requester"].as_str().unwrap_or("");
    let target = p["targetPane"].as_str().unwrap_or("");
    // Tab-aware, identical to real enforcement (authorize_drive) — no divergence.
    let allowed = state.bridge.grant_allows(requester, target).await;
    (StatusCode::OK, serde_json::json!({"allowed": allowed}).to_string())
}

/// POST /api/styles/apply — apply a named style's overrides to ONE pane's
/// appearance, live. Drive-gated like every pane write (own pane free; another
/// pane raises the human's consent prompt). name "" / "default" / "none"
/// clears the pane back to its profile/global appearance.
async fn post_style_apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    if !(parsed["window"].is_u64() || parsed["tab"].is_string() || parsed["pane"].is_string()) {
        return (
            StatusCode::BAD_REQUEST,
            "No pane addressed. style apply will NOT default to the focused pane — pass window/tab/pane.".into(),
        );
    }
    let uid = match state
        .bridge
        .resolve_pane_uid(
            parsed["window"].as_u64().map(|v| v as u32),
            parsed["tab"].as_str(),
            parsed["pane"].as_str(),
        )
        .await
    {
        Some(u) => u,
        None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into()),
    };
    if let Err(resp) = enforce_drive(&state, &headers, &uid).await {
        return resp;
    }
    let name = parsed["name"].as_str().unwrap_or("").trim().to_string();
    let clearing = name.is_empty() || name == "default" || name == "none";
    let style_config = if clearing {
        serde_json::Value::Null
    } else {
        let cfg_path = crate::util::shared_config_path()
            .unwrap_or_else(|| std::path::PathBuf::from(".").join("hyperia.json"));
        let cfg: serde_json::Value = match std::fs::read_to_string(&cfg_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(v) => v,
            None => return (StatusCode::INTERNAL_SERVER_ERROR, "Could not read hyperia.json".into()),
        };
        match cfg["config"]["styles"]
            .as_array()
            .and_then(|a| a.iter().find(|s| s["name"].as_str() == Some(name.as_str())))
            .map(|s| s["config"].clone())
        {
            Some(c) if c.is_object() => c,
            _ => {
                return (
                    StatusCode::NOT_FOUND,
                    format!("Unknown style '{name}'. `style_list` shows the styles; `style_create` makes one."),
                )
            }
        }
    };
    let cmd = serde_json::json!({"type": "ApplyStyle", "uid": uid, "style": style_config});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (
            StatusCode::OK,
            serde_json::json!({
                "ok": true,
                "pane": uid,
                "style": if clearing { serde_json::Value::Null } else { serde_json::Value::String(name) },
                "applied": r
            })
            .to_string(),
        ),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_cd(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let uid = if let Some(u) = parsed["uid"].as_str() {
        Some(u.to_string())
    } else if parsed["window"].is_u64() || parsed["tab"].is_string() || parsed["pane"].is_string() {
        match state
            .bridge
            .resolve_pane_uid(
                parsed["window"].as_u64().map(|v| v as u32),
                parsed["tab"].as_str(),
                parsed["pane"].as_str(),
            )
            .await
        {
            Some(u) => Some(u),
            None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into()),
        }
    } else {
        // A cd is a write — do NOT default to the human's focused pane. Require
        // an explicit target so an agent can't change the cwd of whatever pane
        // the human is using (see focus-never-steal).
        return (StatusCode::BAD_REQUEST, "No pane addressed. cd will NOT default to the focused pane. Pass an explicit uid, or window/tab/pane — pane is a name or paneId from terminal_status.".into());
    };

    let uid = match uid {
        Some(u) => u,
        None => return (StatusCode::NOT_FOUND, "No pane identified".into()),
    };

    // Gate on authorization / consent
    if let Err(resp) = enforce_drive(&state, &headers, &uid).await {
        return resp;
    }

    let path = match parsed["path"].as_str() {
        Some(p) => p.to_string(),
        None => return (StatusCode::BAD_REQUEST, "Missing path parameter".into()),
    };

    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.is_dir() {
        return (StatusCode::BAD_REQUEST, format!("Path is not a directory: {path}"));
    }

    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let (pid, name, shell_has_integration, shell_state, last_user_activity) = {
        let sessions = state.bridge.sessions().await;
        let info = match sessions.get(&uid) {
            Some(i) => i,
            None => return (StatusCode::NOT_FOUND, "Pane not found in sessions".into()),
        };
        (info.pid, info.name.clone(), info.shell_has_integration, info.shell_state.clone(), info.last_user_activity)
    };

    let process = if pid > 0 {
        crate::process::foreground_process_with(&sys, pid)
    } else {
        String::new()
    };
    let shell = std::path::Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&name)
        .trim_end_matches(".exe")
        .to_string();
    let user_active_secs_ago = last_user_activity.map(|t| t.elapsed().as_secs());

    let is_fallback_idle = (process.is_empty() || process.to_lowercase() == shell.to_lowercase()) && user_active_secs_ago.unwrap_or(999) > 15;
    let is_idle = if shell_has_integration { shell_state == "idle" } else { is_fallback_idle };

    let state_str = if is_idle { "idle" } else { "running" };

    let cmd = serde_json::json!({
        "type": "Cd",
        "uid": uid,
        "path": path,
        "state": state_str
    });

    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_close(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    if let Err(resp) = enforce_capability(&state, &headers, "manage").await {
        return resp;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    // Accept either a literal uid, or a window/tab/pane address to resolve — so an
    // agent can close a SPECIFIC pane without first focusing it (focus races the UI).
    let uid = if let Some(u) = parsed["uid"].as_str() {
        Some(u.to_string())
    } else if parsed["window"].is_u64() || parsed["tab"].is_string() || parsed["pane"].is_string() {
        match state
            .bridge
            .resolve_pane_uid(
                parsed["window"].as_u64().map(|v| v as u32),
                parsed["tab"].as_str(),
                parsed["pane"].as_str(),
            )
            .await
        {
            Some(u) => Some(u),
            None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into()),
        }
    } else {
        None
    };
    // Self-close guard (#118): an in-pane agent must NEVER be able to close its
    // OWN pane — that's self-termination, and it's refused as a fundamental rule
    // independent of ACLs/capabilities (a "manage" grant does not authorize an
    // agent to delete itself). Resolve the effective target (the explicit uid, or
    // the focused pane for a no-target close) and compare to the caller's pane.
    let caller = state
        .bridge
        .resolve_caller(bearer_token(&headers).as_deref())
        .await;
    if let identity::CallerIdentity::Pane { pane: caller_pane, .. } = &caller {
        let effective_target = match &uid {
            Some(u) => Some(u.clone()),
            None => state.bridge.resolve_pane_uid(None, None, None).await,
        };
        if effective_target.as_deref() == Some(caller_pane.as_str()) {
            return (
                StatusCode::FORBIDDEN,
                "Refused: an agent cannot close its own pane (self-termination). \
                 This is blocked unconditionally, regardless of permissions. If you \
                 need this pane gone, ask the human; to close a DIFFERENT pane, \
                 address it explicitly by window/tab/pane."
                    .into(),
            );
        }
    }
    // No activity gate on close either: agents can check userActiveSecsAgo
    // via terminal_status if they care to warn before tearing down a pane.
    let mut cmd = serde_json::json!({"type": "Close"});
    if let Some(uid) = uid {
        cmd["uid"] = serde_json::Value::String(uid);
    }
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_new_tab(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let profile = parsed["profile"].as_str().unwrap_or("").to_string();
    let command = parsed["command"].as_str().unwrap_or("").to_string();

    // #119: resolve the target window. Omitted → the focused window (the
    // sidecar's tracked focus, which the renderer honors via `windowId` and
    // falls back to its own focused window if absent). An explicitly named
    // window that doesn't exist is a hard 404 rather than silently opening the
    // tab in the wrong window.
    let requested_window = parsed["window"].as_u64().map(|v| v as u32);
    let window_id = state.bridge.resolve_window_id(requested_window).await;
    if requested_window.is_some() && window_id.is_none() {
        return (StatusCode::NOT_FOUND, "No such window".into());
    }

    let cmd = serde_json::json!({
        "type": "NewTab",
        "profile": profile,
        "command": command,
        "windowId": window_id,
    });
    // Consent AFTER building the command — a pending prompt HOLDS the tab
    // creation and approval executes it (see post_split).
    if let Err(resp) = enforce_create(&state, &headers, "create_tab").await {
        if resp.0 == StatusCode::ACCEPTED {
            let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
            state.bridge.hold_create(&id.label(), cmd).await;
        }
        return resp;
    }
    match state.bridge.send_command(cmd).await {
        Ok(r) => {
            stamp_created_pane(&state, &headers, &r).await;
            (StatusCode::OK, r)
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn get_where_pane(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, String) {
    let a = params.get("a").map(|s| s.as_str()).unwrap_or("");
    let b = params.get("b").map(|s| s.as_str()).unwrap_or("");
    if a.is_empty() || b.is_empty() {
        return (StatusCode::BAD_REQUEST, "Provide ?a=label&b=label".into());
    }
    let sessions = state.bridge.sessions().await;
    // Resolve by uid first, then fall back to split_label
    let find = |key: &str| -> Option<(String, _)> {
        if let Some(s) = sessions.get(key) {
            return Some((key.to_string(), s.clone()));
        }
        sessions.iter()
            .find(|(_, s)| s.split_label == key)
            .map(|(uid, s)| (uid.clone(), s.clone()))
    };
    let (uid_a, sa) = match find(a) {
        Some(v) => v,
        None => return (StatusCode::NOT_FOUND, format!("Pane '{}' not found", a)),
    };
    let (uid_b, sb) = match find(b) {
        Some(v) => v,
        None => return (StatusCode::NOT_FOUND, format!("Pane '{}' not found", b)),
    };
    let (a, b) = (uid_a.as_str(), uid_b.as_str());
    let (sa, sb) = (&sa, &sb);

    let mut parts: Vec<&str> = Vec::new();

    // Vertical position
    if sb.bsp_y >= sa.bsp_y + sa.bsp_h - 1.0 {
        parts.push("below");
    } else if sb.bsp_y + sb.bsp_h <= sa.bsp_y + 1.0 {
        parts.push("above");
    }

    // Horizontal position
    if sb.bsp_x >= sa.bsp_x + sa.bsp_w - 1.0 {
        parts.push("to the right of");
    } else if sb.bsp_x + sb.bsp_w <= sa.bsp_x + 1.0 {
        parts.push("to the left of");
    }

    let label_a = if sa.split_label.is_empty() { a } else { sa.split_label.as_str() };
    let label_b = if sb.split_label.is_empty() { b } else { sb.split_label.as_str() };

    let relation = if parts.is_empty() {
        format!("pane {} overlaps or is the same position as pane {}", label_b, label_a)
    } else {
        format!("pane {} is {} pane {}", label_b, parts.join(" and "), label_a)
    };

    (StatusCode::OK, serde_json::json!({
        "relation": relation,
        "a": {"uid": a, "label": label_a, "x": sa.bsp_x, "y": sa.bsp_y, "width": sa.bsp_w, "height": sa.bsp_h},
        "b": {"uid": b, "label": label_b, "x": sb.bsp_x, "y": sb.bsp_y, "width": sb.bsp_w, "height": sb.bsp_h}
    }).to_string())
}

async fn post_new_window(State(state): State<AppState>, headers: HeaderMap) -> (StatusCode, String) {
    // Zero-window recovery: the create-consent prompt renders INSIDE a Hyperia
    // window, so with none open the approval can never be shown and the request
    // deadlocks (bug_1a03461105e). There is also no focus to steal. Auto-allow
    // the FIRST window; Electron opens it on the new-pane picker instead of
    // spawning a default shell nobody asked for.
    let first_window = state.bridge.has_no_windows().await;
    if !first_window {
        if let Err(resp) = enforce_create(&state, &headers, "create_window").await {
            return resp;
        }
    }
    let cmd = serde_json::json!({"type": "NewWindow", "firstWindow": first_window});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_window_size(State(state): State<AppState>, body: String) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let cmd = serde_json::json!({
        "type": "SetWindowSize",
        "windowId": parsed["window"],
        "width": parsed["width"],
        "height": parsed["height"],
    });
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_layout_save(State(state): State<AppState>) -> (StatusCode, String) {
    let cmd = serde_json::json!({"type": "SaveLayoutState"});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ---------------------------------------------------------------------------
// Named workspaces (epic #146, chunk 1: #167). File ops live in workspace.rs;
// these handlers do the Electron capture round-trip and translate errors.
// ---------------------------------------------------------------------------

fn workspaces_dir_or_500() -> Result<std::path::PathBuf, (StatusCode, String)> {
    workspace::default_workspaces_dir().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "could not resolve home directory for ~/.hyperia/workspaces".to_string(),
    ))
}

fn workspace_error_status(e: &workspace::WorkspaceError) -> StatusCode {
    use workspace::WorkspaceError as E;
    match e {
        E::InvalidName(_) | E::AlreadyExists(_) => StatusCode::BAD_REQUEST,
        E::NotFound(_) => StatusCode::NOT_FOUND,
        E::Corrupt(_) | E::WrongKind(_) | E::NewerThanSupported(_) => {
            StatusCode::UNPROCESSABLE_ENTITY
        }
        E::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[derive(serde::Deserialize)]
struct WorkspaceSaveBody {
    name: String,
    #[serde(default)]
    overwrite: bool,
}

async fn post_workspace_save(
    State(state): State<AppState>,
    Json(body): Json<WorkspaceSaveBody>,
) -> (StatusCode, String) {
    let dir = match workspaces_dir_or_500() {
        Ok(d) => d,
        Err(e) => return e,
    };
    // Correlated capture: every window's geometry + layout, or a missing list.
    let raw = match state
        .bridge
        .send_command(serde_json::json!({"type": "CaptureWorkspace"}))
        .await
    {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("capture failed: {e}")),
    };
    let snapshot: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("capture returned invalid JSON: {e}")),
    };
    if let Some(err) = snapshot.get("error").and_then(|e| e.as_str()) {
        return (StatusCode::BAD_GATEWAY, format!("capture failed: {err}"));
    }
    let windows: Vec<workspace::WorkspaceWindow> =
        match serde_json::from_value(snapshot["windows"].clone()) {
            Ok(w) => w,
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("capture snapshot didn't match the workspace schema: {e}"),
                )
            }
        };
    let missing: Vec<serde_json::Value> = snapshot["missing"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    match workspace::save(
        &dir,
        &body.name,
        windows,
        Some(env!("CARGO_PKG_VERSION").to_string()),
        body.overwrite,
    ) {
        Ok(ws) => {
            let mut reply = serde_json::json!({
                "ok": true,
                "name": ws.name,
                "savedAt": ws.saved_at,
                "windows": ws.windows.len(),
                "path": dir.join(format!("{}.json", ws.name)).to_string_lossy(),
            });
            if !missing.is_empty() {
                reply["warning"] = serde_json::json!(format!(
                    "{} window(s) did not reply in time and are not in the snapshot",
                    missing.len()
                ));
            }
            (StatusCode::OK, reply.to_string())
        }
        Err(e) => (workspace_error_status(&e), e.to_string()),
    }
}

async fn get_workspace_list() -> (StatusCode, String) {
    let dir = match workspaces_dir_or_500() {
        Ok(d) => d,
        Err(e) => return e,
    };
    match workspace::list(&dir) {
        Ok(rows) => (
            StatusCode::OK,
            serde_json::json!({"workspaces": rows}).to_string(),
        ),
        Err(e) => (workspace_error_status(&e), e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct WorkspaceNameBody {
    name: String,
}

/// Profile names the config file declares, or None when it lists none —
/// Electron auto-detects shells at startup, so an empty config can't prove a
/// profile unknown (see workspace::preview).
fn config_profile_names() -> Option<std::collections::HashSet<String>> {
    let cfg = util::read_shared_config().ok()?;
    let profiles = cfg["config"]["profiles"].as_array()?;
    let names: std::collections::HashSet<String> = profiles
        .iter()
        .filter_map(|p| p["name"].as_str().map(|s| s.to_string()))
        .collect();
    if names.is_empty() {
        None
    } else {
        Some(names)
    }
}

async fn post_workspace_preview(Json(body): Json<WorkspaceNameBody>) -> (StatusCode, String) {
    let dir = match workspaces_dir_or_500() {
        Ok(d) => d,
        Err(e) => return e,
    };
    let ws = match workspace::load_workspace(&dir, &body.name) {
        Ok(ws) => ws,
        Err(e) => return (workspace_error_status(&e), e.to_string()),
    };
    let report = workspace::preview_fs(&ws, config_profile_names().as_ref());
    match serde_json::to_string(&report) {
        Ok(json) => (StatusCode::OK, json),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn post_workspace_restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceNameBody>,
) -> (StatusCode, String) {
    // Restoring spawns windows and PTYs — same consent bar as opening panes.
    if let Err(resp) = enforce_create(&state, &headers, "create_window").await {
        return resp;
    }
    let dir = match workspaces_dir_or_500() {
        Ok(d) => d,
        Err(e) => return e,
    };
    let ws = match workspace::load_workspace(&dir, &body.name) {
        Ok(ws) => ws,
        Err(e) => return (workspace_error_status(&e), e.to_string()),
    };
    let report = workspace::preview_fs(&ws, config_profile_names().as_ref());
    let ws_json = match serde_json::to_value(&ws) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let cmd = serde_json::json!({"type": "RestoreWorkspace", "workspace": ws_json});
    match state.bridge.send_command(cmd).await {
        Ok(raw) => {
            let applied: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({"raw": raw}));
            if let Some(err) = applied.get("error").and_then(|e| e.as_str()) {
                return (StatusCode::BAD_GATEWAY, format!("restore failed: {err}"));
            }
            let reply = serde_json::json!({
                "ok": true,
                "name": ws.name,
                "restored": applied,
                "report": report,
            });
            (StatusCode::OK, reply.to_string())
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("restore failed: {e}")),
    }
}

/// Fallback geometry for imported legacy (v0) blobs: the last-known window
/// rect from window-state.json when available, else a neutral default.
fn v0_fallback_geometry() -> workspace::Geometry {
    let path = crate::fsnav::home_dir().join(".hyperia").join("window-state.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            if let (Some(w), Some(h)) = (v["width"].as_u64(), v["height"].as_u64()) {
                return workspace::Geometry {
                    x: v["x"].as_i64().unwrap_or(60) as i32,
                    y: v["y"].as_i64().unwrap_or(60) as i32,
                    width: w as u32,
                    height: h as u32,
                    display_id: v.get("displayId").cloned(),
                    is_maximized: v["isMaximized"].as_bool().unwrap_or(false),
                    is_full_screen: v["isFullScreen"].as_bool().unwrap_or(false),
                };
            }
        }
    }
    workspace::default_v0_geometry()
}

#[derive(serde::Deserialize)]
struct WorkspaceExportBody {
    name: String,
    path: String,
    #[serde(default)]
    overwrite: bool,
}

async fn post_workspace_export(Json(body): Json<WorkspaceExportBody>) -> (StatusCode, String) {
    let dir = match workspaces_dir_or_500() {
        Ok(d) => d,
        Err(e) => return e,
    };
    let dest = std::path::PathBuf::from(&body.path);
    if !dest.is_absolute() {
        return (
            StatusCode::BAD_REQUEST,
            "export path must be absolute (the sidecar's working directory is not yours)".to_string(),
        );
    }
    match workspace::export(&dir, &body.name, &dest, body.overwrite) {
        Ok(ws) => (
            StatusCode::OK,
            serde_json::json!({
                "ok": true,
                "name": ws.name,
                "exportedTo": dest.to_string_lossy(),
                "windows": ws.windows.len(),
            })
            .to_string(),
        ),
        Err(e) => (workspace_error_status(&e), e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct WorkspaceImportBody {
    path: String,
    name: Option<String>,
    #[serde(default)]
    overwrite: bool,
}

async fn post_workspace_import(Json(body): Json<WorkspaceImportBody>) -> (StatusCode, String) {
    let dir = match workspaces_dir_or_500() {
        Ok(d) => d,
        Err(e) => return e,
    };
    let src = std::path::PathBuf::from(&body.path);
    if !src.is_absolute() {
        return (
            StatusCode::BAD_REQUEST,
            "import path must be absolute (the sidecar's working directory is not yours)".to_string(),
        );
    }
    match workspace::import(&dir, &src, body.name.as_deref(), body.overwrite, v0_fallback_geometry()) {
        Ok((ws, was_v0)) => (
            StatusCode::OK,
            serde_json::json!({
                "ok": true,
                "name": ws.name,
                "windows": ws.windows.len(),
                "migrated": was_v0,
                "schemaVersion": ws.schema_version,
            })
            .to_string(),
        ),
        Err(e) => (workspace_error_status(&e), e.to_string()),
    }
}

async fn post_workspace_delete(Json(body): Json<WorkspaceNameBody>) -> (StatusCode, String) {
    let dir = match workspaces_dir_or_500() {
        Ok(d) => d,
        Err(e) => return e,
    };
    match workspace::delete(&dir, &body.name) {
        Ok(()) => (
            StatusCode::OK,
            serde_json::json!({"ok": true, "deleted": body.name}).to_string(),
        ),
        Err(e) => (workspace_error_status(&e), e.to_string()),
    }
}

#[derive(serde::Deserialize)]
struct WorkspaceRenameBody {
    from: String,
    to: String,
    #[serde(default)]
    overwrite: bool,
}

async fn post_workspace_rename(Json(body): Json<WorkspaceRenameBody>) -> (StatusCode, String) {
    let dir = match workspaces_dir_or_500() {
        Ok(d) => d,
        Err(e) => return e,
    };
    match workspace::rename(&dir, &body.from, &body.to, body.overwrite) {
        Ok(()) => (
            StatusCode::OK,
            serde_json::json!({"ok": true, "from": body.from, "to": body.to}).to_string(),
        ),
        Err(e) => (workspace_error_status(&e), e.to_string()),
    }
}

async fn post_open_web_pane(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    if let Err(resp) = enforce_create(&state, &headers, "create_web").await {
        return resp;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let url = match parsed["url"].as_str() {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return (StatusCode::BAD_REQUEST, "url is required".into()),
    };
    let cmd = serde_json::json!({"type": "OpenWebPane", "url": url});
    // The renderer creates the pane asynchronously — snapshot existing web
    // panes first, then wait for the NEW one to register so the reply can
    // carry its paneId. Without this, agents had no handle to address the
    // pane they just opened (the empty-{} → wrong-pane → timeout trap).
    let before = state.bridge.web_pane_uids().await;
    match state.bridge.send_command(cmd).await {
        Ok(_) => match state.bridge.await_new_web_pane(&before, &url, 4000).await {
            Some((pane_id, name)) => (
                StatusCode::OK,
                serde_json::json!({
                    "ok": true, "paneId": pane_id, "name": name, "url": url,
                    "note": "address this pane by paneId in web_pane_content / web_pane_eval / terminal_web_click"
                })
                .to_string(),
            ),
            None => (
                StatusCode::OK,
                serde_json::json!({
                    "ok": true, "paneId": serde_json::Value::Null, "url": url,
                    "note": "pane is still opening — find it in terminal_status in a moment (shell == \"web\")"
                })
                .to_string(),
            ),
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// POST /api/render {path?|content?, title?} — register a markdown document
/// (with the ==highlight== extension) and open its LIVE render page in a new
/// web-pane tab. Backs the `render` MCP tool. Same create_web consent + held-
/// create semantics as open_web_pane.
async fn post_render(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let path = parsed["path"].as_str().unwrap_or("").trim().to_string();
    let content = parsed["content"].as_str().unwrap_or("").to_string();
    if path.is_empty() && content.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "Provide `path` (a markdown file on disk — live-reloads on change) or `content` (inline markdown)".into(),
        );
    }
    let source = if !path.is_empty() {
        let pb = std::path::PathBuf::from(&path);
        if !pb.is_file() {
            return (StatusCode::NOT_FOUND, format!("No such file: {path}"));
        }
        render::RenderSource::File(pb)
    } else {
        render::RenderSource::Inline(content)
    };
    let title = parsed["title"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            std::path::Path::new(&path)
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| "Rendered document".into())
        });
    let id = state.render.insert(render::RenderDoc { title, source }).await;
    let port = std::env::var("HYPERIA_PORT").unwrap_or_else(|_| "9800".into());
    let url = format!("http://localhost:{port}/render/{id}");
    let cmd = serde_json::json!({"type": "OpenWebPane", "url": url});
    if let Err(resp) = enforce_create(&state, &headers, "create_web").await {
        if resp.0 == StatusCode::ACCEPTED {
            let caller = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
            state.bridge.hold_create(&caller.label(), cmd).await;
        }
        return resp;
    }
    let before = state.bridge.web_pane_uids().await;
    match state.bridge.send_command(cmd).await {
        Ok(_) => {
            // Same paneId handoff as open_web_pane — the render tab is a web
            // pane, and agents want to web_pane_content it later.
            let pane_id = state
                .bridge
                .await_new_web_pane(&before, &url, 4000)
                .await
                .map(|(uid, _)| serde_json::Value::String(uid))
                .unwrap_or(serde_json::Value::Null);
            (
                StatusCode::OK,
                serde_json::json!({"ok": true, "id": id, "paneId": pane_id, "url": url, "note": "opened in a new background tab; file-backed docs live-reload ~1.5s after the file changes"}).to_string(),
            )
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_web_pane_reload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(addr): Query<PaneAddress>,
) -> (StatusCode, String) {
    if let Err(resp) = enforce_capability(&state, &headers, "web_nav").await {
        return resp;
    }
    let uid = match state
        .bridge
        .resolve_web_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Ok(u) => u,
        Err(msg) => return (StatusCode::NOT_FOUND, msg),
    };
    let cmd = serde_json::json!({"type": "WebPaneReload", "uid": uid});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_web_pane_content(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(addr): Query<PaneAddress>,
) -> (StatusCode, String) {
    if let Err(resp) = enforce_capability(&state, &headers, "web_nav").await {
        return resp;
    }
    let uid = match state
        .bridge
        .resolve_web_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Ok(u) => u,
        Err(msg) => return (StatusCode::NOT_FOUND, msg),
    };
    let cmd = serde_json::json!({"type": "WebPaneContent", "uid": uid});
    let raw = match state.bridge.send_command(cmd).await {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    // The renderer returns {success, url, title, html}. Convert the rendered DOM
    // to clean reader-mode markdown with grub's converter (no external re-fetch).
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    if parsed.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return (StatusCode::OK, raw); // pass through the error shape unchanged
    }
    let url = parsed["url"].as_str().unwrap_or("");
    let title = parsed["title"].as_str().unwrap_or("");
    let html = parsed["html"].as_str().unwrap_or("");
    let markdown = grub_md::to_markdown(html, url);
    let out = serde_json::json!({
        "success": true,
        "url": url,
        "title": title,
        "markdown": markdown,
    });
    (StatusCode::OK, out.to_string())
}

async fn post_web_pane_click(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    if let Err(resp) = enforce_capability(&state, &headers, "web_nav").await {
        return resp;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let text = parsed["text"].as_str().map(|s| s.to_string());
    let selector = parsed["selector"].as_str().map(|s| s.to_string());

    if text.is_none() && selector.is_none() {
        return (StatusCode::BAD_REQUEST, "Either text or selector is required".into());
    }

    let uid = match state
        .bridge
        .resolve_web_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Ok(u) => u,
        Err(msg) => return (StatusCode::NOT_FOUND, msg),
    };

    let cmd = serde_json::json!({
        "type": "WebPaneClick",
        "uid": uid,
        "text": text,
        "selector": selector
    });
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_web_pane_eval(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    // Arbitrary JS in a webview — gate on "web_eval".
    if let Err(resp) = enforce_capability(&state, &headers, "web_eval").await {
        return resp;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let js = parsed["js"].as_str().unwrap_or("").to_string();
    if js.is_empty() {
        return (StatusCode::BAD_REQUEST, "'js' is required".into());
    }
    let uid = match state
        .bridge
        .resolve_web_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Ok(u) => u,
        Err(msg) => return (StatusCode::NOT_FOUND, msg),
    };
    let cmd = serde_json::json!({"type": "WebPaneEval", "uid": uid, "js": js});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_web_pane_mouse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(addr): Query<PaneAddress>,
    body: String,
) -> (StatusCode, String) {
    if let Err(resp) = enforce_capability(&state, &headers, "web_nav").await {
        return resp;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let x = parsed["x"].as_f64().unwrap_or(0.0);
    let y = parsed["y"].as_f64().unwrap_or(0.0);
    let action = parsed["action"].as_str().unwrap_or("move").to_string();
    let uid = match state
        .bridge
        .resolve_web_pane_uid(addr.window, addr.tab.as_deref(), addr.pane.as_deref())
        .await
    {
        Ok(u) => u,
        Err(msg) => return (StatusCode::NOT_FOUND, msg),
    };
    let cmd = serde_json::json!({"type": "WebPaneMouse", "uid": uid, "x": x, "y": y, "action": action});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_rename_tab(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let name = parsed["name"].as_str().unwrap_or("").to_string();
    if name.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "name required".into());
    }
    // PANE rename: with `pane` set, change that pane's stable codename (the
    // handle agents address it by) instead of the tab name. Lets a container
    // agent re-badge its own pane after a session resume so the crew's names
    // match what their transcripts believe.
    if let Some(pane) = parsed["pane"].as_str() {
        let uid = match state
            .bridge
            .resolve_pane_uid(
                parsed["window"].as_u64().map(|v| v as u32),
                parsed["tab"].as_str(),
                Some(pane),
            )
            .await
        {
            Some(u) => u,
            None => return (StatusCode::NOT_FOUND, "No pane at that address".into()),
        };
        // Update locally so terminal_status is right immediately; Electron's
        // RenamePane echo + the renderer's layout sync re-affirm it.
        {
            let mut sessions = state.bridge.sessions().await;
            if let Some(info) = sessions.get_mut(&uid) {
                info.shell_name = name.clone();
            }
        }
        let cmd = serde_json::json!({"type": "RenamePane", "uid": uid, "name": name});
        return match state.bridge.send_command(cmd).await {
            Ok(r) => (StatusCode::OK, r),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
        };
    }
    let session_uid = match state
        .bridge
        .resolve_tab_uid(
            parsed["window"].as_u64().map(|v| v as u32),
            parsed["tab"].as_str(),
        )
        .await
    {
        Some(uid) => uid,
        None => return (StatusCode::NOT_FOUND, "No tab at that window/tab address".into()),
    };

    // Update locally in sidecar
    {
        let mut sessions = state.bridge.sessions().await;
        let root = sessions.get(&session_uid).map(|info| info.root_tab_uid.clone());
        if let Some(root_uid) = root {
            for (_uid, info) in sessions.iter_mut() {
                if info.root_tab_uid == root_uid {
                    info.tab_name = name.clone();
                }
            }
        }
    }

    // Tell Electron to update the renderer
    let cmd = serde_json::json!({"type": "Rename", "uid": session_uid, "name": name});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_ui_key(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let key_code = match parsed["keyCode"].as_str() {
        Some(k) => k.to_string(),
        None => return (StatusCode::BAD_REQUEST, "Missing keyCode".into()),
    };
    let modifiers = parsed["modifiers"].clone();
    let window_id = parsed["windowId"].as_u64().map(|v| v as u32);
    let mut cmd = serde_json::json!({
        "type": "UIKey",
        "keyCode": key_code,
        "modifiers": modifiers,
    });
    if let Some(wid) = window_id {
        cmd["windowId"] = serde_json::json!(wid);
    }
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn get_notes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<NotesQuery>,
) -> (StatusCode, String) {
    use identity::CallerIdentity;
    use perms::AuthDecision;

    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    let mut has_list_all = false;
    if !state.bridge.perms().enforced() {
        has_list_all = true;
    } else if id.is_system() {
        has_list_all = true;
    } else {
        if let AuthDecision::Allow | AuthDecision::RefuseHome = state.bridge.authorize_capability(&id, "sticky:list_all").await {
            has_list_all = true;
        }
    }

    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let Some(home) = home else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "No home directory".into());
    };
    let path = std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("stickys")
        .join("notes.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let notes = serde_json::from_str::<Vec<serde_json::Value>>(&content).unwrap_or_default();
            let total = notes.len();
            let caller_label = id.label();
            let mut allowed_notes = Vec::new();
            for note in notes {
                let mut allowed = has_list_all;
                if !allowed {
                    if note["creator"].as_str() == Some(&caller_label) {
                        allowed = true;
                    } else if let Some(note_id) = note["id"].as_str() {
                        let cap = format!("sticky:access:{}", note_id);
                        if let AuthDecision::Allow | AuthDecision::RefuseHome = state.bridge.authorize_capability(&id, &cap).await {
                            allowed = true;
                        }
                    }
                }
                if allowed {
                    allowed_notes.push(note);
                }
            }
            // Notes hidden purely by access control (not by the text query below).
            let withheld = total.saturating_sub(allowed_notes.len());

            let query = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty());
            let visible: Vec<serde_json::Value> = if let Some(query) = query {
                let query = query.to_lowercase();
                allowed_notes
                    .into_iter()
                    .filter(|note| {
                        note["text"]
                            .as_str()
                            .map(|text| text.to_lowercase().contains(&query))
                            .unwrap_or(false)
                    })
                    .collect()
            } else {
                allowed_notes
            };

            // Envelope (not a bare array) so we can tell the caller when notes
            // exist that it simply hasn't been granted access to — otherwise an
            // agent reads an empty list as "there are no stickys" and gives up,
            // instead of asking the user for access (which Hyperia will prompt).
            let count = visible.len();
            let mut envelope = serde_json::json!({ "notes": visible, "count": count });
            if withheld > 0 {
                let who = if id.is_anonymous() {
                    "You are ANONYMOUS on this request (no Authorization token). Present your \
                     HYPERIA_AGENT_TOKEN as 'Authorization: Bearer <token>', or call request_token to \
                     mint a persistent hyp_agent_… token and reconnect — then the user can grant you access."
                } else {
                    "You are identified but have not been granted access to these yet."
                };
                envelope["withheld"] = serde_json::json!(withheld);
                envelope["hint"] = serde_json::json!(format!(
                    "{withheld} more sticky note(s) exist that you can't see — they belong to the user or \
                     another agent. {who} To read or open one, call sticky_note_read / sticky_note_open with \
                     its id anyway: Hyperia will ASK THE USER to approve (a consent prompt appears in their \
                     UI), and on approval the call completes. Notes you create yourself are always visible."
                ));
            }
            (StatusCode::OK, envelope.to_string())
        }
        Err(_) => (StatusCode::OK, "[]".into()),
    }
}

async fn post_note_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    if let Err(resp) = enforce_create(&state, &headers, "create_sticky").await {
        return resp;
    }
    use identity::CallerIdentity;
    let id = state.bridge.resolve_caller(bearer_token(&headers).as_deref()).await;
    let creator = id.label();
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let cmd = serde_json::json!({
        "type": "NoteCreate",
        "text": parsed["text"],
        "color": parsed["color"],
        "filePath": parsed["file_path"],
        "creator": creator,
    });
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// POST /api/agent/config/edit — open THE Hyperia config file in a
/// syntax-highlighted code sticky. Fixed action for the config page's
/// "Edit config" button: the page's fetch is anonymous so the general
/// /api/notes create is identity-gated, but this endpoint can only ever
/// open the one local config file, user-initiated — System-side by design.
async fn post_open_config_sticky(State(state): State<AppState>) -> (StatusCode, String) {
    let Some(path) = crate::ghost::api::config_raw_path() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "no home dir".into());
    };
    let cmd = serde_json::json!({
        "type": "NoteCreate",
        "color": "code:dark",
        "filePath": path.to_string_lossy(),
        "creator": "Hyperia",
    });
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_note_close(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let id = parsed["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing note id".into());
    }
    if let Err(resp) = enforce_note_access(&state, &headers, &id).await {
        return resp;
    }
    let cmd = serde_json::json!({"type": "NoteClose", "id": id});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn post_note_open(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let id = parsed["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing note id".into());
    }
    if let Err(resp) = enforce_note_access(&state, &headers, &id).await {
        return resp;
    }
    let cmd = serde_json::json!({"type": "NoteOpen", "id": id});
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn get_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> (StatusCode, String) {
    if let Err(resp) = enforce_note_access(&state, &headers, &id).await {
        return resp;
    }
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let Some(home) = home else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "No home directory".into());
    };
    let path = std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("stickys")
        .join("notes.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let notes = serde_json::from_str::<Vec<serde_json::Value>>(&content).unwrap_or_default();
            let note = resolve_note(&notes, &id);
            match note {
                Some(n) => (StatusCode::OK, serde_json::to_string(&n).unwrap_or_else(|_| "{}".into())),
                None => (StatusCode::NOT_FOUND, format!("Note {} not found", id)),
            }
        }
        Err(_) => (StatusCode::NOT_FOUND, format!("Note {} not found", id)),
    }
}

/// Resolve a note by id, accepting either the full id (`note-<ts>-<suffix>`) or
/// just the short suffix users actually quote (`6r7t`). Exact match wins; failing
/// that, match a note whose id ends with `-<id>` (case-insensitive).
fn resolve_note<'a>(notes: &'a [serde_json::Value], id: &str) -> Option<&'a serde_json::Value> {
    if let Some(n) = notes.iter().find(|n| n["id"].as_str() == Some(id)) {
        return Some(n);
    }
    let id_l = id.to_lowercase();
    let suffix = format!("-{}", id_l);
    notes.iter().find(|n| {
        n["id"]
            .as_str()
            .map(|nid| nid.to_lowercase())
            .map(|nid| nid == id_l || nid.ends_with(&suffix))
            .unwrap_or(false)
    })
}

async fn patch_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> (StatusCode, String) {
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing note id".into());
    }
    if let Err(resp) = enforce_note_access(&state, &headers, &id).await {
        return resp;
    }
    let payload: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()),
    };
    let text = match payload["text"].as_str() {
        Some(t) => t.to_string(),
        None => return (StatusCode::BAD_REQUEST, "Missing 'text' field".into()),
    };

    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let Some(home) = home else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "No home directory".into());
    };

    let path = std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("stickys")
        .join("notes.json");

    let mut notes = match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<Vec<serde_json::Value>>(&content).unwrap_or_default(),
        Err(_) => return (StatusCode::NOT_FOUND, String::new()),
    };

    let found = notes.iter_mut().find(|n| n["id"].as_str() == Some(id.as_str()));
    let Some(note) = found else {
        return (StatusCode::NOT_FOUND, String::new());
    };
    note["text"] = serde_json::Value::String(text.clone());

    let serialized = match serde_json::to_string_pretty(&notes) {
        Ok(content) => content,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if let Err(e) = std::fs::write(&path, serialized) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    let cmd = serde_json::json!({"type": "NoteUpdate", "id": id, "text": text});
    match state.bridge.send_command(cmd).await {
        Ok(_) => (StatusCode::OK, serde_json::json!({"ok": true}).to_string()),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// Schedule (or with body {"schedule":null} unschedule) a sticky. The schedule
/// object is forwarded verbatim to Electron, which owns the timer + runners.
async fn post_note_schedule(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: String,
) -> (StatusCode, String) {
    if let Err(resp) = enforce_note_access(&state, &headers, &id).await {
        return resp;
    }
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    // Accept either the bare schedule object or {"schedule": {...}}.
    let schedule = if parsed.get("schedule").is_some() {
        parsed["schedule"].clone()
    } else {
        parsed
    };
    let cmd = serde_json::json!({"type": "NoteSchedule", "id": id, "schedule": schedule});
    match state.bridge.send_command(cmd).await {
        Ok(_) => (StatusCode::OK, serde_json::json!({"ok": true}).to_string()),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// Grapheme-safe transactional file edit, backed by the aegis-edit module.
/// Body: { path, edits: [{start_line,start_col,end_line,end_col,text}], preview? }.
/// Reads the file → LOPT Document → applies disjoint edits back-to-front → writes
/// atomically (temp + rename). On any validation error nothing is written.
async fn post_edit_apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    use aegis_edit::{Document, TextEdit};
    // Editing files on disk is one of the most powerful things an agent can do
    // — gate it on the "files" capability.
    if let Err(resp) = enforce_capability(&state, &headers, "files").await {
        return resp;
    }
    let err = |code: StatusCode, msg: String| (code, serde_json::json!({"ok": false, "error": msg}).to_string());

    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, format!("bad JSON: {e}")),
    };
    let path = parsed["path"].as_str().unwrap_or("").to_string();
    if path.is_empty() {
        return err(StatusCode::BAD_REQUEST, "'path' is required".into());
    }
    let preview = parsed["preview"].as_bool().unwrap_or(false);

    let edits_json = parsed["edits"].as_array().cloned().unwrap_or_default();
    if edits_json.is_empty() {
        return err(StatusCode::BAD_REQUEST, "'edits' must be a non-empty array".into());
    }
    let edits: Vec<TextEdit> = edits_json
        .iter()
        .map(|e| TextEdit {
            start_line: e["start_line"].as_u64().unwrap_or(0) as usize,
            start_col: e["start_col"].as_u64().unwrap_or(0) as usize,
            end_line: e["end_line"].as_u64().unwrap_or(0) as usize,
            end_col: e["end_col"].as_u64().unwrap_or(0) as usize,
            text: e["text"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    let applied = edits.len();

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => return err(StatusCode::NOT_FOUND, format!("read {path}: {e}")),
    };

    let mut doc = Document::new(content);
    if let Err(e) = doc.apply_transactional_edits(edits) {
        // Validation failure → file untouched (transactional rollback property).
        return err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string());
    }
    let new_content = doc.render();
    let lines = doc.line_count();
    let bytes = new_content.len();

    if !preview {
        // Atomic write: temp file in the same dir + rename (Rust's fs::rename
        // overwrites the destination on Windows via MoveFileEx REPLACE_EXISTING).
        let p = std::path::Path::new(&path);
        let tmp = p.with_extension(format!("aegistmp{}", std::process::id()));
        if let Err(e) = std::fs::write(&tmp, new_content.as_bytes()) {
            return err(StatusCode::INTERNAL_SERVER_ERROR, format!("write tmp: {e}"));
        }
        if let Err(e) = std::fs::rename(&tmp, p) {
            let _ = std::fs::remove_file(&tmp);
            return err(StatusCode::INTERNAL_SERVER_ERROR, format!("rename: {e}"));
        }
    }

    // Bound the echoed preview so a huge file doesn't flood the response.
    let preview_str = if new_content.chars().count() > 4000 {
        new_content.chars().take(4000).collect::<String>() + "\n…[truncated]"
    } else {
        new_content.clone()
    };

    (
        StatusCode::OK,
        serde_json::json!({
            "ok": true,
            "path": path,
            "lines": lines,
            "bytes": bytes,
            "applied": applied,
            "wrote": !preview,
            "preview": preview_str,
        })
        .to_string(),
    )
}

async fn delete_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> (StatusCode, String) {
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing note id".into());
    }
    if let Err(resp) = enforce_note_access(&state, &headers, &id).await {
        return resp;
    }

    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let Some(home) = home else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "No home directory".into());
    };

    let path = std::path::PathBuf::from(home)
        .join(".hyperia")
        .join("stickys")
        .join("notes.json");

    let notes = match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<Vec<serde_json::Value>>(&content).unwrap_or_default(),
        Err(_) => return (StatusCode::NOT_FOUND, String::new()),
    };
    let original_len = notes.len();

    let filtered: Vec<serde_json::Value> = notes
        .into_iter()
        .filter(|note| note["id"].as_str() != Some(id.as_str()))
        .collect();

    if filtered.len() == original_len {
        return (StatusCode::NOT_FOUND, String::new());
    }

    let serialized = match serde_json::to_string_pretty(&filtered) {
        Ok(content) => content,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if let Err(e) = std::fs::write(&path, serialized) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    let cmd = serde_json::json!({"type": "NoteDelete", "id": id});
    match state.bridge.send_command(cmd).await {
        Ok(_) => (
            StatusCode::OK,
            serde_json::json!({"ok": true}).to_string(),
        ),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// In-memory cache for highlight results: content_hash → rules JSON
static HIGHLIGHT_CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u64, String>>> =
    std::sync::OnceLock::new();

fn highlight_cache() -> &'static std::sync::Mutex<std::collections::HashMap<u64, String>> {
    HIGHLIGHT_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn content_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

#[derive(Deserialize)]
struct HighlightRequest {
    content: String,
    hint: Option<String>,
}

async fn post_notes_highlight(
    Json(body): Json<HighlightRequest>,
) -> (StatusCode, String) {
    let content = body.content.chars().take(4000).collect::<String>();
    let key = content_hash(&content);

    // Cache hit
    if let Ok(cache) = highlight_cache().lock() {
        if let Some(cached) = cache.get(&key) {
            return (StatusCode::OK, cached.clone());
        }
    }

    let cfg = match ghost::load_config() {
        Some(c) => c,
        None => return (StatusCode::SERVICE_UNAVAILABLE, r#"{"error":"no api key configured"}"#.into()),
    };

    let hint = body.hint.unwrap_or_default();
    let user_msg = if hint.is_empty() {
        format!("Highlight this content:\n\n{}", content)
    } else {
        format!("Hint: {}\n\nHighlight this content:\n\n{}", hint, content)
    };

    // Resolve model ID (same logic as provider.rs)
    let model = match cfg.model.as_str() {
        "anthropic" => "claude-haiku-4-5-20251001".to_string(),
        other => other.to_string(),
    };

    let req_body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "system": "You are a syntax highlighter. Analyze the given content and return a JSON object with a single key \"rules\" containing an array of highlight rules. Each rule has: \"pattern\" (regex string), \"flags\" (optional, default \"g\"), \"className\" (an hljs CSS class like hljs-keyword, hljs-string, hljs-comment, hljs-number, hljs-title, hljs-built_in, hljs-literal), and optionally \"color\" (hex color override). Identify keywords, literals, identifiers, operators, and domain-specific terms. Return ONLY valid JSON, no explanation, no markdown.",
        "messages": [{"role": "user", "content": user_msg}]
    });

    let client = reqwest::Client::new();
    let resp = match client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&req_body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!(r#"{{"error":"{}"}}"#, e)),
    };

    let resp_json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!(r#"{{"error":"{}"}}"#, e)),
    };

    // Extract text from response
    let text = resp_json["content"][0]["text"].as_str().unwrap_or("{}");

    // Parse and validate — must have a "rules" array
    let parsed: serde_json::Value = serde_json::from_str(text).unwrap_or(serde_json::json!({"rules": []}));
    let result = if parsed["rules"].is_array() {
        parsed
    } else {
        serde_json::json!({"rules": []})
    };

    let out = result.to_string();

    // Store in cache
    if let Ok(mut cache) = highlight_cache().lock() {
        cache.insert(key, out.clone());
    }

    (StatusCode::OK, out)
}

async fn post_agent_status(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, String) {
    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
    let mut cmd = serde_json::json!({
        "type": "AgentStatus",
        "connected": parsed["connected"],
        "working": parsed["working"],
        "label": parsed["label"],
        "humanPercent": parsed["humanPercent"],
    });
    if let Some(uid) = parsed["sessionUid"].as_str() {
        cmd["sessionUid"] = serde_json::json!(uid);
    } else if parsed["window"].is_u64() || parsed["tab"].is_string() || parsed["pane"].is_string() {
        match state
            .bridge
            .resolve_pane_uid(
                parsed["window"].as_u64().map(|v| v as u32),
                parsed["tab"].as_str(),
                parsed["pane"].as_str(),
            )
            .await
        {
            Some(uid) => cmd["sessionUid"] = serde_json::json!(uid),
            None => return (StatusCode::NOT_FOUND, "No pane at that window/tab/pane address".into()),
        }
    }
    match state.bridge.send_command(cmd).await {
        Ok(r) => (StatusCode::OK, r),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Log panics to stderr so they appear in the Electron console
    std::panic::set_hook(Box::new(|info| {
        eprintln!("[sidecar-panic] {info}");
    }));

    let args = Args::parse();

    // Pick the message locale before anything can emit agent-facing prose.
    // Unset or unknown tags fall back to English (see messages/mod.rs).
    if let Ok(tag) = std::env::var("HYPERIA_LOCALE") {
        messages::set_locale(&tag);
    }

    // MCP mode: stdio proxy
    if args.mcp {
        tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()),
            )
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .init();
        tracing::info!("MCP server (stdio) starting");
        return mcp::run_mcp_stdio(args.port).await;
    }

    // Normal sidecar mode.
    //
    // Two log sinks side-by-side:
    //   1. In-memory ring buffer (1000 lines) — served by /api/logs for the
    //      Settings panel and the sidecar_logs MCP tool. Lost on restart.
    //   2. Daily-rotating file under ~/.hyperia/logs/sidecar.log.YYYY-MM-DD.
    //      Survives restarts so anything that happened mid-session is
    //      recoverable. Keeps ALL log lines, not just the latest 1000.
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    let log_dir = home
        .map(|h| std::path::PathBuf::from(h).join(".hyperia").join("logs"))
        .unwrap_or_else(|| std::path::PathBuf::from(".hyperia-logs"));
    let _ = std::fs::create_dir_all(&log_dir);

    // Audit log: one JSONL line per gated/identified call, rolled daily.
    audit::init(&log_dir);

    let log_buffer = logs::new_log_buffer();
    let file_appender = tracing_appender::rolling::daily(&log_dir, "sidecar.log");
    let (file_writer, _file_guard) = tracing_appender::non_blocking(file_appender);
    // Leak the guard so the non-blocking writer keeps draining for the
    // process lifetime. Dropping it would close the file early.
    Box::leak(Box::new(_file_guard));

    use tracing_subscriber::fmt::writer::MakeWriterExt;
    let writer = logs::LogBufferMakeWriter::new(log_buffer.clone()).and(file_writer);
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()),
        )
        .with_writer(writer)
        .with_ansi(false)
        .init();

    tracing::info!("hyperia-sidecar v{}", env!("CARGO_PKG_VERSION"));
    tracing::info!("API :{}", args.port);
    tracing::info!("log dir: {} (daily rotation)", log_dir.display());

    // Ferricula no longer embedded. The ghost agent talks to ferricula over
    // HTTP via FerriculaBackend (FERRICULA_URL env var or the shared Hyperia
    // config). Run ferricula separately — Docker locally
    // (`docker compose up ferricula`) or remote in the cloud.
    let ferricula_url = std::env::var("FERRICULA_URL")
        .unwrap_or_else(|_| "http://localhost:8765".to_string());
    tracing::info!("Ferricula client: {} (run ferricula separately, e.g. via docker compose)", ferricula_url);

    let bridge = Bridge::new();
    let telem = telemetry::TelemetryStore::new();
    let dash_state = dashboard::DashboardState::new(telem.clone());
    let state = AppState { bridge, log_buffer, telemetry: telem, render: render::RenderStore::new() };
    // Grab lume handles before `state` is moved into the router below.
    let lume_for_flush = state.bridge.lume();
    let lume_for_shutdown = state.bridge.lume();
    let bridge_for_monitor = state.bridge.clone();
    // Bridge handle for the identity middleware (runs across all routes incl. /mcp).
    let bridge_for_mw = state.bridge.clone();
    // Bridge handle to mint Ghost's identity (state is moved into the router below).
    let bridge_for_ghost = state.bridge.clone();

    let app = axum::Router::new()
        .route("/health", axum::routing::get(|| async { "ok" }))
        .route("/api/mcp/hyperia.py", axum::routing::get(get_mcp_python))
        .route("/ws", axum::routing::get(bridge::ws_handler))
        // Event Stream API — WebSocket fan-out to external apps (see
        // plan/specs/EVENT_STREAM_API.md). Foundation: connect → hello → snapshot.
        .route("/ws/wall", axum::routing::get(stream::wall_handler))
        .route("/ws/pane/{id}", axum::routing::get(stream::pane_handler))
        .route("/ws/pixels/{id}", axum::routing::get(stream::pixels_handler))
        .route("/ws/tab/{id}", axum::routing::get(stream::tab_handler))
        // Read endpoints
        .route("/api/logs", axum::routing::get(get_logs))
        .route("/api/log", axum::routing::post(post_client_log))
        .route("/api/tts", axum::routing::post(post_tts))
        .route("/api/audio/play", axum::routing::post(post_audio_play))
        .route("/api/audio/probe", axum::routing::post(post_audio_probe))
        .route("/api/audio/mute", axum::routing::post(post_audio_mute))
        .route("/ws/audio", axum::routing::get(ws_audio))
        .route("/api/status", axum::routing::get(get_status))
        .route("/api/screen", axum::routing::get(get_screen))
        .route("/api/fs/dirs", axum::routing::get(get_fs_dirs))
        .route("/api/tab/image", axum::routing::get(get_tab_image))
        .route("/api/window/image", axum::routing::get(get_window_image))
        .route("/api/search/shell", axum::routing::get(get_search_shell))
        .route("/api/scrollback", axum::routing::get(get_scrollback))
        .route("/api/search/sticky", axum::routing::get(get_search_sticky))
        .route("/api/edit/apply", axum::routing::post(post_edit_apply))
        // Write endpoints
        .route("/api/type", axum::routing::post(post_type))
        .route("/api/pulse/on-idle", axum::routing::post(post_pane_on_idle))
        .route("/api/pulse/liveness", axum::routing::post(post_pane_liveness))
        .route("/api/pulse/set", axum::routing::post(post_pulse_set))
        .route("/api/pulse/clear", axum::routing::post(post_pulse_clear))
        .route("/api/pulse/pause", axum::routing::post(post_pulse_pause))
        .route("/api/pulse/status", axum::routing::get(get_pulse_status))
        .route("/api/type-and-collect", axum::routing::post(post_type_and_collect))
        .route("/api/pane/split", axum::routing::post(post_split))
        .route("/render/{id}", axum::routing::get(render::get_render_page))
        .route("/api/render", axum::routing::post(post_render))
        .route("/api/render/{id}/version", axum::routing::get(render::get_render_version))
        .route("/api/pane/focus", axum::routing::post(post_focus))
        .route("/api/perms/request-access", axum::routing::post(post_request_access))
        .route("/api/perms/request", axum::routing::post(post_perm_request))
        .route("/api/perms/respond", axum::routing::post(post_perm_respond))
        .route("/api/perms/state", axum::routing::get(get_perm_state))
        .route("/api/audit/search", axum::routing::get(get_audit_search))
        .route("/api/consent/log", axum::routing::get(get_consent_log))
        .route("/api/bug", axum::routing::post(post_bug))
        .route("/api/bug/log", axum::routing::get(get_bug_log))
        .route("/api/perms/check", axum::routing::post(post_perm_check))
        .route("/api/perms/token", axum::routing::get(get_perm_token))
        .route("/api/perms/enforce", axum::routing::post(post_perm_enforce))
        .route("/api/identity/agent", axum::routing::post(post_identity_agent))
        .route("/api/identity/whoami", axum::routing::get(get_identity_whoami))
        .route("/api/identity/agents", axum::routing::get(get_identity_agents))
        .route("/api/pane/close", axum::routing::post(post_close))
        .route("/api/pane/cd", axum::routing::post(post_cd))
        .route("/api/styles/apply", axum::routing::post(post_style_apply))
        .route("/api/pane/new", axum::routing::post(post_new_tab))
        .route("/api/window/new", axum::routing::post(post_new_window))
        .route("/api/window/size", axum::routing::post(post_window_size))
        .route("/api/layout/save", axum::routing::post(post_layout_save))
        .route("/api/workspace/save", axum::routing::post(post_workspace_save))
        .route("/api/workspace/list", axum::routing::get(get_workspace_list))
        .route("/api/workspace/delete", axum::routing::post(post_workspace_delete))
        .route("/api/workspace/rename", axum::routing::post(post_workspace_rename))
        .route("/api/workspace/preview", axum::routing::post(post_workspace_preview))
        .route("/api/workspace/restore", axum::routing::post(post_workspace_restore))
        .route("/api/workspace/export", axum::routing::post(post_workspace_export))
        .route("/api/workspace/import", axum::routing::post(post_workspace_import))
        .route("/api/web-pane", axum::routing::post(post_open_web_pane))
        .route("/api/web-pane/reload", axum::routing::post(post_web_pane_reload))
        .route("/api/web-pane/click", axum::routing::post(post_web_pane_click))
        .route("/api/web-pane/content", axum::routing::post(post_web_pane_content))
        .route("/api/web-pane/eval", axum::routing::post(post_web_pane_eval))
        .route("/api/web-pane/mouse", axum::routing::post(post_web_pane_mouse))
        .route("/api/pane/where", axum::routing::get(get_where_pane))
        .route("/api/pane/rename", axum::routing::post(post_rename_tab))
        .route("/api/agent/status", axum::routing::post(post_agent_status))
        .route("/api/ui/key", axum::routing::post(post_ui_key))
        .route("/api/pane/describe", axum::routing::post(post_auto_describe))
        .route("/api/notes", axum::routing::get(get_notes).post(post_note_create))
        .route("/api/agent/config/edit", axum::routing::post(post_open_config_sticky))
        .route("/api/notes/highlight", axum::routing::post(post_notes_highlight))
        .route("/api/notes/{id}", axum::routing::get(get_note).delete(delete_note).patch(patch_note))
        .route("/api/notes/{id}/schedule", axum::routing::post(post_note_schedule))
        .route("/api/notes/close", axum::routing::post(post_note_close))
        .route("/api/notes/open", axum::routing::post(post_note_open))
        .with_state(state);

    // Dashboard routes with their own state
    let dash_routes = axum::Router::new()
        .route("/dashboard", axum::routing::get(dashboard::get_dashboard))
        .route("/api/dashboard/version", axum::routing::get(dashboard::get_dashboard_version))
        .route("/api/maximus/toggle", axum::routing::post(dashboard::post_maximus_toggle))
        .route("/api/telemetry/snapshot", axum::routing::get(dashboard::get_telemetry_snapshot))
        .route("/api/telemetry/toggle", axum::routing::post(dashboard::post_telemetry_toggle))
        .route("/api/telemetry/reset", axum::routing::post(dashboard::post_telemetry_reset))
        .route("/api/telemetry/event", axum::routing::post(dashboard::post_telemetry_event))
        .route("/api/dashboard/widgets", axum::routing::get(dashboard::get_widgets).post(dashboard::post_widgets))
        .with_state(dash_state);

    // Ghost agent routes — always mounted, config lazy-loaded per request.
    // Mint Ghost a persistent identity so its sidecar API calls are attributed
    // (not anonymous) — same IdentityStore resolve_caller reads (#22).
    let ghost_token = bridge_for_ghost.identity().mint("Ghost 👻").await.token;
    // Hyperia's OWN agent is consent-exempt (trusted by TOKEN, never name):
    // the user configured it, so its pane actions are the user's ask — no
    // approval prompts for the built-in agent (#131).
    bridge_for_ghost.trust_agent_token(&ghost_token);
    let ghost_state = ghost::GhostState::new(args.port, ghost_token);
    let shared_registry = ghost_state.registry.clone();
    let ghost_routes = axum::Router::new()
        .route("/api/ghost/chat", axum::routing::post(ghost::api::ghost_chat))
        .route("/api/ghost/status", axum::routing::get(ghost::api::ghost_status))
        .route("/api/ghost/debug", axum::routing::get(ghost::api::ghost_debug))
        .route("/api/ghost/history", axum::routing::get(ghost::api::ghost_history))
        .route("/api/ghost/memory", axum::routing::get(ghost::api::ghost_memory))
        .route("/api/ghost/session", axum::routing::get(ghost::api::ghost_session_dump))
        .route("/api/ghost/stop", axum::routing::post(ghost::api::ghost_stop))
        .route("/api/ghost/ui-response", axum::routing::post(ghost::api::ghost_ui_response))
        .route("/api/ghost/inject", axum::routing::post(ghost::api::ghost_inject))
        .route("/api/ghost/continue", axum::routing::post(ghost::api::ghost_continue))
        .route("/api/ghost/reset", axum::routing::post(ghost::api::ghost_reset))
        .route("/api/ghost/window-closed", axum::routing::post(ghost::api::ghost_window_closed))
        // Widget data + action endpoints back the tool_mount SSE event.
        .route("/api/ghost/widget/{id}/data", axum::routing::get(ghost::api::ghost_widget_data))
        .route("/api/ghost/widget/{id}/action", axum::routing::post(ghost::api::ghost_widget_action))
        // Capabilities probe — boot-level decision for the shell page.
        .route("/api/ghost/capabilities", axum::routing::get(ghost::api::ghost_capabilities))
        // Bootstub — Level-0 micro-agent for the no-model-wired case.
        .route("/api/ghost/bootchat", axum::routing::post(ghost::api::ghost_bootchat))
        // Model picker — writes config.agent.{provider,model} from the shell.
        .route("/api/ghost/set-model", axum::routing::post(ghost::api::ghost_set_model))
        .route("/api/ghost/wipe-config", axum::routing::post(ghost::api::ghost_wipe_config))
        // Assets: paste/drop targets land here, then appear as rows in the shell.
        .route(
            "/api/ghost/asset",
            axum::routing::post(ghost::api::ghost_asset_upload)
                .layer(axum::extract::DefaultBodyLimit::max(25 * 1024 * 1024)),
        )
        .route("/api/ghost/asset/{id}", axum::routing::get(ghost::api::ghost_asset_get))
        .route("/api/ghost/assets", axum::routing::get(ghost::api::ghost_asset_list))
        // Static page: the agentic shell pane's HTML.
        .route("/shell", axum::routing::get(ghost::api::ghost_shell_page))
        // Hyperia Agent configuration (epic #131).
        .route("/agent/config", axum::routing::get(ghost::api::agent_config_page))
        .route("/guide", axum::routing::get(ghost::api::guide_page))
        .route(
            "/api/agent/config",
            axum::routing::get(ghost::api::get_agent_config).post(ghost::api::post_agent_config)
        )
        .route("/api/agent/models", axum::routing::get(ghost::api::get_agent_models))
        .route("/api/agent/services", axum::routing::get(ghost::api::get_agent_services))
        .route("/api/agent/keycheck", axum::routing::get(ghost::api::get_agent_keycheck))
        .with_state(ghost_state);

    // Settings agent routes — separate session, SHARED tool registry so
    // the configuration agent has full access to doctor / show_* / settings_set /
    // model_catalog / docker_run / etc. Widgets opened from either panel
    // resolve through the same pending_ui map via /api/ghost/ui-response.
    let settings_state = settings::SettingsState::with_registry(shared_registry);
    let settings_routes = axum::Router::new()
        .route("/api/settings/chat", axum::routing::post(settings::api::settings_chat))
        .route("/api/settings/reset", axum::routing::post(settings::api::settings_reset))
        .with_state(settings_state);

    let app = app
        .merge(dash_routes)
        .merge(ghost_routes)
        .merge(settings_routes)
        .nest_service("/mcp", mcp::streamable_http_service(args.port))
        // Resolve caller identity from the Authorization header for every route
        // (incl. /mcp) — attribution now, enforcement next (#59).
        .layer(axum::middleware::from_fn_with_state(bridge_for_mw, identity_mw));

    // Default bind: all interfaces on Linux (so nemesis8 containers reach the
    // sidecar via host.docker.internal — a loopback-only bind is invisible to
    // them on native Docker), loopback elsewhere (Docker Desktop bridges it).
    let bind = args.bind.unwrap_or_else(|| {
        if cfg!(target_os = "linux") {
            std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)
        } else {
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        }
    });
    let addr = std::net::SocketAddr::new(bind, args.port);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[sidecar] Port {} already in use — another sidecar is running. Exiting. ({})", args.port, e);
            std::process::exit(0); // Exit cleanly so auto-restart doesn't loop
        }
    };
    if !bind.is_loopback() {
        tracing::warn!(
            "Sidecar bound to {} — reachable from outside this machine (this is the \
            default on Linux so nemesis8 containers can connect via \
            host.docker.internal). State-changing MCP tools still require the human's \
            consent, but reads are open — keep this host behind a firewall you trust, \
            or set HYPERIA_BIND=127.0.0.1 to restrict / 172.17.0.1 for docker-only.",
            bind
        );
        eprintln!("[sidecar] bound to {} (non-loopback) — reachable by containers/LAN", bind);
    }
    tracing::info!(%addr, "Sidecar HTTP listening");
    eprintln!("[sidecar] HTTP ready on :{}", args.port);

    // Periodically pickle the lume per-shell logs to disk. Hyperia shuts the
    // sidecar down with `taskkill /F` (uncatchable), so a shutdown-only hook
    // would lose data — a 45s flush bounds the loss instead. The graceful
    // ctrl_c path below adds a final flush for the soft-shutdown case.
    {
        let lume = lume_for_flush;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(45));
            tick.tick().await; // consume the immediate first tick
            loop {
                tick.tick().await;
                lume.persist().await;
            }
        });
    }

    // Idle monitor: ~2s tick. Watches panes that have an armed idle-callback
    // (and, later, pulses), classifies each from its cached screen, and fires on
    // a running->idle edge. Independent of any agent's loop.
    {
        let bridge = bridge_for_monitor;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
            tick.tick().await; // consume the immediate first tick
            loop {
                tick.tick().await;
                bridge.idle_monitor_tick().await;
            }
        });
    }

    let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        lume_for_shutdown.persist().await;
    });
    if let Err(e) = serve.await {
        eprintln!("[sidecar] axum::serve error: {e}");
        std::process::exit(0); // Exit cleanly — Electron will restart if needed
    }

    Ok(())
}
