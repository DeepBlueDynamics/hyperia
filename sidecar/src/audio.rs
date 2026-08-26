// Agent audio streaming (epic #162) — containers play sound on the host.
//
// Two ingest paths, both reusing the TTS stack's rodio/cpal output:
//   POST /ws/audio (WebSocket)  — JSON hello frame, then raw PCM binary frames
//   POST /api/audio/play        — one-shot WAV (or base64 PCM) clip
//
// Consent: raw audio is gated drive-style on the sentinel target `__audio__`
// (see enforce_audio in main.rs). `hyperia_spoken_summary` (TTS) stays UNGATED
// by explicit decision — its radio framing is already self-attributing.
//
// Everything rodio-touching is feature-gated on `tts` (rodio is an optional
// dependency of that feature; the Intel-mac leg builds without it).

#![cfg_attr(not(feature = "tts"), allow(dead_code))]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// Global mute: frames are dropped server-side while set. Muting is the safe
/// direction, so any identified caller may set it; only the system token
/// (the Hyperia app / the human) may clear it.
pub static MUTED: AtomicBool = AtomicBool::new(false);

/// Live stream count, capped by `max_streams()`.
pub static ACTIVE: AtomicUsize = AtomicUsize::new(0);

/// Monotonic id for attribution notices, so the app can pair each
/// "playing audio" toast with the end event that dismisses it.
static NOTICE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn next_notice_id() -> u64 {
    NOTICE_SEQ.fetch_add(1, Ordering::Relaxed)
}

pub const DEFAULT_MAX_STREAMS: usize = 4;

/// `config.audio.enabled` (default true) / `config.audio.maxStreams`.
pub fn audio_enabled() -> bool {
    crate::ghost::api::read_shared_config()["config"]["audio"]["enabled"]
        .as_bool()
        .unwrap_or(true)
}

pub fn max_streams() -> usize {
    crate::ghost::api::read_shared_config()["config"]["audio"]["maxStreams"]
        .as_u64()
        .map(|n| n.clamp(1, 16) as usize)
        .unwrap_or(DEFAULT_MAX_STREAMS)
}

/// Declared PCM format for a stream / clip.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PcmFormat {
    S16le,
    F32le,
}

impl PcmFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "s16le" | "s16" | "pcm16" => Some(Self::S16le),
            "f32le" | "f32" | "float32" => Some(Self::F32le),
            _ => None,
        }
    }
}

/// A validated stream header (the ws hello frame / clip metadata).
#[derive(Clone, Copy, Debug)]
pub struct StreamSpec {
    pub format: PcmFormat,
    pub rate: u32,
    pub channels: u16,
}

impl StreamSpec {
    pub fn from_json(v: &serde_json::Value) -> Result<Self, String> {
        let format = v["format"]
            .as_str()
            .and_then(PcmFormat::parse)
            .ok_or("format must be \"s16le\" or \"f32le\"")?;
        let rate = v["rate"].as_u64().unwrap_or(24000) as u32;
        if !(8000..=48000).contains(&rate) {
            return Err("rate must be 8000-48000".into());
        }
        let channels = v["channels"].as_u64().unwrap_or(1) as u16;
        if !(1..=2).contains(&channels) {
            return Err("channels must be 1 or 2".into());
        }
        Ok(Self {format, rate, channels})
    }

    /// Seconds of audio in a decoded f32 buffer of this spec.
    pub fn secs(&self, samples: usize) -> f64 {
        samples as f64 / (self.rate as f64 * self.channels as f64)
    }
}

/// Decode one binary frame to interleaved f32 samples.
pub fn decode_frame(spec: &StreamSpec, bytes: &[u8]) -> Vec<f32> {
    match spec.format {
        PcmFormat::S16le => bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect(),
        PcmFormat::F32le => bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]).clamp(-1.0, 1.0))
            .collect(),
    }
}

