# Hyperia v0.17.47 — the fleet keeps its memory 🧠

Two versions of fixes born the hard way: every one of these was diagnosed live against a running fleet of container agents while they were actively failing. The headliners: **restarts no longer strand your agents**, and **the sidecar can no longer wedge itself into a half-broken liar**.

## Restarts stop costing you the fleet (v0.17.47)

Pane tokens, pane owners, and durable consent grants now **persist across sidecar restarts** in `~/.hyperia/perms.json` — loaded at boot, written through on every change. The documented token lifecycle was always "stable for the pane's lifetime, revoked when the pane closes," and panes *survive* restarts via session reattach — so the restart wipe was a bug, not a policy. Its cost was real: every update or bounce stranded the whole container fleet on "No identity," followed by a re-consent storm as each agent re-earned access it already had.

Now: restart Hyperia, and your agents come back up still holding their identities and grants. Approve once, keep it.

Deliberately still ephemeral: timed grants, one-shot grants, denial cooldowns, and the master enforcement switch (every boot still comes up gated).

## The wedge is dead (v0.17.47)

A long-lived sidecar could degrade into a uniquely confusing state: **reads worked, writes failed** — agents got instant `HTTP error: error sending request` from `terminal_keys`/`terminal_run`, while the same send sometimes *delivered anyway*. In its terminal stage, the pane screen mirror froze too: agents (and the humans watching them) read half-hour-old screens that still showed an editor the user had long since closed.

Root cause: stale pooled keep-alive connections in the sidecar's internal localhost HTTP clients. Loopback pooling buys nothing and rots; every internal client now dials fresh with a 3-second connect timeout and zero idle pool. Requests either work or fail fast and honestly — no more gaslighting the fleet.

## Links that agents print actually work (v0.17.46)

Terminal URL detection was rebuilt around how agent output actually looks:

- **Wrapped URLs join.** Agents wrap long URLs with a real newline plus indentation — `(https://…/trump-` on one line, `unveils-…)` on the next. Those now read as one clickable link. Joining is deliberately conservative: only fragments ending in continuation characters (`- / _ . = & ?` …) join, so a URL that simply ends at end-of-line never glues to the next bullet.
- **URLs inside box-drawing frames work.** Claude-style `│ … │` panels no longer poison link detection at either edge.
- **`wiki/DDG(X)` survives.** The URL charset allows `)]}`, then trims trailing punctuation with paren-balance awareness — `(https://en.wikipedia.org/wiki/DDG(X))` yields the right link instead of an amputated one.
- **Right-click knows it's a link.** With wrapped links actually detected, hover registers and the link context menu (copy/open) appears instead of the generic menu.

The rebuilt provider was verified against six captured real-world shapes from live agent panes before shipping.

## Model picker (v0.17.46)

**GLM-5.3-flash** (released this week — open weights + Ollama cloud tag), `glm-5.3-flash:cloud`, and `glm-5.2:cloud` join the curated Ollama list, so the agent-config picker offers them out of the box.

## Also in the v0.17.45 line (already released, recapped)

Web panes sit pixel-perfect inside their frames on Linux (the CSS-pixels-vs-DIPs zoom bug), the update-zombie handover, the splash screen's removal, and the agent audio channel with ElevenLabs spoken summaries — see [v0.17.44](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.17.44) and [v0.17.45](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.17.45).

---

**Install:** artifacts below — Windows signed via Azure Trusted Signing, macOS signed + notarized, Linux .deb/AppImage. Auto-updaters on the canary channel pick this up automatically — and thanks to this release, that update is the last one your agents will even notice.
