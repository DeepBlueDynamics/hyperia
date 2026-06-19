use serde_json::Value;
use std::sync::Arc;
use crate::{AppState, TouchBarItem};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use base64::{Engine as _, engine::general_purpose};
use rusttype::{Font, Scale, point};

pub async fn handle_mcp_request(req: Value, state: Arc<AppState>) -> Value {
    let method = match req.get("method").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => return serde_json::json!({
            "jsonrpc": "2.0",
            "error": { "code": -32601, "message": "Method not found" },
            "id": req.get("id")
        }),
    };

    let id = req.get("id").cloned().unwrap_or(Value::Null);

    match method {
        "tools/list" => {
            serde_json::json!({
                "jsonrpc": "2.0",
                "result": {
                    "tools": [
                        {
                            "name": "get_device_status",
                            "description": "Get current connection status, serial number, and firmware version of the Stream Deck Plus.",
                            "inputSchema": { "type": "object", "properties": {} }
                        },
                        {
                            "name": "set_brightness",
                            "description": "Set the brightness of the Stream Deck Plus displays (0 to 100).",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "brightness": { "type": "integer", "minimum": 0, "maximum": 100, "description": "Brightness percentage" }
                                },
                                "required": ["brightness"]
                            }
                        },
                        {
                            "name": "set_button_color",
                            "description": "Set a solid color on a key button (0-7).",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "key": { "type": "integer", "minimum": 0, "maximum": 7, "description": "Button index (0-7)" },
                                    "red": { "type": "integer", "minimum": 0, "maximum": 255, "description": "Red channel (0-255)" },
                                    "green": { "type": "integer", "minimum": 0, "maximum": 255, "description": "Green channel (0-255)" },
                                    "blue": { "type": "integer", "minimum": 0, "maximum": 255, "description": "Blue channel (0-255)" }
                                },
                                "required": ["key", "red", "green", "blue"]
                            }
                        },
                        {
                            "name": "set_button_image",
                            "description": "Set a JPEG/PNG image on a specific key button (0-7). Image data must be base64-encoded. Note: Images are automatically scaled to a 120x120 square.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "key": { "type": "integer", "minimum": 0, "maximum": 7, "description": "Button index (0-7)" },
                                    "image_base64": { "type": "string", "description": "Base64 encoded JPEG/PNG image data (can include data:image/png;base64,... header)" }
                                },
                                "required": ["key", "image_base64"]
                            }
                        },
                        {
                            "name": "set_touch_screen_image",
                            "description": "Upload an image to the LCD touchscreen bar (800x100). The image is automatically scaled to fit the touch bar.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "image_base64": { "type": "string", "description": "Base64 encoded JPEG/PNG image data" },
                                    "x": { "type": "integer", "minimum": 0, "maximum": 800, "description": "X coordinate offset (default 0)" },
                                    "y": { "type": "integer", "minimum": 0, "maximum": 100, "description": "Y coordinate offset (default 0)" },
                                    "width": { "type": "integer", "minimum": 1, "maximum": 800, "description": "Width of target region (default 800)" },
                                    "height": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Height of target region (default 100)" }
                                },
                                "required": ["image_base64"]
                            }
                        },
                        {
                            "name": "sync_hyperia_panes",
                            "description": "Query all active terminal and web panes from Hyperia and map them onto the Stream Deck Plus display and knobs.",
                            "inputSchema": { "type": "object", "properties": {} }
                        }
                    ]
                },
                "id": id
            })
        }
        "tools/call" => {
            let params = match req.get("params") {
                Some(p) => p,
                None => return error_response(id, -32602, "Invalid params"),
            };

            let name = match params.get("name").and_then(|n| n.as_str()) {
                Some(n) => n,
                None => return error_response(id, -32602, "Missing tool name"),
            };

            let args = params.get("arguments").cloned().unwrap_or(Value::Null);

            let result = handle_tool_call(name, args, state).await;
            match result {
                Ok(content) => serde_json::json!({
                    "jsonrpc": "2.0",
                    "result": { "content": content },
                    "id": id
                }),
                Err(e) => serde_json::json!({
                    "jsonrpc": "2.0",
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": format!("Error: {}", e)
                            }
                        ],
                        "isError": true
                    },
                    "id": id
                }),
            }
        }
        _ => error_response(id, -32601, "Method not found"),
    }
}

fn error_response(id: Value, code: i32, message: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "error": { "code": code, "message": message },
        "id": id
    })
}

