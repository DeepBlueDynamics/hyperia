use sysinfo::{Pid, ProcessesToUpdate, System};

/// Convenience wrapper: builds a fresh sysinfo snapshot then finds the
/// foreground process for `shell_pid`. Use `foreground_process_with` when you
/// already have a snapshot (e.g. inside `get_status` which scans all panes).
pub fn foreground_process(shell_pid: u32) -> String {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    foreground_process_with(&sys, shell_pid)
}

/// Walk the process tree rooted at `shell_pid` using an existing sysinfo
/// snapshot and return the name of the deepest running descendant — the
/// foreground app the user is in.
///
/// Returns an empty string if the shell has no children (idle at prompt) or
/// if the PID can't be found.
pub fn foreground_process_with(sys: &System, shell_pid: u32) -> String {
    let root = Pid::from_u32(shell_pid);
    if sys.process(root).is_none() {
        return String::new();
    }
    deepest_child(sys, root).unwrap_or_default()
}

/// Recursively find the name of the deepest single-child descendant of `pid`.
///
/// - No children      → None (shell is idle; caller returns empty or shell name)
/// - One child        → recurse; the leaf is the foreground process
/// - Multiple children → return this node's direct child name (e.g. `cargo`
///                       spawning many `rustc` workers — we want "cargo")
fn deepest_child(sys: &System, pid: Pid) -> Option<String> {
    let children: Vec<Pid> = sys
        .processes()
        .iter()
        .filter_map(|(p, info)| {
            if info.parent() == Some(pid) {
                Some(*p)
            } else {
                None
            }
        })
        .collect();

    match children.len() {
        0 => None,
        1 => {
            let child = children[0];
            let name = sys
                .process(child)
                .map(|p| p.name().to_string_lossy().trim_end_matches(".exe").to_string())
                .unwrap_or_default();
            deepest_child(sys, child).or(Some(name))
        }
        _ => {
            // Multiple children: the direct child is the meaningful command
            // (e.g. `cargo` that spawned many `rustc` workers).
            sys.process(children[0])
                .map(|p| p.name().to_string_lossy().trim_end_matches(".exe").to_string())
        }
    }
}
