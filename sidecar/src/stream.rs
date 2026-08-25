//! Event Stream API — WebSocket fan-out of terminal state to external apps.
//!
//! Two modes (full contract: `plan/specs/EVENT_STREAM_API.md`):
//!   - `/ws/wall`       — every pane at once. Sidecar-rendered, COLORIZED cell
//!     grid: a `frame` keyframe then row `delta`s (JSON), poll-coalesced to fps.
//!     Cheap overview for the 3D monitor wall; the client just draws cells.
//!   - `/ws/pane/{id}`  — one pane, FULL FIDELITY. Raw PTY bytes as BINARY frames,
//!     seeded with the current screen. Feed straight into xterm.js (or any vt100)
//!     for pixel-exact colors/TUIs/cursor/animation.
//!
//! Wall is poll-based and lives entirely here (bridge.rs hot path untouched): a
//! per-connection timer dumps only panes that emitted output since the last tick
//! (gated on `SessionInfo.last_output_at`) and diffs against the connection's OWN
//! cache, so multiple viewers stay correct. Focused rides the existing per-pane
//! raw-byte fan-out (`Bridge::subscribe_output`).

use std::collections::{HashMap, HashSet};
use std::hash::Hasher;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use serde_json::json;

use crate::bridge::Bridge;
use crate::screen::{CellAttr, ScreenDump, ScreenLine};

const PROTO_VERSION: u32 = 1;
const HEARTBEAT: Duration = Duration::from_secs(15);
const DEFAULT_FPS: u64 = 30;

// --- helpers ---------------------------------------------------------------

fn hello(mode: &str) -> String {
    json!({
        "t": "hello", "v": PROTO_VERSION, "mode": mode,
        "serverVersion": env!("CARGO_PKG_VERSION"), "heartbeatMs": HEARTBEAT.as_millis() as u64,
    })
    .to_string()
}

async fn send_text(tx: &mut futures::stream::SplitSink<WebSocket, Message>, s: String) -> bool {
    tx.send(Message::Text(s.into())).await.is_ok()
}

/// Map a vt100 Debug-formatted color ("Default" | "Idx(4)" | "Rgb(255, 0, 0)")
/// to the stable wire form ("default" | "idx:4" | "#ff0000").
fn normalize_color(dbg: &str) -> String {
    if dbg == "Default" {
        return "default".into();
    }
    if let Some(rest) = dbg.strip_prefix("Idx(").and_then(|s| s.strip_suffix(')')) {
        return format!("idx:{}", rest.trim());
    }
    if let Some(rest) = dbg.strip_prefix("Rgb(").and_then(|s| s.strip_suffix(')')) {
        let parts: Vec<u8> = rest.split(',').filter_map(|p| p.trim().parse().ok()).collect();
        if parts.len() == 3 {
            return format!("#{:02x}{:02x}{:02x}", parts[0], parts[1], parts[2]);
        }
    }
    "default".into()
}

fn attr_bits(a: &CellAttr) -> u32 {
    (a.bold as u32) | ((a.italic as u32) << 1) | ((a.underline as u32) << 2)
}

/// One row → `{y, cells:[[char, fg, bg, attrs], ...]}`, trailing blanks trimmed
/// (ScreenLine.text is already trimmed by screen_dump).
fn row_json(line: &ScreenLine) -> serde_json::Value {
    let cells: Vec<_> = line
        .text
        .chars()
        .enumerate()
        .map(|(i, ch)| {
            let a = line.attrs.get(i).cloned().unwrap_or_default();
            json!([ch.to_string(), normalize_color(&a.fg), normalize_color(&a.bg), attr_bits(&a)])
        })
        .collect();
    json!({ "y": line.row, "cells": cells })
}

fn cursor_json(d: &ScreenDump) -> serde_json::Value {
    json!({ "x": d.cursor.col, "y": d.cursor.row, "visible": true })
}

fn frame_json(uid: &str, d: &ScreenDump) -> String {
    let rows: Vec<_> = d.lines.iter().map(row_json).collect();
    json!({
        "t": "frame", "paneId": uid, "cols": d.cols, "rows": d.rows,
        "cursor": cursor_json(d), "rows_data": rows,
    })
    .to_string()
}

