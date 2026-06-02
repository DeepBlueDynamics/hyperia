//! Black-and-white schematic PNG of a tab's pane layout.
//!
//! Renders the BSP (binary-space-partitioning) bounding box of every pane in a
//! tab as a labeled rectangle, with the tab name in a header bar. Output is a
//! tiny grayscale-1 PNG that a multimodal LLM can ingest directly via the MCP
//! `tab_image` tool — much faster orientation than walking JSON.
//!
//! Design: pure Rust, zero new heavyweight deps. `png` (already a sidecar
//! dep) for encoding, `font8x8` for legible monospace labels. White background,
//! black ink, 1px borders. Each pane shows: label, paneType, title or pid.

use crate::bridge::SessionInfo;
use font8x8::legacy::BASIC_LEGACY;
use std::io::Cursor;

const CANVAS_W: usize = 720;
const CANVAS_H: usize = 480;
const HEADER_H: usize = 28;
const PADDING: usize = 8;
const CHAR_W: usize = 8;
const CHAR_H: usize = 8;

/// One pane to render in the layout.
pub struct PaneCell<'a> {
    pub label: &'a str,
    pub kind: &'a str,        // "shell", "web", "ai"
    pub title: &'a str,       // pane title or process name
    pub subtitle: &'a str,    // cwd, url, etc. (one-liner)
    pub bsp_x: f32,
    pub bsp_y: f32,
    pub bsp_w: f32,
    pub bsp_h: f32,
}

impl<'a> From<&'a SessionInfo> for PaneCell<'a> {
    fn from(s: &'a SessionInfo) -> Self {
        let title = if !s.title.is_empty() { s.title.as_str() } else { s.name.as_str() };
        let subtitle = if !s.cwd.is_empty() { s.cwd.as_str() } else { "" };
        PaneCell {
            label: &s.split_label,
            kind: "shell",
            title,
            subtitle,
            bsp_x: s.bsp_x,
            bsp_y: s.bsp_y,
            bsp_w: s.bsp_w,
            bsp_h: s.bsp_h,
        }
    }
}

