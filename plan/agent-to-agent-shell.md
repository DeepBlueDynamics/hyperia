# Plan: external-agent turns visible + attributed in the Hyperia Shell

## Problem
External agents (Claude Code, Codex, n8) can already talk to the ghost via
POST /api/ghost/chat — but each POST gets its OWN SSE stream. The user's open
shell pane never sees those turns: no entry line, no attribution, no reply
rendering. From the human's seat it's invisible (or looks like "you").

## Feature (user spec)
When an agent messages the ghost while a shell pane is open:
- a SECOND entry line appears at the bottom, labeled with the sender
  (e.g. `claude-code~>` from its identity token label, `codex~>`, `n8~>`)
- the message "types out" into that line (streamed char animation), then
  submits — visually identical to a human turn, but attributed
- the ghost's reply renders in the same transcript as usual

## Design sketch
1. Session event bus: GhostSession gains a broadcast (tokio::sync::broadcast)
   that mirrors every GhostEvent AND a new TurnStart{speaker, text} event.
   /api/ghost/chat resolves caller identity from the Authorization header
   (resolve_caller) -> speaker label ("you" for the human shell, agent label
   otherwise) and publishes TurnStart before streaming.
2. Shell subscribes to GET /api/ghost/events (persistent SSE fan-out of the
   bus) in addition to its own POST streams. On TurnStart from a non-human
   speaker: render the second promptline (label + typing animation from the
   text), then render the streamed reply events that follow.
3. Identity: external agents MUST send Authorization: Bearer hyp_agent_...;
   anonymous callers render as `agent?~>`.
4. Concurrency: one turn at a time stays enforced by the existing session
   lock; a second caller's TurnStart queues visibly ("codex~> waiting…").

## Files
- sidecar/src/ghost/agent.rs (broadcast on GhostSession)
- sidecar/src/ghost/api.rs (ghost_chat identity + publish; new ghost_events)
- sidecar/src/main.rs (route /api/ghost/events)
- sidecar/static/shell.html (subscribe; second promptline component)

## Status
Planned only — no code yet (per instruction). Pairs with the doors-contract
full-send prompt fixes committed alongside this plan.