async fn handle_tool_call(name: &str, args: Value, state: Arc<AppState>) -> Result<Value, Box<dyn std::error::Error>> {
    match name {
        "get_device_status" => {
            let status = {
                let s = state.status.lock().unwrap();
                s.clone()
            };
            
            Ok(serde_json::json!([
                {
                    "type": "text",
                    "text": serde_json::to_string_pretty(&status)?
                }
            ]))
        }
        "set_brightness" => {
            let brightness = args.get("brightness").and_then(|b| b.as_u64()).ok_or("Invalid brightness value")? as u8;
            {
                let deck = state.device.lock().unwrap();
                if let Some(ref d) = *deck {
                    d.set_brightness(brightness)?;
                } else {
                    return Err("Stream Deck Plus device not connected".into());
                }
            }
            Ok(serde_json::json!([
                {
                    "type": "text",
                    "text": format!("Brightness set to {}%", brightness)
                }
            ]))
        }
        "set_button_color" => {
            let key = args.get("key").and_then(|k| k.as_u64()).ok_or("Invalid key index")? as u8;
            let r = args.get("red").and_then(|v| v.as_u64()).ok_or("Invalid red")? as u8;
            let g = args.get("green").and_then(|v| v.as_u64()).ok_or("Invalid green")? as u8;
            let b = args.get("blue").and_then(|v| v.as_u64()).ok_or("Invalid blue")? as u8;

            let mut img = image::ImageBuffer::new(120, 120);
            for pixel in img.pixels_mut() {
                *pixel = image::Rgb([r, g, b]);
            }

            let mut jpeg_bytes = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 85);
            encoder.encode(&img, 120, 120, image::ColorType::Rgb8)?;

            {
                let deck = state.device.lock().unwrap();
                if let Some(ref d) = *deck {
                    d.fill_button_image(key, &jpeg_bytes)?;
                } else {
                    return Err("Stream Deck Plus device not connected".into());
                }
            }

            Ok(serde_json::json!([
                {
                    "type": "text",
                    "text": format!("Button {} set to color R:{} G:{} B:{}", key, r, g, b)
                }
            ]))
        }
        "set_button_image" => {
            let key = args.get("key").and_then(|k| k.as_u64()).ok_or("Invalid key index")? as u8;
            let base64_str = args.get("image_base64").and_then(|s| s.as_str()).ok_or("Invalid base64 image data")?;
            
            let bytes = decode_base64_image(base64_str)?;
            let raw_img = image::load_from_memory(&bytes)?;
            
            // Resize to 120x120 px
            let resized = raw_img.resize_exact(120, 120, FilterType::Lanczos3);
            let mut jpeg_bytes = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 80);
            encoder.encode(resized.as_bytes(), 120, 120, image::ColorType::Rgb8)?;

            {
                let deck = state.device.lock().unwrap();
                if let Some(ref d) = *deck {
                    d.fill_button_image(key, &jpeg_bytes)?;
                } else {
                    return Err("Stream Deck Plus device not connected".into());
                }
            }

            Ok(serde_json::json!([
                {
                    "type": "text",
                    "text": format!("Image successfully uploaded to button {}", key)
                }
            ]))
        }
        "set_touch_screen_image" => {
            let base64_str = args.get("image_base64").and_then(|s| s.as_str()).ok_or("Invalid base64 image data")?;
            let x = args.get("x").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let y = args.get("y").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let width = args.get("width").and_then(|v| v.as_u64()).unwrap_or(800) as u16;
            let height = args.get("height").and_then(|v| v.as_u64()).unwrap_or(100) as u16;

            let bytes = decode_base64_image(base64_str)?;
            let raw_img = image::load_from_memory(&bytes)?;
            
            let resized = raw_img.resize_exact(width as u32, height as u32, FilterType::Lanczos3);
            let mut jpeg_bytes = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 80);
            encoder.encode(resized.as_bytes(), width as u32, height as u32, image::ColorType::Rgb8)?;

            {
                let deck = state.device.lock().unwrap();
                if let Some(ref d) = *deck {
                    d.fill_lcd_image(x, y, width, height, &jpeg_bytes)?;
                } else {
                    return Err("Stream Deck Plus device not connected".into());
                }
            }

            Ok(serde_json::json!([
                {
                    "type": "text",
                    "text": format!("Image uploaded to touchscreen region X:{} Y:{} W:{} H:{}", x, y, width, height)
                }
            ]))
        }
        "sync_hyperia_panes" => {
            crate::sync_panes_internal(state).await?;

            Ok(serde_json::json!([
                {
                    "type": "text",
                    "text": "Successfully synchronized active panes from Hyperia."
                }
            ]))
        }
        _ => Err(format!("Unknown tool: {}", name).into()),
    }
}

