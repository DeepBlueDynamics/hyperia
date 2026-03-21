use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use base64::Engine as _;
use image::{DynamicImage, Rgb, RgbImage};

use super::device_actor::DeviceHandle;
use super::screenshot::{encode_png, render_screenshot};
use super::state::SharedState;

#[derive(Clone)]
pub struct AppState {
    pub shared: SharedState,
    pub device: DeviceHandle,
}

pub fn router(shared: SharedState, device: DeviceHandle) -> Router {
    let app_state = AppState { shared, device };
    Router::new()
        .route("/screenshot", get(screenshot_handler))
        .route("/screenshot.png", get(screenshot_handler))
        .route("/status", get(status_handler))
        .route("/health", get(health_handler))
        .route("/test/button/{key}", get(test_button_handler))
        .route("/test/brand", get(test_brand_handler))
        .route("/touchstrip/color", post(touchstrip_color_handler))
        .route("/touchstrip/restore", post(touchstrip_restore_handler))
        .route("/brightness", post(brightness_handler))
        .route("/touchstrip/text", post(touchstrip_text_handler))
        .route("/button/{key}/color", post(button_color_handler))
        .route("/touchstrip/eye", post(touchstrip_eye_handler))
        .route("/button/image", post(button_image_handler))
        .route("/touchstrip/image", post(touchstrip_image_handler))
        .route("/encoder/mode", post(encoder_mode_handler))
        .route("/config", get(config_page_handler))
        .with_state(app_state)
}

async fn screenshot_handler(State(app): State<AppState>) -> Response {
    let st = app.shared.lock().await;
    let composite = render_screenshot(&st);
    let png_bytes = encode_png(&composite);
    (
        StatusCode::OK,
        [
            ("content-type", "image/png"),
            ("cache-control", "no-cache"),
        ],
        png_bytes,
    )
        .into_response()
}

async fn status_handler(State(app): State<AppState>) -> Json<serde_json::Value> {
    let st = app.shared.lock().await;
    let status = st.status();
    Json(serde_json::to_value(&status).unwrap_or_default())
}

async fn health_handler() -> &'static str {
    "ok"
}

async fn test_button_handler(
    State(app): State<AppState>,
    Path(key): Path<u8>,
) -> Response {
    if key > 7 {
        return (StatusCode::BAD_REQUEST, "key must be 0-7").into_response();
    }
    let colors: [[u8; 3]; 8] = [
        [30, 100, 255], [255, 40, 40], [40, 255, 40], [255, 255, 40],
        [200, 40, 255], [40, 255, 255], [255, 140, 40], [255, 255, 255],
    ];
    let c = colors[key as usize];
    let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(120, 120, Rgb(c)));
    match app.device.set_button_image(key, img).await {
        Ok(_) => (StatusCode::OK, format!("Button {} set to RGB({},{},{})", key, c[0], c[1], c[2])).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("FAILED: {e}")).into_response(),
    }
}

async fn test_brand_handler(State(app): State<AppState>) -> Response {
    let images: Vec<Option<DynamicImage>> = {
        let st = app.shared.lock().await;
        st.button_images.iter().map(|img| img.clone()).collect()
    };
    let mut results = Vec::new();
    for (i, img) in images.into_iter().enumerate() {
        match img {
            Some(img) => match app.device.set_button_image(i as u8, img).await {
                Ok(_) => results.push(format!("Button {i}: OK")),
                Err(e) => results.push(format!("Button {i}: FAILED {e}")),
            },
            None => results.push(format!("Button {i}: no image")),
        }
    }
    (StatusCode::OK, results.join("\n")).into_response()
}

#[derive(serde::Deserialize)]
struct ColorPayload {
    r: u8,
    g: u8,
    b: u8,
}

#[derive(serde::Deserialize)]
struct BrightnessPayload {
    value: u8,
}

async fn touchstrip_color_handler(
    State(app): State<AppState>,
    Json(color): Json<ColorPayload>,
) -> Response {
    let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(800, 100, Rgb([color.r, color.g, color.b])));
    match app.device.set_touchstrip_image(img).await {
        Ok(_) => (StatusCode::OK, format!("Touchstrip set to RGB({},{},{})", color.r, color.g, color.b)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("FAILED: {e}")).into_response(),
    }
}

async fn touchstrip_restore_handler(State(app): State<AppState>) -> Response {
    let branded = {
        let st = app.shared.lock().await;
        st.touchstrip_image.clone()
    };
    match branded {
        Some(img) => match app.device.set_touchstrip_image(img).await {
            Ok(_) => (StatusCode::OK, "Touchstrip restored").into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("FAILED: {e}")).into_response(),
        },
        None => (StatusCode::OK, "No branded image in state").into_response(),
    }
}

