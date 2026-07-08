//! Local, offline text-to-speech via Kokoro-82M (ort/ONNX + pure-Rust G2P).
//!
//! Backs the `hyperia_spoken_summary` MCP tool and the `POST /api/tts` route.
//! Everything runs in-process in the sidecar — no cloud call, no telemetry. The
//! ~90 MB int8 ONNX model + voice pack are downloaded to `~/.hyperia/kokoro/` on
//! first synthesis and cached thereafter.
//!
//! Loading the ONNX session is expensive (hundreds of ms), so ONE [`KokoroTts`]
//! is built lazily and reused across every call via a [`tokio::sync::OnceCell`].

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use kokoro_tts::{KokoroTts, Voice};
use tokio::sync::OnceCell;

/// Kokoro V1.0 model assets (GitHub release from the crate's upstream). CPU
/// inference only; ~90 MB total across the two files.
const ONNX_URL: &str =
    "https://github.com/mzdk100/kokoro/releases/download/V1.0/kokoro-v1.0.int8.onnx";
const VOICES_URL: &str =
    "https://github.com/mzdk100/kokoro/releases/download/V1.0/voices.bin";

const ONNX_FILE: &str = "kokoro-v1.0.int8.onnx";
const VOICES_FILE: &str = "voices.bin";

/// Native output format of Kokoro: 24 kHz mono `f32`.
const SAMPLE_RATE: u32 = 24_000;

/// Process-wide, lazily-loaded engine. Reused across calls — building it loads
/// the ONNX session, which is the expensive part. A failed init leaves the cell
/// empty so the next call retries (a transient download/load error is not fatal).
static ENGINE: OnceCell<Arc<KokoroTts>> = OnceCell::const_new();

/// Speak `text` aloud on the host machine, blocking until playback finishes.
///
/// `voice` selects a Kokoro voice by name (see [`resolve_voice`]); `None` →
/// `af_heart`. `speed` is clamped to `0.5..=2.0`; `None` → `1.0`. Returns the
/// spoken audio duration in seconds.
pub async fn speak(text: &str, voice: Option<&str>, speed: Option<f32>) -> Result<f64> {
    let text = text.trim();
    if text.is_empty() {
        return Err(anyhow!("text is empty"));
    }
    let speed = speed.unwrap_or(1.0).clamp(0.5, 2.0);
    let voice = resolve_voice(voice, speed);

    let tts = engine().await?;
    let (audio, took) = tts
        .synth(text, voice)
        .await
        .map_err(|e| anyhow!("Kokoro synth failed: {e}"))?;
    let secs = audio.len() as f64 / SAMPLE_RATE as f64;
    tracing::info!(
        target: "tts",
        "synth {} chars in {:?} -> {:.1}s audio ({} samples @ {} Hz)",
        text.len(),
        took,
        secs,
        audio.len(),
        SAMPLE_RATE
    );

    // Playback is blocking: rodio drives a cpal stream on its own thread and we
    // sleep until the buffer drains. Keep it off the async runtime's workers.
    tokio::task::spawn_blocking(move || play_samples(audio))
        .await
        .context("playback task join failed")??;

    Ok(secs)
}

/// Get (or lazily build) the shared engine.
async fn engine() -> Result<Arc<KokoroTts>> {
    let arc = ENGINE
        .get_or_try_init(|| async {
            let (onnx, voices) = ensure_model().await?;
            tracing::info!(target: "tts", "loading Kokoro model {}", onnx.display());
            let tts = KokoroTts::new(onnx, voices)
                .await
                .map_err(|e| anyhow!("Kokoro model load failed: {e}"))?;
            Ok::<_, anyhow::Error>(Arc::new(tts))
        })
        .await?;
    Ok(arc.clone())
}

