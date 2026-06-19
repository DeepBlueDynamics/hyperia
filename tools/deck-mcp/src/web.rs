use axum::{
    extract::{State, ws::{WebSocket, WebSocketUpgrade, Message}},
    response::{Html, IntoResponse},
    routing::{get, post},
    Router, Json,
};
use std::sync::Arc;
use crate::{AppState, TouchBarItem, device::StreamDeckEvent};
use futures::{sink::SinkExt, stream::StreamExt};
use serde_json::Value;

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index_handler))
        .route("/mcp", post(mcp_handler))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

async fn index_handler() -> Html<&'static str> {
    Html(include_str!("index.html"))
}

async fn mcp_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let res = crate::mcp::handle_mcp_request(payload, state).await;
    Json(res)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.event_tx.subscribe();

    // Spawn task to push state changes to this socket
    let push_task = tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            let msg_text = match serde_json::to_string(&event) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if sender.send(Message::Text(msg_text)).await.is_err() {
                break;
            }
        }
    });

    // Receive control messages from the browser (e.g. trigger actions)
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(val) = serde_json::from_str::<Value>(&text) {
                if let Some(action) = val.get("action").and_then(|a| a.as_str()) {
                    match action {
                        "sync" => {
                            let _ = crate::sync_panes_internal(Arc::clone(&state)).await;
                        }
                        "set_brightness" => {
                            if let Some(b) = val.get("brightness").and_then(|v| v.as_u64()) {
                                if let Some(ref d) = *state.device.lock().unwrap() {
                                    let _ = d.set_brightness(b as u8);
                                }
                            }
                        }
                        "focus_pane" => {
                            if let Some(pane_id) = val.get("pane_id").and_then(|s| s.as_str()) {
                                 *state.last_focused_pane.lock().unwrap() = Some((pane_id.to_string(), std::time::Instant::now()));
                                 let client = crate::hyperia::HyperiaClient::new();
                                 let _ = client.focus_pane(pane_id, None, None).await;
                                 let _ = crate::sync_panes_internal(Arc::clone(&state)).await;
                            }
                        }
                        "run_command" => {
                            if let Some(pane_id) = val.get("pane_id").and_then(|s| s.as_str()) {
                                if let Some(command) = val.get("command").and_then(|s| s.as_str()) {
                                    let client = crate::hyperia::HyperiaClient::new();
                                    let _ = client.run_command(pane_id, command).await;
                                }
                            }
                        }
                        "dial_rotate" => {
                            if let Some(dial) = val.get("dial").and_then(|v| v.as_u64()) {
                                if let Some(delta) = val.get("delta").and_then(|v| v.as_i64()) {
                                    let _ = state.event_tx.send(StreamDeckEvent::DialRotate {
                                        dial: dial as u8,
                                        delta: delta as i8,
                                    });
                                }
                            }
                        }
                        "button_press" => {
                            if let Some(key) = val.get("key").and_then(|v| v.as_u64()) {
                                if let Some(pressed) = val.get("pressed").and_then(|v| v.as_bool()) {
                                    let _ = state.event_tx.send(StreamDeckEvent::ButtonPress {
                                        key: key as u8,
                                        pressed,
                                    });
                                }
                            }
                        }
                        "dial_press" => {
                            if let Some(dial) = val.get("dial").and_then(|v| v.as_u64()) {
                                if let Some(pressed) = val.get("pressed").and_then(|v| v.as_bool()) {
                                    let _ = state.event_tx.send(StreamDeckEvent::DialPress {
                                        dial: dial as u8,
                                        pressed,
                                    });
                                }
                            }
                        }
                        "touch_tap" => {
                            if let Some(col) = val.get("col").and_then(|v| v.as_u64()) {
                                let col = col as usize;
                                let tapped_item = {
                                    let s = state.status.lock().unwrap();
                                    s.active_panes.get(col).cloned()
                                };
                                if let Some(item) = tapped_item {
                                    let state_clone = Arc::clone(&state);
                                    tokio::spawn(async move {
                                        let client = crate::hyperia::HyperiaClient::new();
                                        match item {
                                            TouchBarItem::Pane(pane) => {
                                                // Update local focus state immediately!
                                                {
                                                    let mut items = state_clone.all_items.lock().unwrap();
                                                    for it in items.iter_mut() {
                                                        if let TouchBarItem::Pane(ref mut p) = it {
                                                            p.focused = p.pane_id == pane.pane_id;
                                                        }
                                                    }
                                                    let offset = *state_clone.pane_scroll_offset.lock().unwrap();
                                                    let displayed: Vec<TouchBarItem> = items.iter().skip(offset).take(4).cloned().collect();
                                                    state_clone.status.lock().unwrap().active_panes = displayed;
                                                }
                                                *state_clone.last_focused_pane.lock().unwrap() = Some((pane.pane_id.clone(), std::time::Instant::now()));
                                                if let Some(ref t_name) = pane.tab_name {
                                                    *state_clone.selected_tab_name.lock().unwrap() = Some(t_name.clone());
                                                }
                                                if let Ok(_) = client.focus_pane(&pane.pane_id, pane.tab_name.as_deref(), pane.window_id).await.map_err(|e| e.to_string()) {
                                                    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                                                    let _ = crate::sync_panes_internal(state_clone).await;
                                                }
                                            }
                                            TouchBarItem::AddPane => {
                                                let focused_pane_id = {
                                                    let items = state_clone.all_items.lock().unwrap();
                                                    items.iter().find_map(|item| {
                                                        if let TouchBarItem::Pane(ref p) = item {
                                                            if p.focused {
                                                                return Some(p.pane_id.clone());
                                                            }
                                                        }
                                                        None
                                                    })
                                                };
                                                if let Some(pid) = focused_pane_id {
                                                    let profile = val.get("profile").and_then(|p| p.as_str());
                                                    let url = val.get("url").and_then(|u| u.as_str());
                                                    if let Ok(_) = client.split_pane(&pid, profile, url).await.map_err(|e| e.to_string()) {
                                                        let _ = crate::sync_panes_internal(state_clone).await;
                                                    }
                                                }
                                            }
                                            TouchBarItem::AddTab => {
                                                if let Ok(_) = client.new_tab().await.map_err(|e| e.to_string()) {
                                                    *state_clone.pane_scroll_offset.lock().unwrap() = 0;
                                                    let _ = crate::sync_panes_internal(state_clone).await;
                                                }
                                            }
                                        }
                                    });
                                }
                            }
                        }
                        "touch_swipe" => {
                            if let Some(start_x) = val.get("start_x").and_then(|v| v.as_i64()) {
                                if let Some(end_x) = val.get("end_x").and_then(|v| v.as_i64()) {
                                    let _ = state.event_tx.send(StreamDeckEvent::TouchSwipe {
                                        start_x: start_x as u16,
                                        start_y: 0,
                                        end_x: end_x as u16,
                                        end_y: 0,
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    push_task.abort();
}
