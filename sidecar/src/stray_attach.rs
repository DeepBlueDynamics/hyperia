//! Detach a container attach client left behind in a pane.
//!
//! When the program that ran `docker attach` (e.g. n8) dies, the attach client
//! can outlive it, still on the pane's terminal: it and the shell then both
//! read the keyboard ("half attached"). We remember every attach client seen
//! under a pane's shell; once one is still alive but no longer under that
//! shell, its parent is gone, so we kill it. The container keeps running.

use std::collections::HashMap;

use serde_json::json;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::bridge::Bridge;

const TICK: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub parent: Option<u32>,
    pub start: u64,
    pub cmdline: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stray {
    pub pane_uid: String,
    pub pid: u32,
    pub container: String,
}

#[derive(Default)]
pub struct Tracker {
    /// (pid, start time) → pane uid it was seen under.
    seen: HashMap<(u32, u64), String>,
}

fn base(arg: &str) -> String {
    let name = arg.rsplit(['/', '\\']).next().unwrap_or(arg).to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_string()
}

/// `docker|podman|nerdctl attach … <container>` → the container name.
pub fn attach_target(cmdline: &[String]) -> Option<String> {
    let first = cmdline.first()?;
    if !matches!(base(first).as_str(), "docker" | "podman" | "nerdctl") {
        return None;
    }
    let at = cmdline.iter().position(|a| a == "attach")?;
    cmdline[at + 1..].iter().rev().find(|a| !a.starts_with('-')).cloned()
}

fn under(pid: u32, root: u32, parents: &HashMap<u32, Option<u32>>) -> bool {
    let mut cur = pid;
    for _ in 0..64 {
        match parents.get(&cur).copied().flatten() {
            Some(p) if p == root => return true,
            Some(p) if p != cur => cur = p,
            _ => return false,
        }
    }
    false
}

impl Tracker {
    /// `panes` = (pane uid, shell pid). Returns attach clients to detach.
    pub fn step(&mut self, panes: &[(String, u32)], procs: &[Proc]) -> Vec<Stray> {
        let parents: HashMap<u32, Option<u32>> = procs.iter().map(|p| (p.pid, p.parent)).collect();
        for p in procs {
            if attach_target(&p.cmdline).is_none() {
                continue;
            }
            if let Some((uid, _)) = panes.iter().find(|(_, shell)| *shell != 0 && under(p.pid, *shell, &parents)) {
                self.seen.insert((p.pid, p.start), uid.clone());
            }
        }
        let mut strays = Vec::new();
        self.seen.retain(|(pid, start), uid| {
            let Some(p) = procs.iter().find(|p| p.pid == *pid && p.start == *start) else {
                return false; // exited
            };
            let Some((_, shell)) = panes.iter().find(|(u, _)| u == uid) else {
                return false; // pane closed
            };
            if under(p.pid, *shell, &parents) {
                return true;
            }
            strays.push(Stray {
                pane_uid: uid.clone(),
                pid: p.pid,
                container: attach_target(&p.cmdline).unwrap_or_default(),
            });
            false
        });
        strays
    }
}

fn snapshot(sys: &mut System) -> Vec<Proc> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cmd(UpdateKind::OnlyIfNotSet),
    );
    sys.processes()
        .iter()
        .map(|(pid, p)| Proc {
            pid: pid.as_u32(),
            parent: p.parent().map(|x| x.as_u32()),
            start: p.start_time(),
            cmdline: p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect(),
        })
        .collect()
}

