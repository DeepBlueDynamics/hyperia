use base64::Engine;
use image::DynamicImage;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use super::config::AgentConfig;
use super::device_actor::{DeviceEvent, DeviceHandle};
use super::state::SharedState;

const CLAUDE_API_URL: &str = "https://api.anthropic.com/v1/messages";
const GEMINI_API_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent";

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "set_button_color",
            "description": "Set a button to a solid RGB color.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "key": { "type": "integer", "description": "Button index 0-7" },
                    "r": { "type": "integer", "description": "Red 0-255" },
                    "g": { "type": "integer", "description": "Green 0-255" },
                    "b": { "type": "integer", "description": "Blue 0-255" }
                },
                "required": ["key", "r", "g", "b"]
            }
        }),
        json!({
            "name": "set_button_image",
            "description": "Generate an image with AI and display it on a button.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "key": { "type": "integer", "description": "Button index 0-7" },
                    "prompt": { "type": "string", "description": "Image generation prompt" }
                },
                "required": ["key", "prompt"]
            }
        }),
        json!({
            "name": "set_touchstrip_text",
            "description": "Display text on the touchstrip with optional colors.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Text to display (keep short, ~20 chars max)" },
                    "bg_r": { "type": "integer", "description": "Background red 0-255 (default 10)" },
                    "bg_g": { "type": "integer", "description": "Background green 0-255 (default 15)" },
                    "bg_b": { "type": "integer", "description": "Background blue 0-255 (default 30)" },
                    "fg_r": { "type": "integer", "description": "Foreground red 0-255 (default 160)" },
                    "fg_g": { "type": "integer", "description": "Foreground green 0-255 (default 220)" },
                    "fg_b": { "type": "integer", "description": "Foreground blue 0-255 (default 255)" }
                },
                "required": ["text"]
            }
        }),
        json!({
            "name": "set_touchstrip_color",
            "description": "Set the touchstrip to a solid RGB color.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "r": { "type": "integer", "description": "Red 0-255" },
                    "g": { "type": "integer", "description": "Green 0-255" },
                    "b": { "type": "integer", "description": "Blue 0-255" }
                },
                "required": ["r", "g", "b"]
            }
        }),
        json!({
            "name": "set_touchstrip_eye",
            "description": "Display the All-Seeing Eye of GNOSIS on the touchstrip.",
            "input_schema": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }),
        json!({
            "name": "set_brightness",
            "description": "Set the device display brightness.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "value": { "type": "integer", "description": "Brightness 0-100" }
                },
                "required": ["value"]
            }
        }),
        json!({
            "name": "generate_image",
            "description": "Generate an AI image and display it on a target (button or touchstrip).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Image generation prompt" },
                    "target": { "type": "string", "description": "Where to display: 'button:N' (N=0-7) or 'touchstrip'" }
                },
                "required": ["prompt", "target"]
            }
        }),
    ]
}

pub fn spawn_agent(
    config: AgentConfig,
    device: DeviceHandle,
    state: SharedState,
    button_labels: Vec<String>,
) {
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) if !k.is_empty() => k,
        _ => {
            tracing::warn!("ANTHROPIC_API_KEY not set — agent disabled");
            return;
        }
    };
    let gemini_key = std::env::var("GOOGLE_API_KEY").ok();
    if gemini_key.is_none() {
        tracing::warn!("GOOGLE_API_KEY not set — image generation disabled");
    }

    let mut event_rx = device.subscribe();

    tokio::spawn(async move {
        tracing::info!(model = %config.claude_model, "Claude agent starting");

        let client = reqwest::Client::new();
        let mut conversation: Vec<Value> = Vec::new();
        let tools = tool_definitions();
        let brightness_encoder = config.encoder_brightness;
        let mut encoder_positions: [i32; 4] = [0; 4];

        let startup_text = super::visuals::render_text_strip("GNOSIS ONLINE", [10, 15, 30], [160, 220, 255]);
        device.set_touchstrip_image(startup_text).await.ok();

        loop {
            let event = match event_rx.recv().await {
                Ok(ev) => ev,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(missed = n, "Agent lagged, skipping events");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    tracing::info!("Event channel closed, agent exiting");
                    break;
                }
            };

            let user_message = match event {
                DeviceEvent::ButtonPressed { key, ref action, .. } => {
                    let label = button_labels.get(key as usize)
                        .map(|s| s.as_str())
                        .unwrap_or("unknown");
                    format!("Button {} ({}, action: {}) was pressed.", key, label, action)
                }
                DeviceEvent::EncoderTwist { encoder, delta } => {
                    if encoder == brightness_encoder {
                        let st = state.lock().await;
                        let current = st.brightness;
                        drop(st);
                        let new_val = (current as i16 + delta as i16 * 5).clamp(0, 100) as u8;
                        if let Err(e) = device.set_brightness(new_val).await {
                            tracing::warn!(error = %e, "Brightness adjust failed");
                        }
                        continue;
                    }
                    encoder_positions[encoder as usize] += delta as i32;
                    format!(
                        "Encoder {} twisted by {}. Current position: {}.",
                        encoder, delta, encoder_positions[encoder as usize]
                    )
                }
                DeviceEvent::EncoderPressed { encoder } => {
                    if encoder == brightness_encoder { continue; }
                    format!("Encoder {} was pressed.", encoder)
                }
                DeviceEvent::TouchPress { x, y } => {
                    format!("Touchscreen tapped at ({}, {}).", x, y)
                }
                DeviceEvent::TouchSwipe { from, to } => {
                    format!(
                        "Touchscreen swiped from ({},{}) to ({},{}).",
                        from.0, from.1, to.0, to.1
                    )
                }
            };

            tracing::info!(msg = %user_message, "Sending to Claude");
            conversation.push(json!({
                "role": "user",
                "content": user_message
            }));

            if conversation.len() > 40 {
                let drain_to = conversation.len() - 30;
                conversation.drain(..drain_to);
            }

            let result = run_claude_loop(
                &client,
                &api_key,
                &config.claude_model,
                &config.system_prompt,
                &tools,
                &mut conversation,
                &device,
                gemini_key.as_deref(),
            ).await;

            if let Err(e) = result {
                tracing::error!(error = %e, "Claude agent error");
                let err_img = super::visuals::render_text_strip("AGENT ERROR", [40, 10, 10], [255, 80, 80]);
                device.set_touchstrip_image(err_img).await.ok();
            }
        }
    });
}