fn decode_base64_image(base64_str: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let clean_str = if base64_str.starts_with("data:") {
        if let Some(comma_pos) = base64_str.find(',') {
            &base64_str[comma_pos + 1..]
        } else {
            base64_str
        }
    } else {
        base64_str
    };

    let bytes = general_purpose::STANDARD.decode(clean_str.trim())?;
    Ok(bytes)
}

// Measure text width using glyph bounding boxes
pub fn measure_text_width(font: &Font, text: &str, size: f32) -> i32 {
    let scale = Scale::uniform(size);
    let glyphs: Vec<_> = font.layout(text, scale, point(0.0, 0.0)).collect();
    let mut width: f32 = 0.0;
    for g in glyphs {
        if let Some(bbox) = g.pixel_bounding_box() {
            width = width.max(bbox.max.x as f32);
        }
    }
    width as i32
}

pub fn trim_pane_name(name: &str, max_len: usize) -> String {
    let chars: Vec<char> = name.chars().collect();
    if chars.len() <= max_len {
        return name.to_string();
    }
    
    let mut ends_with_emoji = false;
    let mut emoji = None;
    if let Some(&last_char) = chars.last() {
        if !last_char.is_ascii() {
            ends_with_emoji = true;
            emoji = Some(last_char);
        }
    }
    
    if ends_with_emoji {
        let name_limit = max_len.saturating_sub(3);
        let mut truncated: String = chars.iter().take(name_limit).collect();
        truncated.push_str("..");
        truncated.push(emoji.unwrap());
        truncated
    } else {
        chars.iter().take(max_len).collect()
    }
}

