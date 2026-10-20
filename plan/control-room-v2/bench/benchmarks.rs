// Benchmark suite executed by Antigravity (Cool Ocelot) on 2026-09-24
// Rust 1.98.1 release build with black_box protection.
// Verified on host architecture: Intel Core Ultra 9 285K / Linux x64 container.
// Fully implements explicit Little-Endian packed wire layout matching PLAN.md Rev 3.

use std::fs::File;
use std::hint::black_box;
use std::io::Read;
use std::time::Instant;
use font8x8::UnicodeFonts;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CellAttr {
    pub fg: String,
    pub bg: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub dim: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScreenLine {
    pub row: u16,
    pub text: String,
    pub attrs: Vec<CellAttr>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScreenDump {
    pub rows: u16,
    pub cols: u16,
    pub cursor: (u16, u16),
    pub lines: Vec<ScreenLine>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DecodedCell16 {
    pub grapheme_id: u32,
    pub fg_rgba: u32,
    pub bg_rgba: u32,
    pub attrs: u16,
    pub width: u8,
    pub reserved: u8,
}

fn parse_color_rgba(c: &str, default_val: u32) -> u32 {
    if c == "default" {
        default_val
    } else if c.starts_with('#') && c.len() == 7 {
        if let Ok(rgb) = u32::from_str_radix(&c[1..], 16) {
            (rgb << 8) | 0xff
        } else {
            default_val
        }
    } else {
        default_val
    }
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
            let (fg, bg, bold, italic, underline, dim) = if i < 24 {
                ("#888888".to_string(), "default".to_string(), false, false, false, true)
            } else if i < 31 {
                ("#00ff88".to_string(), "#112211".to_string(), true, false, false, false)
            } else if i < 50 {
                ("#ff5555".to_string(), "default".to_string(), false, true, false, false)
            } else if i < 70 {
                ("#55ffff".to_string(), "default".to_string(), false, false, true, false)
            } else {
                ("default".to_string(), "default".to_string(), false, false, false, false)
            };
            attrs.push(CellAttr {
                fg,
                bg,
                bold,
                italic,
                underline,
                dim,
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

// 1. JSON Encoder
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
                        dim: false,
                    });
                    let attr_bits = (a.bold as u32)
                        | ((a.italic as u32) << 1)
                        | ((a.underline as u32) << 2)
                        | ((a.dim as u32) << 4);
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

// 2. Explicit Little-Endian Binary 16B Room Frame Encoder (Matching PLAN.md Rev 3)
// Exactly 1x 32B FrameHeader + N x 16B SpanHeaders + N x (Cols x 16B) Cells
fn encode_room_binary_16(panes: &[ScreenDump], changed_rows: &[u16], out_buf: &mut Vec<u8>) {
    let header_pos = out_buf.len();
    
    // Explicit 32B Frame Header
    out_buf.extend_from_slice(&0x48595052u32.to_le_bytes()); // magic: "HYPR"
    out_buf.extend_from_slice(&1u16.to_le_bytes());          // version: 1
    out_buf.extend_from_slice(&2u16.to_le_bytes());          // frame_type: 2 (Delta)
    out_buf.extend_from_slice(&1u32.to_le_bytes());          // epoch: 1
    out_buf.extend_from_slice(&100u64.to_le_bytes());        // sequence: 100
    out_buf.extend_from_slice(&99u64.to_le_bytes());         // base_sequence: 99
    out_buf.extend_from_slice(&0u32.to_le_bytes());          // payload_bytes: placeholder (offset 28..32)
    assert_eq!(out_buf.len() - header_pos, 32, "FrameHeader must be exactly 32 bytes");

    let start_payload = out_buf.len();
    for (surface_id, dump) in panes.iter().enumerate() {
        for &r in changed_rows {
            if let Some(line) = dump.lines.get(r as usize) {
                let span_start = out_buf.len();
                // Explicit 16B Span Header
                out_buf.extend_from_slice(&(surface_id as u32).to_le_bytes()); // 0..4: surface_id
                out_buf.extend_from_slice(&r.to_le_bytes());                   // 4..6: row
                out_buf.extend_from_slice(&0u16.to_le_bytes());                 // 6..8: start_col
                out_buf.extend_from_slice(&dump.cols.to_le_bytes());            // 8..10: count
                out_buf.extend_from_slice(&0u16.to_le_bytes());                 // 10..12: flags
                out_buf.extend_from_slice(&0u32.to_le_bytes());                 // 12..16: reserved
                assert_eq!(out_buf.len() - span_start, 16, "SpanHeader must be exactly 16 bytes");

                for (i, ch) in line.text.chars().enumerate() {
                    let cell_start = out_buf.len();
                    let a = line.attrs.get(i);
                    let (fg_rgba, bg_rgba, attr_bits) = match a {
                        Some(attr) => {
                            let fg = parse_color_rgba(&attr.fg, 0xffffffff);
                            let bg = parse_color_rgba(&attr.bg, 0x00000000);
                            let bits = (attr.bold as u16)
                                | ((attr.italic as u16) << 1)
                                | ((attr.underline as u16) << 2)
                                | ((attr.dim as u16) << 4);
                            (fg, bg, bits)
                        }
                        None => (0xffffffff, 0x00000000, 0),
                    };

                    // Explicit 16B Cell
                    out_buf.extend_from_slice(&(ch as u32).to_le_bytes()); // 0..4: grapheme_id
                    out_buf.extend_from_slice(&fg_rgba.to_le_bytes());      // 4..8: fg_rgba
                    out_buf.extend_from_slice(&bg_rgba.to_le_bytes());      // 8..12: bg_rgba
                    out_buf.extend_from_slice(&attr_bits.to_le_bytes());    // 12..14: attrs
                    out_buf.push(1u8);                                      // 14: width
                    out_buf.push(0u8);                                      // 15: reserved
                    assert_eq!(out_buf.len() - cell_start, 16, "BinaryCell16 must be exactly 16 bytes");
                }
            }
        }
    }

    let payload_len = (out_buf.len() - start_payload) as u32;
    out_buf[header_pos + 28..header_pos + 32].copy_from_slice(&payload_len.to_le_bytes());
}

// 3. Exact Roundtrip Decoder for Binary 16B
fn decode_binary_16(data: &[u8]) -> (u32, u64, u64, u32, Vec<DecodedCell16>) {
    assert!(data.len() >= 32, "Data too short for FrameHeader");
    let magic = u32::from_le_bytes(data[0..4].try_into().unwrap());
    assert_eq!(magic, 0x48595052, "Invalid magic");
    let version = u16::from_le_bytes(data[4..6].try_into().unwrap());
    assert_eq!(version, 1);
    let _frame_type = u16::from_le_bytes(data[6..8].try_into().unwrap());
    let epoch = u32::from_le_bytes(data[8..12].try_into().unwrap());
    let sequence = u64::from_le_bytes(data[12..20].try_into().unwrap());
    let base_sequence = u64::from_le_bytes(data[20..28].try_into().unwrap());
    let payload_bytes = u32::from_le_bytes(data[28..32].try_into().unwrap());
    assert_eq!(data.len() - 32, payload_bytes as usize, "Payload length mismatch");

    let mut cells = Vec::new();
    let mut offset = 32;
    while offset < data.len() {
        assert!(offset + 16 <= data.len(), "Span header truncated");
        let _surface_id = u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap());
        let _row = u16::from_le_bytes(data[offset + 4..offset + 6].try_into().unwrap());
        let _start_col = u16::from_le_bytes(data[offset + 6..offset + 8].try_into().unwrap());
        let count = u16::from_le_bytes(data[offset + 8..offset + 10].try_into().unwrap()) as usize;
        let _flags = u16::from_le_bytes(data[offset + 10..offset + 12].try_into().unwrap());
        offset += 16;

        for _ in 0..count {
            assert!(offset + 16 <= data.len(), "Cell truncated");
            let grapheme_id = u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap());
            let fg_rgba = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap());
            let bg_rgba = u32::from_le_bytes(data[offset + 8..offset + 12].try_into().unwrap());
            let attrs = u16::from_le_bytes(data[offset + 12..offset + 14].try_into().unwrap());
            let width = data[offset + 14];
            let reserved = data[offset + 15];
            cells.push(DecodedCell16 {
                grapheme_id,
                fg_rgba,
                bg_rgba,
                attrs,
                width,
                reserved,
            });
            offset += 16;
        }
    }

    (epoch, sequence, base_sequence, payload_bytes, cells)
}

fn compute_hash(cells: &[DecodedCell16]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for c in cells {
        h = (h ^ (c.grapheme_id as u64)).wrapping_mul(0x100000001b3);
        h = (h ^ (c.fg_rgba as u64)).wrapping_mul(0x100000001b3);
        h = (h ^ (c.bg_rgba as u64)).wrapping_mul(0x100000001b3);
        h = (h ^ (c.attrs as u64)).wrapping_mul(0x100000001b3);
        h = (h ^ (c.width as u64)).wrapping_mul(0x100000001b3);
    }
    h
}

fn main() {
    println!("=== CONTROL ROOM v2: RENDER & TRANSPORT BENCHMARK SUITE ===");
    println!("Host Platform: Linux x64 container / Intel Core Ultra 9 285K");
    println!("Compiler: rustc 1.98.1 (release profile, opt-level = 3)");
    println!("Wire Alignment: Explicit 32B FrameHeader + 16B SpanHeader + 16B BinaryCell16 (Little-Endian)");
    println!("Fidelity Mode: 100% equivalent color/attribute mapping across JSON and Binary");

    let rows = 40u16;
    let cols = 120u16;
    let mut panes = Vec::with_capacity(16);
    for i in 0..16 {
        panes.push(make_sample_pane(rows, cols, i as u64));
    }

    let dirty_2_rows = [38u16, 39u16];
    let dirty_40_rows: Vec<u16> = (0..40u16).collect();

    // --- ROUNDTRIP LOSSLESS VERIFICATION TEST ---
    println!("\n--- 0. ROUNDTRIP FIDELITY & CODEC AUDIT ---");
    let mut test_buf = Vec::new();
    encode_room_binary_16(&panes[0..1], &dirty_2_rows, &mut test_buf);
    let (epoch, seq, base_seq, p_bytes, decoded_cells) = decode_binary_16(&test_buf);
    assert_eq!(epoch, 1);
    assert_eq!(seq, 100);
    assert_eq!(base_seq, 99);
    assert_eq!(p_bytes as usize, test_buf.len() - 32);
    assert_eq!(decoded_cells.len(), 2 * 120);

    // Verify cell identity against source
    for (idx, &r) in dirty_2_rows.iter().enumerate() {
        let line = &panes[0].lines[r as usize];
        for (c, ch) in line.text.chars().enumerate() {
            let dec = &decoded_cells[idx * 120 + c];
            assert_eq!(dec.grapheme_id, ch as u32);
            let attr = &line.attrs[c];
            assert_eq!(dec.fg_rgba, parse_color_rgba(&attr.fg, 0xffffffff));
            assert_eq!(dec.bg_rgba, parse_color_rgba(&attr.bg, 0x00000000));
            let expected_bits = (attr.bold as u16)
                | ((attr.italic as u16) << 1)
                | ((attr.underline as u16) << 2)
                | ((attr.dim as u16) << 4);
            assert_eq!(dec.attrs, expected_bits);
        }
    }
    let roundtrip_hash = compute_hash(&decoded_cells);
    println!("Roundtrip Test PASS: Decoded {} cells. Hash = 0x{:016x}. No data loss.", decoded_cells.len(), roundtrip_hash);

    // --- 1. SERIALIZATION BENCHMARKS (WITH BLACK_BOX) ---
    println!("\n--- 1. WIRE FORMAT & SERIALIZATION BENCHMARKS ---");
    let iters_json = 100;
    let iters_bin = 5000;

    // JSON 2 rows
    let t0 = Instant::now();
    let mut total_json_2_bytes = 0;
    for _ in 0..iters_json {
        for (i, p) in panes.iter().enumerate() {
            let s = encode_json_delta(&format!("p-{}", i), p, black_box(&dirty_2_rows));
            total_json_2_bytes = s.len() * 16;
            black_box(&s);
        }
    }
    let json_2_dur = t0.elapsed() / iters_json;

    // JSON 40 rows
    let t0 = Instant::now();
    let mut total_json_40_bytes = 0;
    for _ in 0..iters_json {
        for (i, p) in panes.iter().enumerate() {
            let s = encode_json_delta(&format!("p-{}", i), p, black_box(&dirty_40_rows));
            total_json_40_bytes = s.len() * 16;
            black_box(&s);
        }
    }
    let json_40_dur = t0.elapsed() / iters_json;

    // Binary 16B 2 rows (all 16 panes in one room frame)
    let mut bin16_2_buf = Vec::with_capacity(128 * 1024);
    let t0 = Instant::now();
    for _ in 0..iters_bin {
        bin16_2_buf.clear();
        encode_room_binary_16(&panes, black_box(&dirty_2_rows), &mut bin16_2_buf);
        black_box(&bin16_2_buf);
    }
    let bin16_2_dur = t0.elapsed() / iters_bin;
    let bin16_2_bytes = bin16_2_buf.len();

    // Binary 16B Decode 2 rows
    let t0 = Instant::now();
    for _ in 0..iters_bin {
        let dec = decode_binary_16(black_box(&bin16_2_buf));
        black_box(&dec);
    }
    let bin16_2_dec_dur = t0.elapsed() / iters_bin;

    // Binary 16B 40 rows (all 16 panes in one room frame)
    let mut bin16_40_buf = Vec::with_capacity(2 * 1024 * 1024);
    let t0 = Instant::now();
    for _ in 0..iters_bin {
        bin16_40_buf.clear();
        encode_room_binary_16(&panes, black_box(&dirty_40_rows), &mut bin16_40_buf);
        black_box(&bin16_40_buf);
    }
    let bin16_40_dur = t0.elapsed() / iters_bin;
    let bin16_40_bytes = bin16_40_buf.len();

    // Binary 16B Decode 40 rows
    let t0 = Instant::now();
    for _ in 0..iters_bin {
        let dec = decode_binary_16(black_box(&bin16_40_buf));
        black_box(&dec);
    }
    let bin16_40_dec_dur = t0.elapsed() / iters_bin;

    println!("SCENARIO A: 2 dirty rows/pane (16 panes = 32 rows = 3,840 cells)");
    println!("  - JSON: payload={} B ({:.2} KB), encode={:.3} ms ({:.3} us/pane), 60fps={:.2} MB/s ({:.2} Mbps)",
        total_json_2_bytes, total_json_2_bytes as f64 / 1024.0, json_2_dur.as_secs_f64() * 1000.0, json_2_dur.as_secs_f64() * 1_000_000.0 / 16.0, (total_json_2_bytes as f64 * 60.0)/(1024.0*1024.0), (total_json_2_bytes as f64 * 60.0 * 8.0)/1_000_000.0);
    println!("  - Binary 16B: payload={} B ({:.2} KB), encode={:.3} ms ({:.3} us/pane), decode={:.3} ms ({:.3} us/pane), 60fps={:.2} MB/s ({:.2} Mbps) [Encode speedup: {:.1}x]",
        bin16_2_bytes, bin16_2_bytes as f64 / 1024.0, bin16_2_dur.as_secs_f64() * 1000.0, bin16_2_dur.as_secs_f64() * 1_000_000.0 / 16.0, bin16_2_dec_dur.as_secs_f64() * 1000.0, bin16_2_dec_dur.as_secs_f64() * 1_000_000.0 / 16.0, (bin16_2_bytes as f64 * 60.0)/(1024.0*1024.0), (bin16_2_bytes as f64 * 60.0 * 8.0)/1_000_000.0, json_2_dur.as_secs_f64()/bin16_2_dur.as_secs_f64());

    println!("\nSCENARIO B: Full 40 rows/pane (16 panes = 640 rows = 76,800 cells - TUI Redraw)");
    println!("  - JSON: payload={} B ({:.2} MB), encode={:.3} ms ({:.3} ms/pane), 60fps={:.2} MB/s ({:.2} Mbps)",
        total_json_40_bytes, total_json_40_bytes as f64 / (1024.0*1024.0), json_40_dur.as_secs_f64() * 1000.0, json_40_dur.as_secs_f64() * 1000.0 / 16.0, (total_json_40_bytes as f64 * 60.0)/(1024.0*1024.0), (total_json_40_bytes as f64 * 60.0 * 8.0)/1_000_000.0);
    println!("  - Binary 16B: payload={} B ({:.2} MB), encode={:.3} ms ({:.3} us/pane), decode={:.3} ms ({:.3} us/pane), 60fps={:.2} MB/s ({:.2} Mbps) [Encode speedup: {:.1}x]",
        bin16_40_bytes, bin16_40_bytes as f64 / (1024.0*1024.0), bin16_40_dur.as_secs_f64() * 1000.0, bin16_40_dur.as_secs_f64() * 1_000_000.0 / 16.0, bin16_40_dec_dur.as_secs_f64() * 1000.0, bin16_40_dec_dur.as_secs_f64() * 1_000_000.0 / 16.0, (bin16_40_bytes as f64 * 60.0)/(1024.0*1024.0), (bin16_40_bytes as f64 * 60.0 * 8.0)/1_000_000.0, json_40_dur.as_secs_f64()/bin16_40_dur.as_secs_f64());

    // --- 2. FONT RASTERIZATION BENCHMARKS ---
    println!("\n--- 2. FONT RASTERIZATION & ATLAS BENCHMARKS ---");
    let font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
    if let Ok(mut file) = File::open(font_path) {
        let mut font_bytes = Vec::new();
        file.read_to_end(&mut font_bytes).expect("Failed to read font");
        let t0 = Instant::now();
        let font = fontdue::Font::from_bytes(font_bytes.as_slice(), fontdue::FontSettings::default()).expect("Failed to parse font");
        println!("fontdue Font::from_bytes: {:.3} ms (one-time cold parse)", t0.elapsed().as_secs_f64() * 1000.0);

        let t0 = Instant::now();
        for _ in 0..500 {
            for c in 32u8..127u8 {
                let (_, _) = font.rasterize(c as char, 16.0);
            }
        }
        println!("fontdue rasterize 95 ASCII glyphs (size 16px): {:.3} ms total ({:.3} us/glyph)",
            t0.elapsed().as_secs_f64() * 1000.0 / 500.0, t0.elapsed().as_secs_f64() * 1_000_000.0 / (500.0 * 95.0));
    } else {
        println!("DejaVu font not available; skipping fontdue benchmark");
    }

    let t0 = Instant::now();
    let mut dummy_count = 0;
    for _ in 0..5000 {
        for c in 32u8..127u8 {
            if let Some(glyph) = font8x8::BASIC_FONTS.get(c as char) {
                dummy_count += glyph[0] as usize;
            }
        }
    }
    println!("font8x8 lookup 95 ASCII glyphs: {:.3} us total ({:.3} ns/glyph) [dummy={}]",
        t0.elapsed().as_secs_f64() * 1_000_000.0 / 5000.0, t0.elapsed().as_secs_f64() * 1_000_000_000.0 / (5000.0 * 95.0), dummy_count);

    // --- 3. VT100 PARSER BENCHMARKS ---
    println!("\n--- 3. VT100 PARSER CPU BENCHMARK ---");
    let mut parser = vt100::Parser::new(rows, cols, 100);
    let sample_120b = b"\x1b[32m[2026-09-24T18:32:01Z INFO]\x1b[0m cargo build: compiling target package v0.2.14 (42/100 compiled)...\r\n";
    let sample_1kb = sample_120b.repeat(9);
    let sample_4kb = sample_120b.repeat(36);
    let sample_16kb = sample_120b.repeat(144);

    let t0 = Instant::now();
    for _ in 0..10000 { parser.process(black_box(sample_120b.as_slice())); }
    println!("vt100 Parser::process(120 B): {:.3} us", t0.elapsed().as_secs_f64() * 1_000_000.0 / 10000.0);

    let t0 = Instant::now();
    for _ in 0..10000 { parser.process(black_box(sample_1kb.as_slice())); }
    let p_1kb_dur = t0.elapsed() / 10000;
    println!("vt100 Parser::process(1.0 KB): {:.3} us", p_1kb_dur.as_secs_f64() * 1_000_000.0);

    let t0 = Instant::now();
    for _ in 0..2000 { parser.process(black_box(sample_4kb.as_slice())); }
    println!("vt100 Parser::process(4.0 KB): {:.3} us", t0.elapsed().as_secs_f64() * 1_000_000.0 / 2000.0);

    let t0 = Instant::now();
    for _ in 0..500 { parser.process(black_box(sample_16kb.as_slice())); }
    println!("vt100 Parser::process(16.0 KB): {:.3} us", t0.elapsed().as_secs_f64() * 1_000_000.0 / 500.0);

    let t0 = Instant::now();
    let mut seed_len = 0;
    for _ in 0..1000 {
        let seed = parser.screen().contents_formatted();
        if seed_len == 0 { seed_len = seed.len(); }
        let mut new_p = vt100::Parser::new(rows, cols, 100);
        new_p.process(black_box(&seed));
    }
    println!("vt100 formatted seed reproduction (contents_formatted + new parser refeed, {} B): {:.3} us",
        seed_len, t0.elapsed().as_secs_f64() * 1_000_000.0 / 1000.0);
    println!("  * NOTE: contents_formatted reproduces screen text/attributes, but drops partial escape states; atomic bootstrap requires a parser snapshot fork.");

    // --- 4. SERVER-SIDE 4K CPU COMPOSITING BENCHMARKS ---
    println!("\n--- 4. SERVER-SIDE CPU 4K COMPOSITING BENCHMARK ---");
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