/// Minimal RIFF/WAVE parser: PCM16 or IEEE-float32, 1-2 channels. Enough for
/// the one-shot clip endpoint without pulling a decoder crate.
pub fn parse_wav(bytes: &[u8]) -> Result<(StreamSpec, Vec<f32>), String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut pos = 12usize;
    let mut spec: Option<StreamSpec> = None;
    let mut data: Option<&[u8]> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
        let body_start = pos + 8;
        let body_end = body_start.saturating_add(size).min(bytes.len());
        match id {
            b"fmt " => {
                if size < 16 {
                    return Err("malformed fmt chunk".into());
                }
                let b = &bytes[body_start..body_end];
                let audio_format = u16::from_le_bytes([b[0], b[1]]);
                let channels = u16::from_le_bytes([b[2], b[3]]);
                let rate = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
                let bits = u16::from_le_bytes([b[14], b[15]]);
                let format = match (audio_format, bits) {
                    (1, 16) => PcmFormat::S16le,
                    (3, 32) => PcmFormat::F32le,
                    _ => return Err(format!("unsupported WAV encoding (format={audio_format}, bits={bits}) — use PCM16 or float32")),
                };
                if !(1..=2).contains(&channels) {
                    return Err("WAV must be mono or stereo".into());
                }
                if !(8000..=48000).contains(&rate) {
                    return Err("WAV rate must be 8000-48000".into());
                }
                spec = Some(StreamSpec {format, rate, channels});
            }
            b"data" => data = Some(&bytes[body_start..body_end]),
            _ => {}
        }
        // Chunks are word-aligned.
        pos = body_start + size + (size & 1);
    }
    let spec = spec.ok_or("WAV has no fmt chunk")?;
    let data = data.ok_or("WAV has no data chunk")?;
    Ok((spec, decode_frame(&spec, data)))
}

/// Decode any common audio container to (spec, samples): our fast WAV path
/// first, then rodio's symphonia Decoder — which is already compiled in via
/// the playback stack and handles MP3, FLAC, OGG/Vorbis, and AAC/M4A.
#[cfg(feature = "tts")]
pub fn decode_any(bytes: &[u8]) -> Result<(StreamSpec, Vec<f32>), String> {
    if let Ok(parsed) = parse_wav(bytes) {
        return Ok(parsed);
    }
    use rodio::Source as _;
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let decoder = rodio::Decoder::new(cursor)
        .map_err(|e| format!("undecodable audio ({e}) — send WAV, MP3, FLAC, or OGG (or raw PCM via pcm_base64)"))?;
    let channels = decoder.channels().get();
    let rate = decoder.sample_rate().get();
    if !(1..=2).contains(&channels) {
        return Err(format!("{channels}-channel audio isn't supported — downmix to mono or stereo"));
    }
    if !(8000..=48000).contains(&rate) {
        return Err(format!("sample rate {rate} outside 8000-48000 — resample first"));
    }
    let samples: Vec<f32> = decoder.collect();
    if samples.is_empty() {
        return Err("decoded to zero samples".into());
    }
    Ok((
        StreamSpec {format: PcmFormat::F32le, rate, channels},
        samples,
    ))
}

#[cfg(feature = "tts")]
mod player {
    use super::StreamSpec;
    use std::sync::mpsc;

    /// Handle to a dedicated playback thread. Send decoded f32 chunks; drop the
    /// sender to end the stream (the thread drains and exits).
    pub struct StreamPlayer {
        tx: mpsc::SyncSender<Vec<f32>>,
    }

    impl StreamPlayer {
        /// Spawn a playback thread for one stream. Each chunk is appended to a
        /// rodio Player as a SamplesBuffer — rodio queues appended sources
        /// gaplessly and resamples to the device rate. Device-open failures are
        /// surfaced through a startup handshake so the caller can report
        /// "no audio device" to the agent instead of playing into the void.
        pub fn spawn(spec: StreamSpec) -> Result<Self, String> {
            use rodio::buffer::SamplesBuffer;
            use rodio::{DeviceSinkBuilder, Player};
            use std::num::NonZero;

            // Small bound: the ws loop does its own backlog accounting; this
            // channel just decouples network from audio-callback timing.
            let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(32);
            let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
            std::thread::spawn(move || {
                // The device handle owns the cpal stream — keep it alive for
                // the whole stream (same rule as tts::play_samples).
                let handle = match DeviceSinkBuilder::open_default_sink() {
                    Ok(h) => {
                        let _ = ready_tx.send(Ok(()));
                        h
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("open default audio output: {e}")));
                        return;
                    }
                };
                let player = Player::connect_new(handle.mixer());
                let channels = NonZero::new(spec.channels).expect("channels validated non-zero");
                let rate = NonZero::new(spec.rate).expect("rate validated non-zero");
                while let Ok(chunk) = rx.recv() {
                    if chunk.is_empty() {
                        continue;
                    }
                    player.append(SamplesBuffer::new(channels, rate, chunk));
                }
                // Sender dropped — let what's queued finish, then release the device.
                player.sleep_until_end();
                drop(handle);
            });
            match ready_rx.recv() {
                Ok(Ok(())) => Ok(Self {tx}),
                Ok(Err(e)) => Err(e),
                Err(_) => Err("audio playback thread died during startup".into()),
            }
        }

        /// Queue a chunk. Returns false if the playback thread is gone.
        pub fn send(&self, chunk: Vec<f32>) -> bool {
            self.tx.send(chunk).is_ok()
        }
    }
}

