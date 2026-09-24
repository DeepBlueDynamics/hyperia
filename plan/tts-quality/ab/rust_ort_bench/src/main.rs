use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;
use anyhow::{Context, Result};
use hound::{SampleFormat, WavSpec, WavWriter};
use ndarray::{Array1, Array2};
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct SentenceVector {
    id: String,
    category: String,
    text: String,
    phonemes: String,
    token_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
struct VectorsFile {
    sentences: Vec<SentenceVector>,
}

#[derive(Debug, Serialize)]
struct RawMetrics {
    duration_s: f64,
    peak_f32: f64,
    peak_dbfs: f64,
    over_range_count: usize,
    over_range_pct: f64,
    near_threshold_count: usize,
    near_threshold_pct: f64,
    rms_dbfs: f64,
    trailing_silence_ms: f64,
    end_cutoff_amp: f64,
    sample_count: usize,
}

#[derive(Debug, Serialize)]
struct SentenceRunResult {
    id: String,
    category: String,
    text: String,
    phonemes: String,
    token_count: usize,
    style_row: usize,
    int8: RawMetrics,
    q8f16: RawMetrics,
    fp16: RawMetrics,
}

#[derive(Debug, Serialize)]
struct SectionDReport {
    metadata: BenchmarkMeta,
    results: Vec<SentenceRunResult>,
}

#[derive(Debug, Serialize)]
struct BenchmarkMeta {
    title: String,
    backend: String,
    voice: String,
    speed: f32,
    sample_rate: u32,
    vectors_source: String,
}

fn compute_raw_metrics(samples: &[f32], sr: u32) -> RawMetrics {
    let sample_count = samples.len();
    if sample_count == 0 {
        return RawMetrics {
            duration_s: 0.0,
            peak_f32: 0.0,
            peak_dbfs: -120.0,
            over_range_count: 0,
            over_range_pct: 0.0,
            near_threshold_count: 0,
            near_threshold_pct: 0.0,
            rms_dbfs: -120.0,
            trailing_silence_ms: 0.0,
            end_cutoff_amp: 0.0,
            sample_count: 0,
        };
    }

    let mut peak = 0.0f32;
    let mut sum_sq = 0.0f64;
    let mut over_range = 0usize;
    let mut near_thresh = 0usize;
    let mut last_audible_idx = 0usize;

    for (i, &s) in samples.iter().enumerate() {
        let abs_s = s.abs();
        if abs_s > peak {
            peak = abs_s;
        }
        if abs_s > 1.0 {
            over_range += 1;
        }
        if abs_s >= 0.999 {
            near_thresh += 1;
        }
        if abs_s >= 0.01 {
            last_audible_idx = i;
        }
        sum_sq += (s as f64) * (s as f64);
    }

    let duration_s = sample_count as f64 / sr as f64;
    let rms = (sum_sq / sample_count as f64).sqrt();
    let peak_dbfs = 20.0 * (peak as f64).max(1e-6).log10();
    let rms_dbfs = 20.0 * rms.max(1e-6).log10();

    let trailing_samples = sample_count.saturating_sub(1 + last_audible_idx);
    let trailing_silence_ms = (trailing_samples as f64 / sr as f64) * 1000.0;

    let tail_len = 100.min(sample_count);
    let tail_slice = &samples[sample_count - tail_len..];
    let end_cutoff_amp = tail_slice.iter().map(|s| s.abs() as f64).sum::<f64>() / tail_len as f64;

    RawMetrics {
        duration_s: (duration_s * 1000.0).round() / 1000.0,
        peak_f32: ((peak as f64) * 10000.0).round() / 10000.0,
        peak_dbfs: (peak_dbfs * 100.0).round() / 100.0,
        over_range_count: over_range,
        over_range_pct: ((over_range as f64 / sample_count as f64 * 100.0) * 10000.0).round() / 10000.0,
        near_threshold_count: near_thresh,
        near_threshold_pct: ((near_thresh as f64 / sample_count as f64 * 100.0) * 10000.0).round() / 10000.0,
        rms_dbfs: (rms_dbfs * 100.0).round() / 100.0,
        trailing_silence_ms: (trailing_silence_ms * 10.0).round() / 10.0,
        end_cutoff_amp: (end_cutoff_amp * 100000.0).round() / 100000.0,
        sample_count,
    }
}

fn write_wav_16(path: &Path, samples: &[f32], sample_rate: u32) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec)?;
    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let s = (clamped * 32767.0).round() as i16;
        writer.write_sample(s)?;
    }
    writer.finalize()?;
    Ok(())
}

fn run_inference(
    session: &mut Session,
    token_ids: &[i64],
    style_vec: &[f32],
    speed: f32,
) -> Result<Vec<f32>> {
    let input_ids_tensor = Tensor::from_array(([1, token_ids.len()], token_ids.to_vec()))?;
    let style_tensor = Tensor::from_array(([1, 256], style_vec.to_vec()))?;
    let speed_tensor = Tensor::from_array(([1], vec![speed]))?;

    let outputs = session.run(ort::inputs![
        "input_ids" => input_ids_tensor,
        "style" => style_tensor,
        "speed" => speed_tensor,
    ])?;

    let (_shape, samples) = outputs["waveform"].try_extract_tensor::<f32>()?;
    Ok(samples.to_vec())
}

