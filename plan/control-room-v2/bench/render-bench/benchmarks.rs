// Benchmark source code executed by Antigravity (Cool Ocelot) on 2026-09-24
// Rust 1.98.1 release build with black_box protection against dead-code elimination.
// Verified on host architecture: Intel Core Ultra 9 285K / Linux x64 container.

use std::fs::File;
use std::hint::black_box;
use std::io::Read;
use std::time::Instant;
use font8x8::UnicodeFonts;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CellAttr {
    pub fg: String,
    pub bg: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScreenLine {
    pub row: u16,
    pub text: String,
    pub attrs: Vec<CellAttr>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScreenDump {
    pub rows: u16,
    pub cols: u16,
    pub cursor: (u16, u16),
    pub lines: Vec<ScreenLine>,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BinaryCell16 {
    pub grapheme_id: u32,
    pub fg_rgba: u32,
    pub bg_rgba: u32,
    pub attrs: u16,
    pub width: u8,
    pub reserved: u8,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct SpanHeader {
    pub surface_id: u32,
    pub row: u16,
    pub start_col: u16,
    pub count: u16,
    pub flags: u16,
    pub reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct FrameHeader {
    pub magic: u32,
    pub version: u16,
    pub frame_type: u16,
    pub epoch: u32,
    pub sequence: u64,
    pub base_sequence: u64,
    pub payload_bytes: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BinaryCell8 {
    pub codepoint: u32,
    pub fg_idx: u8,
    pub bg_idx: u8,
    pub attrs: u8,
    pub width: u8,
}

fn make_sample_pane(rows: u16, cols: u16, seed: u64) -> ScreenDump {
    let mut lines = Vec::with_capacity(rows as usize);
    let sample_texts = [
        "2026-09-24T18:32:01.402Z [INFO] cargo build --release target: 84/142 crates compiled",
        "2026-09-24T18:32:01.415Z [DEBUG] stream.rs: wall_loop connection from 127.0.0.1:49210",
        "2026-09-24T18:32:01.428Z [WARN] buffer low watermark: 1420 bytes remaining in queue",
        "2026-09-24T18:32:01.440Z [TRACE] bridge.rs: PTY output dispatched 1024 bytes to 4 listeners",
        "2026-09-24T18:32:01.455Z [ERROR] failed to resolve DNS hostname ops-remote.internal: connection refused",
    ];

    for r in 0..rows {
        let base_txt = sample_texts[((r as usize) + (seed as usize)) % sample_texts.len()];
        let mut text = String::with_capacity(cols as usize);
        while text.len() < cols as usize {
            text.push_str(base_txt);
            if text.len() < cols as usize {
                text.push(' ');
            }
        }
        text.truncate(cols as usize);

        let mut attrs = Vec::with_capacity(cols as usize);
        for (i, _) in text.chars().enumerate() {
            let (fg, bold) = if i < 24 {
                ("#888888".to_string(), false)
            } else if i < 31 {
                ("#00ff88".to_string(), true)
            } else {
                ("default".to_string(), false)
            };
            attrs.push(CellAttr {
                fg,
                bg: "default".to_string(),
                bold,
                italic: false,
                underline: false,
            });
        }
        lines.push(ScreenLine {
            row: r,
            text,
            attrs,
        });
    }

    ScreenDump {
        rows,
        cols,
        cursor: (0, 0),
        lines,
    }
}

fn encode_json_delta(pane_id: &str, dump: &ScreenDump, changed_rows: &[u16]) -> String {
    let rows: Vec<_> = changed_rows
        .iter()
        .filter_map(|&y| dump.lines.get(y as usize))
        .map(|line| {
            let cells: Vec<_> = line
                .text
                .chars()
                .enumerate()
                .map(|(i, ch)| {
                    let a = line.attrs.get(i).cloned().unwrap_or(CellAttr {
                        fg: "default".into(),
                        bg: "default".into(),
                        bold: false,
                        italic: false,
                        underline: false,
                    });
                    let attr_bits = (a.bold as u32) | ((a.italic as u32) << 1) | ((a.underline as u32) << 2);
                    json!([ch.to_string(), a.fg, a.bg, attr_bits])
                })
                .collect();
            json!({ "y": line.row, "cells": cells })
        })
        .collect();

    json!({
        "t": "delta",
        "paneId": pane_id,
        "cursor": { "x": dump.cursor.0, "y": dump.cursor.1, "visible": true },
        "rows_data": rows,
    })
    .to_string()
}

fn encode_binary_16(surface_id: u32, dump: &ScreenDump, changed_rows: &[u16], out_buf: &mut Vec<u8>) {
    let header_pos = out_buf.len();
    let dummy_frame_hdr = FrameHeader {
        magic: 0x48595052,
        version: 1,
        frame_type: 2,
        epoch: 1,
        sequence: 100,
        base_sequence: 99,
        payload_bytes: 0,
    };
    let hdr_bytes = unsafe {
        std::slice::from_raw_parts(&dummy_frame_hdr as *const _ as *const u8, std::mem::size_of::<FrameHeader>())
    };
    out_buf.extend_from_slice(hdr_bytes);

    let start_payload = out_buf.len();
    for &r in changed_rows {
        if let Some(line) = dump.lines.get(r as usize) {
            let span_hdr = SpanHeader {
                surface_id,
                row: r,
                start_col: 0,
                count: dump.cols,
                flags: 0,
                reserved: 0,
            };
            let span_bytes = unsafe {
                std::slice::from_raw_parts(&span_hdr as *const _ as *const u8, std::mem::size_of::<SpanHeader>())
            };
            out_buf.extend_from_slice(span_bytes);

            for (i, ch) in line.text.chars().enumerate() {
                let a = line.attrs.get(i);
                let (fg, bold) = match a {
                    Some(attr) => (if attr.fg == "default" { 0xffffffff } else { 0x00ff88ff }, attr.bold),
                    None => (0xffffffff, false),
                };
                let cell = BinaryCell16 {
                    grapheme_id: ch as u32,
                    fg_rgba: fg,
                    bg_rgba: 0x00000000,
                    attrs: if bold { 1 } else { 0 },
                    width: 1,
                    reserved: 0,
                };
                let cell_bytes = unsafe {
                    std::slice::from_raw_parts(&cell as *const _ as *const u8, std::mem::size_of::<BinaryCell16>())
                };
                out_buf.extend_from_slice(cell_bytes);
            }
        }
    }
    let payload_len = (out_buf.len() - start_payload) as u32;
    let payload_len_bytes = payload_len.to_le_bytes();
    out_buf[header_pos + 28..header_pos + 32].copy_from_slice(&payload_len_bytes);
}

fn encode_binary_8(surface_id: u32, dump: &ScreenDump, changed_rows: &[u16], out_buf: &mut Vec<u8>) {
    let header_pos = out_buf.len();
    let dummy_frame_hdr = FrameHeader {
        magic: 0x48595052,
        version: 1,
        frame_type: 2,
        epoch: 1,
        sequence: 100,
        base_sequence: 99,
        payload_bytes: 0,
    };
    let hdr_bytes = unsafe {
        std::slice::from_raw_parts(&dummy_frame_hdr as *const _ as *const u8, std::mem::size_of::<FrameHeader>())
    };
    out_buf.extend_from_slice(hdr_bytes);

    let start_payload = out_buf.len();
    for &r in changed_rows {
        if let Some(line) = dump.lines.get(r as usize) {
            let span_hdr = SpanHeader {
                surface_id,
                row: r,
                start_col: 0,
                count: dump.cols,
                flags: 0,
                reserved: 0,
            };
            let span_bytes = unsafe {
                std::slice::from_raw_parts(&span_hdr as *const _ as *const u8, std::mem::size_of::<SpanHeader>())
            };
            out_buf.extend_from_slice(span_bytes);

            for (i, ch) in line.text.chars().enumerate() {
                let cell = BinaryCell8 {
                    codepoint: ch as u32,
                    fg_idx: 15,
                    bg_idx: 0,
                    attrs: 0,
                    width: 1,
                };
                let cell_bytes = unsafe {
                    std::slice::from_raw_parts(&cell as *const _ as *const u8, std::mem::size_of::<BinaryCell8>())
                };
                out_buf.extend_from_slice(cell_bytes);
            }
        }
    }
    let payload_len = (out_buf.len() - start_payload) as u32;
    let payload_len_bytes = payload_len.to_le_bytes();
    out_buf[header_pos + 28..header_pos + 32].copy_from_slice(&payload_len_bytes);
}

fn main() {
    println!("=== CONTROL ROOM v2: RENDER & TRANSPORT BENCHMARK ===");
    println!("Timestamp: 2026-09-24");
    println!("Target: 16 active streaming panes (120 cols x 40 rows each)");
    println!("Total visible room cells: 16 * 120 * 40 = 76,800 cells\n");

    let num_panes = 16;
    let cols = 120;
    let rows = 40;
    let panes: Vec<ScreenDump> = (0..num_panes)
        .map(|i| make_sample_pane(rows, cols, i as u64))
        .collect();

    // 1. Serialization
    let dirty_2_rows: Vec<u16> = vec![38, 39];
    let dirty_40_rows: Vec<u16> = (0..rows).collect();

    let iters = 200;
    let t0 = Instant::now();
    let mut json_2_bytes = 0;
    for _ in 0..iters {
        for (i, p) in panes.iter().enumerate() {
            let s = encode_json_delta(&format!("pane-{}", i), p, &dirty_2_rows);
            if json_2_bytes == 0 { json_2_bytes += s.len(); }
        }
    }
    let json_2_dur = t0.elapsed() / iters;
    let total_json_2_bytes = json_2_bytes * num_panes;

    let iters_full = 50;
    let t0 = Instant::now();
    let mut json_40_bytes = 0;
    for _ in 0..iters_full {
        for (i, p) in panes.iter().enumerate() {
            let s = encode_json_delta(&format!("pane-{}", i), p, &dirty_40_rows);
            if json_40_bytes == 0 { json_40_bytes += s.len(); }
        }
    }
    let json_40_dur = t0.elapsed() / iters_full;
    let total_json_40_bytes = json_40_bytes * num_panes;

    let iters_bin = 1000;
    let mut bin16_buf = Vec::with_capacity(128 * 1024);
    let t0 = Instant::now();
    for _ in 0..iters_bin {
        bin16_buf.clear();
        for (i, p) in panes.iter().enumerate() {
            encode_binary_16(i as u32, p, &dirty_2_rows, &mut bin16_buf);
        }
    }
    let bin16_2_dur = t0.elapsed() / iters_bin;
    let bin16_2_bytes = bin16_buf.len();

    let mut bin16_40_buf = Vec::with_capacity(2 * 1024 * 1024);
    let t0 = Instant::now();
    for _ in 0..iters_bin {
        bin16_40_buf.clear();
        for (i, p) in panes.iter().enumerate() {
            encode_binary_16(i as u32, p, &dirty_40_rows, &mut bin16_40_buf);
        }
    }
    let bin16_40_dur = t0.elapsed() / iters_bin;
    let bin16_40_bytes = bin16_40_buf.len();

    let mut bin8_buf = Vec::with_capacity(64 * 1024);
    let t0 = Instant::now();
    for _ in 0..iters_bin {
        bin8_buf.clear();
        for (i, p) in panes.iter().enumerate() {
            encode_binary_8(i as u32, p, &dirty_2_rows, &mut bin8_buf);
        }
    }
    let bin8_2_dur = t0.elapsed() / iters_bin;
    let bin8_2_bytes = bin8_buf.len();

    let mut bin8_40_buf = Vec::with_capacity(1024 * 1024);
    let t0 = Instant::now();
    for _ in 0..iters_bin {
        bin8_40_buf.clear();
        for (i, p) in panes.iter().enumerate() {
            encode_binary_8(i as u32, p, &dirty_40_rows, &mut bin8_40_buf);
        }
    }
    let bin8_40_dur = t0.elapsed() / iters_bin;
    let bin8_40_bytes = bin8_40_buf.len();

    println!("SCENARIO A: 2 dirty rows/pane (16 panes = 32 rows = 3,840 cells)");
    println!("  - JSON: payload={} B ({:.2} KB), encode={:.3} ms ({:.3} us/pane), 60fps={:.2} MB/s ({:.2} Mbps)",
        total_json_2_bytes, total_json_2_bytes as f64 / 1024.0, json_2_dur.as_secs_f64() * 1000.0, json_2_dur.as_secs_f64() * 1_000_000.0 / 16.0, (total_json_2_bytes as f64 * 60.0)/(1024.0*1024.0), (total_json_2_bytes as f64 * 60.0 * 8.0)/1_000_000.0);
    println!("  - Binary 16B: payload={} B ({:.2} KB), encode={:.3} ms ({:.3} us/pane), 60fps={:.2} MB/s ({:.2} Mbps) [Speedup: {:.1}x]",
        bin16_2_bytes, bin16_2_bytes as f64 / 1024.0, bin16_2_dur.as_secs_f64() * 1000.0, bin16_2_dur.as_secs_f64() * 1_000_000.0 / 16.0, (bin16_2_bytes as f64 * 60.0)/(1024.0*1024.0), (bin16_2_bytes as f64 * 60.0 * 8.0)/1_000_000.0, json_2_dur.as_secs_f64()/bin16_2_dur.as_secs_f64());
    println!("  - Binary 8B: payload={} B ({:.2} KB), encode={:.3} ms ({:.3} us/pane), 60fps={:.2} MB/s ({:.2} Mbps)",
        bin8_2_bytes, bin8_2_bytes as f64 / 1024.0, bin8_2_dur.as_secs_f64() * 1000.0, bin8_2_dur.as_secs_f64() * 1_000_000.0 / 16.0, (bin8_2_bytes as f64 * 60.0)/(1024.0*1024.0), (bin8_2_bytes as f64 * 60.0 * 8.0)/1_000_000.0);

    println!("SCENARIO B: Full 40 rows/pane (16 panes = 640 rows = 76,800 cells)");
    println!("  - JSON: payload={} B ({:.2} MB), encode={:.3} ms ({:.3} ms/pane), 60fps={:.2} MB/s ({:.2} Mbps)",
        total_json_40_bytes, total_json_40_bytes as f64 / (1024.0*1024.0), json_40_dur.as_secs_f64() * 1000.0, json_40_dur.as_secs_f64() * 1000.0 / 16.0, (total_json_40_bytes as f64 * 60.0)/(1024.0*1024.0), (total_json_40_bytes as f64 * 60.0 * 8.0)/1_000_000.0);
    println!("  - Binary 16B: payload={} B ({:.2} MB), encode={:.3} ms ({:.3} us/pane), 60fps={:.2} MB/s ({:.2} Mbps) [Speedup: {:.1}x]",
        bin16_40_bytes, bin16_40_bytes as f64 / (1024.0*1024.0), bin16_40_dur.as_secs_f64() * 1000.0, bin16_40_dur.as_secs_f64() * 1_000_000.0 / 16.0, (bin16_40_bytes as f64 * 60.0)/(1024.0*1024.0), (bin16_40_bytes as f64 * 60.0 * 8.0)/1_000_000.0, json_40_dur.as_secs_f64()/bin16_40_dur.as_secs_f64());
    println!("  - Binary 8B: payload={} B ({:.2} MB), encode={:.3} ms ({:.3} us/pane), 60fps={:.2} MB/s ({:.2} Mbps)",
        bin8_40_bytes, bin8_40_bytes as f64 / (1024.0*1024.0), bin8_40_dur.as_secs_f64() * 1000.0, bin8_40_dur.as_secs_f64() * 1_000_000.0 / 16.0, (bin8_40_bytes as f64 * 60.0)/(1024.0*1024.0), (bin8_40_bytes as f64 * 60.0 * 8.0)/1_000_000.0);

    // 2. Fontdue
    let font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
    let mut font_bytes = Vec::new();
    let mut file = File::open(font_path).expect("Failed to open DejaVu font");
    file.read_to_end(&mut font_bytes).expect("Failed to read font");
    let t0 = Instant::now();
    let font = fontdue::Font::from_bytes(font_bytes.as_slice(), fontdue::FontSettings::default()).expect("Failed to parse font");
    println!("fontdue Font::from_bytes: {:.3} ms", t0.elapsed().as_secs_f64() * 1000.0);

    let t0 = Instant::now();
    for _ in 0..500 {
        for c in 32u8..127u8 {
            let (_, _) = font.rasterize(c as char, 16.0);
        }
    }
    println!("fontdue rasterize 95 ASCII glyphs (size 16px): {:.3} ms total ({:.3} us/glyph)",
        t0.elapsed().as_secs_f64() * 1000.0 / 500.0, t0.elapsed().as_secs_f64() * 1_000_000.0 / (500.0 * 95.0));

    // 3. vt100
    let mut parser = vt100::Parser::new(rows, cols, 100);
    let sample_120b = b"\x1b[32m[2026-09-24T18:32:01Z INFO]\x1b[0m cargo build: compiling target package v0.2.14 (42/100 compiled)...\r\n";
    let sample_1kb = sample_120b.repeat(9);
    let sample_4kb = sample_120b.repeat(36);
    let sample_16kb = sample_120b.repeat(144);

    let t0 = Instant::now();
    for _ in 0..10000 { parser.process(black_box(sample_120b.as_slice())); }
    println!("vt100 process(120 B): {:.3} us", t0.elapsed().as_secs_f64() * 1_000_000.0 / 10000.0);

    let t0 = Instant::now();
    for _ in 0..10000 { parser.process(black_box(sample_1kb.as_slice())); }
    let p_1kb_dur = t0.elapsed() / 10000;
    println!("vt100 process(1.0 KB): {:.3} us", p_1kb_dur.as_secs_f64() * 1_000_000.0);

    let t0 = Instant::now();
    for _ in 0..2000 { parser.process(black_box(sample_4kb.as_slice())); }
    println!("vt100 process(4.0 KB): {:.3} us", t0.elapsed().as_secs_f64() * 1_000_000.0 / 2000.0);

    let t0 = Instant::now();
    for _ in 0..500 { parser.process(black_box(sample_16kb.as_slice())); }
    println!("vt100 process(16.0 KB): {:.3} us", t0.elapsed().as_secs_f64() * 1_000_000.0 / 500.0);

    let t0 = Instant::now();
    let mut seed_len = 0;
    for _ in 0..1000 {
        let seed = parser.screen().contents_formatted();
        if seed_len == 0 { seed_len = seed.len(); }
        let mut new_p = vt100::Parser::new(rows, cols, 100);
        new_p.process(black_box(&seed));
    }
    println!("vt100 seed reproduction (contents_formatted + new parser refeed, {} B): {:.3} us", seed_len, t0.elapsed().as_secs_f64() * 1_000_000.0 / 1000.0);

    // 4. CPU Compositing
    let fb_w = 3840usize;
    let fb_h = 2160usize;
    let fb_bytes = fb_w * fb_h * 4;
    let mut fb = vec![0u8; fb_bytes];
    let t0 = Instant::now();
    for _ in 0..50 { fb.fill(black_box(0)); black_box(&fb); }
    println!("CPU 4K buffer fill(0) (clear): {:.3} ms", t0.elapsed().as_secs_f64() * 1000.0 / 50.0);

    let mut fb2 = vec![0u8; fb_bytes];
    let t0 = Instant::now();
    for _ in 0..50 { fb2.copy_from_slice(black_box(&fb)); black_box(&fb2); }
    println!("CPU 4K buffer copy_from_slice (memcpy): {:.3} ms", t0.elapsed().as_secs_f64() * 1000.0 / 50.0);

    let cell_w = 8usize;
    let cell_h = 13usize;
    let t0 = Instant::now();
    for _ in 0..100 {
        for pane_idx in 0..16 {
            let px_x = (pane_idx % 4) * 960;
            let px_y = (pane_idx / 4) * 540;
            for r in 0..2 {
                let y = px_y + (r + 38) * cell_h;
                for c in 0..120 {
                    let x = px_x + c * cell_w;
                    for gy in 0..cell_h {
                        let dst_idx = ((y + gy) * fb_w + x) * 4;
                        if dst_idx + cell_w * 4 <= fb.len() {
                            for gx in 0..cell_w {
                                fb[dst_idx + gx * 4] = 0x00;
                                fb[dst_idx + gx * 4 + 1] = 0xff;
                                fb[dst_idx + gx * 4 + 2] = 0x88;
                                fb[dst_idx + gx * 4 + 3] = 0xff;
                            }
                        }
                    }
                }
            }
        }
        black_box(&fb);
    }
    println!("CPU blit 2 dirty rows/pane (3,840 cells across all 16 panes): {:.3} ms total ({:.3} us/pane)",
        t0.elapsed().as_secs_f64() * 1000.0 / 100.0, t0.elapsed().as_secs_f64() * 1_000_000.0 / (100.0 * 16.0));

    let t0 = Instant::now();
    for _ in 0..20 {
        for pane_idx in 0..16 {
            let px_x = (pane_idx % 4) * 960;
            let px_y = (pane_idx / 4) * 540;
            for r in 0..40 {
                let y = px_y + r * cell_h;
                for c in 0..120 {
                    let x = px_x + c * cell_w;
                    for gy in 0..cell_h {
                        let dst_idx = ((y + gy) * fb_w + x) * 4;
                        if dst_idx + cell_w * 4 <= fb.len() {
                            for gx in 0..cell_w {
                                fb[dst_idx + gx * 4] = 0x00;
                                fb[dst_idx + gx * 4 + 1] = 0xff;
                                fb[dst_idx + gx * 4 + 2] = 0x88;
                                fb[dst_idx + gx * 4 + 3] = 0xff;
                            }
                        }
                    }
                }
            }
        }
        black_box(&fb);
    }
    println!("CPU blit full screen (76,800 cells across all 16 panes): {:.3} ms total", t0.elapsed().as_secs_f64() * 1000.0 / 20.0);
}
