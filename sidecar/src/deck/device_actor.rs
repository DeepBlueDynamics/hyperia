use elgato_streamdeck::images::ImageRect;
use elgato_streamdeck::{StreamDeck, StreamDeckInput};
use image::{DynamicImage, Rgb, RgbImage};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, oneshot};

use super::config::GlitchConfig;
use super::state::SharedState;
use super::visuals;

/// Commands sent to the device actor thread.
pub enum DeviceCmd {
    SetBrightness(u8, oneshot::Sender<Result<(), String>>),
    SetButtonImage(u8, DynamicImage, oneshot::Sender<Result<(), String>>),
    ClearButton(Option<u8>, oneshot::Sender<Result<(), String>>),
    SetTouchstripImage(DynamicImage, oneshot::Sender<Result<(), String>>),
    Reset(oneshot::Sender<Result<(), String>>),
    SetAlert(u8, [u8; 3], u64, oneshot::Sender<Result<(), String>>),
    ClearAlert(u8, oneshot::Sender<Result<(), String>>),
}

/// Events broadcast from the device (buttons, encoders, touch).
#[derive(Debug, Clone)]
pub enum DeviceEvent {
    ButtonPressed { key: u8, action: String, command: Option<String> },
    EncoderTwist { encoder: u8, delta: i8 },
    EncoderPressed { encoder: u8 },
    TouchPress { x: u16, y: u16 },
    TouchSwipe { from: (u16, u16), to: (u16, u16) },
}

/// Configuration passed to the device actor.
pub struct ActorConfig {
    pub glitch: GlitchConfig,
    pub button_actions: Vec<String>,
    pub button_commands: Vec<Option<String>>,
    pub base_button_images: Vec<DynamicImage>,
    pub base_touchstrip: DynamicImage,
    pub ticker_active: Arc<AtomicBool>,
}

struct ActiveAlert {
    color: [u8; 3],
    period_ms: u64,
    alert_img: DynamicImage,
    last_toggle: Instant,
    showing_alert: bool,
}

impl ActiveAlert {
    fn new(base: &DynamicImage, color: [u8; 3], period_ms: u64) -> Self {
        let base_rgb = base.to_rgb8();
        let mut blended = RgbImage::new(120, 120);
        for y in 0..120u32 {
            for x in 0..120u32 {
                let p = base_rgb.get_pixel(x, y);
                blended.put_pixel(x, y, Rgb([
                    (p[0] as f32 * 0.4 + color[0] as f32 * 0.6) as u8,
                    (p[1] as f32 * 0.4 + color[1] as f32 * 0.6) as u8,
                    (p[2] as f32 * 0.4 + color[2] as f32 * 0.6) as u8,
                ]));
            }
        }
        Self {
            color,
            period_ms,
            alert_img: DynamicImage::ImageRgb8(blended),
            last_toggle: Instant::now(),
            showing_alert: false,
        }
    }
}

/// Handle for sending commands to the device actor. This is Send + Sync.
#[derive(Clone)]
pub struct DeviceHandle {
    cmd_tx: mpsc::Sender<DeviceCmd>,
    event_tx: broadcast::Sender<DeviceEvent>,
}

