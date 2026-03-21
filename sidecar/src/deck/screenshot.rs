use image::{DynamicImage, Rgb, RgbImage};
use std::io::Cursor;

use super::state::DeviceState;

const BTN_SIZE: u32 = 120;
const BTN_GAP: u32 = 6;
const PADDING: u32 = 12;
const STRIP_W: u32 = 800;
const STRIP_H: u32 = 100;
const KNOB_AREA_H: u32 = 70;

const TOTAL_W: u32 = PADDING + 8 * (BTN_SIZE + BTN_GAP) - BTN_GAP + PADDING;
const TOTAL_H: u32 = PADDING + BTN_SIZE + BTN_GAP + STRIP_H + BTN_GAP + KNOB_AREA_H + PADDING;

/// Render a composite screenshot of the entire Stream Deck Plus state.
pub fn render_screenshot(state: &DeviceState) -> DynamicImage {
    let mut canvas = RgbImage::from_pixel(TOTAL_W, TOTAL_H, Rgb([25, 25, 30]));

    let btn_y = PADDING;
    for i in 0..8 {
        let btn_x = PADDING + i as u32 * (BTN_SIZE + BTN_GAP);
        let btn_img = state.button_image_or_black(i);
        let btn_rgb = btn_img.to_rgb8();

        draw_rect(&mut canvas, btn_x - 1, btn_y - 1, BTN_SIZE + 2, BTN_SIZE + 2, Rgb([60, 60, 65]));

        for y in 0..BTN_SIZE.min(btn_rgb.height()) {
            for x in 0..BTN_SIZE.min(btn_rgb.width()) {
                canvas.put_pixel(btn_x + x, btn_y + y, *btn_rgb.get_pixel(x, y));
            }
        }

        if state.button_pressed[i] {
            draw_rect(&mut canvas, btn_x, btn_y + BTN_SIZE - 4, BTN_SIZE, 4, Rgb([255, 80, 80]));
        }
    }

    let strip_y = btn_y + BTN_SIZE + BTN_GAP;
    let strip_x = (TOTAL_W - STRIP_W) / 2;
    let strip_img = state.touchstrip_image_or_black();
    let strip_rgb = strip_img.to_rgb8();

    draw_rect(&mut canvas, strip_x - 1, strip_y - 1, STRIP_W + 2, STRIP_H + 2, Rgb([60, 60, 65]));

    for y in 0..STRIP_H.min(strip_rgb.height()) {
        for x in 0..STRIP_W.min(strip_rgb.width()) {
            canvas.put_pixel(strip_x + x, strip_y + y, *strip_rgb.get_pixel(x, y));
        }
    }

    if let Some((tx, _ty)) = state.last_touch {
        let marker_x = strip_x + (tx as u32).min(STRIP_W - 1);
        for dy in 0..STRIP_H {
            if dy % 4 < 2 {
                canvas.put_pixel(marker_x, strip_y + dy, Rgb([255, 255, 255]));
            }
        }
    }

    let knob_y = strip_y + STRIP_H + BTN_GAP;
    let knob_section_w = TOTAL_W / 4;

    for i in 0..4 {
        let cx = i as u32 * knob_section_w + knob_section_w / 2;
        let cy = knob_y + KNOB_AREA_H / 2;
        let radius = 22u32;

        draw_filled_circle(&mut canvas, cx, cy, radius, Rgb([50, 50, 55]));

        let ring_color = if state.encoder_pressed[i] {
            Rgb([255, 120, 60])
        } else {
            Rgb([100, 100, 110])
        };
        draw_circle_outline(&mut canvas, cx, cy, radius, ring_color);

        let pos = state.encoder_positions[i];
        let angle = (pos as f32 * 15.0).to_radians();
        let line_len = radius as f32 - 4.0;
        let ex = cx as f32 + line_len * angle.sin();
        let ey = cy as f32 - line_len * angle.cos();
        draw_line(&mut canvas, cx as f32, cy as f32, ex, ey, Rgb([220, 220, 230]));

        let num_str = format!("{}", pos);
        let text_x = cx as i32 - (num_str.len() as i32 * 3);
        let text_y = cy as i32 + radius as i32 + 4;
        draw_tiny_text(&mut canvas, text_x, text_y, &num_str, Rgb([160, 160, 170]));
    }

    DynamicImage::ImageRgb8(canvas)
}

pub fn encode_jpeg(img: &DynamicImage) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    img.to_rgb8()
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("JPEG encode");
    buf.into_inner()
}

pub fn encode_png(img: &DynamicImage) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    img.to_rgb8()
        .write_to(&mut buf, image::ImageFormat::Png)
        .expect("PNG encode");
    buf.into_inner()
}

