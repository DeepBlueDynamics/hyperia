//! Radio log: every spoken transmission (who, to whom, what was said, and its
//! audio) so the dashboard can show it on air and replay it later.
//!
//! Stored under ~/.hyperia/radio: `log.jsonl` (one line per transmission) and
//! `<id>.wav`. Reads are loopback-only: summaries can carry work details.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Mutex;

use axum::extract::{ConnectInfo, Path, Query};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

/// Entries kept in memory and audio files kept on disk.
const KEEP: usize = 500;
/// Waveform outline resolution sent to the dashboard.
const PEAKS: usize = 160;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    /// Playback start, unix ms.
    pub ts: u64,
    pub from: String,
    #[serde(default)]
    pub from_pane: Option<String>,
    pub to: String,
    /// What the agent asked to say (no radio frame).
    pub text: String,
    /// The exact transcript spoken (frame included).
    pub spoken: String,
    pub voice: String,
    pub engine: String,
    pub secs: f64,
    /// Max |sample| per bin, 0–255.
    pub peaks: Vec<u8>,
}

/// What the caller knows before synthesis; the audio arrives at playback.
pub struct Meta {
    pub from: String,
    pub from_pane: Option<String>,
    pub to: String,
    pub text: String,
    pub spoken: String,
}

static LOG: Mutex<Option<VecDeque<Entry>>> = Mutex::new(None);

fn dir() -> PathBuf {
    crate::fsnav::home_dir().join(".hyperia").join("radio")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn with_log<R>(f: impl FnOnce(&mut VecDeque<Entry>) -> R) -> R {
    let mut g = LOG.lock().unwrap_or_else(|e| e.into_inner());
    let log = g.get_or_insert_with(load);
    f(log)
}

/// Newest KEEP entries from log.jsonl, oldest first.
fn load() -> VecDeque<Entry> {
    let text = std::fs::read_to_string(dir().join("log.jsonl")).unwrap_or_default();
    let mut out: VecDeque<Entry> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    while out.len() > KEEP {
        out.pop_front();
    }
    out
}

pub fn peaks(audio: &[f32]) -> Vec<u8> {
    if audio.is_empty() {
        return Vec::new();
    }
    let bins = PEAKS.min(audio.len());
    (0..bins)
        .map(|i| {
            let (a, b) = (i * audio.len() / bins, ((i + 1) * audio.len() / bins).max(i * audio.len() / bins + 1));
            let m = audio[a..b].iter().fold(0f32, |m, s| m.max(s.abs()));
            (m.clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect()
}

/// Record a transmission as it goes on air: write its audio, append the log.
/// Best-effort — a disk error never blocks playback.
pub fn record(meta: Meta, audio: &[f32], rate: u32, voice: &str, engine: &str) {
    let ts = now_ms();
    let id = format!("{ts}-{:04x}", rand_u16());
    let entry = Entry {
        id: id.clone(),
        ts,
        from: meta.from,
        from_pane: meta.from_pane,
        to: meta.to,
        text: meta.text,
        spoken: meta.spoken,
        voice: voice.to_string(),
        engine: engine.to_string(),
        secs: audio.len() as f64 / rate as f64,
        peaks: peaks(audio),
    };
    let d = dir();
    if let Err(e) = std::fs::create_dir_all(&d)
        .and_then(|_| write_wav(&d.join(format!("{id}.wav")), audio, rate))
    {
        tracing::warn!(target: "radio", "radio audio not saved: {e}");
    }
    if let Ok(line) = serde_json::to_string(&entry) {
        use std::io::Write;
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(d.join("log.jsonl"))
            .and_then(|mut f| writeln!(f, "{line}"));
    }
    let dropped: Vec<String> = with_log(|log| {
        log.push_back(entry);
        let mut gone = Vec::new();
        while log.len() > KEEP {
            if let Some(e) = log.pop_front() {
                gone.push(e.id);
            }
        }
        gone
    });
    for id in dropped {
        let _ = std::fs::remove_file(d.join(format!("{id}.wav")));
    }
}

fn rand_u16() -> u16 {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (n ^ (n >> 16)) as u16
}

fn write_wav(path: &std::path::Path, samples: &[f32], rate: u32) -> std::io::Result<()> {
    use std::io::Write;
    let data_len = (samples.len() as u32) * 2;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?; // PCM
    f.write_all(&1u16.to_le_bytes())?; // mono
    f.write_all(&rate.to_le_bytes())?;
    f.write_all(&(rate * 2).to_le_bytes())?;
    f.write_all(&2u16.to_le_bytes())?;
    f.write_all(&16u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for &s in samples {
        f.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
    }
    f.flush()
}

fn local_only(peer: &SocketAddr) -> Option<Response> {
    (!peer.ip().is_loopback()).then(|| (StatusCode::FORBIDDEN, "radio log is local-only").into_response())
}

#[derive(Deserialize)]
pub struct LogQuery {
    limit: Option<usize>,
}

/// GET /api/radio/log?limit=N — newest first, each with on_air and has_audio.
pub async fn get_log(ConnectInfo(peer): ConnectInfo<SocketAddr>, Query(q): Query<LogQuery>) -> Response {
    if let Some(r) = local_only(&peer) {
        return r;
    }
    let now = now_ms();
    let limit = q.limit.unwrap_or(60).min(KEEP);
    let d = dir();
    let entries: Vec<serde_json::Value> = with_log(|log| {
        log.iter()
            .rev()
            .take(limit)
            .map(|e| {
                let mut v = serde_json::to_value(e).unwrap_or_default();
                v["on_air"] = (now < e.ts + (e.secs * 1000.0) as u64).into();
                v["has_audio"] = d.join(format!("{}.wav", e.id)).exists().into();
                v
            })
            .collect()
    });
    axum::Json(serde_json::json!({"now": now, "entries": entries})).into_response()
}

/// GET /api/radio/audio/:id — the transmission's WAV.
pub async fn get_audio(ConnectInfo(peer): ConnectInfo<SocketAddr>, Path(id): Path<String>) -> Response {
    if let Some(r) = local_only(&peer) {
        return r;
    }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return (StatusCode::BAD_REQUEST, "bad id").into_response();
    }
    match std::fs::read(dir().join(format!("{id}.wav"))) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "audio/wav"), (header::CACHE_CONTROL, "max-age=86400")], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "no audio for that transmission").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peaks_outline_the_loudest_sample_per_bin() {
        let mut a = vec![0.0f32; 1600];
        a[5] = -0.5;
        a[1599] = 1.4; // clipped to full scale
        let p = peaks(&a);
        assert_eq!(p.len(), PEAKS);
        assert_eq!(p[0], 128);
        assert_eq!(p[PEAKS - 1], 255);
        assert!(p[1..PEAKS - 1].iter().all(|&x| x == 0));
        assert!(peaks(&[]).is_empty());
        assert_eq!(peaks(&[0.25; 3]).len(), 3);
    }

    #[test]
    fn wav_header_matches_the_samples() {
        let p = std::env::temp_dir().join(format!("radio-test-{}.wav", std::process::id()));
        write_wav(&p, &[0.0, 1.0, -1.0], 24_000).unwrap();
        let b = std::fs::read(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        assert_eq!(b.len(), 44 + 6);
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(b[24..28].try_into().unwrap()), 24_000);
        assert_eq!(i16::from_le_bytes([b[46], b[47]]), 32767);
    }
}