async fn run_claude_loop(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    tools: &[Value],
    conversation: &mut Vec<Value>,
    device: &DeviceHandle,
    gemini_key: Option<&str>,
) -> Result<(), String> {
    let max_iterations = 10;

    for _ in 0..max_iterations {
        let body = json!({
            "model": model,
            "max_tokens": 1024,
            "system": system_prompt,
            "tools": tools,
            "messages": conversation,
        });

        let resp = client
            .post(CLAUDE_API_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("HTTP error: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(format!("Claude API {status}: {body_text}"));
        }

        let resp_json: Value = resp.json().await.map_err(|e| format!("JSON parse: {e}"))?;
        let content = resp_json["content"].as_array()
            .ok_or("No content array in response")?;
        let stop_reason = resp_json["stop_reason"].as_str().unwrap_or("");

        conversation.push(json!({
            "role": "assistant",
            "content": content.clone(),
        }));

        if stop_reason == "tool_use" {
            let mut tool_results: Vec<Value> = Vec::new();

            for block in content {
                if block["type"].as_str() == Some("tool_use") {
                    let tool_id = block["id"].as_str().unwrap_or("");
                    let tool_name = block["name"].as_str().unwrap_or("");
                    let input = &block["input"];

                    tracing::info!(tool = tool_name, input = %input, "Executing tool");
                    let result = execute_tool(tool_name, input, device, gemini_key).await;

                    let (result_text, is_error) = match result {
                        Ok(msg) => (msg, false),
                        Err(msg) => (msg, true),
                    };

                    tool_results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": result_text,
                        "is_error": is_error,
                    }));
                }
            }

            if !tool_results.is_empty() {
                conversation.push(json!({
                    "role": "user",
                    "content": tool_results,
                }));
            }
        } else {
            for block in content {
                if block["type"].as_str() == Some("text") {
                    if let Some(text) = block["text"].as_str() {
                        tracing::info!(response = %text, "Claude says");
                    }
                }
            }
            return Ok(());
        }
    }

    Err("Tool-use loop exceeded max iterations".to_string())
}

