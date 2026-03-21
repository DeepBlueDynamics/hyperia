#[allow(dead_code)]
pub mod agent;
pub mod config;
#[allow(dead_code)]
pub mod device;
#[allow(dead_code)]
pub mod device_actor;
pub mod http;
#[allow(dead_code)]
pub mod mcp;
#[allow(dead_code)]
pub mod screenshot;
pub mod state;
pub mod ticker;
pub mod visuals;

use device_actor::{ActorConfig, DeviceHandle};
use state::DeviceInfo;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// Everything needed to interact with the Stream Deck from the terminal.
#[allow(dead_code)]
pub struct DeckHandle {
    pub device: DeviceHandle,
    pub state: state::SharedState,
}

/// Initialize Stream Deck Plus: connect, boot sequence, spawn actor + agent + HTTP.
/// Returns None if no device found (non-fatal).
pub async fn init_deck(deck_port: u16) -> Result<DeckHandle, String> {
    let cfg = config::Config::load();
    tracing::info!(port = cfg.http_port, brightness = cfg.brightness, "Deck init starting");

    // Connect to device
    let (deck, caps) = device::connect_plus(None)?;
    tracing::info!(serial = %caps.serial, firmware = %caps.firmware, "Connected to Stream Deck Plus");

    // Boot sequence (matrix rain + branding)
    let (branded_buttons, branded_strip) = visuals::run_boot_sequence(&deck, &cfg);
    tracing::info!("Boot sequence complete");

    // Set brightness
    deck.set_brightness(cfg.brightness).map_err(|e| format!("{e}"))?;

    // Shared state
    let shared_state = state::new_shared_state();
    {
        let mut st = shared_state.lock().await;
        st.device_info = Some(DeviceInfo {
            kind: caps.kind.clone(),
            serial: caps.serial.clone(),
            firmware: caps.firmware.clone(),
            manufacturer: caps.manufacturer.clone(),
            product: caps.product.clone(),
        });
        st.brightness = cfg.brightness;
        for (i, img) in branded_buttons.iter().enumerate() {
            st.button_images[i] = Some(img.clone());
        }
        st.touchstrip_image = Some(branded_strip.clone());
    }

    // Spawn device actor
    let actor_config = ActorConfig {
        glitch: cfg.glitch.clone(),
        button_actions: cfg.buttons.iter().map(|b| b.action.clone()).collect(),
        button_commands: cfg.buttons.iter().map(|b| b.command.clone()).collect(),
        base_button_images: branded_buttons,
        base_touchstrip: branded_strip,
        ticker_active: Arc::new(AtomicBool::new(false)),
    };
    let device_handle = device_actor::spawn_device_actor(deck, shared_state.clone(), actor_config);

    // Spawn Claude agent if enabled
    if cfg.agent.enabled {
        let button_labels: Vec<String> = cfg.buttons.iter().map(|b| b.label.clone()).collect();
        agent::spawn_agent(cfg.agent.clone(), device_handle.clone(), shared_state.clone(), button_labels);
        tracing::info!("Claude agent spawned");
    }

    // Spawn deck HTTP server
    let http_port = if deck_port > 0 { deck_port } else { cfg.http_port };
    let http_state = shared_state.clone();
    let http_device = device_handle.clone();
    tokio::spawn(async move {
        let app = http::router(http_state, http_device);
        let addr = std::net::SocketAddr::from(([0, 0, 0, 0], http_port));
        tracing::info!(%addr, "Deck HTTP server listening");
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });

    // No alert pulse — deck is ready immediately

    // Subscribe to button events and execute actions against the sidecar API
    let sidecar_port = if deck_port > 0 { 9800_u16 } else { 9800 };
    let mut event_rx = device_handle.subscribe();
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{}", sidecar_port);
        loop {
            match event_rx.recv().await {
                Ok(device_actor::DeviceEvent::ButtonPressed { action, command, .. }) => {
                    tracing::info!(action = %action, "Deck button action");
                    match action.as_str() {
                        "command" => {
                            if let Some(cmd) = command {
                                // Single call: open new tab with startup command
                                let _ = client.post(format!("{}/api/pane/new", base))
                                    .json(&serde_json::json!({"command": cmd}))
                                    .send().await;
                            }
                        }
                        "voice_toggle" => {
                            let resp = client.post(format!("{}/api/voice/toggle", base))
                                .send().await;
                            match resp {
                                Ok(r) => {
                                    let text = r.text().await.unwrap_or_default();
                                    tracing::info!("Voice toggle: {text}");
                                }
                                Err(e) => tracing::warn!("Voice toggle failed: {e}"),
                            }
                        }
                        "screenshot" => {
                            tracing::info!("Screenshot action triggered");
                        }
                        "status" => {
                            tracing::info!("Status action triggered");
                        }
                        _ => {
                            tracing::info!(action = %action, "Unhandled deck action");
                        }
                    }
                }
                Ok(device_actor::DeviceEvent::EncoderTwist { encoder: 0, delta }) => {
                    // First encoder knob selects tabs — twist right = next, left = prev
                    if let Ok(resp) = client.get(format!("{}/api/status", base)).send().await {
                        if let Ok(status) = resp.json::<serde_json::Value>().await {
                            if let Some(panes) = status["panes"].as_array() {
                                if !panes.is_empty() {
                                    // Find which pane to focus
                                    // delta > 0 = clockwise = next tab, delta < 0 = prev
                                    let count = panes.len() as i64;
                                    let target = if delta > 0 {
                                        // Just focus next pane (wraps via modulo)
                                        // We don't know current focus, so use a simple approach
                                        -1i64 // sentinel
                                    } else {
                                        -2i64
                                    };
                                    let _ = target; // unused, use keyboard shortcut instead

                                    // Send Ctrl+Tab (next) or Ctrl+Shift+Tab (prev) via type endpoint
                                    // Actually, use the focus API with pane cycling
                                    // Simpler: just send the keyboard shortcut to Electron
                                    // Even simpler: use the focus endpoint
                                    // We need current focused pane — not available from status.
                                    // Best approach: cycle through panes
                                    static CURRENT_PANE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
                                    let current = CURRENT_PANE.load(std::sync::atomic::Ordering::Relaxed);
                                    let next = if delta > 0 {
                                        (current + 1) % panes.len()
                                    } else {
                                        if current == 0 { panes.len() - 1 } else { current - 1 }
                                    };
                                    CURRENT_PANE.store(next, std::sync::atomic::Ordering::Relaxed);

                                    let body = serde_json::json!({"id": next});
                                    let _ = client.post(format!("{}/api/pane/focus", base))
                                        .json(&body)
                                        .send().await;
                                    tracing::info!(pane = next, "Encoder switched to pane");
                                }
                            }
                        }
                    }
                }
                Ok(_) => {} // other encoders, touch
                Err(_) => break,
            }
        }
    });

    Ok(DeckHandle {
        device: device_handle,
        state: shared_state,
    })
}
