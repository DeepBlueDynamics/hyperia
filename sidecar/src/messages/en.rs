//! English catalog — the source of truth and the fallback for every other locale.
//!
//! This module must cover every [`Msg`] variant; `messages::tests` enforces it.
//! Keep the prose here and the logic elsewhere: if you find yourself wanting a
//! conditional inside a string, that's a sign it should be two keys.
//!
//! Length guidance, learned the hard way (#135): text on an ERROR path is cheap —
//! it is emitted once, to an agent that is already stuck, and thoroughness there
//! saves a human from re-explaining. Text on an ALWAYS-ON surface (an MCP tool
//! description, the server instructions block) is charged to every agent on every
//! connect, forever. Put the long explanation in the refusal; leave a pointer in
//! the always-on surface.

use super::Msg;

pub fn get(key: Msg) -> Option<&'static str> {
    Some(match key {
        // ── Received-facts preambles ─────────────────────────────────────────
        // These report only what the server RECEIVED. They must never diagnose
        // the caller: "you have no identity" once sent two agents theory-building
        // about token tiers and config quests when the actual fact was "the
        // header never arrived" (#135).
        Msg::AnonNoAuthHeader => "FACT: this request arrived with NO Authorization header — the \
             server received no credentials at all. If you believe your client is configured with \
             a token, your transport is not sending it on THIS call.",

        Msg::AnonUnknownToken => "FACT: an Authorization token WAS received ({{prefix}}…, \
             {{len}} chars) but it is not recognized by this sidecar. Pane tokens (hyp_pane_…) are \
             deleted when their pane closes and wiped on sidecar restart; agent tokens \
             (hyp_agent_…) persist in ~/.hyperia/agents.json. Your token is most likely stale — \
             re-read HYPERIA_AGENT_TOKEN from a live pane or re-mint with request_token.",

        // ── Recovery guidance ────────────────────────────────────────────────
        Msg::RecoveryHost => "RECOVERY — you are calling from the host, so this is yours to fix. \
             1) Find the config block your session ACTUALLY loaded and make it send \
             Authorization = \"Bearer ${HYPERIA_AGENT_TOKEN}\". PRECEDENCE IS THE USUAL CULPRIT: \
             for the same server name a project-scoped entry SILENTLY SHADOWS the global one — \
             they are NOT merged — so a correct global entry does you no good when a \
             project-scoped entry omits `headers` entirely. For Claude Code, check any \
             project-local .mcp.json and projects[<cwd>].mcpServers.hyperia in ~/.claude.json \
             FIRST, before you look at the global mcpServers block, and confirm the header is \
             present in whichever one actually wins. 2) FULLY RESTART this agent process \
             afterward — MCP Authorization headers are read ONLY at startup; editing config \
             mid-session, or reconnecting with '/mcp', does NOT reload them. This is the step most \
             often missed. 3) Verify with hyperia_version (a read), then retry the write. NOTE: \
             request_token will NOT rescue an in-pane agent — it mints a token you have no way to \
             inject into an already-running connection. It is for external clients that can \
             rewrite their config and reconnect.",

        Msg::RecoveryContainer => "RECOVERY — this request's Host header is a container \
             host-gateway, not loopback, so you are almost certainly running INSIDE A CONTAINER. \
             DO NOT hand-edit MCP config in here and DO NOT go hunting for a token on the \
             container filesystem. The container is EPHEMERAL: anything you change is wiped when \
             it is next rebuilt or reset, the same failure comes back, and the next agent debugs \
             it from scratch. The fix belongs to the ORCHESTRATOR on the host — for nemesis8 that \
             is the checked-in server config (mcp-servers/hyperia.toml) and the HYPERIA_URL env it \
             injects, which is durable and applies to every future container. Report this to the \
             human or to the orchestrating host agent and let them make the change; the container \
             then has to be restarted to pick it up.\n\
             SEPARATELY, IF YOU CANNOT REACH THE SIDECAR AT ALL (connection refused, rather than \
             this message): that is BIND SCOPE, not auth, and the answer DEPENDS ON YOUR CONTAINER \
             RUNTIME — Hyperia supports both docker and podman, so identify which one you are on \
             before concluding anything. Under Docker Desktop (Windows/macOS) host.docker.internal \
             is forwarded by the VM to the host's loopback, so a loopback-bound sidecar is \
             reachable and a refused connection means something else. Under PODMAN, and under \
             native Linux docker, the host is reached through a REAL bridge gateway instead \
             (podman typically 10.88.0.1 and the name host.containers.internal, docker typically \
             172.17.0.1) — nothing is listening there when the sidecar is bound to loopback, so \
             every container call is refused no matter how correct your MCP config is. That is \
             fixed host-side by binding wider (HYPERIA_BIND=0.0.0.0), never from inside the \
             container.",

        // ── Refusals ─────────────────────────────────────────────────────────
        Msg::DriveRefuseHome => "That's the pane you're running in — you can't drive your own \
             terminal. Split it or open a new pane for a worker shell.",

        Msg::DriveSoftWall => "{{facts}} Reads (terminal_status, terminal_screen, hyperia_version) \
             work without identity; writes (terminal_run/keys/cd/split, etc.) do not. IMPORTANT: \
             do NOT call request_access to fix this — request_access ALSO requires identity and \
             will return this exact error. Identity comes first, access second.\n\
             {{recovery}}\n\
             Once identity works, if you still need to drive a pane you don't own, request_access \
             will then be able to raise the user's approval prompt.",

        Msg::CreateSoftWall => "{{facts}} Creating panes/tabs requires identity.\n{{recovery}}",

        Msg::CapabilitySoftWall => "{{facts}} The '{{cap}}' capability therefore can't be \
             authorized.\n{{recovery}}",

        // ── Tool responses ───────────────────────────────────────────────────
        Msg::RequestTokenMinted => "Minted a persistent Hyperia agent token for \"{{name}}\":\n\n  \
             {{token}}\n\n\
             USE IT RIGHT NOW — NO RESTART NEEDED. Your MCP connection's Authorization header is \
             frozen at startup, but the sidecar reads credentials fresh on EVERY plain-HTTP \
             request. Call the HTTP API directly with the header \
             Authorization: Bearer {{token}} — prove it with GET {{base}}/api/identity/whoami, \
             then use any endpoint (the MCP tools are thin wrappers over {{base}}/api/... routes). \
             This works from anywhere that can reach the sidecar: host shells, panes, and \
             containers (same base URL you already use).\n\n\
             MAKE IT PERMANENT — hand this to your human (or run it yourself if you are a host \
             session) so future sessions are born working:\n  \
             claude mcp add --transport http hyperia {{base}}/mcp --header \
             \"Authorization: Bearer {{token}}\"\n\
             SCOPE WARNING: for the same server name a project-scoped entry silently SHADOWS a \
             user/global one — they are not merged. Fix the entry your session ACTUALLY loads \
             (check the project scope first; `claude mcp remove hyperia` there if one exists), or \
             the add changes nothing. The new header takes effect on the NEXT session start.\n\n\
             This token persists in ~/.hyperia/agents.json; calling request_token again with the \
             same name returns it.\n\n\
             CAVEAT — IN A CONTAINER (docker or podman — you reach this sidecar via \
             host.docker.internal, host.containers.internal, or a gateway IP): the direct-HTTP \
             path above works immediately, but do NOT wire this token into container-local \
             config; that filesystem is ephemeral and the edit is wiped on the next reset. For \
             the permanent fix, report to the host orchestrator instead (nemesis8: \
             mcp-servers/hyperia.toml + HYPERIA_URL), then restart the container.",
    })
}