async fn execute_tool(
    name: &str,
    input: &Value,
    device: &DeviceHandle,
    gemini_key: Option<&str>,
) -> Result<String, String> {
    match name {
        "set_button_color" => {
            let key = input["key"].as_u64().ok_or("missing key")? as u8;
            let r = input["r"].as_u64().ok_or("missing r")? as u8;
            let g = input["g"].as_u64().ok_or("missing g")? as u8;
            let b = input["b"].as_u64().ok_or("missing b")? as u8;
            if key > 7 { return Err("key must be 0-7".into()); }
            let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(120, 120, image::Rgb([r, g, b])));
            device.set_button_image(key, img).await.map_err(|e| format!("device: {e}"))?;
            Ok(format!("Button {key} set to RGB({r},{g},{b})"))
        }

        "set_button_image" => {
            let key = input["key"].as_u64().ok_or("missing key")? as u8;
            let prompt = input["prompt"].as_str().ok_or("missing prompt")?;
            if key > 7 { return Err("key must be 0-7".into()); }
            let gemini_key = gemini_key.ok_or("GOOGLE_API_KEY not set")?;
            let img = generate_gemini_image(gemini_key, prompt, 120, 120).await?;
            device.set_button_image(key, img).await.map_err(|e| format!("device: {e}"))?;
            Ok(format!("Button {key} image generated: {prompt}"))
        }

        "set_touchstrip_text" => {
            let text = input["text"].as_str().ok_or("missing text")?;
            let bg = [
                input["bg_r"].as_u64().unwrap_or(10) as u8,
                input["bg_g"].as_u64().unwrap_or(15) as u8,
                input["bg_b"].as_u64().unwrap_or(30) as u8,
            ];
            let fg = [
                input["fg_r"].as_u64().unwrap_or(160) as u8,
                input["fg_g"].as_u64().unwrap_or(220) as u8,
                input["fg_b"].as_u64().unwrap_or(255) as u8,
            ];
            let img = super::visuals::render_text_strip(text, bg, fg);
            device.set_touchstrip_image(img).await.map_err(|e| format!("device: {e}"))?;
            Ok(format!("Touchstrip text: \"{text}\""))
        }

        "set_touchstrip_color" => {
            let r = input["r"].as_u64().ok_or("missing r")? as u8;
            let g = input["g"].as_u64().ok_or("missing g")? as u8;
            let b = input["b"].as_u64().ok_or("missing b")? as u8;
            let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(800, 100, image::Rgb([r, g, b])));
            device.set_touchstrip_image(img).await.map_err(|e| format!("device: {e}"))?;
            Ok(format!("Touchstrip set to RGB({r},{g},{b})"))
        }

        "set_touchstrip_eye" => {
            let img = super::visuals::render_eye_strip();
            device.set_touchstrip_image(img).await.map_err(|e| format!("device: {e}"))?;
            Ok("Eye of GNOSIS displayed".to_string())
        }

        "set_brightness" => {
            let value = input["value"].as_u64().ok_or("missing value")? as u8;
            let clamped = value.min(100);
            device.set_brightness(clamped).await.map_err(|e| format!("device: {e}"))?;
            Ok(format!("Brightness set to {clamped}%"))
        }

        "generate_image" => {
            let prompt = input["prompt"].as_str().ok_or("missing prompt")?;
            let target = input["target"].as_str().ok_or("missing target")?;
            let gemini_key = gemini_key.ok_or("GOOGLE_API_KEY not set")?;

            if target == "touchstrip" {
                let img = generate_gemini_image(gemini_key, prompt, 800, 100).await?;
                device.set_touchstrip_image(img).await.map_err(|e| format!("device: {e}"))?;
                Ok(format!("Touchstrip image generated: {prompt}"))
            } else if target.starts_with("button:") {
                let key: u8 = target[7..].parse().map_err(|_| "bad button index")?;
                if key > 7 { return Err("key must be 0-7".into()); }
                let img = generate_gemini_image(gemini_key, prompt, 120, 120).await?;
                device.set_button_image(key, img).await.map_err(|e| format!("device: {e}"))?;
                Ok(format!("Button {key} image generated: {prompt}"))
            } else {
                Err(format!("Invalid target: {target}. Use 'touchstrip' or 'button:N'"))
            }
        }

        _ => Err(format!("Unknown tool: {name}")),
    }
}

async fn generate_gemini_image(
    api_key: &str,
    prompt: &str,
    width: u32,
    height: u32,
) -> Result<DynamicImage, String> {
    let client = reqwest::Client::new();
    let url = format!("{GEMINI_API_URL}?key={api_key}");

    let body = json!({
        "generationConfig": {
            "responseModalities": ["IMAGE", "TEXT"]
        },
        "contents": [{
            "parts": [{
                "text": prompt
            }]
        }]
    });

    tracing::info!(prompt = %prompt, "Generating image via Gemini");

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini HTTP error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("Gemini API {status}: {body_text}"));
    }

    let resp_json: Value = resp.json().await.map_err(|e| format!("Gemini JSON parse: {e}"))?;
    let candidates = resp_json["candidates"].as_array()
        .ok_or("No candidates in Gemini response")?;

    for candidate in candidates {
        if let Some(parts) = candidate["content"]["parts"].as_array() {
            for part in parts {
                if let Some(inline_data) = part["inlineData"].as_object() {
                    if let Some(b64_data) = inline_data.get("data").and_then(|d| d.as_str()) {
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(b64_data)
                            .map_err(|e| format!("base64 decode: {e}"))?;
                        let img = image::load_from_memory(&bytes)
                            .map_err(|e| format!("image decode: {e}"))?;
                        let resized = img.resize_exact(width, height, image::imageops::FilterType::Lanczos3);
                        return Ok(resized);
                    }
                }
            }
        }
    }

    Err("No image data found in Gemini response".to_string())
}
