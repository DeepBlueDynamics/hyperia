//! Door taxonomy + `DoorState` — the shared, pure data layer for the
//! MCP-tool-doors progressive-disclosure model (plan/mcp-tool-doors.md §3–§4).
//!
//! A **door** is a named category of tools. A small always-on **core** plus a
//! bounded set of *open* doors is all a model ever sees at once, so a 4B local
//! model (Sailfish, 8k context) or a token-billed cloud model never faces the
//! full 100+ tool catalog.
//!
//! ## Two surfaces, one catalog
//! Hyperia has two independent tool surfaces — the built-in ghost agent loop
//! (`ghost/registry.rs`) and the external MCP server (`mcp.rs`). They share the
//! *concept* of doors but expose different tool sets and, in places, different
//! door names (ghost `terminal` vs MCP `terminal_layout`). A single [`Door`]
//! entry therefore carries both a `ghost_tools` and an `mcp_tools` slice; a door
//! that only exists on one surface leaves the other slice empty. Pick the slice
//! for a surface with [`Door::tools`].
//!
//! ## Doors are NOT security
//! The door menu is a UX / token-budget concern only. Consent (`request_access`,
//! 202/403 soft-walls) and identity (Ghost's `hyp_agent_` token) are enforced at
//! the HTTP API layer, never here. Auto-opening a door on a direct tool call is
//! therefore safe by construction — it grants nothing the menu was withholding.
//!
//! This module is intentionally pure (no I/O, no async): it is exhaustively
//! unit-tested and consumed by both surfaces in later phases.

/// Which tool surface a [`DoorState`] / lookup applies to.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Surface {
    Ghost,
    Mcp,
}

/// A category of tools. Populated per surface: a door absent from a surface has
/// an empty slice there (see module docs).
#[derive(Clone, Copy, Debug)]
pub struct Door {
    pub name: &'static str,
    /// One-line summary — this is the *entire* cost of a closed door in the
    /// menu, so keep it terse.
    pub description: &'static str,
    pub ghost_tools: &'static [&'static str],
    pub mcp_tools: &'static [&'static str],
}

impl Door {
    /// The tool names this door exposes on `surface` (empty if the door does
    /// not exist there).
    pub fn tools(&self, surface: Surface) -> &'static [&'static str] {
        match surface {
            Surface::Ghost => self.ghost_tools,
            Surface::Mcp => self.mcp_tools,
        }
    }
}

// ---------------------------------------------------------------------------
// Core tool sets (always on). Includes the meta-tools that drive doors.
// ---------------------------------------------------------------------------

/// Ghost agent core — 11 defs (plan §3.1). `open_tools`/`close_tools` are new
/// meta-tools (added in Phase 2); `tool_search` is an existing registry tool.
pub const GHOST_CORE: &[&str] = &[
    "terminal_status",
    "terminal_run",
    "terminal_screen",
    "file_read",
    "file_write",
    "watercooler",
    "memory_recall",
    "memory_remember",
    // meta:
    "tool_search",
    "open_tools",
    "close_tools",
];

/// External MCP core — 12 defs (plan §3.2). `open_tools`/`close_tools`/
/// `search_tools` are new meta-tools (added in Phase 4).
pub const MCP_CORE: &[&str] = &[
    "terminal_status",
    "terminal_run",
    "terminal_screen",
    "terminal_keys",
    "terminal_split",
    "tab_snapshot",
    "request_access",
    "request_token",
    "hyperia_version",
    // meta:
    "open_tools",
    "close_tools",
    "search_tools",
];

/// Meta-tool names that live in the core but are NOT backed by a real
/// tool-def / router entry yet (added in Phase 2/4). Excluded when
/// cross-checking a core list against a live tool catalog.
pub const GHOST_META: &[&str] = &["open_tools", "close_tools"];
pub const MCP_META: &[&str] = &["open_tools", "close_tools", "search_tools"];

/// Core tools for a surface.
pub fn core_tools(surface: Surface) -> &'static [&'static str] {
    match surface {
        Surface::Ghost => GHOST_CORE,
        Surface::Mcp => MCP_CORE,
    }
}