async fn brightness_handler(
    State(app): State<AppState>,
    Json(payload): Json<BrightnessPayload>,
) -> Response {
    match app.device.set_brightness(payload.value).await {
        Ok(_) => (StatusCode::OK, format!("Brightness set to {}", payload.value)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("FAILED: {e}")).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct TextPayload {
    text: String,
    #[serde(default = "default_bg")]
    bg: [u8; 3],
    #[serde(default = "default_fg")]
    fg: [u8; 3],
}
fn default_bg() -> [u8; 3] { [10, 15, 30] }
fn default_fg() -> [u8; 3] { [160, 220, 255] }

async fn touchstrip_text_handler(
    State(app): State<AppState>,
    Json(payload): Json<TextPayload>,
) -> Response {
    let img = super::visuals::render_text_strip(&payload.text, payload.bg, payload.fg);
    match app.device.set_touchstrip_image(img).await {
        Ok(_) => (StatusCode::OK, format!("Touchstrip text: \"{}\"", payload.text)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("FAILED: {e}")).into_response(),
    }
}

async fn button_color_handler(
    State(app): State<AppState>,
    Path(key): Path<u8>,
    Json(color): Json<ColorPayload>,
) -> Response {
    if key > 7 {
        return (StatusCode::BAD_REQUEST, "key must be 0-7").into_response();
    }
    let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(120, 120, Rgb([color.r, color.g, color.b])));
    match app.device.set_button_image(key, img).await {
        Ok(_) => (StatusCode::OK, format!("Button {key} set to RGB({},{},{})", color.r, color.g, color.b)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("FAILED: {e}")).into_response(),
    }
}

async fn touchstrip_eye_handler(State(app): State<AppState>) -> Response {
    let img = super::visuals::render_eye_strip();
    match app.device.set_touchstrip_image(img).await {
        Ok(_) => (StatusCode::OK, "Eye displayed").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("FAILED: {e}")).into_response(),
    }
}

async fn button_image_handler(
    State(app): State<AppState>,
    body: String,
) -> Response {
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let key = parsed["key"].as_u64().unwrap_or(0) as u8;
    let b64 = parsed["image_base64"].as_str().unwrap_or("");
    let bytes = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64) {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad base64: {e}")).into_response(),
    };
    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad image: {e}")).into_response(),
    };
    match app.device.set_button_image(key, img).await {
        Ok(_) => (StatusCode::OK, format!("Button {} image set", key)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("FAILED: {e}")).into_response(),
    }
}

async fn touchstrip_image_handler(
    State(app): State<AppState>,
    body: String,
) -> Response {
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let b64 = parsed["image_base64"].as_str().unwrap_or("");
    let bytes = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64) {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad base64: {e}")).into_response(),
    };
    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad image: {e}")).into_response(),
    };
    match app.device.set_touchstrip_image(img).await {
        Ok(_) => (StatusCode::OK, "Touchstrip image set").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("FAILED: {e}")).into_response(),
    }
}

async fn encoder_mode_handler(
    State(_app): State<AppState>,
    body: String,
) -> Response {
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let _encoder = parsed["encoder"].as_u64().unwrap_or(0);
    let _mode = parsed["mode"].as_str().unwrap_or("tabs");
    (StatusCode::OK, format!("Encoder {} mode set to {}", _encoder, _mode)).into_response()
}

async fn config_page_handler() -> axum::response::Html<String> {
    axum::response::Html(deck_config_html())
}