fn draw_rect(canvas: &mut RgbImage, x: u32, y: u32, w: u32, h: u32, color: Rgb<u8>) {
    for dx in 0..w {
        for dy in 0..h {
            if dx == 0 || dx == w - 1 || dy == 0 || dy == h - 1 {
                let px = x + dx;
                let py = y + dy;
                if px < canvas.width() && py < canvas.height() {
                    canvas.put_pixel(px, py, color);
                }
            }
        }
    }
}

fn draw_filled_circle(canvas: &mut RgbImage, cx: u32, cy: u32, r: u32, color: Rgb<u8>) {
    let r2 = (r * r) as i32;
    for dy in -(r as i32)..=(r as i32) {
        for dx in -(r as i32)..=(r as i32) {
            if dx * dx + dy * dy <= r2 {
                let px = cx as i32 + dx;
                let py = cy as i32 + dy;
                if px >= 0 && py >= 0 && (px as u32) < canvas.width() && (py as u32) < canvas.height() {
                    canvas.put_pixel(px as u32, py as u32, color);
                }
            }
        }
    }
}

fn draw_circle_outline(canvas: &mut RgbImage, cx: u32, cy: u32, r: u32, color: Rgb<u8>) {
    let r2_outer = (r * r) as i32;
    let ri = r.saturating_sub(2);
    let r2_inner = (ri * ri) as i32;
    for dy in -(r as i32)..=(r as i32) {
        for dx in -(r as i32)..=(r as i32) {
            let d2 = dx * dx + dy * dy;
            if d2 <= r2_outer && d2 >= r2_inner {
                let px = cx as i32 + dx;
                let py = cy as i32 + dy;
                if px >= 0 && py >= 0 && (px as u32) < canvas.width() && (py as u32) < canvas.height() {
                    canvas.put_pixel(px as u32, py as u32, color);
                }
            }
        }
    }
}

fn draw_line(canvas: &mut RgbImage, x1: f32, y1: f32, x2: f32, y2: f32, color: Rgb<u8>) {
    let steps = ((x2 - x1).abs().max((y2 - y1).abs())) as usize + 1;
    for s in 0..=steps {
        let t = s as f32 / steps.max(1) as f32;
        let px = (x1 + t * (x2 - x1)) as i32;
        let py = (y1 + t * (y2 - y1)) as i32;
        for dy in -1..=1 {
            for dx in -1..=1 {
                let fx = px + dx;
                let fy = py + dy;
                if fx >= 0 && fy >= 0 && (fx as u32) < canvas.width() && (fy as u32) < canvas.height() {
                    canvas.put_pixel(fx as u32, fy as u32, color);
                }
            }
        }
    }
}

fn draw_tiny_text(canvas: &mut RgbImage, x: i32, y: i32, text: &str, color: Rgb<u8>) {
    let mut cursor_x = x;
    for ch in text.chars() {
        let glyph = tiny_glyph(ch);
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..4 {
                if bits & (1 << (3 - col)) != 0 {
                    let px = cursor_x + col;
                    let py = y + row as i32;
                    if px >= 0 && py >= 0 && (px as u32) < canvas.width() && (py as u32) < canvas.height() {
                        canvas.put_pixel(px as u32, py as u32, color);
                    }
                }
            }
        }
        cursor_x += 5;
    }
}

fn tiny_glyph(ch: char) -> [u8; 5] {
    match ch {
        '0' => [0b0110, 0b1001, 0b1001, 0b1001, 0b0110],
        '1' => [0b0010, 0b0110, 0b0010, 0b0010, 0b0111],
        '2' => [0b0110, 0b1001, 0b0010, 0b0100, 0b1111],
        '3' => [0b1110, 0b0001, 0b0110, 0b0001, 0b1110],
        '4' => [0b1001, 0b1001, 0b1111, 0b0001, 0b0001],
        '5' => [0b1111, 0b1000, 0b1110, 0b0001, 0b1110],
        '6' => [0b0110, 0b1000, 0b1110, 0b1001, 0b0110],
        '7' => [0b1111, 0b0001, 0b0010, 0b0100, 0b0100],
        '8' => [0b0110, 0b1001, 0b0110, 0b1001, 0b0110],
        '9' => [0b0110, 0b1001, 0b0111, 0b0001, 0b0110],
        '-' => [0b0000, 0b0000, 0b1111, 0b0000, 0b0000],
        '+' => [0b0000, 0b0010, 0b0111, 0b0010, 0b0000],
        ' ' => [0b0000, 0b0000, 0b0000, 0b0000, 0b0000],
        _   => [0b1111, 0b1111, 0b1111, 0b1111, 0b1111],
    }
}