impl DeviceHandle {
    pub async fn set_brightness(&self, pct: u8) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(DeviceCmd::SetBrightness(pct, tx)).await.map_err(|_| "device gone".to_string())?;
        rx.await.map_err(|_| "device gone".to_string())?
    }

    pub async fn set_button_image(&self, key: u8, img: DynamicImage) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(DeviceCmd::SetButtonImage(key, img, tx)).await.map_err(|_| "device gone".to_string())?;
        rx.await.map_err(|_| "device gone".to_string())?
    }

    pub async fn clear_button(&self, key: Option<u8>) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(DeviceCmd::ClearButton(key, tx)).await.map_err(|_| "device gone".to_string())?;
        rx.await.map_err(|_| "device gone".to_string())?
    }

    pub async fn set_touchstrip_image(&self, img: DynamicImage) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(DeviceCmd::SetTouchstripImage(img, tx)).await.map_err(|_| "device gone".to_string())?;
        rx.await.map_err(|_| "device gone".to_string())?
    }

    pub async fn reset(&self) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(DeviceCmd::Reset(tx)).await.map_err(|_| "device gone".to_string())?;
        rx.await.map_err(|_| "device gone".to_string())?
    }

    pub async fn set_alert(&self, key: u8, color: [u8; 3], period_ms: u64) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(DeviceCmd::SetAlert(key, color, period_ms, tx)).await.map_err(|_| "device gone".to_string())?;
        rx.await.map_err(|_| "device gone".to_string())?
    }

    pub async fn clear_alert(&self, key: u8) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx.send(DeviceCmd::ClearAlert(key, tx)).await.map_err(|_| "device gone".to_string())?;
        rx.await.map_err(|_| "device gone".to_string())?
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DeviceEvent> {
        self.event_tx.subscribe()
    }
}

/// Spawn the device actor. Returns a handle for sending commands.
pub fn spawn_device_actor(deck: StreamDeck, state: SharedState, actor_config: ActorConfig) -> DeviceHandle {
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<DeviceCmd>(64);
    let (event_tx, _) = broadcast::channel::<DeviceEvent>(32);
    let event_tx_clone = event_tx.clone();
    let rt = tokio::runtime::Handle::current();

    std::thread::spawn(move || {
        let mut prev_pressed = [false; 8];
        let mut glitch_frame: u64 = 0;
        let mut alerts: [Option<ActiveAlert>; 8] = Default::default();

        let glitch_enabled = actor_config.glitch.enabled;
        let glitch_min = actor_config.glitch.min_interval_ms;
        let glitch_max = actor_config.glitch.max_interval_ms;
        let glitch_intensity = actor_config.glitch.intensity;
        let glitch_range = if glitch_max > glitch_min { glitch_max - glitch_min } else { 1 };

        let mut next_glitch = if glitch_enabled {
            Instant::now() + Duration::from_millis(
                glitch_min + (visuals::prand(0, 99) as u64 % glitch_range)
            )
        } else {
            Instant::now() + Duration::from_secs(999_999)
        };
        let mut glitch_restore_at: Option<Instant> = None;

        let ticker_active = actor_config.ticker_active;
        let base_buttons = actor_config.base_button_images;
        let base_strip = actor_config.base_touchstrip;
        let button_actions = actor_config.button_actions;
        let button_commands = actor_config.button_commands;

        loop {
            while let Ok(cmd) = cmd_rx.try_recv() {
                process_command(&deck, &state, &rt, cmd, &base_buttons, &mut alerts);
            }

            match deck.read_input(Some(Duration::from_millis(50))) {
                Ok(input) => {
                    if !matches!(input, StreamDeckInput::NoData) {
                        if let StreamDeckInput::ButtonStateChange(ref states) = input {
                            for (i, &pressed) in states.iter().enumerate() {
                                if i < 8 && pressed && !prev_pressed[i] {
                                    if alerts[i].is_some() {
                                        alerts[i] = None;
                                        deck.set_button_image(i as u8, base_buttons[i].clone()).ok();
                                        deck.flush().ok();
                                        tracing::info!(key = i, "Alert cleared by press");
                                    }
                                    if let Some(action) = button_actions.get(i) {
                                        let cmd = button_commands.get(i).and_then(|c| c.clone());
                                        let _ = event_tx_clone.send(DeviceEvent::ButtonPressed {
                                            key: i as u8,
                                            action: action.clone(),
                                            command: cmd,
                                        });
                                        tracing::info!(key = i, action = %action, "Button pressed");
                                    }
                                }
                                if i < 8 {
                                    prev_pressed[i] = pressed;
                                }
                            }
                        }
                        process_input(&state, &rt, input, &event_tx_clone);
                    }
                }
                Err(e) => {
                    tracing::warn!("HID read error: {e}");
                    std::thread::sleep(Duration::from_millis(200));
                }
            }

            // Alert flash updates
            let now = Instant::now();
            for i in 0..8 {
                if let Some(ref mut alert) = alerts[i] {
                    let half_period = Duration::from_millis(alert.period_ms / 2);
                    if now.duration_since(alert.last_toggle) >= half_period {
                        alert.showing_alert = !alert.showing_alert;
                        alert.last_toggle = now;
                        if alert.showing_alert {
                            deck.set_button_image(i as u8, alert.alert_img.clone()).ok();
                        } else {
                            deck.set_button_image(i as u8, base_buttons[i].clone()).ok();
                        }
                        deck.flush().ok();
                    }
                }
            }

            // Glitch check
            let has_alerts = alerts.iter().any(|a| a.is_some());
            if !has_alerts {
                if let Some(restore_at) = glitch_restore_at {
                    if now >= restore_at {
                        if let Ok(rect) = ImageRect::from_image(base_strip.clone()) {
                            deck.write_lcd(0, 0, &rect).ok();
                        }
                        glitch_restore_at = None;
                    }
                } else if glitch_enabled && now >= next_glitch {
                    glitch_frame += 1;
                    let strip_rgb = base_strip.to_rgb8();
                    let glitched_strip = visuals::glitch_image(&strip_rgb, glitch_intensity, glitch_frame);
                    if let Ok(rect) = ImageRect::from_image(DynamicImage::ImageRgb8(glitched_strip)) {
                        deck.write_lcd(0, 0, &rect).ok();
                    }
                    glitch_restore_at = Some(now + Duration::from_millis(
                        80 + (visuals::prand(glitch_frame, 32) as u64 % 200)
                    ));
                    let interval = glitch_min + (visuals::prand(glitch_frame, 33) as u64 % glitch_range);
                    next_glitch = now + Duration::from_millis(interval);
                }
            }

            match rt.block_on(async { tokio::time::timeout(Duration::from_millis(1), cmd_rx.recv()).await }) {
                Ok(Some(cmd)) => process_command(&deck, &state, &rt, cmd, &base_buttons, &mut alerts),
                Ok(None) => break,
                Err(_) => {}
            }
        }

        tracing::info!("Device actor exiting");
    });

    DeviceHandle { cmd_tx, event_tx }
}

