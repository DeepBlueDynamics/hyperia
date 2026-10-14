//! Health readout for the Control Deck's corner panels: GPU (with the
//! processes holding VRAM), host CPU/RAM, delivery and mail backlog, the
//! sidecar's own warnings, and the radio. Loopback only, like the radio log.
//!
//! Slow probes (nvidia-smi, Windows GPU counters) run on a background loop;
//! the endpoint only reads their last result plus a few small files.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ConnectInfo;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use sysinfo::{MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

static STARTED: LazyLock<Instant> = LazyLock::new(Instant::now);
static PROBES: LazyLock<Mutex<Value>> = LazyLock::new(|| Mutex::new(json!({})));

/// Mail to a pane that's still unread after this long is called out.
const UNREAD_AFTER_MS: u64 = 3 * 60 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// One nvidia-smi line: name, util %, temp °C, power W, used MiB, total MiB.
pub(crate) fn parse_smi(line: &str) -> Option<Value> {
    let f: Vec<&str> = line.split(',').map(str::trim).collect();
    if f.len() < 6 {
        return None;
    }
    let num = |s: &str| s.parse::<f64>().ok();
    Some(json!({
        "name": f[0], "util": num(f[1]), "temp": num(f[2]), "power_w": num(f[3]),
        "vram_used_gb": num(f[4]).map(|m| m / 1024.0), "vram_total_gb": num(f[5]).map(|m| m / 1024.0),
    }))
}

/// typeperf CSV for "\GPU Process Memory(*)\Dedicated Usage": bytes per pid.
pub(crate) fn parse_typeperf(csv: &str) -> HashMap<u32, f64> {
    let rows: Vec<Vec<String>> = csv
        .lines()
        .filter(|l| l.starts_with('"'))
        .map(|l| l.split("\",\"").map(|c| c.trim_matches('"').to_string()).collect())
        .collect();
    let mut out = HashMap::new();
    let (Some(head), Some(vals)) = (rows.first(), rows.get(1)) else { return out };
    for (h, v) in head.iter().zip(vals).skip(1) {
        let Some(pid) = h.split("pid_").nth(1).and_then(|r| r.split('_').next()).and_then(|p| p.parse::<u32>().ok()) else { continue };
        if let Ok(bytes) = v.trim().parse::<f64>() {
            *out.entry(pid).or_insert(0.0) += bytes;
        }
    }
    out
}

/// Friendlier names for the usual big VRAM holders.
fn label(proc_name: &str) -> String {
    let n = proc_name.trim_end_matches(".exe");
    match n.to_ascii_lowercase().as_str() {
        "vmwp" => "WSL / Docker VM".into(),
        "dwm" => "Windows desktop".into(),
        _ => n.to_string(),
    }
}