fn main() -> Result<()> {
    println!("=== Rust ort Section D Model-Precision Benchmark ===");
    ort::init_from("/opt/mcp-venv/lib/python3.11/site-packages/onnxruntime/capi/libonnxruntime.so.1.26.0")?.commit();
    println!("Initialized ORT from system libonnxruntime.so");
    let vectors_path = "/workspace/hyperia/plan/tts-quality/g2p_vectors.json";
    let vectors_file = File::open(vectors_path).context("Open g2p_vectors.json")?;
    let vectors_data: VectorsFile = serde_json::from_reader(vectors_file)?;
    println!("Loaded {} test vectors from {}", vectors_data.sentences.len(), vectors_path);

    // Load af_heart style table
    let mut style_file = File::open("/tmp/models/af_heart_style.bin").context("Open af_heart_style.bin")?;
    let mut style_bytes = Vec::new();
    style_file.read_to_end(&mut style_bytes)?;
    let style_floats: Vec<f32> = style_bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    println!("Loaded af_heart style table: {} floats (510 rows x 256)", style_floats.len());

    let audio_dir = PathBuf::from("/workspace/hyperia/plan/tts-quality/ab/audio");
    std::fs::create_dir_all(&audio_dir)?;

    println!("Initializing ONNX Runtime sessions...");
    let t0 = Instant::now();
    let mut sess_int8 = Session::builder()?.commit_from_file("/tmp/models/kokoro-v1.0.int8.onnx")?;
    println!("  Loaded kokoro-v1.0.int8.onnx in {:.2}s", t0.elapsed().as_secs_f64());

    let t1 = Instant::now();
    let mut sess_q8f16 = Session::builder()?.commit_from_file("/tmp/models/kokoro-v1.0-q8f16.onnx")?;
    println!("  Loaded kokoro-v1.0-q8f16.onnx in {:.2}s", t1.elapsed().as_secs_f64());

    let t2 = Instant::now();
    let mut sess_fp16 = Session::builder()?.commit_from_file("/tmp/models/kokoro-v1.0.fp16.onnx")?;
    println!("  Loaded kokoro-v1.0.fp16.onnx in {:.2}s", t2.elapsed().as_secs_f64());

    let mut results: Vec<SentenceRunResult> = Vec::new();

    for item in &vectors_data.sentences {
        let token_ids = &item.token_ids;
        let interior_len = token_ids.len().saturating_sub(2);
        let style_row = interior_len.min(510).saturating_sub(1);
        let style_vec = &style_floats[style_row * 256..(style_row + 1) * 256];

        println!("\nSynthesizing [{}]: {} tokens, style_row={}", item.id, token_ids.len(), style_row);

        // 1. int8
        let samples_int8 = run_inference(&mut sess_int8, token_ids, style_vec, 1.0)?;
        let metrics_int8 = compute_raw_metrics(&samples_int8, 24000);
        let wav_int8 = audio_dir.join(format!("int8_{}.wav", item.id));
        write_wav_16(&wav_int8, &samples_int8, 24000)?;

        // 2. q8f16
        let samples_q8f16 = run_inference(&mut sess_q8f16, token_ids, style_vec, 1.0)?;
        let metrics_q8f16 = compute_raw_metrics(&samples_q8f16, 24000);
        let wav_q8f16 = audio_dir.join(format!("q8f16_{}.wav", item.id));
        write_wav_16(&wav_q8f16, &samples_q8f16, 24000)?;

        // 3. fp16
        let samples_fp16 = run_inference(&mut sess_fp16, token_ids, style_vec, 1.0)?;
        let metrics_fp16 = compute_raw_metrics(&samples_fp16, 24000);
        let wav_fp16 = audio_dir.join(format!("fp16_{}.wav", item.id));
        write_wav_16(&wav_fp16, &samples_fp16, 24000)?;

        println!(
            "  int8:  dur={:.2}s, peak={:.4}, rms={:.2}dB, over={}",
            metrics_int8.duration_s, metrics_int8.peak_f32, metrics_int8.rms_dbfs, metrics_int8.over_range_count
        );
        println!(
            "  q8f16: dur={:.2}s, peak={:.4}, rms={:.2}dB, over={}",
            metrics_q8f16.duration_s, metrics_q8f16.peak_f32, metrics_q8f16.rms_dbfs, metrics_q8f16.over_range_count
        );
        println!(
            "  fp16:  dur={:.2}s, peak={:.4}, rms={:.2}dB, over={}",
            metrics_fp16.duration_s, metrics_fp16.peak_f32, metrics_fp16.rms_dbfs, metrics_fp16.over_range_count
        );

        results.push(SentenceRunResult {
            id: item.id.clone(),
            category: item.category.clone(),
            text: item.text.clone(),
            phonemes: item.phonemes.clone(),
            token_count: token_ids.len(),
            style_row,
            int8: metrics_int8,
            q8f16: metrics_q8f16,
            fp16: metrics_fp16,
        });
    }

    let report = SectionDReport {
        metadata: BenchmarkMeta {
            title: "Section D: Model Precision Isolation (Grok Misaki 0.9.4 Vectors)".to_string(),
            backend: "Rust ort 2.0.0-rc.13 (CPUExecutionProvider)".to_string(),
            voice: "af_heart".to_string(),
            speed: 1.0,
            sample_rate: 24000,
            vectors_source: vectors_path.to_string(),
        },
        results,
    };

    let out_json_path = "/workspace/hyperia/plan/tts-quality/ab/rust_section_d_raw.json";
    let out_file = File::create(out_json_path)?;
    serde_json::to_writer_pretty(out_file, &report)?;
    println!("\nWrote raw Section D benchmark output to {}", out_json_path);

    Ok(())
}