// ---------------------------------------------------------------------------
// Door catalog (plan §3.1 ghost table + §3.2 MCP table).
//
// Doors shared across surfaces (same name, both slices populated): inspect,
// web, stickys, settings. Ghost-only: terminal, memory_deep, ui, create.
// MCP-only: terminal_layout, pulse, styles, telemetry_diag, editing.
// ---------------------------------------------------------------------------

pub const DOORS: &[Door] = &[
    // ---- shared-name doors -------------------------------------------------
    Door {
        name: "inspect",
        description: "Snapshots, shell state, confirmation & description of what's on screen",
        ghost_tools: &[
            "tab_snapshot",
            "shell_state",
            "shell_confirm",
            "auto_describe",
            "session_report",
            "maximus_explain",
            "terminal_ui_key",
        ],
        mcp_tools: &[
            "terminal_scrollback",
            "shell_log_search",
            "shell_state",
            "shell_confirm",
            "tab_image",
            "auto_describe",
            "terminal_ui_key",
        ],
    },
    Door {
        name: "web",
        description: "Open web panes, read/eval/click pages, fetch URLs",
        ghost_tools: &[
            "open_web_pane",
            "web_pane_content",
            "web_pane_eval",
            "web_pane_mouse",
            "terminal_web_click",
            "terminal_web_reload",
            "web_fetch",
        ],
        mcp_tools: &[
            "open_web_pane",
            "web_pane_content",
            "web_pane_eval",
            "web_pane_mouse",
            "terminal_web_click",
            "terminal_web_reload",
        ],
    },
    Door {
        name: "stickys",
        description: "Create, list, update & close sticky notes",
        ghost_tools: &[
            "sticky_note_create",
            "sticky_note_create_code",
            "sticky_note_list",
            "sticky_note_update",
            "sticky_note_close",
            "sticky_note_delete",
        ],
        mcp_tools: &[
            "sticky_note_create",
            "sticky_note_create_code",
            "sticky_note_list",
            "sticky_note_search",
            "sticky_note_read",
            "sticky_note_update",
            "sticky_note_open",
            "sticky_note_close",
            "sticky_note_delete",
            "sticky_note_schedule",
        ],
    },
    Door {
        name: "settings",
        description: "Diagnostics, model catalog, docker, settings profiles",
        ghost_tools: &[
            "doctor",
            "model_catalog",
            "docker_run",
            "help",
            "open_settings",
        ],
        mcp_tools: &[
            "settings_get",
            "settings_set",
            "settings_list_profiles",
            "settings_add_profile",
            "settings_delete_profile",
            "doctor",
        ],
    },
    // ---- ghost-only doors --------------------------------------------------
    Door {
        name: "terminal",
        description: "Terminal layout: keys, cd, split, focus, tabs & windows",
        ghost_tools: &[
            "terminal_keys",
            "terminal_cd",
            "terminal_split",
            "terminal_focus",
            "terminal_close",
            "terminal_new_tab",
            "terminal_new_window",
            "terminal_rename",
            "terminal_where_pane",
        ],
        mcp_tools: &[],
    },
    Door {
        name: "memory_deep",
        description: "Deep memory: dream, connect, SQL, inspect & embody",
        ghost_tools: &[
            "memory_dream",
            "memory_connect",
            "memory_status",
            "memory_sql",
            "memory_inspect",
            "memory_keystone",
            "memory_neighbors",
            "memory_embody",
        ],
        mcp_tools: &[],
    },
    Door {
        name: "ui",
        description: "Inline widgets: inputs, buttons, pickers, forms & tool mounts",
        ghost_tools: &["show_input", "show_button", "show_picker", "show_form", "tool_mount"],
        mcp_tools: &[],
    },
    Door {
        name: "create",
        description: "Author new tools at runtime",
        ghost_tools: &["tool_create"],
        mcp_tools: &[],
    },
    // ---- MCP-only doors ----------------------------------------------------
    Door {
        name: "terminal_layout",
        description: "Terminal layout: tabs, windows, focus, rename, cd, sizing",
        ghost_tools: &[],
        mcp_tools: &[
            "terminal_new_tab",
            "terminal_new_window",
            "terminal_close",
            "terminal_focus",
            "terminal_rename",
            "terminal_where_pane",
            "terminal_cd",
            "terminal_set_window_size",
            "terminal_flush_state",
        ],
    },
    Door {
        name: "pulse",
        description: "Pane busy/idle status and pulse indicators",
        ghost_tools: &[],
        mcp_tools: &[
            "pane_busy",
            "pane_idle",
            "pane_on_idle",
            "pane_pulse_set",
            "pane_pulse_clear",
            "pane_pulse_pause",
            "pane_pulse_status",
        ],
    },
    Door {
        name: "styles",
        description: "Manage terminal styles and dashboard widgets",
        ghost_tools: &[],
        mcp_tools: &["style_list", "style_create", "style_delete", "dashboard_widgets"],
    },
    Door {
        name: "telemetry_diag",
        description: "Telemetry, sidecar logs, audit search & agent status",
        ghost_tools: &[],
        mcp_tools: &[
            "telemetry_toggle",
            "telemetry_snapshot",
            "telemetry_record",
            "telemetry_reset",
            "sidecar_logs",
            "audit_search",
            "agent_status",
        ],
    },
    Door {
        name: "editing",
        description: "Apply text edits to files",
        ghost_tools: &[],
        mcp_tools: &["apply_text_edits"],
    },
];

