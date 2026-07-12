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

/// Kokoro V1.0 model assets. CPU inference only; ~120 MB total across the two
/// files. Each is fetched from OUR CDN first (hyperia.nuts.services, served off
/// our own Cloud Run site) and only falls back to the crate's upstream GitHub
/// release if that fails — first URL that succeeds wins.
const ONNX_URLS: &[&str] = &[
    "https://hyperia.nuts.services/models/kokoro-v1.0.int8.onnx",
    "https://github.com/mzdk100/kokoro/releases/download/V1.0/kokoro-v1.0.int8.onnx",
];
const VOICES_URLS: &[&str] = &[
    "https://hyperia.nuts.services/models/voices.bin",
    "https://github.com/mzdk100/kokoro/releases/download/V1.0/voices.bin",
];

const ONNX_FILE: &str = "kokoro-v1.0.int8.onnx";
const VOICES_FILE: &str = "voices.bin";

/// Native output format of Kokoro: 24 kHz mono `f32`.
const SAMPLE_RATE: u32 = 24_000;

/// Process-wide, lazily-loaded engine. Reused across calls — building it loads
/// the ONNX session, which is the expensive part. A failed init leaves the cell
/// empty so the next call retries (a transient download/load error is not fatal).
static ENGINE: OnceCell<Arc<KokoroTts>> = OnceCell::const_new();

/// Kokoro's v10 synth path indexes the voice style-pack by phoneme count
/// (`pack[phonemes.len() - 1]`) and PANICS out-of-bounds once a single synth
/// exceeds the pack size (~510 phonemes). That reset the /api/tts connection on
/// any long summary — the "TTS is down" reports were really this crash. Phoneme
/// count is roughly bounded by character count in English, so we cap each chunk
/// well under the ceiling in characters. 250 leaves generous margin.
const MAX_SYNTH_CHARS: usize = 250;

/// Split `text` into synth-sized chunks, breaking on word boundaries and
/// preferring to end a chunk right after sentence punctuation. A single word
/// longer than `max_chars` (e.g. a pasted URL) is hard-split by characters so no
/// chunk can ever exceed the ceiling.
fn chunk_for_synth(text: &str, max_chars: usize) -> Vec<String> {
    let text = text.trim();
    if text.chars().count() <= max_chars {
        return vec![text.to_string()];
    }
    let is_sentence_end = |c: char| matches!(c, '.' | '!' | '?' | ';' | ':');
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for word in text.split_whitespace() {
        // Hard-split a pathologically long single "word" (URL, base64, etc.).
        if word.chars().count() > max_chars {
            let t = cur.trim();
            if !t.is_empty() {
                chunks.push(t.to_string());
            }
            cur.clear();
            let mut buf = String::new();
            for ch in word.chars() {
                if buf.chars().count() >= max_chars {
                    chunks.push(std::mem::take(&mut buf));
                }
                buf.push(ch);
            }
            cur = buf;
            continue;
        }
        if !cur.is_empty() && cur.chars().count() + 1 + word.chars().count() > max_chars {
            chunks.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
        // Break on a natural boundary once the chunk is reasonably full.
        if cur.chars().count() >= max_chars * 3 / 5 && word.ends_with(is_sentence_end) {
            chunks.push(std::mem::take(&mut cur));
        }
    }
    let t = cur.trim();
    if !t.is_empty() {
        chunks.push(t.to_string());
    }
    if chunks.is_empty() {
        chunks.push(text.to_string());
    }
    chunks
}

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

    // Lowercase for synthesis: kokoro-tts's cmudict lookup is case-sensitive
    // (`.get(word)` with no fold — their espeak path lowercases, the dict path
    // forgot), so "The" misses the dictionary and gets SPELLED letter-by-letter.
    // Case carries no pronunciation info; unknown tokens (acronyms) still fall
    // back to letter-spelling exactly as before.
    let spoken = text.to_lowercase();

    let tts = engine().await?;

    // Chunk so no single synth call exceeds Kokoro's phoneme ceiling (see
    // MAX_SYNTH_CHARS) — long text used to panic the v10 synth path and reset the
    // request. Concatenate the per-chunk audio for one continuous playback.
    let chunks = chunk_for_synth(&spoken, MAX_SYNTH_CHARS);
    let mut audio: Vec<f32> = Vec::new();
    let mut took = std::time::Duration::ZERO;
    for chunk in &chunks {
        let (a, dt) = tts
            .synth(chunk.as_str(), voice)
            .await
            .map_err(|e| anyhow!("Kokoro synth failed: {e}"))?;
        took += dt;
        audio.extend_from_slice(&a);
    }
    let secs = audio.len() as f64 / SAMPLE_RATE as f64;
    tracing::info!(
        target: "tts",
        "synth {} chars in {} chunk(s), {:?} -> {:.1}s audio ({} samples @ {} Hz)",
        text.len(),
        chunks.len(),
        took,
        secs,
        audio.len(),
        SAMPLE_RATE
    );

    // Debug dump: write the raw synthesized audio to ~/.hyperia/kokoro/last.wav
    // so it can be inspected / played directly — isolating synth from playback.
    let dump = crate::fsnav::home_dir().join(".hyperia").join("kokoro").join("last.wav");
    match write_wav_16(&dump, &audio) {
        Ok(()) => tracing::info!(target: "tts", "dumped {} samples -> {}", audio.len(), dump.display()),
        Err(e) => tracing::warn!(target: "tts", "wav dump failed: {e}"),
    }

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
    download_if_missing(&onnx, ONNX_URLS).await?;
    download_if_missing(&voices, VOICES_URLS).await?;
    Ok((onnx, voices))
}