fn deck_config_html() -> String {
    r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Hyperia Deck Config</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, monospace; background: #0a0a0f; color: #ccc; min-height: 100vh; padding: 20px; }
h1 { font-size: 18px; color: #fff; margin-bottom: 20px; letter-spacing: 2px; }
.deck-grid { display: grid; grid-template-columns: repeat(4, 120px); gap: 10px; margin-bottom: 20px; }
.btn-slot {
  width: 120px; height: 120px; background: #111; border: 2px solid #333; border-radius: 8px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  cursor: pointer; transition: border-color 0.2s;
}
.btn-slot:hover { border-color: #468cff; }
.btn-slot.selected { border-color: #00ff64; box-shadow: 0 0 12px rgba(0,255,100,0.2); }
.btn-emoji { font-size: 48px; }
.btn-label { font-size: 10px; color: #888; margin-top: 4px; }
.emoji-picker { display: flex; flex-wrap: wrap; gap: 4px; margin: 10px 0; max-width: 700px; }
.emoji-opt { font-size: 28px; cursor: pointer; padding: 3px; border-radius: 6px; transition: background 0.1s; }
.emoji-opt:hover { background: #222; transform: scale(1.2); }
.config-row { display: flex; gap: 10px; align-items: center; margin: 8px 0; }
.config-row label { color: #888; width: 80px; font-size: 12px; }
.config-row input, .config-row select { background: #111; border: 1px solid #333; color: #fff; padding: 6px 10px; border-radius: 4px; flex: 1; font-size: 13px; }
.config-row input[type=color] { width: 40px; flex: none; padding: 2px; height: 30px; }
button.apply { background: #1a3a1a; border: 1px solid #22c55e; color: #22c55e; padding: 8px 24px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-top: 10px; }
button.apply:hover { background: #22c55e; color: #000; }
.status { color: #468cff; font-size: 12px; margin-top: 8px; min-height: 16px; }
h2 { font-size: 14px; color: #aaa; margin: 16px 0 8px; }
.strip-preview { width: 500px; height: 50px; background: #0a0a1e; border: 1px solid #333; border-radius: 6px; margin: 8px 0; display: flex; align-items: center; justify-content: center; color: #468cff; font-size: 16px; letter-spacing: 3px; }
.knobs { display: flex; gap: 20px; margin: 10px 0; }
.knob { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.knob-circle { width: 50px; height: 50px; border-radius: 50%; border: 2px solid #444; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #aaa; background: #111; }
.knob select { background: #111; border: 1px solid #333; color: #fff; padding: 3px; border-radius: 4px; font-size: 11px; width: 90px; }
.knob-label { font-size: 10px; color: #666; }
.sections { display: flex; gap: 40px; flex-wrap: wrap; }
.section { flex: 1; min-width: 300px; }
</style>
</head>
<body>
<h1>STREAM DECK CONFIG</h1>

<div class="deck-grid" id="grid"></div>

<div class="sections">
<div class="section">
<h2>EMOJI</h2>
<div class="emoji-picker" id="picker"></div>
</div>
<div class="section">
<h2>BUTTON</h2>
<div class="config-row"><label>Label</label><input id="cfg-label" placeholder="Label"></div>
<div class="config-row"><label>Color</label><input type="color" id="cfg-color" value="#468cff"></div>
<div class="config-row"><label>Action</label>
  <select id="cfg-action">
    <option value="command">Run command</option>
    <option value="screenshot">Screenshot</option>
    <option value="status">Status</option>
    <option value="home">Home</option>
  </select>
</div>
<div class="config-row"><label>Command</label><input id="cfg-cmd" placeholder="claude, nemisis8 interactive..."></div>
<button class="apply" onclick="applyButton()">Apply</button>

<h2>TOUCHSTRIP</h2>
<div class="strip-preview" id="strip-preview">HYPERIA</div>
<div class="config-row"><label>Text</label><input id="strip-text" value="HYPERIA"></div>
<div class="config-row"><label>Color</label><input type="color" id="strip-color" value="#468cff"></div>
<button class="apply" onclick="applyStrip()">Update Strip</button>

<h2>KNOBS</h2>
<div class="knobs">
  <div class="knob"><div class="knob-circle">K1</div><select id="knob0"><option value="tabs">Tabs</option><option value="brightness">Brightness</option><option value="volume">Volume</option><option value="custom">Custom</option></select><span class="knob-label">Encoder 1</span></div>
  <div class="knob"><div class="knob-circle">K2</div><select id="knob1"><option value="brightness">Brightness</option><option value="tabs">Tabs</option><option value="volume">Volume</option><option value="custom">Custom</option></select><span class="knob-label">Encoder 2</span></div>
  <div class="knob"><div class="knob-circle">K3</div><select id="knob2"><option value="volume">Volume</option><option value="tabs">Tabs</option><option value="brightness">Brightness</option><option value="custom">Custom</option></select><span class="knob-label">Encoder 3</span></div>
  <div class="knob"><div class="knob-circle">K4</div><select id="knob3"><option value="custom">Custom</option><option value="tabs">Tabs</option><option value="brightness">Brightness</option><option value="volume">Volume</option></select><span class="knob-label">Encoder 4</span></div>
</div>
<button class="apply" onclick="applyKnobs()">Apply Knobs</button>
</div>
</div>

<div class="status" id="status"></div>

<script>
const EMOJIS = [
  '🦀','🐙','🦑','🦈','🐉','🦎','🐍','🦅','🦇','🐺','🐲','👁','💀','⚡','🔥','💥',
  '✨','🧠','🎯','🎮','🎤','💻','🖥','⌨','📡','🛸','🌀','🌊','🔮','💎','🗡','🛡',
  '⚔','🏴','☠','🤖','👾','🕹','📊','🏠','⚙','🔧','🔬','🧬','💉','🧪','📦','🚀',
  '🌙','☄','🪐','🌌','🎵','🎶','📻','🔊','🎧','🃏','♠','♦','🐈','🐕','🦊','🐸',
  '🦉','🦋','🐝','🌸','🍄','🌿','🎄','❄','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪',
];

let buttons = [
  {emoji:'👁',label:'Observe',color:'#2878c8',action:'screenshot',command:''},
  {emoji:'💥',label:'Health',color:'#b43c3c',action:'status',command:''},
  {emoji:'💻',label:'Terminal',color:'#3cb450',action:'command',command:'cmd'},
  {emoji:'⚡',label:'Codex',color:'#c8a028',action:'command',command:'cd C:\\Users\\kordl\\Code\\Gnosis\\nemesis8 && .\\target\\debug\\nemisis8.exe interactive'},
  {emoji:'✨',label:'Claude',color:'#8c3cb4',action:'command',command:'claude'},
  {emoji:'🎤',label:'Auracle',color:'#3ca0a0',action:'voice_toggle',command:''},
  {emoji:'📊',label:'Dashboard',color:'#c86428',action:'command',command:'start http://localhost:9800/dashboard'},
  {emoji:'🏠',label:'Home',color:'#b4b4b4',action:'home',command:''},
];

let selected = 0;

function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  buttons.forEach((b, i) => {
    const div = document.createElement('div');
    div.className = 'btn-slot' + (i === selected ? ' selected' : '');
    div.style.borderColor = i === selected ? '#00ff64' : b.color + '66';
    div.style.boxShadow = i === selected ? '0 0 12px rgba(0,255,100,0.2)' : 'inset 0 0 30px ' + b.color + '11';
    div.innerHTML = '<span class="btn-emoji">' + b.emoji + '</span><span class="btn-label" style="color:' + b.color + '">' + b.label + '</span>';
    div.onclick = function() { selected = i; renderGrid(); loadSelected(); };
    grid.appendChild(div);
  });
}

function renderPicker() {
  const picker = document.getElementById('picker');
  picker.innerHTML = '';
  EMOJIS.forEach(function(e) {
    const span = document.createElement('span');
    span.className = 'emoji-opt';
    span.textContent = e;
    span.onclick = function() {
      buttons[selected].emoji = e;
      renderGrid();
      pushButtonImage(selected);
    };
    picker.appendChild(span);
  });
}

function loadSelected() {
  const b = buttons[selected];
  document.getElementById('cfg-label').value = b.label;
  document.getElementById('cfg-color').value = b.color;
  document.getElementById('cfg-action').value = b.action;
  document.getElementById('cfg-cmd').value = b.command;
}

function applyButton() {
  const b = buttons[selected];
  b.label = document.getElementById('cfg-label').value;
  b.color = document.getElementById('cfg-color').value;
  b.action = document.getElementById('cfg-action').value;
  b.command = document.getElementById('cfg-cmd').value;
  renderGrid();
  pushButtonImage(selected);
  setStatus('Button ' + selected + ' updated');
}

function pushButtonImage(key) {
  const b = buttons[key];
  const canvas = document.createElement('canvas');
  canvas.width = 120; canvas.height = 120;
  const ctx = canvas.getContext('2d');

  // Dark background with colored vignette
  const grad = ctx.createRadialGradient(60, 55, 10, 60, 60, 80);
  grad.addColorStop(0, b.color + '22');
  grad.addColorStop(1, '#0b0b0f');
  ctx.fillStyle = '#0b0b0f';
  ctx.fillRect(0, 0, 120, 120);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 120, 120);

  // Colored border
  ctx.strokeStyle = b.color + '44';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, 116, 116);

  // Emoji
  ctx.font = '56px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.emoji, 60, 50);

  // Label in button color
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = b.color;
  ctx.fillText(b.label, 60, 105);

  canvas.toBlob(function(blob) {
    const reader = new FileReader();
    reader.onload = function() {
      const b64 = reader.result.split(',')[1];
      fetch('/button/image', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({key: key, image_base64: b64})
      }).then(function() { setStatus('Button ' + key + ' pushed to deck'); });
    };
    reader.readAsDataURL(blob);
  }, 'image/png');
}

function applyStrip() {
  const text = document.getElementById('strip-text').value;
  const hex = document.getElementById('strip-color').value;
  const r = parseInt(hex.substr(1,2),16);
  const g = parseInt(hex.substr(3,2),16);
  const b = parseInt(hex.substr(5,2),16);
  document.getElementById('strip-preview').textContent = text;
  document.getElementById('strip-preview').style.color = hex;
  fetch('/touchstrip/text', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text: text, bg: [10,10,15], fg: [r,g,b]})
  }).then(function() { setStatus('Touchstrip updated'); });
}

function applyKnobs() {
  for (let i = 0; i < 4; i++) {
    const mode = document.getElementById('knob' + i).value;
    fetch('/encoder/mode', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({encoder: i, mode: mode})
    });
  }
  setStatus('Knobs updated');
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
  setTimeout(function() { document.getElementById('status').textContent = ''; }, 3000);
}

renderGrid();
renderPicker();
loadSelected();
</script>
</body>
</html>"##.to_string()
}