fn delta_json(uid: &str, d: &ScreenDump, changed: &[u16]) -> String {
    let rows: Vec<_> = changed
        .iter()
        .filter_map(|&y| d.lines.get(y as usize))
        .map(row_json)
        .collect();
    json!({ "t": "delta", "paneId": uid, "cursor": cursor_json(d), "rows_data": rows }).to_string()
}

/// Rows whose text OR attributes changed since the previous dump.
fn changed_rows(cur: &ScreenDump, prev: &ScreenDump) -> Vec<u16> {
    cur.lines
        .iter()
        .zip(prev.lines.iter())
        .filter_map(|(c, p)| if c != p { Some(c.row) } else { None })
        .collect()
}

struct CacheEntry {
    last_output: Option<Instant>,
    rows: u16,
    cols: u16,
    dump: ScreenDump,
}

fn fps_from(params: &HashMap<String, String>) -> u64 {
    params
        .get("fps")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_FPS)
        .clamp(1, 60)
}

/// Flat snapshot of every pane (wall connect). window/tab grouping lets the 3D
/// client place each pane on the right monitor.
async fn panes_snapshot(bridge: &Bridge) -> Vec<serde_json::Value> {
    let sessions = bridge.sessions().await;
    sessions
        .iter()
        .map(|(uid, s)| {
            let title = if s.title.is_empty() { s.shell_name.clone() } else { s.title.clone() };
            json!({
                "paneId": uid, "title": title, "shellName": s.shell_name,
                "cols": s.cols, "rows": s.rows, "windowId": s.window_id,
                "tabId": s.root_tab_uid, "tabName": s.tab_name,
                "active": s.pane_active, "tabActive": s.tab_active,
                "state": s.shell_state, "cwd": s.cwd,
            })
        })
        .collect()
}

// --- wall mode: /ws/wall (colorized grid keyframe + deltas) ----------------

