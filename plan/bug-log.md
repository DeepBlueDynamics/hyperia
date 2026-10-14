# Hyperia bug log

Bugs found while using Hyperia and what was done about them. Newest first.
"Shipped in" is the first installer that has the fix; "unbuilt" means the fix
is committed but no installer has it yet.

| # | Found | Bug | Cause | Fix | Status |
|---|---|---|---|---|---|
| 13 | 2026-10-14 | On the Control Deck, host-claude's spoken reply sounded from the very top of the ring, not from its pane | `/api/tts` used an agent's pane binding to pick the spoken name but recorded `from_pane` only for pane callers, so the deck had no pane to draw from and fell back to the top | Record the pane found for the name as `from_pane` for bound agents too | Fixed, unbuilt |
| 12 | 2026-10-14 | Host Claude resumed in a Hyperia pane (Ordinary Penguin) got "[Hyperia mail] … run msg_check" for a radio call, but `msg_check` showed only months of old host-claude mail | The project-scoped `hyperia` MCP entry in `~/.claude.json` hard-codes the host-claude token, shadowing the global `${HYPERIA_AGENT_TOKEN:-…}` one, so the agent isn't its pane and pane mail is invisible to it. A fresh MCP child session also replays the parent's whole unread backlog in one result (128k chars) | Workaround: `pane_bind` host-claude to the pane (awaiting approval). Proposed: the notice should say which mailbox to read, and `msg_check` should cap/oldest-skip a huge parent backlog | Open |
| 11 | 2026-10-14 | Inevitable Bobcat got 9 radio mails under call signs it never saw ("may be meant for me") | Signs rotate after every call, so by the time queued calls are read the pane holds a different sign; the mail never said the heard sign was this pane's | `radio_deliver` mail now opens with "You were called as “Golf India”, this pane's call sign at the time of the call…" | Fixed, unbuilt |
| 10 | 2026-10-14 | Radio (hertz) mail to Stable Xerinae arrived ~1 min late | The mail notice is withheld while the human is in or typing in the pane; nothing tells them it's waiting | Held mail notices show a top-right "📨 … Deliver now / Later" toast (feat/held-input-toast) | Fixed, unbuilt |
| 9 | 2026-10-14 | An agent's send into the pane the human is in waits silently until they leave | Focus protection defers it with no signal | Top-right "⌨️ … Send now / Later" toast; Send now releases that one send and blurs the pane (`a3290352`) | Fixed, unbuilt |
| 8 | 2026-10-14 | Magnificent Vole called itself "Vulnerable Canid"; reply could go astray | Context compaction kept the old pane's name as a fact; Hyperia's own labels were correct | Proposed: stamp "You are X in pane Y" on the first tool result per MCP session and after a rename | Open |
| 7 | 2026-10-13 | Inevitable Bobcat, resumed in a new pane, used its old pane name | Same as #8, via `claude --resume` | Same as #8 | Open |
| 6 | 2026-10-13 | Unread pane mail is unreachable once its pane closes | Pane mail belongs to the pane ID; the new pane has a new ID and token | Proposed: park it; when a likely successor shows up (same Claude conversation), ask the human to move it | Open |
| 5 | 2026-10-12 | Web panes and web-only tabs showed their uid instead of the page | The layout sync with title/URL was sent before the sidecar socket opened and never resent | Kept on the tracked session and replayed on register (`096fff56`) | Shipped 0.21.13 |
| 4 | 2026-10-12 | Local build refused to run while a sibling checkout had dev watchers | The build guard matched process command lines by path prefix | Match repo path plus a trailing separator (`59ae3cb3`) | Shipped 0.21.12 |
| 3 | 2026-10-12 | `[555;x;yM` junk typed into a pane after n8 exited | n8 left mouse/focus reporting switched on | Switch it off when the pane is back at an idle prompt off the alt screen (`c1e406d6`) | Shipped 0.21.12 |
| 2 | 2026-10-12 | Host agents' reads didn't register, saves counted as creates, edits counted twice | Read tool not mapped; known paths treated as new; watcher and OTel both reported | Map Read, treat known paths as modified, hold watcher changes 6 s and dedupe against OTel for 15 s (`fb6d0337`) | Shipped 0.21.12 |
| 1 | 2026-10-12 | Release e2e failed on Ubuntu with `UnknownVizError` | The after-hook screenshot throws on that runner | Screenshot is best-effort (`7fd703e8`, PR #318) | Merged to canary |

## Handed to other projects

| Found | Bug | Where |
|---|---|---|
| 2026-10-13 | Codex agent's `nuts_edit` edits never reach the Hyperia deck | nuts-files runs without `NEMESIS8_EVENTS_FILE`/`NEMESIS8_AGENT_ID`, so its events carry no agent ID: nemesis8 #166 |
| 2026-10-14 | hertz takes ~7 s to route a call; its double-check sends worse transcripts as follow-ups | hertz relay (the agent in Stable Xerinae offered to tighten the check) |
