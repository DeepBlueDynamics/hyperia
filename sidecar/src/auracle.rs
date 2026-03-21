//! Auracle (voice/mic) integration — managed background process.
//!
//! Spawns auracle.exe as a child process with --auto-listen, receives
//! transcription callbacks via HTTP, and types them into the focused pane.
//!
//! Also manages the transcription service (Whisper) via Docker if available.

use std::process::Stdio;
use std::sync::Arc;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::bridge::Bridge;

// ---------------------------------------------------------------------------
// Locate auracle.exe
// ---------------------------------------------------------------------------

fn find_auracle_exe() -> Option<String> {
    if let Ok(p) = std::env::var("AURACLE_EXE") {
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let base = std::path::PathBuf::from(&home)
        .join("Code")
        .join("Gnosis")
        .join("djimic")
        .join("target");

    for profile in &["release", "debug"] {
        let exe = base.join(profile).join("auracle.exe");
        if exe.exists() {
            return Some(exe.to_string_lossy().into_owned());
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Docker / transcription service management
// ---------------------------------------------------------------------------

/// Check if Docker is available on this system.
async fn has_docker() -> bool {
    Command::new("docker")
        .arg("info")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Check if nvidia-smi is available (GPU support for Docker).
async fn has_nvidia_gpu() -> bool {
    Command::new("nvidia-smi")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Check if the transcription service is reachable.
async fn transcription_healthy(service_url: &str) -> bool {
    reqwest::get(format!("{}/health", service_url))
        .await
        .and_then(|r| Ok(r.status().is_success()))
        .unwrap_or(false)
}

/// Find the docker-compose directory for the transcription service.
fn transcription_compose_dir() -> Option<std::path::PathBuf> {
    // Look relative to the sidecar binary, then in well-known locations
    let candidates = [
        // Relative to sidecar binary
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .map(|p| p.join("..").join("services").join("transcription")),
        // In the hyperia repo
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .ok()
            .map(|h| {
                std::path::PathBuf::from(h)
                    .join("Code")
                    .join("Gnosis")
                    .join("hyperia")
                    .join("services")
                    .join("transcription")
            }),
    ];

    for candidate in candidates.into_iter().flatten() {
        let canonical = candidate.canonicalize().unwrap_or(candidate.clone());
        if canonical.join("docker-compose.yml").exists() {
            return Some(canonical);
        }
    }

    None
}

/// Ensure the transcription service is running. Start via Docker if possible.
async fn ensure_transcription(service_url: &str) -> TranscriptionCheck {
    // Already running?
    if transcription_healthy(service_url).await {
        return TranscriptionCheck {
            running: true,
            docker: false,
            gpu: false,
            message: "Transcription service already running".into(),
        };
    }

    // Try Docker
    if !has_docker().await {
        return TranscriptionCheck {
            running: false,
            docker: false,
            gpu: false,
            message: format!(
                "Transcription service not running at {service_url} and Docker not available. \
                 Install Docker or run the service manually: \
                 pip install openai-whisper aiohttp soundfile && \
                 python services/transcription/transcription_service.py"
            ),
        };
    }

    let compose_dir = match transcription_compose_dir() {
        Some(d) => d,
        None => {
            return TranscriptionCheck {
                running: false,
                docker: true,
                gpu: false,
                message: "Docker available but docker-compose.yml not found in services/transcription/".into(),
            };
        }
    };

    let gpu = has_nvidia_gpu().await;
    let compose_file = if gpu {
        "docker-compose.gpu.yml"
    } else {
        "docker-compose.yml"
    };

    tracing::info!(
        compose_dir = %compose_dir.display(),
        compose_file,
        gpu,
        "Starting transcription service via Docker"
    );

    let result = Command::new("docker")
        .arg("compose")
        .arg("-f")
        .arg(compose_file)
        .arg("up")
        .arg("-d")
        .current_dir(&compose_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .status()
        .await;

    match result {
        Ok(status) if status.success() => {
            // Wait for health check
            for _ in 0..30 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if transcription_healthy(service_url).await {
                    return TranscriptionCheck {
                        running: true,
                        docker: true,
                        gpu,
                        message: format!(
                            "Transcription service started via Docker ({})",
                            if gpu { "GPU" } else { "CPU" }
                        ),
                    };
                }
            }
            TranscriptionCheck {
                running: false,
                docker: true,
                gpu,
                message: "Docker container started but service not responding after 60s".into(),
            }
        }
        Ok(status) => TranscriptionCheck {
            running: false,
            docker: true,
            gpu,
            message: format!("docker compose up failed (exit {})", status),
        },
        Err(e) => TranscriptionCheck {
            running: false,
            docker: true,
            gpu,
            message: format!("docker compose error: {e}"),
        },
    }
}

#[derive(serde::Serialize, Clone)]
pub struct TranscriptionCheck {
    pub running: bool,
    pub docker: bool,
    pub gpu: bool,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Auracle handle
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Auracle {
    inner: Arc<AuracleInner>,
}

struct AuracleInner {
    child: Mutex<Option<Child>>,
    bridge: Bridge,
    sidecar_port: u16,
    service_url: String,
}

#[derive(serde::Serialize)]
pub struct VoiceStatus {
    pub running: bool,
    pub exe: Option<String>,
    pub service_url: String,
    pub auracle_http: String,
    pub transcription: Option<TranscriptionCheck>,
}

impl Auracle {
    pub fn new(bridge: Bridge, sidecar_port: u16) -> Self {
        let service_url = std::env::var("TRANSCRIPTION_SERVICE_URL")
            .unwrap_or_else(|_| "http://localhost:8765".into());

        Self {
            inner: Arc::new(AuracleInner {
                child: Mutex::new(None),
                bridge,
                sidecar_port,
                service_url,
            }),
        }
    }

    pub async fn is_running(&self) -> bool {
        let mut child = self.inner.child.lock().await;
        match child.as_mut() {
            Some(c) => match c.try_wait() {
                Ok(Some(_)) => {
                    *child = None;
                    false
                }
                Ok(None) => true,
                Err(_) => {
                    *child = None;
                    false
                }
            },
            None => false,
        }
    }

    pub async fn start(&self) -> Result<String, String> {
        if self.is_running().await {
            return Ok("Already running".into());
        }

        // Ensure transcription service is available before starting Auracle
        let tx_check = ensure_transcription(&self.inner.service_url).await;
        if !tx_check.running {
            tracing::warn!("Transcription: {}", tx_check.message);
            // Start anyway — Auracle will retry when segments come in
        } else {
            tracing::info!("Transcription: {}", tx_check.message);
        }

        let exe = find_auracle_exe().ok_or_else(|| {
            "auracle.exe not found. Set AURACLE_EXE or build djimic.".to_string()
        })?;

        let forward_url = format!(
            "http://127.0.0.1:{}/api/voice/forward",
            self.inner.sidecar_port
        );

        tracing::info!(
            exe = %exe,
            forward = %forward_url,
            service = %self.inner.service_url,
            "Starting Auracle"
        );

        let child = Command::new(&exe)
            .arg("serve")
            .arg("--auto-listen")
            .arg("--forward-url")
            .arg(&forward_url)
            .arg("--service-url")
            .arg(&self.inner.service_url)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Spawn failed: {e}"))?;

        let pid = child.id().unwrap_or(0);
        *self.inner.child.lock().await = Some(child);
        tracing::info!(pid, "Auracle started");
        Ok(format!("Started (pid {pid})"))
    }

    pub async fn stop(&self) -> String {
        let mut guard = self.inner.child.lock().await;
        if let Some(ref mut c) = *guard {
            let pid = c.id().unwrap_or(0);
            let _ = c.kill().await;
            *guard = None;
            tracing::info!(pid, "Auracle stopped");
            format!("Stopped (pid {pid})")
        } else {
            "Not running".into()
        }
    }

    pub async fn toggle(&self) -> Result<String, String> {
        if self.is_running().await {
            Ok(self.stop().await)
        } else {
            self.start().await
        }
    }

    pub async fn status(&self) -> VoiceStatus {
        let running = self.is_running().await;
        let tx_healthy = transcription_healthy(&self.inner.service_url).await;

        VoiceStatus {
            running,
            exe: find_auracle_exe(),
            service_url: self.inner.service_url.clone(),
            auracle_http: "http://127.0.0.1:3131".into(),
            transcription: Some(TranscriptionCheck {
                running: tx_healthy,
                docker: false, // don't re-check docker on every status call
                gpu: false,
                message: if tx_healthy {
                    "Transcription service healthy".into()
                } else {
                    format!("Transcription service not reachable at {}", self.inner.service_url)
                },
            }),
        }
    }

    /// Handle a forwarded transcript from Auracle. Types it into the focused pane.
    pub async fn handle_transcript(&self, text: &str) -> Result<String, String> {
        let status = self.inner.bridge.get_status().await;
        let uid = status["panes"]
            .as_array()
            .and_then(|panes| panes.first())
            .and_then(|p| p["uid"].as_str())
            .map(|s| s.to_string())
            .ok_or("No active pane")?;

        let cmd = serde_json::json!({
            "type": "Keys",
            "uid": uid,
            "keys": text,
        });
        self.inner.bridge.send_command(cmd).await
    }
}

// ---------------------------------------------------------------------------
// Init — mirrors deck::init_deck pattern
// ---------------------------------------------------------------------------

pub async fn init_auracle(
    bridge: Bridge,
    sidecar_port: u16,
    auto_start: bool,
) -> Auracle {
    let auracle = Auracle::new(bridge, sidecar_port);

    if auto_start {
        match auracle.start().await {
            Ok(msg) => tracing::info!("Auracle: {msg}"),
            Err(e) => tracing::warn!("Auracle: {e}"),
        }
    } else {
        tracing::info!("Auracle ready (use /api/voice/start or MCP voice_start)");
    }

    auracle
}
