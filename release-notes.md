# Hyperia v0.17.51 — no more WebRTC leak 🕵️

A privacy fix that matters most if you drive web panes through a proxy.

## Web panes stop leaking your LAN IP over WebRTC

Real Chrome hides your private (LAN) addresses behind mDNS `.local` ICE candidates by default. Electron's `WebContentsView` — what Hyperia's web panes are — left the raw private IP exposed, so any page's `RTCPeerConnection` could read the host's `172.x` / `192.168.x` address even when the page's HTTP traffic was routed through a proxy.

That's a direct deanonymization signal: anti-bot systems cross-check the WebRTC address against your HTTP exit IP, and a mismatch — or a raw LAN address showing through — flags you instantly. Caught in the wild by nodemaven's connection checker running in a Hyperia pane: *"WebRTC exposed a raw LAN address, mDNS obfuscation is disabled."*

Each web pane now sets `default_public_interface_only`, binding WebRTC to the same public interface as the page's HTTP exit. No private-IP leak, and WebRTC still works — chosen over the nuclear `disable_non_proxied_udp`, which would break legitimate calls.

**Verify:** run any WebRTC leak test (e.g. nodemaven's connection checker) in a web pane — the WebRTC section should match your exit IP with no LAN address, instead of flagging a leak.

## Also

- `.claude/` (agent memory, subagent defs, local settings) is now untracked — local machine state, not repo material.

Coming from further back? [v0.17.50](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.17.50) added live tab-drag reordering and welcomed our newest committer.