/// Look up a door entry by name (surface-agnostic).
pub fn door_by_name(name: &str) -> Option<&'static Door> {
    DOORS.iter().find(|d| d.name == name)
}

/// Iterator over the doors that exist on `surface` (non-empty tool slice).
pub fn doors_for(surface: Surface) -> impl Iterator<Item = &'static Door> {
    DOORS.iter().filter(move |d| !d.tools(surface).is_empty())
}

/// Which door a tool belongs to on `surface`, or `None` if it is a core tool
/// or not part of the taxonomy at all.
pub fn door_of(surface: Surface, tool: &str) -> Option<&'static str> {
    doors_for(surface)
        .find(|d| d.tools(surface).contains(&tool))
        .map(|d| d.name)
}

/// Default live-tool cap. Overridable per-process via `HYPERIA_TOOL_CAP`.
pub const DEFAULT_TOOL_CAP: usize = 20;

fn cap_from_env() -> usize {
    std::env::var("HYPERIA_TOOL_CAP")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|&c| c > 0)
        .unwrap_or(DEFAULT_TOOL_CAP)
}

// ---------------------------------------------------------------------------
// DoorState — per-session (ghost) / per-identity (MCP) open-door bookkeeping.
// ---------------------------------------------------------------------------

/// Tracks which doors are currently open for one session/identity.
///
/// `open` is LRU-ordered: **front = oldest (least-recently-used), back = MRU**.
/// The invariant is a live-tool budget: `core + Σ open-door tools ≤ cap`.
/// Opening a door that would breach the cap evicts the oldest door(s) first
/// (never the door being opened — a single oversized door is allowed to exceed
/// the cap rather than be un-openable).
#[derive(Clone, Debug)]
pub struct DoorState {
    surface: Surface,
    open: Vec<String>,
    cap: usize,
    enabled: bool,
}

impl DoorState {
    /// New state for `surface`, cap read from `HYPERIA_TOOL_CAP` (default 20),
    /// doors mode disabled by default (enabled by the Phase 2/4 flags).
    pub fn new(surface: Surface) -> Self {
        Self {
            surface,
            open: Vec::new(),
            cap: cap_from_env(),
            enabled: false,
        }
    }

    /// Explicit-cap constructor — deterministic, for tests and config-driven
    /// caps (cloud providers get a larger cap; see plan §4.3).
    pub fn with_cap(surface: Surface, cap: usize) -> Self {
        Self {
            surface,
            open: Vec::new(),
            cap: cap.max(1),
            enabled: false,
        }
    }