pub fn spawn() {
    LazyLock::force(&STARTED);
    tokio::spawn(async move {
        let mut sys = System::new_with_specifics(RefreshKind::new().with_memory(MemoryRefreshKind::everything()));
        let mut tick: u64 = 0;
        loop {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let mut host = json!({
                "cpu": sys.global_cpu_usage(),
                "ram_used_gb": sys.used_memory() as f64 / 1e9,
                "ram_total_gb": sys.total_memory() as f64 / 1e9,
            });
            host["cores"] = json!(sys.cpus().len());
            let gpu = if tick % 2 == 0 {
                tokio::task::spawn_blocking(|| {
                    let out = quiet(std::process::Command::new("nvidia-smi").args([
                        "--query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total",
                        "--format=csv,noheader,nounits",
                    ]))
                    .output()
                    .ok()?;
                    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).lines().next().and_then(parse_smi)).flatten()
                })
                .await
                .ok()
                .flatten()
            } else {
                None
            };
            let procs = if cfg!(windows) && tick % 5 == 0 {
                let per_pid = tokio::task::spawn_blocking(|| {
                    let out = quiet(std::process::Command::new("typeperf").args(["\\GPU Process Memory(*)\\Dedicated Usage", "-sc", "1"]))
                        .output()
                        .ok()?;
                    Some(parse_typeperf(&String::from_utf8_lossy(&out.stdout)))
                })
                .await
                .ok()
                .flatten();
                per_pid.map(|m| {
                    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new());
                    let mut v: Vec<(String, f64)> = m
                        .into_iter()
                        .filter(|(_, b)| *b > 50e6)
                        .map(|(pid, b)| {
                            let name = sys.process(Pid::from_u32(pid)).map(|p| p.name().to_string_lossy().to_string()).unwrap_or_else(|| format!("pid {pid}"));
                            (label(&name), b / 1e9)
                        })
                        .collect();
                    v.sort_by(|a, b| b.1.total_cmp(&a.1));
                    v.truncate(5);
                    v.into_iter().map(|(n, gb)| json!({"name": n, "gb": gb})).collect::<Vec<_>>()
                })
            } else {
                None
            };
            {
                let mut p = PROBES.lock().unwrap_or_else(|e| e.into_inner());
                p["host"] = host;
                if let Some(g) = gpu {
                    p["gpu"] = g;
                }
                if let Some(pr) = procs {
                    p["gpu_procs"] = json!(pr);
                }
            }
            tick += 1;
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

/// Last `max` bytes of a file, from the first whole line.
fn tail(path: &Path, max: u64) -> String {
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let s = String::from_utf8_lossy(&buf).to_string();
    if start > 0 { s.split_once('\n').map(|(_, r)| r.to_string()).unwrap_or_default() } else { s }
}

fn hyperia_dir() -> PathBuf {
    crate::fsnav::home_dir().join(".hyperia")
}

/// Counts by state over the last hour, plus anything queued or awaiting approval.
fn delivery() -> Value {
    let raw = std::fs::read_to_string(hyperia_dir().join("delivery-operations.json")).unwrap_or_default();
    let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let ops: Vec<&Value> = match &v {
        Value::Array(a) => a.iter().collect(),
        Value::Object(o) => match o.get("operations") {
            Some(Value::Object(m)) => m.values().collect(),
            Some(Value::Array(a)) => a.iter().collect(),
            _ => o.values().collect(),
        },
        _ => vec![],
    };
    let hour = now_ms().saturating_sub(3_600_000);
    let mut c: HashMap<String, u64> = HashMap::new();
    for op in ops {
        let state = op["state"].as_str().unwrap_or("").to_ascii_lowercase();
        let recent = op["created_ms"].as_u64().unwrap_or(0) >= hour;
        if recent || matches!(state.as_str(), "queued" | "awaitingapproval" | "awaiting_approval") {
            *c.entry(state).or_default() += 1;
        }
    }
    let get = |k: &[&str]| k.iter().map(|s| c.get(*s).copied().unwrap_or(0)).sum::<u64>();
    let (held_sends, held_mail) = crate::held_input::HELD.try_lock().map(|h| h.counts()).unwrap_or((0, 0));
    json!({
        "queued": get(&["queued"]),
        "awaiting_approval": get(&["awaitingapproval", "awaiting_approval"]),
        "failed_1h": get(&["failed", "indeterminate", "expired"]),
        "submitted_1h": get(&["submitted"]),
        "held_sends": held_sends, "held_mail": held_mail,
    })
}

/// Pane mail still unread after UNREAD_AFTER_MS (last 30 min only).
fn unread_mail() -> Value {
    let logs = hyperia_dir().join("logs");
    let reads: HashSet<String> = tail(&logs.join("message-reads.jsonl"), 512 * 1024)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok()?["msgId"].as_str().map(str::to_string))
        .collect();
    let now = now_ms();
    let mut by_pane: HashMap<String, u64> = HashMap::new();
    for l in tail(&logs.join("messages.jsonl"), 512 * 1024).lines() {
        let Ok(m) = serde_json::from_str::<Value>(l) else { continue };
        if !m["toPrincipal"].as_str().unwrap_or("").starts_with("pane:") {
            continue;
        }
        let age = now.saturating_sub(m["ts"].as_u64().unwrap_or(now));
        if age < UNREAD_AFTER_MS || age > 30 * 60 * 1000 || reads.contains(m["id"].as_str().unwrap_or("")) {
            continue;
        }
        *by_pane.entry(m["to"].as_str().unwrap_or("?").to_string()).or_default() += 1;
    }
    json!(by_pane.into_iter().map(|(to, n)| json!({"to": to, "count": n})).collect::<Vec<_>>())
}