#[cfg(feature = "tts")]
pub use player::StreamPlayer;

/// The websocket protocol loop for one ingest stream. Caller has already done
/// identity + consent + slot claiming; this owns the hello handshake, frame
/// decode, mute/backlog handling, and the playback thread's lifetime.
#[cfg(feature = "tts")]
pub async fn ws_loop(
    mut socket: axum::extract::ws::WebSocket,
    bridge: crate::bridge::Bridge,
    caller_name: String,
    _slot: StreamSlot,
) {
    use axum::extract::ws::Message;
    use std::time::{Duration, Instant};

    let send_json = |v: serde_json::Value| Message::Text(v.to_string().into());

    // Hello frame: one JSON text message within 10s, or we hang up.
    let hello = match tokio::time::timeout(Duration::from_secs(10), socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => t.to_string(),
        Ok(Some(Ok(_))) => {
            let _ = socket
                .send(send_json(serde_json::json!({"error": "first frame must be a JSON hello: {\"format\":\"s16le\",\"rate\":24000,\"channels\":1}"})))
                .await;
            return;
        }
        _ => return, // closed, errored, or silent — nothing to say to nobody
    };
    let spec = match serde_json::from_str::<serde_json::Value>(&hello)
        .map_err(|e| format!("hello is not JSON: {e}"))
        .and_then(|v| StreamSpec::from_json(&v))
    {
        Ok(s) => s,
        Err(e) => {
            let _ = socket.send(send_json(serde_json::json!({"error": e}))).await;
            return;
        }
    };
    let player = match StreamPlayer::spawn(spec) {
        Ok(p) => p,
        Err(e) => {
            let _ = socket.send(send_json(serde_json::json!({"error": e}))).await;
            return;
        }
    };
    let _ = socket.send(send_json(serde_json::json!({"ok": true}))).await;

    // Attribution: sound is never anonymous — toast the callsign in the app.
    // The toast STAYS UP for the life of the stream; the end notice below
    // (paired by id) dismisses it.
    let notice_id = next_notice_id();
    let _ = bridge
        .notify(serde_json::json!({
            "type": "AudioNotice", "id": notice_id, "name": caller_name, "active": true
        }))
        .await;

    // Backlog accounting: appended-seconds vs wall-clock. If the agent runs
    // ahead of realtime by more than the jitter window, DROP (oldest-first by
    // construction — we drop the incoming frame, what's queued keeps playing).
    const MAX_BACKLOG_SECS: f64 = 0.6;
    let started = Instant::now();
    let mut appended_secs = 0.0f64;
    let mut dropped: u64 = 0;
    let mut was_muted = MUTED.load(Ordering::Relaxed);

    while let Some(msg) = socket.recv().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        match msg {
            axum::extract::ws::Message::Binary(bytes) => {
                let muted = MUTED.load(Ordering::Relaxed);
                if muted != was_muted {
                    was_muted = muted;
                    let _ = socket.send(send_json(serde_json::json!({"muted": muted}))).await;
                }
                if muted {
                    continue;
                }
                let samples = decode_frame(&spec, &bytes);
                if samples.is_empty() {
                    continue;
                }
                let elapsed = started.elapsed().as_secs_f64();
                if appended_secs - elapsed > MAX_BACKLOG_SECS {
                    dropped += 1;
                    if dropped == 1 || dropped % 100 == 0 {
                        let _ = socket
                            .send(send_json(serde_json::json!({"dropped": dropped, "hint": "you are sending faster than realtime — pace to the sample rate"})))
                            .await;
                    }
                    continue;
                }
                appended_secs += spec.secs(samples.len());
                if !player.send(samples) {
                    let _ = socket
                        .send(send_json(serde_json::json!({"error": "audio output died"})))
                        .await;
                    break;
                }
            }
            axum::extract::ws::Message::Close(_) => break,
            // Pings are answered by axum; other text frames are ignored.
            _ => {}
        }
    }
    // Stream over — take the attribution toast down.
    let _ = bridge
        .notify(serde_json::json!({"type": "AudioNotice", "id": notice_id, "active": false}))
        .await;
    // player + _slot drop here: the playback thread drains what's queued and
    // releases the device; the stream slot frees for the next caller.
}

/// RAII guard for the active-stream count.
pub struct StreamSlot;

impl StreamSlot {
    /// Claim a slot, or say how many are busy.
    pub fn claim() -> Result<Self, String> {
        let max = max_streams();
        let prev = ACTIVE.fetch_add(1, Ordering::SeqCst);
        if prev >= max {
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
            return Err(format!("audio stream limit reached ({max} active) — try again when one closes"));
        }
        Ok(Self)
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}