pub fn spawn(bridge: Bridge) {
    tokio::spawn(async move {
        let mut tracker = Tracker::default();
        let mut sys = System::new();
        let mut tick = tokio::time::interval(TICK);
        loop {
            tick.tick().await;
            let panes: Vec<(String, u32, String)> = bridge
                .sessions()
                .await
                .iter()
                .map(|(uid, s)| (uid.clone(), s.pid, s.shell_name.clone()))
                .collect();
            let procs = snapshot(&mut sys);
            let pids: Vec<(String, u32)> = panes.iter().map(|(u, p, _)| (u.clone(), *p)).collect();
            for stray in tracker.step(&pids, &procs) {
                let killed = sys.process(Pid::from_u32(stray.pid)).is_some_and(|p| p.kill());
                let pane = panes
                    .iter()
                    .find(|(u, _, _)| *u == stray.pane_uid)
                    .map(|(_, _, n)| n.clone())
                    .unwrap_or_default();
                tracing::info!(pane = %pane, pid = stray.pid, container = %stray.container, killed, "detached stray attach client");
                if killed {
                    let reattach = if stray.container.starts_with("n8-") {
                        format!("n8 attach {}", stray.container)
                    } else {
                        format!("docker attach {}", stray.container)
                    };
                    let text = format!(
                        "Detached {pane} from container {} — the program that attached it had exited. \
                         The container is still running; reattach with: {reattach}",
                        stray.container
                    );
                    let _ = bridge.notify(json!({"type": "AgentNotice", "text": text})).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: Option<u32>, cmd: &str) -> Proc {
        Proc { pid, parent, start: 100, cmdline: cmd.split(' ').map(String::from).collect() }
    }
    fn panes() -> Vec<(String, u32)> {
        vec![("pane-a".into(), 10)]
    }
    const ATTACH: &str = "docker attach --sig-proxy=false --detach-keys=ctrl-^ n8-perky-lark";

    #[test]
    fn reads_the_container_from_attach_commands() {
        let cmd = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        assert_eq!(attach_target(&cmd(ATTACH)).as_deref(), Some("n8-perky-lark"));
        assert_eq!(attach_target(&cmd("C:\\bin\\podman.exe attach box")).as_deref(), Some("box"));
        assert_eq!(attach_target(&cmd("docker run -it img")), None);
        assert_eq!(attach_target(&cmd("n8 attach n8-x")), None);
    }

    #[test]
    fn an_attach_under_its_running_parent_is_left_alone() {
        let mut t = Tracker::default();
        let live = vec![proc(10, None, "pwsh"), proc(20, Some(10), "n8"), proc(30, Some(20), ATTACH)];
        assert!(t.step(&panes(), &live).is_empty());
        assert!(t.step(&panes(), &live).is_empty());
    }

    #[test]
    fn an_attach_whose_parent_died_is_detached_once() {
        let mut t = Tracker::default();
        t.step(&panes(), &[proc(10, None, "pwsh"), proc(20, Some(10), "n8"), proc(30, Some(20), ATTACH)]);
        let orphaned = vec![proc(10, None, "pwsh"), proc(30, Some(20), ATTACH)];
        assert_eq!(
            t.step(&panes(), &orphaned),
            vec![Stray { pane_uid: "pane-a".into(), pid: 30, container: "n8-perky-lark".into() }]
        );
        assert!(t.step(&panes(), &orphaned).is_empty());
    }

    #[test]
    fn a_clean_exit_or_closed_pane_is_forgotten() {
        let mut t = Tracker::default();
        t.step(&panes(), &[proc(10, None, "pwsh"), proc(30, Some(10), ATTACH)]);
        assert!(t.step(&panes(), &[proc(10, None, "pwsh")]).is_empty());
        t.step(&panes(), &[proc(10, None, "pwsh"), proc(31, Some(10), ATTACH)]);
        assert!(t.step(&[], &[proc(31, Some(1), ATTACH)]).is_empty());
    }

    #[test]
    fn a_reused_pid_is_not_mistaken_for_the_old_client() {
        let mut t = Tracker::default();
        t.step(&panes(), &[proc(10, None, "pwsh"), proc(30, Some(10), ATTACH)]);
        let mut reused = proc(30, Some(1), ATTACH);
        reused.start = 999;
        assert!(t.step(&panes(), &[proc(10, None, "pwsh"), reused]).is_empty());
    }
}