/// Ensure the ONNX model + voice pack exist under `~/.hyperia/kokoro/`,
/// downloading them on first use. Returns `(onnx_path, voices_path)`.
pub async fn ensure_model() -> Result<(PathBuf, PathBuf)> {
    let dir = crate::fsnav::home_dir().join(".hyperia").join("kokoro");
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("create kokoro dir {}", dir.display()))?;

    let onnx = dir.join(ONNX_FILE);
    let voices = dir.join(VOICES_FILE);
    download_if_missing(&onnx, ONNX_URL).await?;
    download_if_missing(&voices, VOICES_URL).await?;
    Ok((onnx, voices))
}

/// Stream-download `url` to `path` unless a non-empty file is already there.
///
/// Writes to a `.part` sibling and renames on completion, so an interrupted
/// download never leaves a truncated file that the "non-empty" check accepts.
async fn download_if_missing(path: &Path, url: &str) -> Result<()> {
    if let Ok(meta) = tokio::fs::metadata(path).await {
        if meta.len() > 0 {
            tracing::debug!(
                target: "tts",
                "kokoro asset present: {} ({} bytes)",
                path.display(),
                meta.len()
            );
            return Ok(());
        }
    }

    tracing::info!(target: "tts", "downloading kokoro asset {} -> {}", url, path.display());

    // Uses rustls (reqwest is built with rustls-tls, default-features off).
    let client = reqwest::Client::builder()
        .build()
        .context("build reqwest client")?;
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("GET {url} returned an error status"))?;
    let total = resp.content_length();

    let tmp = path.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("create {}", tmp.display()))?;

    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_log: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("streaming {url}"))?;
        file.write_all(&chunk).await.context("write chunk")?;
        downloaded += chunk.len() as u64;
        // Log roughly every 8 MB so a slow ~90 MB pull shows progress.
        if downloaded - last_log >= 8 * 1024 * 1024 {
            last_log = downloaded;
            match total {
                Some(t) => tracing::info!(target: "tts", "  {} / {} bytes", downloaded, t),
                None => tracing::info!(target: "tts", "  {} bytes", downloaded),
            }
        }
    }
    file.flush().await.context("flush download")?;
    drop(file);

    tokio::fs::rename(&tmp, path)
        .await
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    tracing::info!(target: "tts", "downloaded {} ({} bytes)", path.display(), downloaded);
    Ok(())
}

/// Map a voice name to a [`Voice`] with the given speed. Unknown names fall back
/// to `af_heart`. Only the English v1.0 voices we advertise are wired up.
fn resolve_voice(name: Option<&str>, speed: f32) -> Voice {
    match name.unwrap_or("af_heart").trim().to_ascii_lowercase().as_str() {
        "am_michael" => Voice::AmMichael(speed),
        "am_puck" => Voice::AmPuck(speed),
        "bf_emma" => Voice::BfEmma(speed),
        "bm_george" => Voice::BmGeorge(speed),
        "af_bella" => Voice::AfBella(speed),
        "af_nicole" => Voice::AfNicole(speed),
        "bm_lewis" => Voice::BmLewis(speed),
        // "af_heart" and anything unrecognized:
        _ => Voice::AfHeart(speed),
    }
}

/// Play a mono `f32` buffer at [`SAMPLE_RATE`] on the default output device.
/// Blocking — call from `spawn_blocking`.
fn play_samples(audio: Vec<f32>) -> Result<()> {
    use rodio::buffer::SamplesBuffer;
    use rodio::{DeviceSinkBuilder, Player};
    use std::num::NonZero;

    // The device handle owns the underlying cpal stream; it MUST stay alive
    // until playback finishes or the device closes mid-sound.
    let handle = DeviceSinkBuilder::open_default_sink()
        .map_err(|e| anyhow!("open default audio output: {e}"))?;
    let player = Player::connect_new(handle.mixer());

    let channels = NonZero::new(1u16).expect("1 channel is non-zero");
    let rate = NonZero::new(SAMPLE_RATE).expect("sample rate is non-zero");
    let buffer = SamplesBuffer::new(channels, rate, audio);

    player.append(buffer);
    player.sleep_until_end(); // blocks until the buffer has fully played
    drop(handle);
    Ok(())
}