/// Ensure `path` exists and is non-empty, downloading from the first working URL
/// in `urls` (our CDN first, upstream GitHub fallback). A file already present
/// is left untouched. Each candidate is tried in order; the first success wins,
/// and only the last error surfaces if every URL fails.
async fn download_if_missing(path: &Path, urls: &[&str]) -> Result<()> {
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

    let mut last_err: Option<anyhow::Error> = None;
    for url in urls {
        match fetch_url(path, url).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                tracing::warn!(target: "tts", "download from {url} failed, trying next: {e:#}");
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no download URLs configured for {}", path.display())))
}

/// Stream one `url` to `path`. Writes to a `.part` sibling and renames on
/// completion, so an interrupted download never leaves a truncated file that the
/// "non-empty" check would later accept.
async fn fetch_url(path: &Path, url: &str) -> Result<()> {
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

/// Reduce a pane/agent display name to a short *spokenable* callsign: the part
/// before any " | <process>" suffix, letters + apostrophes only (drops emoji,
/// digits, punctuation), whitespace-collapsed.
/// `"Severe Booby 🥐 | Nemesis8 Danger"` → `"Severe Booby"`;
/// `"Prior Sloth 🦥"` → `"Prior Sloth"`.
pub fn spokenable_name(raw: &str) -> String {
    let head = raw.split('|').next().unwrap_or(raw);
    let cleaned: String = head
        .chars()
        .map(|c| if c.is_alphabetic() || c == '\'' { c } else { ' ' })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Wrap `text` in a radio-transmission frame addressed from `caller` to
/// `recipient`:
/// `"{recipient}, {recipient}, this is {caller} transmitting. {text}. This is
/// {caller}. Oh ver and out."`
///
/// The sign-off is deliberately spelled "oh ver": the int8 af_heart voice clips
/// "over"'s UNSTRESSED final syllable (OW1 V ER0 → "ove"). "oh" (OW1) and
/// "ver" (V ER1) are both real cmudict entries, and ver's STRESSED ER1 forces
/// the full syllable — so it sounds like "over" instead of "ove". Don't
/// respell it as one made-up word (e.g. "ovear"): a dictionary miss falls back
/// to letter-spelling ("O-V-E-A-R").
pub fn radio_wrap(recipient: &str, caller: &str, text: &str) -> String {
    // Strip trailing sentence punctuation from the body so the frame reads
    // cleanly ("… transmitting. <text>. This is …").
    let body = text.trim().trim_end_matches(['.', ',', '!', '?', ';', ':', ' ']);
    format!(
        "{recipient}, {recipient}, this is {caller} transmitting. {body}. This is {caller}. Oh ver and out."
    )
}

/// Write mono `f32` samples as a 16-bit PCM WAV at [`SAMPLE_RATE`] (no deps —
/// hand-rolled 44-byte header + LE i16 samples). Used to dump synthesized audio
/// for inspection / direct playback.
fn write_wav_16(path: &Path, samples: &[f32]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data_len = (samples.len() as u32) * 2; // 16-bit mono
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?; // PCM fmt chunk size
    f.write_all(&1u16.to_le_bytes())?; // audio format = PCM
    f.write_all(&1u16.to_le_bytes())?; // channels = mono
    f.write_all(&SAMPLE_RATE.to_le_bytes())?; // sample rate
    f.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?; // byte rate = rate * blockalign
    f.write_all(&2u16.to_le_bytes())?; // block align = channels * (bits/8)
    f.write_all(&16u16.to_le_bytes())?; // bits per sample
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        f.write_all(&v.to_le_bytes())?;
    }
    f.flush()?;
    Ok(())
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