/// WARN/ERROR lines in the sidecar log over the last hour (known noise skipped).
pub(crate) fn count_problems(log: &str, since_iso: &str) -> (u64, u64) {
    let (mut warn, mut err) = (0, 0);
    for l in log.lines() {
        if l.get(..since_iso.len()).is_none_or(|ts| ts < since_iso) || l.contains("server-discover-probe") {
            continue;
        }
        if l.contains(" WARN ") {
            warn += 1;
        } else if l.contains(" ERROR ") || l.contains("panicked") {
            err += 1;
        }
    }
    (warn, err)
}

fn sidecar() -> Value {
    let logs = hyperia_dir().join("logs");
    let newest = std::fs::read_dir(&logs)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("sidecar.log."))
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    let since = crate::workspace::epoch_to_rfc3339(now_ms() / 1000 - 3600);
    let (warn, err) = newest.map(|e| count_problems(&tail(&e.path(), 2 * 1024 * 1024), &since)).unwrap_or((0, 0));
    json!({"version": env!("CARGO_PKG_VERSION"), "uptime_s": STARTED.elapsed().as_secs(), "warn_1h": warn, "error_1h": err})
}

/// GET /api/deck/health
pub async fn get_health(ConnectInfo(peer): ConnectInfo<SocketAddr>) -> Response {
    if let Some(r) = crate::radio_log::local_only(&peer) {
        return r;
    }
    let mut body = PROBES.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let (d, u, s) = tokio::task::spawn_blocking(|| (delivery(), unread_mail(), sidecar())).await.unwrap_or((json!({}), json!([]), json!({})));
    body["delivery"] = d;
    body["unread_mail"] = u;
    body["sidecar"] = s;
    body["radio"] = crate::radio::summary();
    Json(body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_smi_line() {
        let g = parse_smi("NVIDIA GeForce RTX 3060, 33, 47, 53.20, 11049, 12288").unwrap();
        assert_eq!(g["name"], "NVIDIA GeForce RTX 3060");
        assert_eq!(g["util"], 33.0);
        assert!((g["vram_total_gb"].as_f64().unwrap() - 12.0).abs() < 1e-9);
        assert!(parse_smi("garbage").is_none());
    }

    #[test]
    fn parses_typeperf_per_pid_and_sums_adapters() {
        let csv = "\r\n\"(PDH-CSV 4.0)\",\"\\\\BOX\\GPU Process Memory(pid_28856_luid_0x1_phys_0)\\Dedicated Usage\",\"\\\\BOX\\GPU Process Memory(pid_28856_luid_0x2_phys_0)\\Dedicated Usage\",\"\\\\BOX\\GPU Process Memory(pid_2080_luid_0x1_phys_0)\\Dedicated Usage\"\r\n\"10/14/2026 16:00:00.000\",\"4000000000\",\"500000000\",\"1800000000\"\r\n";
        let m = parse_typeperf(csv);
        assert_eq!(m[&28856], 4.5e9);
        assert_eq!(m[&2080], 1.8e9);
        assert_eq!(label("vmwp.exe"), "WSL / Docker VM");
    }

    #[test]
    fn counts_recent_problems_and_skips_known_noise() {
        let log = "2026-10-14T20:00:00Z  WARN old\n2026-10-14T21:30:00Z  WARN rmcp server-discover-probe-1\n2026-10-14T21:31:00Z  WARN real\n2026-10-14T21:32:00Z ERROR boom\n";
        assert_eq!(count_problems(log, "2026-10-14T21:00:00"), (1, 1));
    }
}