fn process_command(
    deck: &StreamDeck,
    state: &SharedState,
    rt: &tokio::runtime::Handle,
    cmd: DeviceCmd,
    base_buttons: &[DynamicImage],
    alerts: &mut [Option<ActiveAlert>; 8],
) {
    match cmd {
        DeviceCmd::SetBrightness(pct, reply) => {
            let result = deck.set_brightness(pct).map_err(|e| e.to_string());
            if result.is_ok() {
                rt.block_on(async { state.lock().await.brightness = pct });
            }
            let _ = reply.send(result);
        }
        DeviceCmd::SetButtonImage(key, img, reply) => {
            let resized = img.resize_exact(120, 120, image::imageops::FilterType::Lanczos3);
            let result = deck.set_button_image(key, resized.clone())
                .and_then(|_| deck.flush())
                .map_err(|e| e.to_string());
            if result.is_ok() {
                rt.block_on(async {
                    state.lock().await.button_images[key as usize] = Some(resized);
                });
            }
            let _ = reply.send(result);
        }
        DeviceCmd::ClearButton(key, reply) => {
            let result = match key {
                Some(k) => {
                    let r = deck.clear_button_image(k).map_err(|e| e.to_string());
                    if r.is_ok() {
                        rt.block_on(async {
                            state.lock().await.button_images[k as usize] = None;
                        });
                    }
                    r
                }
                None => {
                    let r = deck.clear_all_button_images().map_err(|e| e.to_string());
                    if r.is_ok() {
                        rt.block_on(async {
                            let mut st = state.lock().await;
                            for img in st.button_images.iter_mut() {
                                *img = None;
                            }
                        });
                    }
                    r
                }
            };
            let _ = reply.send(result);
        }
        DeviceCmd::SetTouchstripImage(img, reply) => {
            let resized = img.resize_exact(800, 100, image::imageops::FilterType::Lanczos3);
            let result = (|| {
                let rect = ImageRect::from_image(resized.clone()).map_err(|e| e.to_string())?;
                deck.write_lcd(0, 0, &rect).map_err(|e| e.to_string())
            })();
            if result.is_ok() {
                rt.block_on(async {
                    state.lock().await.touchstrip_image = Some(resized);
                });
            }
            let _ = reply.send(result);
        }
        DeviceCmd::Reset(reply) => {
            let result = deck.reset().map_err(|e| e.to_string());
            if result.is_ok() {
                rt.block_on(async {
                    let mut st = state.lock().await;
                    for img in st.button_images.iter_mut() {
                        *img = None;
                    }
                    st.touchstrip_image = None;
                });
            }
            let _ = reply.send(result);
        }
        DeviceCmd::SetAlert(key, color, period_ms, reply) => {
            if (key as usize) < 8 {
                if let Some(base) = base_buttons.get(key as usize) {
                    alerts[key as usize] = Some(ActiveAlert::new(base, color, period_ms));
                    tracing::info!(key = key, r = color[0], g = color[1], b = color[2], period = period_ms, "Alert set");
                }
                let _ = reply.send(Ok(()));
            } else {
                let _ = reply.send(Err("key must be 0-7".to_string()));
            }
        }
        DeviceCmd::ClearAlert(key, reply) => {
            if (key as usize) < 8 {
                alerts[key as usize] = None;
                if let Some(base) = base_buttons.get(key as usize) {
                    deck.set_button_image(key, base.clone()).ok();
                    deck.flush().ok();
                }
                let _ = reply.send(Ok(()));
            } else {
                let _ = reply.send(Err("key must be 0-7".to_string()));
            }
        }
    }
}

