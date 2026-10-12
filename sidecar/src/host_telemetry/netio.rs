//! Approximate network for host agents (not in n8 containers). Windows has no
//! per-process network counters without admin, so this samples each agent
//! pane's process-tree I/O (GetProcessIoCounters: file + network + device) and
//! records it as Network with host "io-approx"; the dashboard marks it as such.
//! Exact numbers come from the counting proxy (proxy.rs) for panes using it.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::bridge::Bridge;
use crate::telemetry::{NetDirection, TelemetryEvent, TelemetryStore};

const SAMPLE_EVERY: Duration = Duration::from_secs(3);
pub const HOST_APPROX: &str = "io-approx";

/// Bytes/s from two cumulative readings; a shrinking total (a child exited and
/// took its counters with it) restarts the baseline instead of going negative.
pub(crate) fn rate(prev: u64, now: u64, secs: f64) -> u64 {
    if now < prev || secs <= 0.0 {
        return 0;
    }
    ((now - prev) as f64 / secs) as u64
}

/// Total (read, written) bytes of `root` and all its descendants.
pub(crate) fn tree_io(sys: &System, children: &HashMap<Pid, Vec<Pid>>, root: Pid) -> (u64, u64) {
    let (mut r, mut w) = (0u64, 0u64);
    let mut stack = vec![root];
    let mut seen = 0usize;
    while let Some(pid) = stack.pop() {
        seen += 1;
        if seen > 4096 {
            break;
        }
        if let Some(p) = sys.process(pid) {
            let u = p.disk_usage();
            r = r.saturating_add(u.total_read_bytes);
            w = w.saturating_add(u.total_written_bytes);
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    (r, w)
}

pub fn spawn(bridge: Bridge, telemetry: TelemetryStore) {
    tokio::spawn(async move {
        let mut sys = System::new();
        let mut last: HashMap<String, (u64, u64, Instant)> = HashMap::new();
        loop {
            tokio::time::sleep(SAMPLE_EVERY).await;
            let panes: Vec<(String, u32)> = bridge
                .sessions()
                .await
                .iter()
                .filter(|(_, s)| s.pid > 0 && s.name != "web")
                .map(|(u, s)| (u.clone(), s.pid))
                .collect();
            // Host agents only: n8 container panes are measured by n8 itself.
            let mut wanted = Vec::new();
            for (uid, pid) in panes {
                let token = bridge
                    .classification_for(&uid)
                    .await
                    .and_then(|c| c.classification.agent_token().map(str::to_string));
                if token.as_deref().is_some_and(|t| !matches!(t, "n8" | "nemesis8")) {
                    wanted.push((uid, pid));
                }
            }
            last.retain(|uid, _| wanted.iter().any(|(u, _)| u == uid));
            if wanted.is_empty() {
                continue;
            }
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_disk_usage());
            let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
            for (pid, p) in sys.processes() {
                if let Some(parent) = p.parent() {
                    children.entry(parent).or_default().push(*pid);
                }
            }
            let now = Instant::now();
            for (uid, pid) in wanted {
                let (r, w) = tree_io(&sys, &children, Pid::from_u32(pid));
                if let Some((pr, pw, at)) = last.get(&uid) {
                    let secs = now.duration_since(*at).as_secs_f64();
                    let (rx, tx) = (rate(*pr, r, secs), rate(*pw, w, secs));
                    if rx > 0 {
                        telemetry.record(&uid, TelemetryEvent::Network { direction: NetDirection::Inbound, host: HOST_APPROX.into(), bytes: rx });
                    }
                    if tx > 0 {
                        telemetry.record(&uid, TelemetryEvent::Network { direction: NetDirection::Outbound, host: HOST_APPROX.into(), bytes: tx });
                    }
                }
                last.insert(uid, (r, w, now));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_never_go_negative() {
        assert_eq!(rate(1000, 4000, 3.0), 1000);
        assert_eq!(rate(4000, 1000, 3.0), 0, "a child exited: restart the baseline");
        assert_eq!(rate(0, 10, 0.0), 0);
    }

    #[test]
    fn tree_io_sums_this_process() {
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_disk_usage());
        let me = Pid::from_u32(std::process::id());
        let (r, w) = tree_io(&sys, &HashMap::new(), me);
        // A test binary has read itself and its libraries; totals are cumulative.
        assert!(r > 0 || w > 0);
    }
}
