use elgato_streamdeck::images::ImageRect;
use elgato_streamdeck::StreamDeck;
use image::{DynamicImage, Rgb, RgbImage};
use std::time::{Duration, Instant};

use super::config::{ButtonConfig, Config};

// ══════════════════════════════════════════════════════════
//  PSEUDO-RANDOM (deterministic, no deps)
// ══════════════════════════════════════════════════════════

pub fn prand(seed: u64, salt: u64) -> u32 {
    let mut h = seed.wrapping_mul(6364136223846793005).wrapping_add(salt.wrapping_mul(1442695040888963407));
    h ^= h >> 16;
    h = h.wrapping_mul(0x45d9f3b);
    h ^= h >> 16;
    (h & 0xFFFFFFFF) as u32
}

// ══════════════════════════════════════════════════════════
//  CJK GLYPHS — 8x8 pixel bitmaps of Chinese characters
// ══════════════════════════════════════════════════════════

const CJK_GLYPHS: [[u8; 8]; 16] = [
    [0x10, 0x10, 0x7E, 0x10, 0x28, 0x44, 0x82, 0x00],
    [0x10, 0x7E, 0x52, 0x52, 0x7E, 0x10, 0x10, 0x00],
    [0x10, 0x10, 0x28, 0x28, 0x44, 0x44, 0x82, 0x00],
    [0x10, 0x54, 0x54, 0x54, 0x54, 0x54, 0x7C, 0x00],
    [0x10, 0x92, 0x54, 0x38, 0x10, 0x28, 0x44, 0x82],
    [0x10, 0x54, 0x54, 0x10, 0x28, 0x44, 0x82, 0x00],
    [0x7E, 0x42, 0x42, 0x7E, 0x42, 0x42, 0x7E, 0x00],
    [0x7C, 0x44, 0x7C, 0x44, 0x7C, 0x04, 0x04, 0x00],
    [0x7E, 0x10, 0x10, 0x7E, 0x10, 0x28, 0x44, 0x82],
    [0x00, 0x24, 0x00, 0x42, 0x81, 0x81, 0x42, 0x3C],
    [0x7E, 0x10, 0x7E, 0x52, 0x7E, 0x52, 0x81, 0x00],
    [0x10, 0x7E, 0x10, 0x10, 0x7E, 0x92, 0x10, 0x44],
    [0x20, 0x20, 0x7E, 0x22, 0x22, 0x22, 0x42, 0x82],
    [0x10, 0x28, 0x7E, 0x10, 0x7E, 0x28, 0x44, 0x82],
    [0x10, 0x10, 0x7E, 0x10, 0x28, 0x44, 0x82, 0x00],
    [0x24, 0x7E, 0x24, 0x00, 0x7C, 0x44, 0x44, 0x7C],
];

struct StripColumn {
    x: u32,
    head_y: f32,
    speed: f32,
    trail_len: usize,
    glyphs: Vec<usize>,
}

struct StripMatrix {
    columns: Vec<StripColumn>,
}

impl StripMatrix {
    fn new(n_columns: u32, _scale: u32) -> Self {
        let mut columns = Vec::new();
        for i in 0..n_columns {
            columns.push(StripColumn {
                x: (prand(i as u64, 50) % 800) as u32,
                head_y: 100.0 + (prand(i as u64, 51) % 100) as f32,
                speed: 1.0 + (prand(i as u64, 52) % 25) as f32 / 10.0,
                trail_len: 2 + (prand(i as u64, 53) % 4) as usize,
                glyphs: (0..8).map(|j| (prand(i as u64 * 8 + j, 54) % 16) as usize).collect(),
            });
        }
        Self { columns }
    }

    fn tick(&mut self, frame: u64) {
        for col in &mut self.columns {
            col.head_y -= col.speed;
            if col.head_y < -80.0 {
                col.head_y = 100.0 + (prand(frame + col.x as u64, 55) % 60) as f32;
                col.speed = 1.0 + (prand(frame + col.x as u64, 56) % 25) as f32 / 10.0;
                for (j, g) in col.glyphs.iter_mut().enumerate() {
                    *g = (prand(frame * 8 + j as u64, 58) % 16) as usize;
                }
            }
        }
    }