    pub fn surface(&self) -> Surface {
        self.surface
    }
    pub fn cap(&self) -> usize {
        self.cap
    }
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
    }
    pub fn with_enabled(mut self, on: bool) -> Self {
        self.enabled = on;
        self
    }

    /// Open doors, oldest → newest (front → back).
    pub fn open_doors(&self) -> &[String] {
        &self.open
    }

    pub fn is_door_open(&self, name: &str) -> bool {
        self.open.iter().any(|d| d == name)
    }

    /// Count of the tools currently live: core + every open door's tools.
    pub fn live_tool_count(&self) -> usize {
        let mut n = core_tools(self.surface).len();
        for name in &self.open {
            if let Some(door) = door_by_name(name) {
                n += door.tools(self.surface).len();
            }
        }
        n
    }

    /// The full set of live tool names this turn: core first, then open doors
    /// in LRU order. Order is stable and deduped is unnecessary (the taxonomy
    /// is a partition — see unit tests).
    pub fn live_tools(&self) -> Vec<&'static str> {
        let mut out: Vec<&'static str> = core_tools(self.surface).to_vec();
        for name in &self.open {
            if let Some(door) = door_by_name(name) {
                out.extend_from_slice(door.tools(self.surface));
            }
        }
        out
    }

    /// Which door a tool belongs to on this surface (or `None` for core /
    /// unknown).
    pub fn door_of(&self, tool: &str) -> Option<&'static str> {
        door_of(self.surface, tool)
    }

    /// Open a door. Returns the list of doors evicted to stay within the cap
    /// (LRU order, oldest first). No-op (empty vec) if the door does not exist
    /// on this surface. If the door is already open it is moved to MRU.
    pub fn open_door(&mut self, name: &str) -> Vec<String> {
        // Reject doors that don't exist on this surface.
        match door_by_name(name) {
            Some(d) if !d.tools(self.surface).is_empty() => {}
            _ => return Vec::new(),
        }

        // Already open → move to MRU, nothing evicted.
        if let Some(pos) = self.open.iter().position(|d| d == name) {
            let d = self.open.remove(pos);
            self.open.push(d);
            return Vec::new();
        }

        // New door goes to the MRU end.
        self.open.push(name.to_string());

        // Evict oldest doors (front) until within cap — but never evict the
        // door we just opened (stop when it is the only one left).
        let mut evicted = Vec::new();
        while self.live_tool_count() > self.cap && self.open.len() > 1 {
            evicted.push(self.open.remove(0));
        }
        evicted
    }

    /// Mark a tool as used: move its door to MRU so it survives the next
    /// eviction longest. No-op for core tools and tools of closed doors.
    pub fn touch(&mut self, tool: &str) {
        if let Some(door_name) = self.door_of(tool) {
            if let Some(pos) = self.open.iter().position(|d| d == door_name) {
                let d = self.open.remove(pos);
                self.open.push(d);
            }
        }
    }

    /// Close a door (no-op if not open).
    pub fn close_door(&mut self, name: &str) {
        self.open.retain(|d| d != name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    // ---- taxonomy structure -------------------------------------------------

    #[test]
    fn every_door_has_at_most_ten_tools() {
        for d in DOORS {
            assert!(
                d.ghost_tools.len() <= 10,
                "ghost door '{}' has {} tools (>10)",
                d.name,
                d.ghost_tools.len()
            );
            assert!(
                d.mcp_tools.len() <= 10,
                "mcp door '{}' has {} tools (>10)",
                d.name,
                d.mcp_tools.len()
            );
        }
    }

    #[test]
    fn door_names_are_unique() {
        let mut seen = HashSet::new();
        for d in DOORS {
            assert!(seen.insert(d.name), "duplicate door name '{}'", d.name);
        }
    }

    /// No tool appears in two doors, nor in both a door and the core, on a
    /// given surface (the taxonomy must be a partition).
    fn assert_partition(surface: Surface) {
        let core: HashSet<&str> = core_tools(surface).iter().copied().collect();
        let mut seen: HashSet<&str> = HashSet::new();
        for d in doors_for(surface) {
            for &t in d.tools(surface) {
                assert!(
                    !core.contains(t),
                    "[{surface:?}] tool '{t}' is in both core and door '{}'",
                    d.name
                );
                assert!(
                    seen.insert(t),
                    "[{surface:?}] tool '{t}' appears in more than one door (door '{}')",
                    d.name
                );
            }
        }
    }

    #[test]
    fn ghost_taxonomy_is_a_partition() {
        assert_partition(Surface::Ghost);
    }

    #[test]
    fn mcp_taxonomy_is_a_partition() {
        assert_partition(Surface::Mcp);
    }

    #[test]
    fn expected_door_counts_per_surface() {
        // Plan §3.1 table: 8 ghost doors (header says "7", table lists 8 —
        // the table is authoritative). Plan §3.2: 9 MCP doors.
        assert_eq!(doors_for(Surface::Ghost).count(), 8, "ghost door count");
        assert_eq!(doors_for(Surface::Mcp).count(), 9, "mcp door count");
        assert_eq!(GHOST_CORE.len(), 11, "ghost core count");
        assert_eq!(MCP_CORE.len(), 12, "mcp core count");
    }

    /// Every ghost catalog tool (registry `tool_defs`) belongs to exactly one
    /// door OR the core — and every ghost taxonomy tool (minus meta) is a real
    /// registry tool. Validates the table against `registry.rs` directly.
    #[test]
    fn ghost_catalog_matches_registry_exactly() {
        use crate::ghost::registry::ToolRegistry;
        let reg = ToolRegistry::new(9800, "test-token".into());
        let catalog: HashSet<String> = reg
            .tool_defs(None, None, None)
            .into_iter()
            .map(|t| t.name)
            .collect();

        let core: HashSet<&str> = GHOST_CORE.iter().copied().collect();
        let meta: HashSet<&str> = GHOST_META.iter().copied().collect();

        // (a) Each registry tool is in exactly one place (core xor one door).
        for name in &catalog {
            let in_core = core.contains(name.as_str());
            let in_door = door_of(Surface::Ghost, name).is_some();
            assert!(
                in_core ^ in_door,
                "registry tool '{name}' must be in exactly one of core/door \
                 (core={in_core}, door={in_door})"
            );
        }

        // (b) Every non-meta core tool exists in the registry catalog.
        for &c in GHOST_CORE {
            if meta.contains(c) {
                continue;
            }
            assert!(
                catalog.contains(c),
                "core tool '{c}' is not a real registry tool"
            );
        }

        // (c) Every ghost door tool exists in the registry catalog.
        for d in doors_for(Surface::Ghost) {
            for &t in d.ghost_tools {
                assert!(
                    catalog.contains(t),
                    "ghost door '{}' tool '{t}' is not a real registry tool",
                    d.name
                );
            }
        }

        // (d) Nothing in the registry is left uncovered.
        for name in &catalog {
            let covered =
                core.contains(name.as_str()) || door_of(Surface::Ghost, name).is_some();
            assert!(covered, "registry tool '{name}' is not covered by any door or core");
        }
    }

    // ---- DoorState: cap / LRU / eviction -----------------------------------

    #[test]
    fn cap_not_breached_by_a_single_fitting_door() {
        // ghost core = 11, terminal door = 9 → 20, exactly the default cap.
        let mut s = DoorState::with_cap(Surface::Ghost, 20);
        let evicted = s.open_door("terminal");
        assert!(evicted.is_empty(), "no eviction expected");
        assert_eq!(s.live_tool_count(), 20);
        assert_eq!(s.open_doors(), &["terminal".to_string()]);
    }

    #[test]
    fn opening_second_door_evicts_oldest_when_over_cap() {
        // core 11 + terminal 9 = 20; adding web (7) → 27 > 20 → evict terminal.
        let mut s = DoorState::with_cap(Surface::Ghost, 20);
        s.open_door("terminal");
        let evicted = s.open_door("web");
        assert_eq!(evicted, vec!["terminal".to_string()]);
        assert_eq!(s.open_doors(), &["web".to_string()]);
        assert_eq!(s.live_tool_count(), 18); // 11 + 7
    }

    #[test]
    fn lru_order_and_eviction() {
        // Larger cap so two doors coexist, then a third forces one eviction.
        let mut s = DoorState::with_cap(Surface::Ghost, 30);
        assert!(s.open_door("terminal").is_empty()); // 11+9 = 20
        assert!(s.open_door("web").is_empty()); // +7 = 27 ≤ 30
        assert_eq!(s.open_doors(), &["terminal".to_string(), "web".to_string()]);

        // stickys (6) → 33 > 30 → evict oldest (terminal).
        let evicted = s.open_door("stickys");
        assert_eq!(evicted, vec!["terminal".to_string()]);
        assert_eq!(s.open_doors(), &["web".to_string(), "stickys".to_string()]);
    }

    #[test]
    fn touch_moves_door_to_mru() {
        let mut s = DoorState::with_cap(Surface::Ghost, 30);
        s.open_door("terminal");
        s.open_door("web");
        // web is MRU; touch a terminal tool → terminal becomes MRU.
        s.touch("terminal_split");
        assert_eq!(s.open_doors(), &["web".to_string(), "terminal".to_string()]);

        // Now opening stickys over cap should evict web (the new oldest).
        let evicted = s.open_door("stickys");
        assert_eq!(evicted, vec!["web".to_string()]);
    }

    #[test]
    fn touch_is_noop_for_core_and_closed_tools() {
        let mut s = DoorState::with_cap(Surface::Ghost, 30);
        s.open_door("terminal");
        s.open_door("web");
        let before = s.open_doors().to_vec();
        s.touch("terminal_run"); // core tool → no door
        s.touch("sticky_note_list"); // closed door → no-op
        assert_eq!(s.open_doors(), &before[..]);
    }

    #[test]
    fn reopening_open_door_moves_to_mru_without_eviction() {
        let mut s = DoorState::with_cap(Surface::Ghost, 30);
        s.open_door("terminal");
        s.open_door("web");
        let evicted = s.open_door("terminal"); // already open
        assert!(evicted.is_empty());
        assert_eq!(s.open_doors(), &["web".to_string(), "terminal".to_string()]);
    }

    #[test]
    fn single_oversized_door_is_allowed_to_exceed_cap() {
        // Tiny cap: even one door exceeds it, but we still open it (can't evict
        // the door being opened).
        let mut s = DoorState::with_cap(Surface::Ghost, 5);
        let evicted = s.open_door("terminal");
        assert!(evicted.is_empty());
        assert!(s.is_door_open("terminal"));
        assert!(s.live_tool_count() > s.cap());
    }

    #[test]
    fn close_door_removes_it() {
        let mut s = DoorState::with_cap(Surface::Ghost, 30);
        s.open_door("terminal");
        s.open_door("web");
        s.close_door("terminal");
        assert!(!s.is_door_open("terminal"));
        assert_eq!(s.open_doors(), &["web".to_string()]);
        s.close_door("terminal"); // idempotent
        s.close_door("nonexistent"); // no-op
        assert_eq!(s.open_doors(), &["web".to_string()]);
    }

    #[test]
    fn opening_unknown_or_wrong_surface_door_is_noop() {
        let mut s = DoorState::with_cap(Surface::Ghost, 30);
        assert!(s.open_door("does_not_exist").is_empty());
        // 'pulse' is an MCP-only door — invalid on the ghost surface.
        assert!(s.open_door("pulse").is_empty());
        assert!(s.open_doors().is_empty());
    }

    #[test]
    fn door_of_lookup() {
        assert_eq!(door_of(Surface::Ghost, "web_pane_eval"), Some("web"));
        assert_eq!(door_of(Surface::Ghost, "terminal_split"), Some("terminal"));
        assert_eq!(door_of(Surface::Ghost, "terminal_run"), None); // core
        assert_eq!(door_of(Surface::Ghost, "not_a_tool"), None);
        // MCP surface: same concept, surface-specific door name.
        assert_eq!(door_of(Surface::Mcp, "terminal_new_tab"), Some("terminal_layout"));
        assert_eq!(door_of(Surface::Mcp, "apply_text_edits"), Some("editing"));
        // A ghost-only tool is unknown on the MCP surface.
        assert_eq!(door_of(Surface::Mcp, "tool_create"), None);
    }

    #[test]
    fn live_tools_lists_core_then_open_doors() {
        let mut s = DoorState::with_cap(Surface::Ghost, 30);
        s.open_door("web");
        let live = s.live_tools();
        // core present
        assert!(live.contains(&"terminal_run"));
        // web door present
        assert!(live.contains(&"web_pane_eval"));
        // closed door absent
        assert!(!live.contains(&"sticky_note_list"));
        assert_eq!(live.len(), s.live_tool_count());
    }
}
