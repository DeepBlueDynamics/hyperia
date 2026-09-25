#!/usr/bin/env python3
"""
A/B Objective Audio Evaluation Harness for Kokoro TTS.
Author: Antigravity (Continued Alpaca), A/B Measurement Owner.
Implements SWARM.md GO order & CONSENSUS.md R1 corrections.

Evaluates:
  1. python_ref_fp16: Python reference (fp16, misaki G2P, unchunked)
  2. model_only_fp16: Model test (fp16 ONNX, same G2P)
  3. model_only_q8f16: Model test (q8f16 ONNX, same G2P, isolates Q8F16 quantization)
  4. model_only_int8: Model test (int8 ONNX, same G2P, isolates INT8 quantization)
  5. python_sim_chunked_int8: Python text-pipeline simulation (lowercased, 250-char chunking, int8 ONNX, misaki G2P)
  6. live_sidecar_ping: Live latency and duration from running sidecar /api/tts endpoint
  7. Section D: Evaluates Rust build outputs (old vs new G2P on int8, then int8/q8f16/fp16) when provided.
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import numpy as np
import soundfile as sf

# Load local dependencies
sys.path.insert(0, "/tmp/pypkgs")
from kokoro_onnx import Kokoro
from evaluate import compute_raw_f32_metrics, compute_spectral_metrics, load_audio_f32

MODELS_DIR = "/tmp/models"
AUDIO_DIR = "/tmp/audio"
os.makedirs(AUDIO_DIR, exist_ok=True)

VOICES_PATH = os.path.join(MODELS_DIR, "voices-v1.0.bin")
MODEL_PATHS = {
    "fp16": os.path.join(MODELS_DIR, "kokoro-v1.0.fp16.onnx"),
    "q8f16": os.path.join(MODELS_DIR, "kokoro-v1.0-q8f16.onnx"),
    "int8": os.path.join(MODELS_DIR, "kokoro-v1.0.int8.onnx"),
}

def chunk_for_synth(text: str, max_chars: int = 250):
    """Replicates sidecar/src/tts.rs chunk_for_synth character-based chunking."""
    text = text.strip()
    if len(text) <= max_chars:
        return [text]
    is_sentence_end = lambda c: c in ".!?;:"
    chunks = []
    cur = ""
    for word in text.split():
        if len(word) > max_chars:
            if cur.strip():
                chunks.append(cur.strip())
            cur = ""
            buf = ""
            for ch in word:
                if len(buf) >= max_chars:
                    chunks.append(buf)
                    buf = ""
                buf += ch
            cur = buf
            continue
        if cur and len(cur) + 1 + len(word) > max_chars:
            chunks.append(cur.strip())
            cur = ""
        if cur:
            cur += " "
        cur += word
        if len(cur) >= max_chars * 3 // 5 and is_sentence_end(word[-1]):
            chunks.append(cur.strip())
            cur = ""
    if cur.strip():
        chunks.append(cur.strip())
    return chunks or [text]

def call_live_sidecar(text: str, voice: str = "af_heart", speed: float = 1.0):
    """Pings running sidecar /api/tts endpoint for response metadata."""
    url = "http://host.docker.internal:9800/api/tts"
    payload = json.dumps({"text": text, "voice": voice, "speed": speed, "frame": False}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            elapsed = time.time() - t0
            return {
                "ok": data.get("ok", False),
                "duration_secs": data.get("duration_secs", 0.0),
                "elapsed_s": round(elapsed, 2),
                "spoken": data.get("spoken", ""),
            }
    except Exception as e:
        return {"ok": False, "error": str(e)}

def run_suite(section_d_dir: str = None):
    sentences_path = "/workspace/hyperia/plan/tts-quality/ab/sentences.json"
    with open(sentences_path, "r", encoding="utf-8") as f:
        sentences = json.load(f)

    print(f"[A/B Harness] Loaded {len(sentences)} test sentences from {sentences_path}")

    # Load ONNX models
    print("[A/B Harness] Loading Kokoro ONNX models into memory...")
    engines = {}
    for key, path in MODEL_PATHS.items():
        if not os.path.exists(path):
            raise FileNotFoundError(f"Model path missing: {path}")
        print(f"  Loading {key} from {path} ({os.path.getsize(path)/(1024*1024):.1f} MB)...")
        engines[key] = Kokoro(path, VOICES_PATH)
    print("[A/B Harness] Models loaded successfully.")

    results_by_sentence = []
    variant_stats = {
        "python_ref_fp16": {"mcd": [], "corr": [], "rms": [], "peak": [], "over_range": [], "near_thresh": [], "trailing_silence": []},
        "model_only_fp16": {"mcd": [], "corr": [], "rms": [], "peak": [], "over_range": [], "near_thresh": [], "trailing_silence": []},
        "model_only_q8f16": {"mcd": [], "corr": [], "rms": [], "peak": [], "over_range": [], "near_thresh": [], "trailing_silence": []},
        "model_only_int8": {"mcd": [], "corr": [], "rms": [], "peak": [], "over_range": [], "near_thresh": [], "trailing_silence": []},
        "python_sim_chunked_int8": {"mcd": [], "corr": [], "rms": [], "peak": [], "over_range": [], "near_thresh": [], "trailing_silence": []},
    }

    # Section D trackers if directory provided
    section_d_variants = ["rust_old_g2p_int8", "rust_new_g2p_int8", "rust_new_g2p_q8f16", "rust_new_g2p_fp16"]
    if section_d_dir and os.path.isdir(section_d_dir):
        for var in section_d_variants:
            variant_stats[var] = {"mcd": [], "corr": [], "rms": [], "peak": [], "over_range": [], "near_thresh": [], "trailing_silence": []}

    sr = 24000

    for item in sentences:
        s_id = item["id"]
        category = item["category"]
        text = item["text"]
        print(f"\n--- [{s_id}] ({category}) ---")
        print(f"Text: \"{text}\"")

        row = {
            "id": s_id,
            "category": category,
            "text": text,
            "target": item.get("target", ""),
            "variants": {},
        }

        # 1. python_ref_fp16 (reference gold standard: FP16 ONNX, misaki G2P, unchunked)
        ref_samples, _ = engines["fp16"].create(text, voice="af_heart", speed=1.0, lang="en-us")
        ref_samples = np.asarray(ref_samples, dtype=np.float32)
        ref_wav = os.path.join(AUDIO_DIR, f"ref_{s_id}.wav")
        sf.write(ref_wav, ref_samples, sr)
        ref_m = compute_raw_f32_metrics(ref_samples, sr)
        ref_m.update({"spectral_correlation": 1.0, "mcd_db": 0.0, "cosine_similarity": 1.0, "duration_ratio": 1.0})
        row["variants"]["python_ref_fp16"] = ref_m
        variant_stats["python_ref_fp16"]["rms"].append(ref_m["rms_dbfs"])
        variant_stats["python_ref_fp16"]["peak"].append(ref_m["peak_f32"])
        variant_stats["python_ref_fp16"]["over_range"].append(ref_m["over_range_count"])
        variant_stats["python_ref_fp16"]["near_thresh"].append(ref_m["near_threshold_count"])
        variant_stats["python_ref_fp16"]["trailing_silence"].append(ref_m["trailing_silence_ms"])

        # 2. model_only_fp16 (re-run on fp16)
        fp16_samples, _ = engines["fp16"].create(text, voice="af_heart", speed=1.0, lang="en-us")
        fp16_samples = np.asarray(fp16_samples, dtype=np.float32)
        fp16_m = compute_raw_f32_metrics(fp16_samples, sr)
        fp16_spec = compute_spectral_metrics(fp16_samples, ref_samples, sr)
        fp16_m.update(fp16_spec)
        fp16_m["duration_ratio"] = round(fp16_m["duration_s"] / max(ref_m["duration_s"], 1e-3), 3)
        row["variants"]["model_only_fp16"] = fp16_m
        variant_stats["model_only_fp16"]["mcd"].append(fp16_spec["mcd_db"])
        variant_stats["model_only_fp16"]["corr"].append(fp16_spec["spectral_correlation"])
        variant_stats["model_only_fp16"]["rms"].append(fp16_m["rms_dbfs"])
        variant_stats["model_only_fp16"]["peak"].append(fp16_m["peak_f32"])
        variant_stats["model_only_fp16"]["over_range"].append(fp16_m["over_range_count"])
        variant_stats["model_only_fp16"]["near_thresh"].append(fp16_m["near_threshold_count"])
        variant_stats["model_only_fp16"]["trailing_silence"].append(fp16_m["trailing_silence_ms"])

        # 3. model_only_q8f16 (isolates Q8F16 quantization effect)
        q8_samples, _ = engines["q8f16"].create(text, voice="af_heart", speed=1.0, lang="en-us")
        q8_samples = np.asarray(q8_samples, dtype=np.float32)
        q8_wav = os.path.join(AUDIO_DIR, f"q8f16_{s_id}.wav")
        sf.write(q8_wav, q8_samples, sr)
        q8_m = compute_raw_f32_metrics(q8_samples, sr)
        q8_spec = compute_spectral_metrics(q8_samples, ref_samples, sr)
        q8_m.update(q8_spec)
        q8_m["duration_ratio"] = round(q8_m["duration_s"] / max(ref_m["duration_s"], 1e-3), 3)
        row["variants"]["model_only_q8f16"] = q8_m
        variant_stats["model_only_q8f16"]["mcd"].append(q8_spec["mcd_db"])
        variant_stats["model_only_q8f16"]["corr"].append(q8_spec["spectral_correlation"])
        variant_stats["model_only_q8f16"]["rms"].append(q8_m["rms_dbfs"])
        variant_stats["model_only_q8f16"]["peak"].append(q8_m["peak_f32"])
        variant_stats["model_only_q8f16"]["over_range"].append(q8_m["over_range_count"])
        variant_stats["model_only_q8f16"]["near_thresh"].append(q8_m["near_threshold_count"])
        variant_stats["model_only_q8f16"]["trailing_silence"].append(q8_m["trailing_silence_ms"])

        # 4. model_only_int8 (isolates INT8 quantization effect)
        int8_samples, _ = engines["int8"].create(text, voice="af_heart", speed=1.0, lang="en-us")
        int8_samples = np.asarray(int8_samples, dtype=np.float32)
        int8_wav = os.path.join(AUDIO_DIR, f"int8_{s_id}.wav")
        sf.write(int8_wav, int8_samples, sr)
        int8_m = compute_raw_f32_metrics(int8_samples, sr)
        int8_spec = compute_spectral_metrics(int8_samples, ref_samples, sr)
        int8_m.update(int8_spec)
        int8_m["duration_ratio"] = round(int8_m["duration_s"] / max(ref_m["duration_s"], 1e-3), 3)
        row["variants"]["model_only_int8"] = int8_m
        variant_stats["model_only_int8"]["mcd"].append(int8_spec["mcd_db"])
        variant_stats["model_only_int8"]["corr"].append(int8_spec["spectral_correlation"])
        variant_stats["model_only_int8"]["rms"].append(int8_m["rms_dbfs"])
        variant_stats["model_only_int8"]["peak"].append(int8_m["peak_f32"])
        variant_stats["model_only_int8"]["over_range"].append(int8_m["over_range_count"])
        variant_stats["model_only_int8"]["near_thresh"].append(int8_m["near_threshold_count"])
        variant_stats["model_only_int8"]["trailing_silence"].append(int8_m["trailing_silence_ms"])

        # 5. python_sim_chunked_int8 (simulates lowercase + 250-char chunking on int8; NOTE: uses misaki G2P)
        spoken_text = text.lower()
        chunks = chunk_for_synth(spoken_text, 250)
        chunk_buffers = []
        for ch in chunks:
            c_audio, _ = engines["int8"].create(ch, voice="af_heart", speed=1.0, lang="en-us")
            chunk_buffers.append(np.asarray(c_audio, dtype=np.float32))
        sim_samples = np.concatenate(chunk_buffers) if chunk_buffers else np.array([], dtype=np.float32)
        sim_wav = os.path.join(AUDIO_DIR, f"sim_int8_{s_id}.wav")
        sf.write(sim_wav, sim_samples, sr)
        sim_m = compute_raw_f32_metrics(sim_samples, sr)
        sim_spec = compute_spectral_metrics(sim_samples, ref_samples, sr)
        sim_m.update(sim_spec)
        sim_m["duration_ratio"] = round(sim_m["duration_s"] / max(ref_m["duration_s"], 1e-3), 3)
        sim_m["chunk_count"] = len(chunks)
        row["variants"]["python_sim_chunked_int8"] = sim_m
        variant_stats["python_sim_chunked_int8"]["mcd"].append(sim_spec["mcd_db"])
        variant_stats["python_sim_chunked_int8"]["corr"].append(sim_spec["spectral_correlation"])
        variant_stats["python_sim_chunked_int8"]["rms"].append(sim_m["rms_dbfs"])
        variant_stats["python_sim_chunked_int8"]["peak"].append(sim_m["peak_f32"])
        variant_stats["python_sim_chunked_int8"]["over_range"].append(sim_m["over_range_count"])
        variant_stats["python_sim_chunked_int8"]["near_thresh"].append(sim_m["near_threshold_count"])
        variant_stats["python_sim_chunked_int8"]["trailing_silence"].append(sim_m["trailing_silence_ms"])

        # 6. Live sidecar ping (reports duration & latency from running HTTP API; no audio stream captured)
        sidecar_res = call_live_sidecar(text, voice="af_heart", speed=1.0)
        row["live_sidecar_ping"] = sidecar_res

        # 7. Section D: Rust build audio evaluations if directory provided
        if section_d_dir and os.path.isdir(section_d_dir):
            for var in section_d_variants:
                var_file = os.path.join(section_d_dir, var, f"{s_id}.wav")
                if os.path.exists(var_file):
                    r_audio = load_audio_f32(var_file, target_sr=sr)
                    r_m = compute_raw_f32_metrics(r_audio, sr)
                    r_spec = compute_spectral_metrics(r_audio, ref_samples, sr)
                    r_m.update(r_spec)
                    r_m["duration_ratio"] = round(r_m["duration_s"] / max(ref_m["duration_s"], 1e-3), 3)
                    row["variants"][var] = r_m
                    variant_stats[var]["mcd"].append(r_spec["mcd_db"])
                    variant_stats[var]["corr"].append(r_spec["spectral_correlation"])
                    variant_stats[var]["rms"].append(r_m["rms_dbfs"])
                    variant_stats[var]["peak"].append(r_m["peak_f32"])
                    variant_stats[var]["over_range"].append(r_m["over_range_count"])
                    variant_stats[var]["near_thresh"].append(r_m["near_threshold_count"])
                    variant_stats[var]["trailing_silence"].append(r_m["trailing_silence_ms"])

        print(f"  Ref:       dur={ref_m['duration_s']:.2f}s, peak={ref_m['peak_f32']:.4f}, rms={ref_m['rms_dbfs']:.1f}dB, over={ref_m['over_range_count']}, silence={ref_m['trailing_silence_ms']:.1f}ms")
        print(f"  FP16:      dur={fp16_m['duration_s']:.2f}s, corr={fp16_spec['spectral_correlation']:.4f}, mcd={fp16_spec['mcd_db']:.2f}dB")
        print(f"  Q8F16:     dur={q8_m['duration_s']:.2f}s, corr={q8_spec['spectral_correlation']:.4f}, mcd={q8_spec['mcd_db']:.2f}dB, peak={q8_m['peak_f32']:.4f}, over={q8_m['over_range_count']}")
        print(f"  INT8:      dur={int8_m['duration_s']:.2f}s, corr={int8_spec['spectral_correlation']:.4f}, mcd={int8_spec['mcd_db']:.2f}dB, peak={int8_m['peak_f32']:.4f}, over={int8_m['over_range_count']}")
        print(f"  Sim INT8:  dur={sim_m['duration_s']:.2f}s, corr={sim_spec['spectral_correlation']:.4f}, mcd={sim_spec['mcd_db']:.2f}dB, chunks={sim_m['chunk_count']}")
        if sidecar_res.get("ok"):
            print(f"  Sidecar:   duration={sidecar_res.get('duration_secs', 0):.2f}s, HTTP latency={sidecar_res.get('elapsed_s', 0)}s")

        results_by_sentence.append(row)

    # Compute Summary Statistics strictly from collected arrays
    summary = {}
    for var, stats in variant_stats.items():
        if not stats["rms"]:
            continue
        summary[var] = {
            "mean_spectral_corr": round(float(np.mean(stats["corr"])), 4) if stats["corr"] else 1.0,
            "mean_mcd_db": round(float(np.mean(stats["mcd"])), 2) if stats["mcd"] else 0.0,
            "mean_rms_dbfs": round(float(np.mean(stats["rms"])), 2),
            "max_peak_f32": round(float(np.max(stats["peak"])), 4),
            "total_over_range_samples": int(np.sum(stats["over_range"])),
            "total_near_thresh_samples": int(np.sum(stats["near_thresh"])),
            "mean_trailing_silence_ms": round(float(np.mean(stats["trailing_silence"])), 1),
        }

    full_output = {
        "metadata": {
            "engine": "kokoro_onnx 0.6.1 + onnxruntime 1.30.0",
            "voice": "af_heart",
            "speed": 1.0,
            "sample_rate": 24000,
            "sentence_count": len(sentences),
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime()),
            "models": {
                "fp16": "kokoro-v1.0.fp16.onnx (163.5 MB)",
                "q8f16": "kokoro-v1.0-q8f16.onnx (86.0 MB)",
                "int8": "kokoro-v1.0.int8.onnx (92.4 MB)",
            },
        },
        "summary": summary,
        "sentences": results_by_sentence,
    }

    results_json_path = "/workspace/hyperia/plan/tts-quality/ab/results.json"
    with open(results_json_path, "w", encoding="utf-8") as f:
        json.dump(full_output, f, indent=2)
    print(f"\n[A/B Harness] Wrote complete results to {results_json_path}")

    # Generate strictly data-driven COMPARISON.md
    generate_markdown_report(full_output, "/workspace/hyperia/plan/tts-quality/ab/COMPARISON.md")
    print("[A/B Harness] Generated COMPARISON.md successfully.")
    return full_output

def generate_markdown_report(data: dict, out_path: str):
    meta = data["metadata"]
    summary = data["summary"]
    sentences = data["sentences"]

    md = []
    md.append("# TTS Objective A/B Quality Comparison (R1 Compliant)")
    md.append("\n**Author:** Antigravity (Continued Alpaca), A/B Measurement Owner")
    md.append(f"**Execution Timestamp:** {meta['timestamp']}")
    md.append(f"**Fixed Benchmark Suite:** [`sentences.json`](file:///workspace/hyperia/plan/tts-quality/ab/sentences.json) ({meta['sentence_count']} sentences)")
    md.append(f"**Test Parameters:** Voice: `{meta['voice']}`, Speed: `{meta['speed']}`, Sample Rate: `{meta['sample_rate']} Hz`")
    md.append("\n---\n")

    md.append("## 1. Methodology & Honest Branch Definitions")
    md.append("Per CONSENSUS.md R1 corrections, all branches are defined with strict attribution:\n")
    md.append("- `python_ref_fp16`: Reference audio synthesized with research Python tool (`kokoro-onnx` 0.6.1, `kokoro-v1.0.fp16.onnx`, misaki 0.9.4 G2P, standard casing, unchunked).")
    md.append("- `model_only_fp16`: Kokoro with FP16 ONNX model, identical misaki G2P and casing.")
    md.append("- `model_only_q8f16`: Kokoro with Q8F16 ONNX model (86.0 MB), identical misaki G2P. Isolates mixed-precision quantization.")
    md.append("- `model_only_int8`: Kokoro with INT8 ONNX model (92.4 MB), identical misaki G2P. Isolates INT8 quantization.")
    md.append("- `python_sim_chunked_int8`: Python simulation of text pipeline (source text lowercased, chunked at 250 characters via `chunk_for_synth`, int8 ONNX model). **Note:** Uses misaki G2P; does *not* simulate Rust CMUdict G2P or Mandarin number expansion.")
    md.append("- `live_sidecar_ping`: Queries running host sidecar at `http://host.docker.internal:9800/api/tts`. Reports API response duration and round-trip HTTP latency. Does *not* capture host rodio audio.")
    md.append("- Raw f32 physical metrics (peak, RMS, over-range, silence) are measured directly on floating-point sample arrays before any WAV or DAC conversion.")

    md.append("\n---\n")
    md.append("## 2. Summary Statistics Across 15 Benchmark Sentences")
    md.append("\nAll values below are calculated directly from execution arrays (no hard-coded conclusions):\n")

    md.append("| Variant | Spectral Corr ($r_{\\text{spec}}$) | Mean MCD (dB) | Mean RMS (dBFS) | Max Peak (f32) | Over-Range Samples ($|x| > 1.0$) | Near-Threshold Samples ($|x| \\ge 0.999$) | Mean Trailing Silence (ms) |")
    md.append("|---|---|---|---|---|---|---|---|")

    for var, s in summary.items():
        corr_str = f"{s['mean_spectral_corr']:.4f}"
        mcd_str = f"{s['mean_mcd_db']:.2f} dB"
        rms_str = f"{s['mean_rms_dbfs']:.2f} dBFS"
        peak_str = f"{s['max_peak_f32']:.4f}"
        over_str = f"{s['total_over_range_samples']}"
        near_str = f"{s['total_near_thresh_samples']}"
        sil_str = f"{s['mean_trailing_silence_ms']:.1f} ms"
        md.append(f"| **`{var}`** | {corr_str} | {mcd_str} | {rms_str} | {peak_str} | {over_str} | {near_str} | {sil_str} |")

    md.append("\n---\n")
    md.append("## 3. Empirical Observations (Verified Facts)")
    md.append("\n### A. Model Precision (holding G2P constant)")
    q8_s = summary.get("model_only_q8f16", {})
    int8_s = summary.get("model_only_int8", {})
    fp16_s = summary.get("model_only_fp16", {})

    if q8_s and int8_s:
        md.append(f"- **Spectral Correlation to Reference ($r_{{\\text{{spec}}}}$):**")
        md.append(f"  - Q8F16: `{q8_s.get('mean_spectral_corr', 0.0):.4f}`")
        md.append(f"  - INT8: `{int8_s.get('mean_spectral_corr', 0.0):.4f}`")
        md.append(f"- **Mel-Cepstral Distortion (MCD):**")
        md.append(f"  - Q8F16: `{q8_s.get('mean_mcd_db', 0.0):.2f} dB`")
        md.append(f"  - INT8: `{int8_s.get('mean_mcd_db', 0.0):.2f} dB`")
        md.append(f"- **Peak & Over-Range Behavior:**")
        md.append(f"  - Q8F16 max peak: `{q8_s.get('max_peak_f32', 0.0):.4f}` (Over-range samples: `{q8_s.get('total_over_range_samples', 0)}`, Near-threshold: `{q8_s.get('total_near_thresh_samples', 0)}`)")
        md.append(f"  - INT8 max peak: `{int8_s.get('max_peak_f32', 0.0):.4f}` (Over-range samples: `{int8_s.get('total_over_range_samples', 0)}`, Near-threshold: `{int8_s.get('total_near_thresh_samples', 0)}`)")
        md.append(f"- **Asset Size:**")
        md.append("  - FP16: 163.5 MB")
        md.append("  - INT8: 92.4 MB")
        md.append("  - Q8F16: 86.0 MB (smallest asset among the three)")

    md.append("\n### B. Text Chunking (`long_01` & `long_02`)")
    long_sentences = [s for s in sentences if s["category"] == "long_sentences"]
    for ls in long_sentences:
        s_id = ls["id"]
        v = ls["variants"]
        c_cnt = v.get("python_sim_chunked_int8", {}).get("chunk_count", 1)
        r_dur = v.get("python_ref_fp16", {}).get("duration_s", 0.0)
        c_dur = v.get("python_sim_chunked_int8", {}).get("duration_s", 0.0)
        c_mcd = v.get("python_sim_chunked_int8", {}).get("mcd_db", 0.0)
        md.append(f"- `{s_id}` ({len(ls['text'])} chars): split into {c_cnt} chunks by `chunk_for_synth(250)`. Reference duration: {r_dur:.2f}s, Chunked duration: {c_dur:.2f}s, MCD: {c_mcd:.2f} dB.")

    md.append("\n---\n")
    md.append("## 4. Per-Sentence Measurement Breakdown")
    md.append("\n| ID | Category | Ref Dur (s) | Q8F16 Corr | INT8 Corr | Sim INT8 Corr | Q8F16 MCD | INT8 MCD | Sim INT8 MCD | Live Sidecar Dur (s) |")
    md.append("|---|---|---|---|---|---|---|---|---|---|")

    for s in sentences:
        s_id = s["id"]
        cat = s["category"]
        v = s["variants"]
        ref_d = v.get("python_ref_fp16", {}).get("duration_s", 0.0)
        q8_c = v.get("model_only_q8f16", {}).get("spectral_correlation", 0.0)
        int8_c = v.get("model_only_int8", {}).get("spectral_correlation", 0.0)
        sim_c = v.get("python_sim_chunked_int8", {}).get("spectral_correlation", 0.0)
        q8_m = v.get("model_only_q8f16", {}).get("mcd_db", 0.0)
        int8_m = v.get("model_only_int8", {}).get("mcd_db", 0.0)
        sim_m = v.get("python_sim_chunked_int8", {}).get("mcd_db", 0.0)
        sidecar_d = s.get("live_sidecar_ping", {}).get("duration_secs", "-")
        md.append(f"| `{s_id}` | {cat} | {ref_d:.2f}s | {q8_c:.4f} | {int8_c:.4f} | {sim_c:.4f} | {q8_m:.2f} | {int8_m:.2f} | {sim_m:.2f} | {sidecar_d} |")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--section-d", default=None, help="Path to Section D Rust build audio output directory")
    args = parser.parse_args()
    run_suite(args.section_d)