/// Render a tab's layout as a grayscale PNG. Returns the PNG bytes.
pub fn render_tab_png(tab_name: &str, panes: &[PaneCell<'_>]) -> Vec<u8> {
    // Single-channel 8-bit grayscale buffer. 0=black, 255=white.
    let mut buf = vec![255u8; CANVAS_W * CANVAS_H];

    // Outer frame.
    draw_rect_outline(&mut buf, 0, 0, CANVAS_W - 1, CANVAS_H - 1, 0);

    // Header bar: separator below it.
    draw_hline(&mut buf, 0, CANVAS_W - 1, HEADER_H, 0);
    let header_text = format!("Tab: {} ({} pane{})",
        truncate(tab_name, 50),
        panes.len(),
        if panes.len() == 1 { "" } else { "s" });
    draw_text(&mut buf, PADDING, (HEADER_H - CHAR_H) / 2, &header_text, 0);

    // Body region for panes.
    let body_top = HEADER_H + 1;
    let body_left = 0usize;
    let body_w = CANVAS_W;
    let body_h = CANVAS_H - HEADER_H - 1;

    if panes.is_empty() {
        let msg = "(no panes)";
        let x = (CANVAS_W - msg.len() * CHAR_W) / 2;
        let y = body_top + body_h / 2 - CHAR_H / 2;
        draw_text(&mut buf, x, y, msg, 0);
    } else {
        // Map each pane's BSP rect (0..100 in both axes) into the body region.
        // If BSP values look stale or all zero, fall back to an even grid.
        let any_bsp = panes.iter().any(|p| p.bsp_w > 0.0 && p.bsp_h > 0.0);
        for (i, p) in panes.iter().enumerate() {
            let (rx, ry, rw, rh) = if any_bsp && p.bsp_w > 0.0 && p.bsp_h > 0.0 {
                let x = body_left + ((p.bsp_x / 100.0) * body_w as f32) as usize;
                let y = body_top + ((p.bsp_y / 100.0) * body_h as f32) as usize;
                let w = ((p.bsp_w / 100.0) * body_w as f32) as usize;
                let h = ((p.bsp_h / 100.0) * body_h as f32) as usize;
                (x, y, w, h)
            } else {
                // Even row layout — one row per pane.
                let h = body_h / panes.len().max(1);
                (body_left, body_top + i * h, body_w, h)
            };
            draw_pane_cell(&mut buf, rx, ry, rw.max(2), rh.max(2), p);
        }
    }

    // Encode to PNG (grayscale, 8-bit).
    let mut png_bytes: Vec<u8> = Vec::with_capacity(8 * 1024);
    {
        let mut enc = png::Encoder::new(Cursor::new(&mut png_bytes), CANVAS_W as u32, CANVAS_H as u32);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().expect("png header");
        writer.write_image_data(&buf).expect("png data");
    }
    png_bytes
}

// ---------------------------------------------------------------------------
// Drawing primitives — grayscale buffer, 0=black, 255=white.
// ---------------------------------------------------------------------------

fn px(buf: &mut [u8], x: usize, y: usize, v: u8) {
    if x < CANVAS_W && y < CANVAS_H {
        buf[y * CANVAS_W + x] = v;
    }
}

fn draw_hline(buf: &mut [u8], x0: usize, x1: usize, y: usize, v: u8) {
    let (a, b) = (x0.min(x1), x0.max(x1));
    for x in a..=b { px(buf, x, y, v); }
}

fn draw_vline(buf: &mut [u8], x: usize, y0: usize, y1: usize, v: u8) {
    let (a, b) = (y0.min(y1), y0.max(y1));
    for y in a..=b { px(buf, x, y, v); }
}

fn draw_rect_outline(buf: &mut [u8], x0: usize, y0: usize, x1: usize, y1: usize, v: u8) {
    draw_hline(buf, x0, x1, y0, v);
    draw_hline(buf, x0, x1, y1, v);
    draw_vline(buf, x0, y0, y1, v);
    draw_vline(buf, x1, y0, y1, v);
}

fn draw_char(buf: &mut [u8], x: usize, y: usize, ch: char, v: u8) {
    let idx = ch as usize;
    if idx >= BASIC_LEGACY.len() { return; }
    let glyph = BASIC_LEGACY[idx];
    for (row, bits) in glyph.iter().enumerate() {
        for col in 0..8 {
            if bits & (1 << col) != 0 {
                px(buf, x + col, y + row, v);
            }
        }
    }
}

fn draw_text(buf: &mut [u8], x: usize, y: usize, text: &str, v: u8) {
    let mut cx = x;
    for ch in text.chars() {
        if cx + CHAR_W > CANVAS_W { break; }
        draw_char(buf, cx, y, ch, v);
        cx += CHAR_W;
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() }
    else {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

// ---------------------------------------------------------------------------
// Pane cell rendering — one labeled box.
// ---------------------------------------------------------------------------

fn draw_pane_cell(buf: &mut [u8], x: usize, y: usize, w: usize, h: usize, p: &PaneCell<'_>) {
    if w < 4 || h < 4 { return; }
    let right = (x + w - 1).min(CANVAS_W - 1);
    let bottom = (y + h - 1).min(CANVAS_H - 1);
    draw_rect_outline(buf, x, y, right, bottom, 0);

    let inner_x = x + PADDING;
    let inner_y = y + PADDING;
    let inner_w = w.saturating_sub(PADDING * 2);
    if inner_w < CHAR_W { return; }
    let max_chars = inner_w / CHAR_W;

    // Header line: "[a] shell" — empty label means a root (un-split) pane;
    // show "[*]" so it doesn't read as a typo.
    let label_disp = if p.label.is_empty() { "*" } else { p.label };
    let head = truncate(&format!("[{}] {}", label_disp, p.kind), max_chars);
    draw_text(buf, inner_x, inner_y, &head, 0);

    // Underline separator under header.
    let head_pix = head.chars().count() * CHAR_W;
    draw_hline(buf, inner_x, inner_x + head_pix, inner_y + CHAR_H + 1, 0);

    // Title (truncated to cell width).
    if !p.title.is_empty() && h >= 24 + CHAR_H * 2 {
        let title = truncate(p.title, max_chars);
        draw_text(buf, inner_x, inner_y + CHAR_H + 6, &title, 0);
    }

    // Subtitle (cwd / url).
    if !p.subtitle.is_empty() && h >= 24 + CHAR_H * 3 {
        let sub = truncate(p.subtitle, max_chars);
        draw_text(buf, inner_x, inner_y + (CHAR_H + 6) + CHAR_H + 2, &sub, 0);
    }
}