// Draw titles/labels on the touch bar
pub fn redraw_touch_bar(
    items: &[TouchBarItem],
    deck_opt: &Option<crate::device::StreamDeckPlus>,
    flash_color: Option<image::Rgb<u8>>,
    offset: usize,
    total_len: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    let deck = match deck_opt {
        Some(ref d) => d,
        None => return Ok(()),
    };

    // Render an 800x100 image bar
    let normal_bg = image::Rgb([30, 30, 35]);
    let bg_color = flash_color.unwrap_or(normal_bg);
    let mut bar_img = image::ImageBuffer::from_pixel(800, 100, bg_color);

    // Draw grid dividers
    for x in [200, 400, 600] {
        for y in 0..100 {
            bar_img.put_pixel(x, y, image::Rgb([60, 60, 65]));
        }
    }

    // Load Arial or Segoe UI font from Windows fonts dir
    let font_paths = [
        "C:\\Windows\\Fonts\\seguiemj.ttf", // Segoe UI Emoji
        "C:\\Windows\\Fonts\\segoeui.ttf",  // Segoe UI
        "C:\\Windows\\Fonts\\arial.ttf",    // Arial
    ];

    let mut font_data = None;
    for path in &font_paths {
        if let Ok(data) = std::fs::read(path) {
            font_data = Some(data);
            break;
        }
    }

    if let Some(data) = font_data {
        if let Some(font) = Font::try_from_vec(data) {
            // Draw each item in its 200x100 slot
            for (i, item) in items.iter().take(4).enumerate() {
                let x_offset = (i * 200) as i32;
                
                // Draw Dial function label centered at the bottom (Y = 80)
                let dial_label = match i {
                    0 => "Scroll Pane",
                    1 => "Scroll Tabs",
                    2 => "Scroll App",
                    3 => "Brightness",
                    _ => "",
                };
                let dial_label_color = image::Rgb([140, 140, 150]);
                let dial_width = measure_text_width(&font, dial_label, 11.0);
                draw_text(&mut bar_img, &font, dial_label, x_offset + 100 - (dial_width / 2), 80, 11.0, dial_label_color);

                match item {
                    TouchBarItem::Pane(pane) => {
                        let is_terminal = pane.shell.as_deref() != Some("web");

                        // Set color: green for terminal, blue for web
                        let pane_color = if is_terminal {
                            if pane.focused { image::Rgb([50, 220, 100]) } else { image::Rgb([30, 140, 70]) }
                        } else {
                            if pane.focused { image::Rgb([0, 150, 255]) } else { image::Rgb([0, 90, 180]) }
                        };

                        // Draw background highlighting for focused pane (if not flashing)
                        if pane.focused && flash_color.is_none() {
                            let focus_bg = if is_terminal {
                                image::Rgb([35, 45, 40])
                            } else {
                                image::Rgb([30, 38, 48])
                            };
                            for x in (x_offset + 2)..(x_offset + 198) {
                                for y in 2..72 {
                                    if x >= 0 && x < 800 {
                                        bar_img.put_pixel(x as u32, y as u32, focus_bg);
                                    }
                                }
                            }
                        }

                        // Top Row (Type Icon): Y = 9, size 26.0
                        let icon_str = if is_terminal { ">_" } else { "🌐" };
                        let icon_width = measure_text_width(&font, icon_str, 26.0);
                        draw_text(&mut bar_img, &font, icon_str, x_offset + 100 - (icon_width / 2), 9, 26.0, pane_color);

                        // Second Row (Name + Emoji at end): Y = 44, size 14.0
                        let trimmed_name = trim_pane_name(&pane.name, 17);
                        let name_width = measure_text_width(&font, &trimmed_name, 14.0);
                        draw_text(&mut bar_img, &font, &trimmed_name, x_offset + 100 - (name_width / 2), 44, 14.0, pane_color);
                    }
                    TouchBarItem::AddPane => {
                        let plus_color = image::Rgb([230, 180, 50]); // Yellow accent
                        let text_plus = "+";
                        let plus_width = measure_text_width(&font, text_plus, 26.0);
                        draw_text(&mut bar_img, &font, text_plus, x_offset + 100 - (plus_width / 2), 9, 26.0, plus_color);

                        let text_sub = "PANE";
                        let sub_width = measure_text_width(&font, text_sub, 14.0);
                        draw_text(&mut bar_img, &font, text_sub, x_offset + 100 - (sub_width / 2), 44, 14.0, plus_color);
                    }
                    TouchBarItem::AddTab => {
                        let plus_color = image::Rgb([230, 180, 50]); // Yellow accent
                        let text_plus = "+";
                        let plus_width = measure_text_width(&font, text_plus, 26.0);
                        draw_text(&mut bar_img, &font, text_plus, x_offset + 100 - (plus_width / 2), 9, 26.0, plus_color);

                        let text_sub = "TAB";
                        let sub_width = measure_text_width(&font, text_sub, 14.0);
                        draw_text(&mut bar_img, &font, text_sub, x_offset + 100 - (sub_width / 2), 44, 14.0, plus_color);
                    }
                }
            }

            // Draw scroll indicator arrows if there are more than 4 items
            let max_offset = total_len.saturating_sub(4);
            if max_offset > 0 {
                let arrow_color = image::Rgb([180, 180, 180]);
                if offset > 0 {
                    // Left arrow `<` at X = 8, Y = 32
                    draw_text(&mut bar_img, &font, "<", 8, 32, 28.0, arrow_color);
                }
                if offset < max_offset {
                    // Right arrow `>` at X = 782, Y = 32
                    let arrow_width = measure_text_width(&font, ">", 28.0);
                    draw_text(&mut bar_img, &font, ">", 800 - 8 - arrow_width, 32, 28.0, arrow_color);
                }
            }
        } else {
            eprintln!("Failed to parse font data");
        }
    } else {
        eprintln!("Failed to read any font from paths");
    }

    // Compress to JPEG and send
    let mut jpeg_bytes = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 85);
    encoder.encode(&bar_img, 800, 100, image::ColorType::Rgb8)?;

    deck.fill_lcd_image(0, 0, 800, 100, &jpeg_bytes)?;

    Ok(())
}

fn draw_text(
    img: &mut image::ImageBuffer<image::Rgb<u8>, Vec<u8>>,
    font: &Font,
    text: &str,
    x: i32,
    y: i32,
    size: f32,
    color: image::Rgb<u8>,
) {
    let scale = Scale::uniform(size);
    let v_metrics = font.v_metrics(scale);
    let glyphs: Vec<_> = font
        .layout(text, scale, point(x as f32, y as f32 + v_metrics.ascent))
        .collect();

    for glyph in glyphs {
        if let Some(bounding_box) = glyph.pixel_bounding_box() {
            glyph.draw(|gx, gy, gv| {
                let px = bounding_box.min.x + gx as i32;
                let py = bounding_box.min.y + gy as i32;
                if px >= 0 && px < img.width() as i32 && py >= 0 && py < img.height() as i32 {
                    let pixel = img.get_pixel_mut(px as u32, py as u32);
                    // Alpha blend text
                    let alpha = gv;
                    let r = ((color.0[0] as f32 * alpha) + (pixel.0[0] as f32 * (1.0 - alpha))) as u8;
                    let g = ((color.0[1] as f32 * alpha) + (pixel.0[1] as f32 * (1.0 - alpha))) as u8;
                    let b = ((color.0[2] as f32 * alpha) + (pixel.0[2] as f32 * (1.0 - alpha))) as u8;
                    *pixel = image::Rgb([r, g, b]);
                }
            });
        }
    }
}