    fn render_over(&self, base: &RgbImage, opacity: f32, scale: u32) -> RgbImage {
        let mut img = base.clone();
        let char_h = 8 * scale;

        for col in &self.columns {
            for (i, &glyph_idx) in col.glyphs.iter().enumerate() {
                if i >= col.trail_len { break; }
                let cy = col.head_y + (i as f32 * char_h as f32 * 1.3);
                if cy < -(char_h as f32) || cy >= 100.0 { continue; }

                let fade = 1.0 - (i as f32 / col.trail_len as f32);
                let glyph = CJK_GLYPHS[glyph_idx % 16];

                let cr = if i == 0 { 200 } else { (60.0 * fade) as u8 };
                let cg = if i == 0 { 240 } else { (120.0 * fade) as u8 };
                let cb = if i == 0 { 255 } else { (220.0 * fade) as u8 };

                for row in 0..8u32 {
                    let bits = glyph[row as usize];
                    for bit in 0..8u32 {
                        if bits & (1 << (7 - bit)) != 0 {
                            for dy in 0..scale {
                                for dx in 0..scale {
                                    let px = col.x as i32 + (bit * scale + dx) as i32;
                                    let py = cy as i32 + (row * scale + dy) as i32;
                                    if px >= 0 && py >= 0 && (px as u32) < 800 && (py as u32) < 100 {
                                        let existing = img.get_pixel(px as u32, py as u32);
                                        let a = opacity * fade;
                                        let nr = (existing[0] as f32 * (1.0 - a) + cr as f32 * a) as u8;
                                        let ng = (existing[1] as f32 * (1.0 - a) + cg as f32 * a) as u8;
                                        let nb = (existing[2] as f32 * (1.0 - a) + cb as f32 * a) as u8;
                                        img.put_pixel(px as u32, py as u32, Rgb([nr, ng, nb]));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        img
    }
}

fn write_strip(deck: &StreamDeck, img: &RgbImage) {
    if let Ok(rect) = ImageRect::from_image(DynamicImage::ImageRgb8(img.clone())) {
        deck.write_lcd(0, 0, &rect).ok();
    }
}

pub fn run_boot_sequence(deck: &StreamDeck, config: &Config) -> (Vec<DynamicImage>, DynamicImage) {
    let branded_buttons: Vec<DynamicImage> = config.buttons.iter().map(|b| make_icon_button(b)).collect();
    let branded_strip = make_touchstrip();
    let branded_rgb = branded_strip.to_rgb8();

    if !config.boot.enabled {
        write_strip(deck, &branded_rgb);
        return (branded_buttons, branded_strip);
    }

    let duration_ms = config.boot.duration_ms;
    let n_columns = (config.boot.matrix_density as f32 * 0.15).max(4.0).min(15.0) as u32;
    let scale = 2u32;

    let mut matrix = StripMatrix::new(n_columns, scale);
    let start = Instant::now();
    let duration = Duration::from_millis(duration_ms);
    let mut frame: u64 = 0;

    while start.elapsed() < duration {
        let progress = start.elapsed().as_millis() as f32 / duration_ms as f32;

        let matrix_opacity = if progress < 0.6 {
            0.85
        } else {
            0.85 * (1.0 - (progress - 0.6) / 0.4)
        };

        let gnosis_brightness = if progress < 0.3 {
            progress / 0.3 * 0.4
        } else {
            0.4 + (progress - 0.3) / 0.7 * 0.6
        };

        let mut base = RgbImage::new(800, 100);
        for y in 0..100u32 {
            for x in 0..800u32 {
                let p = branded_rgb.get_pixel(x, y);
                base.put_pixel(x, y, Rgb([
                    (p[0] as f32 * gnosis_brightness) as u8,
                    (p[1] as f32 * gnosis_brightness) as u8,
                    (p[2] as f32 * gnosis_brightness) as u8,
                ]));
            }
        }

        matrix.tick(frame);
        let composited = matrix.render_over(&base, matrix_opacity, scale);
        write_strip(deck, &composited);
        frame += 1;
    }

    write_strip(deck, &branded_rgb);
    tracing::info!(frames = frame, "Boot sequence complete");

    for (i, img) in branded_buttons.iter().enumerate() {
        match deck.set_button_image(i as u8, img.clone()) {
            Ok(_) => tracing::info!(key = i, "Button image cached OK"),
            Err(e) => tracing::warn!(key = i, error = %e, "Button image cache FAILED"),
        }
    }
    match deck.flush() {
        Ok(_) => tracing::info!("Button images flushed to device"),
        Err(e) => tracing::warn!(error = %e, "Button image flush FAILED"),
    }

    (branded_buttons, branded_strip)
}

pub fn glitch_image(src: &RgbImage, intensity: f32, frame: u64) -> RgbImage {
    let w = src.width();
    let h = src.height();
    let mut out = src.clone();

    let n = (h as f32 * intensity * 0.3) as u32;
    for i in 0..n {
        let y = prand(frame + i as u64, 20) % h;
        let shift = (prand(frame + i as u64, 21) % 20) as i32 - 10;
        let shift = (shift as f32 * intensity) as i32;
        for x in 0..w {
            let sx = ((x as i32 + shift).rem_euclid(w as i32)) as u32;
            out.put_pixel(x, y, *src.get_pixel(sx, y));
        }
    }

    let nc = (h as f32 * intensity * 0.15) as u32;
    for i in 0..nc {
        let y = prand(frame * 3 + i as u64, 22) % h;
        let offset = (prand(frame * 3 + i as u64, 23) % 6) as i32 - 3;
        for x in 0..w {
            let p = *out.get_pixel(x, y);
            let sx = ((x as i32 + offset).rem_euclid(w as i32)) as u32;
            let sp = *src.get_pixel(sx, y);
            out.put_pixel(x, y, Rgb([p[0], p[1], sp[2]]));
        }
    }

    let nn = (w as f32 * h as f32 * intensity * 0.01) as u32;
    for i in 0..nn {
        let x = prand(frame * 7 + i as u64, 24) % w;
        let y = prand(frame * 7 + i as u64, 25) % h;
        let v = (prand(frame * 7 + i as u64, 26) % 200) as u8 + 55;
        out.put_pixel(x, y, Rgb([v / 3, v / 2, v]));
    }
    out
}

pub fn make_icon_button(btn: &ButtonConfig) -> DynamicImage {
    let [r, g, b] = btn.color;

    // Try loading a PNG from assets/ first
    {
        let asset_paths = [
            format!("assets/{}.png", btn.icon),
            format!("sidecar/assets/{}.png", btn.icon),
            format!("../../sidecar/assets/{}.png", btn.icon),
        ];
        for path in &asset_paths {
            if let Ok(loaded) = image::open(path) {
                let resized = loaded.resize_exact(120, 120, image::imageops::FilterType::Lanczos3);
                tracing::info!(icon = %btn.icon, path = %path, "Loaded PNG icon");
                return resized;
            }
        }
    }

    // Fallback: draw procedurally
    let mut img = RgbImage::new(120, 120);
    for y in 0..120u32 {
        for x in 0..120u32 {
            let vig = 1.0 - 0.3 * (((x as f32 - 60.0).powi(2) + (y as f32 - 60.0).powi(2)).sqrt() / 85.0);
            let v = (18.0 * vig).max(0.0) as u8;
            img.put_pixel(x, y, Rgb([v, v, v + 2]));
        }
    }
    match btn.icon.as_str() {
        "eye"      => draw_eye(&mut img, r, g, b),
        "pulse"    => draw_pulse(&mut img, r, g, b),
        "terminal" => draw_terminal(&mut img, r, g, b),
        "bolt"     => draw_bolt(&mut img, r, g, b),
        "brain"    => draw_brain(&mut img, r, g, b),
        "wave"     => draw_wave(&mut img, r, g, b),
        "gear"     => draw_gear(&mut img, r, g, b),
        "gnosis"   => draw_gnosis_icon(&mut img, r, g, b),
        _          => draw_solid(&mut img, r, g, b),
    }

    for i in 0..120u32 {
        let c = Rgb([r / 6, g / 6, b / 6]);
        img.put_pixel(i, 0, c); img.put_pixel(i, 119, c);
        img.put_pixel(0, i, c); img.put_pixel(119, i, c);
    }
    DynamicImage::ImageRgb8(img)
}

pub fn make_touchstrip() -> DynamicImage {
    let mut img = RgbImage::new(800, 100);
    for y in 0..100u32 {
        for x in 0..800u32 {
            let base = 15.0 + 10.0 * (1.0 - (y as f32 - 50.0).abs() / 50.0);
            let accent = (x as f32 / 800.0 * std::f32::consts::PI * 4.0).sin() * 3.0;
            let v = (base + accent).max(0.0).min(255.0) as u8;
            img.put_pixel(x, y, Rgb([v / 2, v, (v as f32 * 1.2).min(255.0) as u8]));
        }
    }
    let letters = pixelfont_hyperia();
    let total_w: usize = letters.iter().map(|l| l[0].len() + 2).sum::<usize>() - 2;
    let scale = 3;
    let sx = (800 - total_w * scale) / 2;
    let sy = (100 - 11 * scale) / 2;
    let mut cx = sx;
    for letter in &letters {
        let lw = letter[0].len();
        for (row, line) in letter.iter().enumerate() {
            for (col, ch) in line.chars().enumerate() {
                if ch == '#' {
                    for dy in 0..scale { for dx in 0..scale {
                        let px = (cx + col * scale + dx) as u32;
                        let py = (sy + row * scale + dy) as u32;
                        if px < 800 && py < 100 { img.put_pixel(px, py, Rgb([160, 220, 255])); }
                    }}
                }
            }
        }
        cx += (lw + 2) * scale;
    }
    for x in 100..700u32 {
        let v = ((1.0 - ((x as f32 - 400.0) / 300.0).abs()) * 80.0).max(0.0) as u8;
        img.put_pixel(x, 8, Rgb([v/2, v, (v as f32 * 1.3).min(255.0) as u8]));
        img.put_pixel(x, 91, Rgb([v/2, v, (v as f32 * 1.3).min(255.0) as u8]));
    }
    DynamicImage::ImageRgb8(img)
}

fn pixelfont_hyperia() -> Vec<Vec<&'static str>> {
    // H Y P E R I A
    vec![
        vec!["##   ##","##   ##","##   ##","#######","##   ##","##   ##","##   ##","##   ##","##   ##","##   ##","##   ##"], // H
        vec!["##   ##","##   ##"," ## ## "," ## ## ","  ###  ","  ###  ","  ###  ","  ###  ","  ###  ","  ###  ","  ###  "], // Y
        vec!["###### ","##   ##","##   ##","##   ##","###### ","##     ","##     ","##     ","##     ","##     ","##     "], // P
        vec!["#######","##     ","##     ","##     ","###### ","##     ","##     ","##     ","##     ","##     ","#######"], // E
        vec!["###### ","##   ##","##   ##","##   ##","###### ","## ##  ","##  ## ","##  ## ","##   ##","##   ##","##   ##"], // R
        vec!["#######","  ###  ","  ###  ","  ###  ","  ###  ","  ###  ","  ###  ","  ###  ","  ###  ","  ###  ","#######"], // I
        vec![" ##### ","##   ##","##   ##","##   ##","#######","##   ##","##   ##","##   ##","##   ##","##   ##","##   ##"], // A
    ]
}

const FONT_5X7: [(char, [u8; 7]); 48] = [
    ('0', [0x0E,0x11,0x13,0x15,0x19,0x11,0x0E]),
    ('1', [0x04,0x0C,0x04,0x04,0x04,0x04,0x0E]),
    ('2', [0x0E,0x11,0x01,0x06,0x08,0x10,0x1F]),
    ('3', [0x0E,0x11,0x01,0x06,0x01,0x11,0x0E]),
    ('4', [0x02,0x06,0x0A,0x12,0x1F,0x02,0x02]),
    ('5', [0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E]),
    ('6', [0x06,0x08,0x10,0x1E,0x11,0x11,0x0E]),
    ('7', [0x1F,0x01,0x02,0x04,0x08,0x08,0x08]),
    ('8', [0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E]),
    ('9', [0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C]),
    ('A', [0x0E,0x11,0x11,0x1F,0x11,0x11,0x11]),
    ('B', [0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E]),
    ('C', [0x0E,0x11,0x10,0x10,0x10,0x11,0x0E]),
    ('D', [0x1E,0x11,0x11,0x11,0x11,0x11,0x1E]),
    ('E', [0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F]),
    ('F', [0x1F,0x10,0x10,0x1E,0x10,0x10,0x10]),
    ('G', [0x0E,0x11,0x10,0x17,0x11,0x11,0x0E]),
    ('H', [0x11,0x11,0x11,0x1F,0x11,0x11,0x11]),
    ('I', [0x0E,0x04,0x04,0x04,0x04,0x04,0x0E]),
    ('K', [0x11,0x12,0x14,0x18,0x14,0x12,0x11]),
    ('L', [0x10,0x10,0x10,0x10,0x10,0x10,0x1F]),
    ('M', [0x11,0x1B,0x15,0x15,0x11,0x11,0x11]),
    ('N', [0x11,0x19,0x15,0x13,0x11,0x11,0x11]),
    ('O', [0x0E,0x11,0x11,0x11,0x11,0x11,0x0E]),
    ('P', [0x1E,0x11,0x11,0x1E,0x10,0x10,0x10]),
    ('R', [0x1E,0x11,0x11,0x1E,0x14,0x12,0x11]),
    ('S', [0x0E,0x11,0x10,0x0E,0x01,0x11,0x0E]),
    ('T', [0x1F,0x04,0x04,0x04,0x04,0x04,0x04]),
    ('U', [0x11,0x11,0x11,0x11,0x11,0x11,0x0E]),
    ('V', [0x11,0x11,0x11,0x11,0x0A,0x0A,0x04]),
    ('W', [0x11,0x11,0x11,0x15,0x15,0x1B,0x11]),
    ('X', [0x11,0x11,0x0A,0x04,0x0A,0x11,0x11]),
    ('Y', [0x11,0x11,0x0A,0x04,0x04,0x04,0x04]),
    (' ', [0x00,0x00,0x00,0x00,0x00,0x00,0x00]),
    ('!', [0x04,0x04,0x04,0x04,0x04,0x00,0x04]),
    (':', [0x00,0x04,0x04,0x00,0x04,0x04,0x00]),
    ('-', [0x00,0x00,0x00,0x1F,0x00,0x00,0x00]),
    ('.', [0x00,0x00,0x00,0x00,0x00,0x00,0x04]),
    (',', [0x00,0x00,0x00,0x00,0x00,0x04,0x08]),
    ('?', [0x0E,0x11,0x01,0x06,0x04,0x00,0x04]),
    ('+', [0x00,0x04,0x04,0x1F,0x04,0x04,0x00]),
    ('=', [0x00,0x00,0x1F,0x00,0x1F,0x00,0x00]),
    ('<', [0x02,0x04,0x08,0x10,0x08,0x04,0x02]),
    ('>', [0x08,0x04,0x02,0x01,0x02,0x04,0x08]),
    ('/', [0x01,0x02,0x02,0x04,0x08,0x08,0x10]),
    ('#', [0x0A,0x1F,0x0A,0x0A,0x1F,0x0A,0x00]),
    ('$', [0x04,0x0E,0x14,0x0E,0x05,0x0E,0x04]),
    ('%', [0x18,0x19,0x04,0x08,0x13,0x03,0x00]),
];

fn get_glyph(ch: char) -> [u8; 7] {
    let upper = ch.to_ascii_uppercase();
    for &(c, data) in &FONT_5X7 {
        if c == upper { return data; }
    }
    [0x00; 7]
}

pub fn render_text_strip(text: &str, bg: [u8; 3], fg: [u8; 3]) -> DynamicImage {
    let scale = 4u32;
    let char_w = 5 * scale + scale;
    let char_h = 7 * scale;
    let total_w = text.len() as u32 * char_w;
    let start_x = if total_w < 800 { (800 - total_w) / 2 } else { 4 };
    let start_y = (100 - char_h) / 2;

    let mut img = RgbImage::from_pixel(800, 100, Rgb(bg));

    for (ci, ch) in text.chars().enumerate() {
        let glyph = get_glyph(ch);
        let ox = start_x + ci as u32 * char_w;
        for row in 0..7u32 {
            let bits = glyph[row as usize];
            for col in 0..5u32 {
                if bits & (1 << (4 - col)) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let px = ox + col * scale + dx;
                            let py = start_y + row * scale + dy;
                            if px < 800 && py < 100 {
                                img.put_pixel(px, py, Rgb(fg));
                            }
                        }
                    }
                }
            }
        }
    }

    DynamicImage::ImageRgb8(img)
}

pub fn render_eye_strip() -> DynamicImage {
    let mut img = RgbImage::new(800, 100);

    let cx = 400.0f32;
    let cy = 50.0f32;
    for y in 0..100u32 {
        for x in 0..800u32 {
            let dx = (x as f32 - cx) / 400.0;
            let dy = (y as f32 - cy) / 50.0;
            let d = (dx * dx + dy * dy).sqrt();
            let v = (12.0 * (1.0 - d * 0.5).max(0.0)) as u8;
            img.put_pixel(x, y, Rgb([v / 3, v / 2, v]));
        }
    }

    for ray in 0..24 {
        let angle = (ray as f32 / 24.0) * std::f32::consts::PI * 2.0;
        let cos_a = angle.cos();
        let sin_a = angle.sin();
        for r in 42..200 {
            let rx = cx + r as f32 * cos_a;
            let ry = cy + r as f32 * sin_a * 0.5;
            if rx >= 0.0 && rx < 800.0 && ry >= 0.0 && ry < 100.0 {
                let fade = (1.0 - (r as f32 - 42.0) / 158.0).max(0.0);
                let intensity = (fade * 25.0) as u8;
                let px = rx as u32;
                let py = ry as u32;
                let existing = img.get_pixel(px, py);
                img.put_pixel(px, py, Rgb([
                    existing[0].saturating_add(intensity / 4),
                    existing[1].saturating_add(intensity / 2),
                    existing[2].saturating_add(intensity),
                ]));
            }
        }
    }

    let eye_w = 180.0f32;
    let eye_h = 38.0f32;
    let eye_cx = 400.0f32;
    let eye_cy = 50.0f32;

    for i in 0..720 {
        let t = (i as f32 / 720.0) * std::f32::consts::PI;
        let x_pos = eye_cx - eye_w * t.cos();
        let y_upper = eye_cy - eye_h * t.sin();
        let y_lower = eye_cy + eye_h * t.sin();

        let lid_color = Rgb([120, 180, 240]);
        for thick in -1..=1 {
            let yu = (y_upper + thick as f32) as u32;
            let yl = (y_lower + thick as f32) as u32;
            let xp = x_pos as u32;
            if xp < 800 {
                if yu < 100 { img.put_pixel(xp, yu, lid_color); }
                if yl < 100 { img.put_pixel(xp, yl, lid_color); }
            }
        }
    }

    for y in 12..88u32 {
        for x in 220..580u32 {
            let dx = (x as f32 - eye_cx) / eye_w;
            let dy = (y as f32 - eye_cy) / eye_h;
            if dx.abs() <= 1.0 {
                let max_dy = (1.0 - dx * dx).sqrt();
                if dy.abs() < max_dy {
                    let existing = img.get_pixel(x, y);
                    img.put_pixel(x, y, Rgb([
                        existing[0] / 3,
                        existing[1] / 3,
                        (existing[2] / 2).max(8),
                    ]));
                }
            }
        }
    }

    let iris_r = 28.0f32;
    for y in 0..100u32 {
        for x in 300..500u32 {
            let dx = x as f32 - eye_cx;
            let dy = y as f32 - eye_cy;
            let d = (dx * dx + dy * dy).sqrt();
            if d < iris_r {
                let t = d / iris_r;
                let r = (20.0 + 60.0 * t) as u8;
                let g = (80.0 + 100.0 * t) as u8;
                let b = (200.0 - 40.0 * t) as u8;
                img.put_pixel(x, y, Rgb([r, g, b]));
            }
        }
    }

    let pupil_r = 12.0f32;
    for y in 38..62u32 {
        for x in 388..412u32 {
            let dx = x as f32 - eye_cx;
            let dy = y as f32 - eye_cy;
            let d = (dx * dx + dy * dy).sqrt();
            if d < pupil_r {
                let edge = (d / pupil_r * 15.0) as u8;
                img.put_pixel(x, y, Rgb([edge / 2, edge, edge + 5]));
            }
        }
    }

    let hl_cx = 390.0f32;
    let hl_cy = 42.0f32;
    let hl_r = 6.0f32;
    for y in 36..48u32 {
        for x in 384..396u32 {
            let dx = x as f32 - hl_cx;
            let dy = y as f32 - hl_cy;
            let d = (dx * dx + dy * dy).sqrt();
            if d < hl_r {
                let bright = ((1.0 - d / hl_r) * 255.0) as u8;
                img.put_pixel(x, y, Rgb([
                    180u8.saturating_add(bright / 4),
                    200u8.saturating_add(bright / 4),
                    255,
                ]));
            }
        }
    }

    let hl2_cx = 406.0f32;
    let hl2_cy = 45.0f32;
    let hl2_r = 3.0f32;
    for y in 42..48u32 {
        for x in 403..409u32 {
            let dx = x as f32 - hl2_cx;
            let dy = y as f32 - hl2_cy;
            let d = (dx * dx + dy * dy).sqrt();
            if d < hl2_r {
                let bright = ((1.0 - d / hl2_r) * 200.0) as u8;
                img.put_pixel(x, y, Rgb([160u8.saturating_add(bright / 3), 190u8.saturating_add(bright / 3), 240]));
            }
        }
    }

    let label = "GNOSIS";
    let scale = 1u32;
    let lx = 520u32;
    let ly = 42u32;
    for (ci, ch) in label.chars().enumerate() {
        let glyph = get_glyph(ch);
        let ox = lx + ci as u32 * (5 * scale + scale);
        for row in 0..7u32 {
            let bits = glyph[row as usize];
            for col in 0..5u32 {
                if bits & (1 << (4 - col)) != 0 {
                    let px = ox + col * scale;
                    let py = ly + row * scale;
                    if px < 800 && py < 100 {
                        img.put_pixel(px, py, Rgb([80, 130, 180]));
                    }
                }
            }
        }
    }

    for y in 0..100u32 {
        for x in 200..600u32 {
            let dx = (x as f32 - eye_cx) / eye_w;
            let dy = (y as f32 - eye_cy) / eye_h;
            if dx.abs() <= 1.2 {
                let max_dy = if dx.abs() <= 1.0 {
                    (1.0 - dx * dx).sqrt()
                } else {
                    0.0
                };
                let dist_to_lid = (dy.abs() - max_dy).abs();
                if dist_to_lid < 0.15 && dist_to_lid > 0.02 {
                    let glow = ((1.0 - dist_to_lid / 0.15) * 30.0) as u8;
                    let existing = img.get_pixel(x, y);
                    img.put_pixel(x, y, Rgb([
                        existing[0].saturating_add(glow / 4),
                        existing[1].saturating_add(glow / 2),
                        existing[2].saturating_add(glow),
                    ]));
                }
            }
        }
    }

    DynamicImage::ImageRgb8(img)
}

// ══════════════════════════════════════════════════════════
//  STOCK TICKER (scrolling 800x100 strip)
// ══════════════════════════════════════════════════════════

pub struct TickerItem {
    pub symbol: String,
    pub price: f32,
    pub change_pct: f32,
}

pub fn render_ticker_frame(items: &[TickerItem], offset: u32) -> DynamicImage {
    let bg = Rgb([5u8, 10, 20]);
    let scale = 3u32;
    let char_w = 5 * scale + scale; // 18px per char cell
    let char_h = 7 * scale;         // 21px tall
    let start_y = (100 - char_h) / 2;

    let cyan: [u8; 3]  = [100, 220, 255];
    let white: [u8; 3]  = [180, 190, 200];
    let green: [u8; 3]  = [40, 220, 80];
    let red: [u8; 3]    = [220, 60, 60];

    // Build colored character list
    let mut chars: Vec<(char, [u8; 3])> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            for _ in 0..3 { chars.push((' ', white)); }
        }
        for ch in item.symbol.chars() { chars.push((ch, cyan)); }
        chars.push((' ', white));
        let price_str = format!("{:.2}", item.price);
        for ch in price_str.chars() { chars.push((ch, white)); }
        chars.push((' ', white));
        let sign = if item.change_pct >= 0.0 { "+" } else { "" };
        let change_str = format!("{}{:.1}%", sign, item.change_pct);
        let color = if item.change_pct >= 0.0 { green } else { red };
        for ch in change_str.chars() { chars.push((ch, color)); }
    }
    // Trailing gap for seamless wrap
    for _ in 0..5 { chars.push((' ', white)); }

    let total_w = chars.len() as u32 * char_w;
    let wrapped_offset = if total_w > 0 { offset % total_w } else { 0 };

    let mut img = RgbImage::from_pixel(800, 100, bg);

    for (ci, &(ch, color)) in chars.iter().enumerate() {
        let glyph = get_glyph(ch);
        let base_x = (ci as u32 * char_w) as i32 - wrapped_offset as i32;

        // Render at base position and wrapped position for seamless scroll
        for &wrap in &[0i32, total_w as i32] {
            let ox = base_x + wrap;
            if ox >= 800 || ox + char_w as i32 <= 0 { continue; }

            for row in 0..7u32 {
                let bits = glyph[row as usize];
                for col in 0..5u32 {
                    if bits & (1 << (4 - col)) != 0 {
                        for dy in 0..scale {
                            for dx in 0..scale {
                                let px = ox + (col * scale + dx) as i32;
                                let py = start_y as i32 + (row * scale + dy) as i32;
                                if px >= 0 && (px as u32) < 800 && py >= 0 && (py as u32) < 100 {
                                    img.put_pixel(px as u32, py as u32, Rgb(color));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    DynamicImage::ImageRgb8(img)
}

// ── Drawing primitives ──

fn px(img: &mut RgbImage, x: i32, y: i32, c: Rgb<u8>) {
    if x >= 0 && x < 120 && y >= 0 && y < 120 { img.put_pixel(x as u32, y as u32, c); }
}

fn circ(img: &mut RgbImage, cx: f32, cy: f32, r: f32, c: Rgb<u8>) {
    let r2 = r * r;
    for y in (cy-r) as i32..=(cy+r) as i32 { for x in (cx-r) as i32..=(cx+r) as i32 {
        if (x as f32-cx).powi(2)+(y as f32-cy).powi(2) <= r2 { px(img, x, y, c); }
    }}
}

fn line(img: &mut RgbImage, x1: f32, y1: f32, x2: f32, y2: f32, t: f32, c: Rgb<u8>) {
    let steps = ((x2-x1).abs().max((y2-y1).abs())) as usize + 1;
    let h = (t/2.0) as i32;
    for s in 0..=steps {
        let f = s as f32 / steps.max(1) as f32;
        let px_ = (x1+f*(x2-x1)) as i32; let py_ = (y1+f*(y2-y1)) as i32;
        for dy in -h..=h { for dx in -h..=h { px(img, px_+dx, py_+dy, c); } }
    }
}

fn draw_eye(img: &mut RgbImage, r: u8, g: u8, b: u8) {
    let c = Rgb([r,g,b]);
    for x in 25..95 { let xf = (x as f32-60.0)/35.0; let hh = (28.0*(1.0-xf*xf).max(0.0).sqrt()) as i32;
        for t in 0..3 { px(img, x, 60-hh-t, c); px(img, x, 60+hh+t, c); } }
    circ(img, 60.0, 60.0, 16.0, c); circ(img, 60.0, 60.0, 8.0, Rgb([10,10,15])); circ(img, 55.0, 55.0, 3.0, Rgb([220,230,255]));
}
fn draw_pulse(img: &mut RgbImage, r: u8, g: u8, b: u8) {
    let c = Rgb([r,g,b]);
    let p = [(15.0,60.0),(35.0,60.0),(42.0,40.0),(50.0,80.0),(58.0,25.0),(66.0,90.0),(74.0,55.0),(82.0,60.0),(105.0,60.0)];
    for i in 0..p.len()-1 { line(img, p[i].0, p[i].1, p[i+1].0, p[i+1].1, 4.0, c); }
}
fn draw_terminal(img: &mut RgbImage, r: u8, g: u8, b: u8) {
    let c = Rgb([r,g,b]);
    for x in 20..100 { for t in 0..2 { px(img, x, 25+t, c); px(img, x, 95+t, c); } }
    for y in 25..97 { for t in 0..2 { px(img, 20+t, y, c); px(img, 99+t, y, c); } }
    for x in 20..100 { for y in 25..33 { px(img, x, y, Rgb([r/3,g/3,b/3])); } }
    line(img, 30.0, 50.0, 42.0, 58.0, 3.0, c); line(img, 42.0, 58.0, 30.0, 66.0, 3.0, c); line(img, 48.0, 68.0, 68.0, 68.0, 3.0, c);
}
fn draw_bolt(img: &mut RgbImage, r: u8, g: u8, b: u8) {
    let c = Rgb([r,g,b]);
    for (x1,y1,x2,y2) in [(68.0,18.0,42.0,55.0),(42.0,55.0,70.0,55.0),(70.0,55.0,38.0,102.0),(38.0,102.0,62.0,62.0),(62.0,62.0,40.0,62.0)] {
        line(img, x1,y1,x2,y2, 5.0, c);
    }
}
fn draw_brain(img: &mut RgbImage, r: u8, g: u8, b: u8) {
    let c = Rgb([r,g,b]);
    circ(img, 48.0, 50.0, 22.0, c); circ(img, 72.0, 50.0, 22.0, c);
    circ(img, 45.0, 68.0, 18.0, c); circ(img, 75.0, 68.0, 18.0, c); circ(img, 60.0, 78.0, 12.0, c);
    for y in 32..90 { px(img, 60, y, Rgb([10,10,15])); }
    let d = Rgb([r/2,g/2,b/2]);
    for y in 40..75 { let w = ((y as f32*0.3).sin()*5.0) as i32; px(img, 48+w, y, d); px(img, 72-w, y, d); }
}
fn draw_wave(img: &mut RgbImage, r: u8, g: u8, b: u8) {
    for w in 0..3 { let by = 38.0+w as f32*20.0; let i = 1.0-w as f32*0.25;
        let c = Rgb([(r as f32*i) as u8,(g as f32*i) as u8,(b as f32*i) as u8]);
        for x in 15..105 { let y = by+10.0*(x as f32*0.08+w as f32*0.8).sin(); for t in 0..4 { px(img, x, y as i32+t, c); } }
    }
}
fn draw_gear(img: &mut RgbImage, r: u8, g: u8, b: u8) {
    let c = Rgb([r,g,b]);
    for a in 0..360 { let ang = (a as f32).to_radians(); let tooth = if a%45<22 { 32.0 } else { 26.0 };
        for rad in 24..tooth as i32 { px(img, (60.0+rad as f32*ang.cos()) as i32, (60.0+rad as f32*ang.sin()) as i32, c); } }
    circ(img, 60.0, 60.0, 22.0, c); circ(img, 60.0, 60.0, 10.0, Rgb([12,12,15]));
}
fn draw_gnosis_icon(img: &mut RgbImage, r: u8, g: u8, b: u8) {
    let c = Rgb([r,g,b]);
    for a in 30..330 { let ang = (a as f32).to_radians();
        for rad in 28..34 { px(img, (60.0+rad as f32*ang.cos()) as i32, (58.0+rad as f32*ang.sin()) as i32, c); } }
    for x in 58..80 { for t in 0..5 { px(img, x, 58+t, c); } }
    circ(img, 60.0, 58.0, 8.0, c); circ(img, 60.0, 58.0, 4.0, Rgb([10,10,15])); circ(img, 58.0, 56.0, 1.5, Rgb([220,230,255]));
}
fn draw_solid(img: &mut RgbImage, r: u8, g: u8, b: u8) {
    for y in 5..115 { for x in 5..115 { px(img, x, y, Rgb([r,g,b])); } }
}