async fn wall_loop(socket: WebSocket, bridge: Bridge, fps: u64) {
    let (mut tx, mut rx) = socket.split();
    if !send_text(&mut tx, hello("wall")).await {
        return;
    }
    let panes = panes_snapshot(&bridge).await;
    if !send_text(&mut tx, json!({"t": "panes", "v": PROTO_VERSION, "panes": panes}).to_string()).await {
        return;
    }

    let mut cache: HashMap<String, CacheEntry> = HashMap::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(1000 / fps));
    let mut hb = tokio::time::interval(HEARTBEAT);
    hb.tick().await; // drop the immediate heartbeat tick

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                // Snapshot phase: hold the sessions lock only long enough to dump
                // the panes that actually changed, then release before sending.
                let (updates, removed): (Vec<(String, ScreenDump, Option<Instant>)>, Vec<String>) = {
                    let sessions = bridge.sessions().await;
                    let mut updates = Vec::new();
                    for (uid, info) in sessions.iter() {
                        let need = match cache.get(uid) {
                            None => true,
                            Some(c) => info.last_output_at != c.last_output || info.rows != c.rows || info.cols != c.cols,
                        };
                        if need {
                            updates.push((uid.clone(), info.screen.screen_dump(), info.last_output_at));
                        }
                    }
                    let live: HashSet<&String> = sessions.keys().collect();
                    let removed: Vec<String> = cache.keys().filter(|k| !live.contains(*k)).cloned().collect();
                    (updates, removed)
                };

                for uid in removed {
                    cache.remove(&uid);
                    if !send_text(&mut tx, json!({"t":"topo","op":"remove","paneId":uid}).to_string()).await {
                        return;
                    }
                }
                for (uid, dump, last_output) in updates {
                    let dims_changed = cache
                        .get(&uid)
                        .map(|c| c.rows != dump.rows || c.cols != dump.cols)
                        .unwrap_or(false);
                    let is_new = !cache.contains_key(&uid);
                    let ok = if is_new || dims_changed {
                        send_text(&mut tx, frame_json(&uid, &dump)).await
                    } else {
                        let changed = changed_rows(&dump, &cache[&uid].dump);
                        if changed.is_empty() {
                            true
                        } else {
                            send_text(&mut tx, delta_json(&uid, &dump, &changed)).await
                        }
                    };
                    if !ok {
                        return;
                    }
                    cache.insert(uid, CacheEntry { last_output, rows: dump.rows, cols: dump.cols, dump });
                }
            }
            _ = hb.tick() => {
                if !send_text(&mut tx, r#"{"t":"ping"}"#.to_string()).await { break; }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
}

// --- focused mode: /ws/pane/{id} (raw PTY binary, xterm.js-ready) -----------

async fn pane_raw_loop(socket: WebSocket, bridge: Bridge, pane: String) {
    let (mut tx, mut rx) = socket.split();
    if !send_text(&mut tx, hello("focused")).await {
        return;
    }

    // Resolve the pane prefix → (uid, meta json, boot seed bytes) under one lock.
    let resolved = {
        let sessions = bridge.sessions().await;
        sessions
            .iter()
            .find(|(uid, _)| uid.as_str() == pane.as_str() || uid.starts_with(pane.as_str()))
            .map(|(uid, s)| {
                let title = if s.title.is_empty() { s.shell_name.clone() } else { s.title.clone() };
                (
                    uid.clone(),
                    json!({"t":"meta","paneId":uid,"title":title,"cols":s.cols,"rows":s.rows,"state":s.shell_state,"cwd":s.cwd}).to_string(),
                    s.screen.contents_formatted(),
                    s.cols,
                    s.rows,
                )
            })
    };
    let (uid, meta, seed, mut last_cols, mut last_rows) = match resolved {
        Some(v) => v,
        None => {
            let _ = send_text(&mut tx, json!({"t":"error","code":"no-such-pane","message":pane}).to_string()).await;
            return;
        }
    };

    if !send_text(&mut tx, meta).await {
        return;
    }
    // Boot: text snapshot (compat fallback) + a BINARY seed that reproduces the
    // current screen for a fresh xterm.js, then `replay-end`.
    let text = bridge.get_screen_text_by_uid(&uid).await;
    let _ = send_text(&mut tx, json!({"t":"screen-snapshot","paneId":uid,"text":text}).to_string()).await;
    if !seed.is_empty() && tx.send(Message::Binary(seed.into())).await.is_err() {
        return;
    }
    let _ = send_text(&mut tx, r#"{"t":"replay-end"}"#.to_string()).await;

    // Live raw PTY bytes as binary frames.
    let mut out = bridge.subscribe_output(&uid).await;
    let mut hb = tokio::time::interval(HEARTBEAT);
    hb.tick().await;
    // Resize is OUT-OF-BAND (not encoded in the PTY byte stream), so the viewer
    // can't infer it — poll the pane's dims and emit an explicit {t:"resize"}
    // control frame when they change so the client can reflow its VT/monitor.
    let mut dims_ticker = tokio::time::interval(Duration::from_millis(200));
    dims_ticker.tick().await;
    loop {
        tokio::select! {
            chunk = out.recv() => {
                match chunk {
                    Some(bytes) => { if tx.send(Message::Binary(bytes.into())).await.is_err() { break; } }
                    None => break, // pane gone
                }
            }
            _ = dims_ticker.tick() => {
                let dims = {
                    let sessions = bridge.sessions().await;
                    sessions.get(&uid).map(|s| (s.cols, s.rows))
                };
                if let Some((cols, rows)) = dims {
                    if cols != last_cols || rows != last_rows {
                        last_cols = cols;
                        last_rows = rows;
                        let _ = send_text(&mut tx, json!({"t":"resize","paneId":uid,"cols":cols,"rows":rows}).to_string()).await;
                    }
                }
            }
            _ = hb.tick() => {
                if !send_text(&mut tx, r#"{"t":"ping"}"#.to_string()).await { break; }
            }
            msg = rx.next() => {
                match msg {
                    // INPUT: the human typing in the 3D viewer. Keystrokes arrive as
                    // BINARY frames (UTF-8 of xterm's onData) and go straight to the
                    // pane's PTY. Direct write (no agent-consent gate) — this is the
                    // human at the keyboard, not an agent.
                    Some(Ok(Message::Binary(keys))) => {
                        if let Ok(s) = String::from_utf8(keys.to_vec()) {
                            if !s.is_empty() {
                                let _ = bridge
                                    .send_command(json!({"type": "Keys", "uid": uid, "keys": s}))
                                    .await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {} // Text frames reserved for future control (pong, etc.)
                }
            }
        }
    }
}

// --- axum handlers ---------------------------------------------------------

pub async fn wall_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<crate::AppState>,
) -> impl IntoResponse {
    let bridge = state.bridge;
    let fps = fps_from(&params);
    ws.on_upgrade(move |socket| wall_loop(socket, bridge, fps))
}

pub async fn pane_handler(
    ws: WebSocketUpgrade,
    Path(pane): Path<String>,
    State(state): State<crate::AppState>,
) -> impl IntoResponse {
    let bridge = state.bridge;
    ws.on_upgrade(move |socket| pane_raw_loop(socket, bridge, pane))
}

// --- pixel mode: /ws/pixels/{id} (rendered frames — for WEB panes) ----------
//
// Web panes have no PTY, so the only way to put one on a 3D monitor is its
// rendered pixels. Pull-based: only while a client is watching, Electron
// captures the pane at the CLIENT-REQUESTED w×h (no wasted pixels — the size is
// the efficiency lever) and returns a JPEG; we ship it as a binary frame and
// skip byte-identical frames (static pages cost ~nothing). The frame is flat /
// front-facing — the 3D scene applies the monitor's tilt via texture mapping.

pub async fn pixels_handler(
    ws: WebSocketUpgrade,
    Path(pane): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<crate::AppState>,
) -> impl IntoResponse {
    let bridge = state.bridge;
    let w: u32 = params.get("w").and_then(|s| s.parse().ok()).unwrap_or(640).clamp(16, 4096);
    let h: u32 = params.get("h").and_then(|s| s.parse().ok()).unwrap_or(400).clamp(16, 4096);
    let fps = fps_from(&params);
    ws.on_upgrade(move |socket| pixels_loop(socket, bridge, pane, w, h, fps))
}

async fn pixels_loop(socket: WebSocket, bridge: Bridge, pane: String, w: u32, h: u32, fps: u64) {
    let (mut tx, mut rx) = socket.split();
    if !send_text(&mut tx, hello("pixels")).await {
        return;
    }
    // Resolve to a full uid (web panes ARE in the session map as shell:"web").
    let uid = {
        let sessions = bridge.sessions().await;
        sessions
            .iter()
            .find(|(u, _)| u.as_str() == pane.as_str() || u.starts_with(pane.as_str()))
            .map(|(u, _)| u.clone())
            .unwrap_or_else(|| pane.clone())
    };
    let _ = send_text(&mut tx, json!({"t":"meta","paneId":uid,"w":w,"h":h,"fps":fps,"format":"jpeg"}).to_string()).await;

    let mut ticker = tokio::time::interval(Duration::from_millis(1000 / fps));
    let mut hb = tokio::time::interval(HEARTBEAT);
    hb.tick().await;
    let mut last_hash: u64 = 0;
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let resp = bridge
                    .send_command(json!({"type":"CapturePane","uid":uid,"w":w,"h":h,"quality":60}))
                    .await;
                if let Ok(b64) = resp {
                    if !b64.is_empty() {
                        if let Ok(bytes) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64) {
                            let mut hasher = std::collections::hash_map::DefaultHasher::new();
                            hasher.write(&bytes);
                            let hash = hasher.finish();
                            if hash != last_hash {
                                last_hash = hash;
                                if tx.send(Message::Binary(bytes.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            _ = hb.tick() => {
                if !send_text(&mut tx, r#"{"t":"ping"}"#.to_string()).await { break; }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
}

// --- tab mode: /ws/tab/{tabId} (layout manifest + multiplexed pane streams) --
//
// A tab is a BSP layout of panes (terminals AND web panes). We stream the
// COMPOSITION: a `tab-layout` manifest (pane rects + types) plus each pane's own
// stream multiplexed on ONE socket, tagged by paneId — terminals as the wall's
// colorized frame/delta (crisp text, cheap), web panes as JPEG pixels. The 3D
// client places every pane in its rect on one monitor. Terminals stream from the
// vt100 mirror regardless of tab visibility; a BACKGROUND tab's web panes may be
// stale (only the active tab is painted).

/// One pane's layout descriptor for the `tab-layout` manifest. Terminals carry
/// grid dims; web panes carry the derived capture px size.
struct TabPane {
    uid: String,
    is_web: bool,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    cols: u16,
    rows: u16,
    /// Stable friendly codename ("Brave Skink 🥐") — layout-stable, never
    /// shadowed by OSC titles. Label monitors with THIS.
    name: String,
    /// Volatile display title (OSC title, falls back to the codename).
    title: String,
    state: String,
}

fn tab_pane_json(p: &TabPane, tab_w: u32, tab_h: u32) -> serde_json::Value {
    if p.is_web {
        let px = (((p.w as f64) / 100.0) * tab_w as f64).round().max(16.0) as u32;
        let py = (((p.h as f64) / 100.0) * tab_h as f64).round().max(16.0) as u32;
        json!({"paneId":p.uid,"type":"web","x":p.x,"y":p.y,"w":p.w,"h":p.h,"px":px,"py":py,"name":p.name,"title":p.title,"state":p.state})
    } else {
        json!({"paneId":p.uid,"type":"terminal","x":p.x,"y":p.y,"w":p.w,"h":p.h,"cols":p.cols,"rows":p.rows,"name":p.name,"title":p.title,"state":p.state})
    }
}

/// Stable hash of the layout (pane set + rects + dims + type) so we re-emit the
/// manifest only when the split actually changes, not every frame.
fn layout_hash(panes: &[TabPane]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for p in panes {
        h.write(p.uid.as_bytes());
        h.write_u8(p.is_web as u8);
        h.write_i32((p.x * 100.0) as i32);
        h.write_i32((p.y * 100.0) as i32);
        h.write_i32((p.w * 100.0) as i32);
        h.write_i32((p.h * 100.0) as i32);
        h.write_u16(p.cols);
        h.write_u16(p.rows);
    }
    h.finish()
}

pub async fn tab_handler(
    ws: WebSocketUpgrade,
    Path(tab): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<crate::AppState>,
) -> impl IntoResponse {
    let bridge = state.bridge;
    let fps = fps_from(&params);
    let w: u32 = params.get("w").and_then(|s| s.parse().ok()).unwrap_or(1920).clamp(16, 7680);
    let h: u32 = params.get("h").and_then(|s| s.parse().ok()).unwrap_or(1080).clamp(16, 4320);
    ws.on_upgrade(move |socket| tab_loop(socket, bridge, tab, fps, w, h))
}

async fn tab_loop(socket: WebSocket, bridge: Bridge, tab_key: String, fps: u64, tab_w: u32, tab_h: u32) {
    let (mut tx, mut rx) = socket.split();
    if !send_text(&mut tx, hello("tab")).await {
        return;
    }

    // Resolve the tab key → canonical rootTabUid (accept full/prefix uid or name).
    let tab_uid = {
        let sessions = bridge.sessions().await;
        sessions
            .values()
            .find(|s| {
                s.root_tab_uid == tab_key
                    || s.root_tab_uid.starts_with(tab_key.as_str())
                    || s.tab_name == tab_key
            })
            .map(|s| s.root_tab_uid.clone())
    };
    let tab_uid = match tab_uid {
        Some(v) => v,
        None => {
            let _ = send_text(&mut tx, json!({"t":"error","code":"no-such-tab","message":tab_key}).to_string()).await;
            return;
        }
    };

    let mut cache: HashMap<String, CacheEntry> = HashMap::new();
    let mut web_hashes: HashMap<String, u64> = HashMap::new();
    let mut last_layout: u64 = 0;
    let mut ticker = tokio::time::interval(Duration::from_millis(1000 / fps));
    let mut hb = tokio::time::interval(HEARTBEAT);
    hb.tick().await;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                // Snapshot the tab under the lock: build the pane manifest, dump
                // terminals that changed, collect web capture targets. Release the
                // lock BEFORE any send / CapturePane (which is an async round-trip).
                #[allow(clippy::type_complexity)]
                let (mut panes, term_updates, web_targets, live, tab_name, window_id):
                    (Vec<TabPane>, Vec<(String, ScreenDump, Option<Instant>, bool)>, Vec<(String, u32, u32)>, HashSet<String>, String, u32) = {
                    let sessions = bridge.sessions().await;
                    let mut panes = Vec::new();
                    let mut term_updates = Vec::new();
                    let mut web_targets = Vec::new();
                    let mut live = HashSet::new();
                    let mut tab_name = String::new();
                    let mut window_id = 0u32;
                    for (uid, s) in sessions.iter() {
                        if s.root_tab_uid != tab_uid {
                            continue;
                        }
                        if tab_name.is_empty() {
                            tab_name = s.tab_name.clone();
                            window_id = s.window_id;
                        }
                        live.insert(uid.clone());
                        let is_web = s.name == "web" || s.name == "ai";
                        panes.push(TabPane {
                            uid: uid.clone(),
                            is_web,
                            x: s.bsp_x, y: s.bsp_y, w: s.bsp_w, h: s.bsp_h,
                            cols: s.cols, rows: s.rows,
                            name: s.shell_name.clone(),
                            title: if s.title.is_empty() { s.shell_name.clone() } else { s.title.clone() },
                            state: s.shell_state.clone(),
                        });
                        if is_web {
                            let px = (((s.bsp_w as f64) / 100.0) * tab_w as f64).round().max(16.0) as u32;
                            let py = (((s.bsp_h as f64) / 100.0) * tab_h as f64).round().max(16.0) as u32;
                            web_targets.push((uid.clone(), px, py));
                        } else {
                            let need = match cache.get(uid) {
                                None => true,
                                Some(c) => s.last_output_at != c.last_output || s.rows != c.rows || s.cols != c.cols,
                            };
                            if need {
                                let is_key = cache.get(uid).map(|c| c.rows != s.rows || c.cols != s.cols).unwrap_or(true);
                                term_updates.push((uid.clone(), s.screen.screen_dump(), s.last_output_at, is_key));
                            }
                        }
                    }
                    (panes, term_updates, web_targets, live, tab_name, window_id)
                };

                if panes.is_empty() {
                    let _ = send_text(&mut tx, json!({"t":"bye","reason":"tab-closed"}).to_string()).await;
                    break;
                }
                cache.retain(|k, _| live.contains(k));
                web_hashes.retain(|k, _| live.contains(k));

                // Layout change → re-emit the manifest (paneId-sorted for a stable hash).
                panes.sort_by(|a, b| a.uid.cmp(&b.uid));
                let lh = layout_hash(&panes);
                if lh != last_layout {
                    last_layout = lh;
                    let pj: Vec<_> = panes.iter().map(|p| tab_pane_json(p, tab_w, tab_h)).collect();
                    if !send_text(&mut tx, json!({
                        "t":"tab-layout","v":PROTO_VERSION,"tabId":tab_uid,"tabName":tab_name,
                        "windowId":window_id,"w":tab_w,"h":tab_h,"panes":pj,
                    }).to_string()).await {
                        return;
                    }
                }

                // Terminal panes: keyframe (new/resized) or row deltas, tagged by paneId.
                for (uid, dump, last_output, is_key) in term_updates {
                    let ok = if is_key {
                        send_text(&mut tx, frame_json(&uid, &dump)).await
                    } else {
                        let changed = changed_rows(&dump, &cache[&uid].dump);
                        if changed.is_empty() { true } else { send_text(&mut tx, delta_json(&uid, &dump, &changed)).await }
                    };
                    if !ok {
                        return;
                    }
                    cache.insert(uid, CacheEntry { last_output, rows: dump.rows, cols: dump.cols, dump });
                }

                // Web panes: capture at the rect-derived size, skip byte-identical frames.
                for (uid, px, py) in web_targets {
                    let resp = bridge
                        .send_command(json!({"type":"CapturePane","uid":uid,"w":px,"h":py,"quality":60}))
                        .await;
                    if let Ok(b64) = resp {
                        if !b64.is_empty() {
                            let mut hasher = std::collections::hash_map::DefaultHasher::new();
                            hasher.write(b64.as_bytes());
                            let hash = hasher.finish();
                            if web_hashes.get(&uid) != Some(&hash) {
                                web_hashes.insert(uid.clone(), hash);
                                if !send_text(&mut tx, json!({"t":"pixels","paneId":uid,"jpeg":b64}).to_string()).await {
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            _ = hb.tick() => {
                if !send_text(&mut tx, r#"{"t":"ping"}"#.to_string()).await { break; }
            }
            msg = rx.next() => {
                match msg {
                    // INPUT: {t:"input", paneId, keys} → the named pane's PTY (human
                    // input). A tab carries many panes, so input MUST name its target.
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                            if v["t"] == "input" {
                                if let (Some(pid), Some(keys)) = (v["paneId"].as_str(), v["keys"].as_str()) {
                                    if !keys.is_empty() {
                                        let full = {
                                            let sessions = bridge.sessions().await;
                                            sessions.keys().find(|u| u.as_str() == pid || u.starts_with(pid)).cloned()
                                        };
                                        if let Some(uid) = full {
                                            let _ = bridge.send_command(json!({"type":"Keys","uid":uid,"keys":keys})).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
}