fn process_input(
    state: &SharedState,
    rt: &tokio::runtime::Handle,
    input: StreamDeckInput,
    event_tx: &broadcast::Sender<DeviceEvent>,
) {
    rt.block_on(async {
        let mut st = state.lock().await;
        match input {
            StreamDeckInput::ButtonStateChange(states) => {
                for (i, &pressed) in states.iter().enumerate() {
                    if i < 8 {
                        st.button_pressed[i] = pressed;
                    }
                }
            }
            StreamDeckInput::EncoderStateChange(states) => {
                for (i, &pressed) in states.iter().enumerate() {
                    if i < 4 {
                        if pressed && !st.encoder_pressed[i] {
                            tracing::info!(encoder = i, "Encoder pressed");
                            let _ = event_tx.send(DeviceEvent::EncoderPressed { encoder: i as u8 });
                        }
                        st.encoder_pressed[i] = pressed;
                    }
                }
            }
            StreamDeckInput::EncoderTwist(deltas) => {
                for (i, &delta) in deltas.iter().enumerate() {
                    if i < 4 && delta != 0 {
                        st.encoder_positions[i] += delta as i32;
                        tracing::info!(encoder = i, delta = delta, position = st.encoder_positions[i], "Encoder twist");
                        let _ = event_tx.send(DeviceEvent::EncoderTwist {
                            encoder: i as u8,
                            delta: delta as i8,
                        });
                    }
                }
            }
            StreamDeckInput::TouchScreenPress(x, y) => {
                st.last_touch = Some((x, y));
                tracing::info!(x = x, y = y, "Touch press");
                let _ = event_tx.send(DeviceEvent::TouchPress { x, y });
            }
            StreamDeckInput::TouchScreenLongPress(x, y) => {
                st.last_touch = Some((x, y));
                tracing::info!(x = x, y = y, "Touch long press");
                let _ = event_tx.send(DeviceEvent::TouchPress { x, y });
            }
            StreamDeckInput::TouchScreenSwipe(from, to) => {
                st.last_touch = Some(to);
                tracing::info!(from_x = from.0, from_y = from.1, to_x = to.0, to_y = to.1, "Touch swipe");
                let _ = event_tx.send(DeviceEvent::TouchSwipe { from, to });
            }
            _ => {}
        }
    });
}
