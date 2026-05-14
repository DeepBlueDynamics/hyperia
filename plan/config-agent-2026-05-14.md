# Configuration Agent + Inline UI — Plan

Written 2026-05-14. Captures Kord's design for the settings/config agent
and the chat-inline UI pattern that powers it.

## Vision

The buttons at the top of the chat panel disappear. The model picker at the
bottom disappears. Instead, the user **talks** to the configuration agent —
"I want to edit the config myself", "change my model", "set up nuts.services"
— and the agent responds by **rendering UI inline in the chat** as the next
step. A button, an input field, a picker, a dialog. The user interacts with
it without leaving the conversation.

The configuration agent does not operate the user's terminal in general. Its
one exception is launching services in Docker (e.g. `docker run shivvr`) when
that's the right next step in the conversation.

## Components

### 1. `doctor` — readiness probe (sidecar tool)

Runs on every chat-panel open and exposed as an MCP tool. Returns a structured
report the agent reads to decide what to ask next.

```jsonc
doctor() → {
  "nuts_token":   { "configured": bool, "authenticated": bool, "email"?: string },
  "nemesis":      { "installed": bool, "path"?: string, "version"?: string },
  "shivvr":       { "reachable": bool, "url": string, "local": bool },
  "ferricula":    { "reachable": bool, "url": string, "memory_count"?: int },
  "ollama":       { "running": bool, "models": [string] },
  "model_proxy":  { "configured": bool, "provider"?: string },
  "platform":     { "os": "win32"|"darwin"|"linux", "arch": string }
}
```

Implementation notes:
- All probes hit local resources (filesystem, localhost ports) — no network
  calls except an `Authorization` header validation to nuts.services if a
  token is present.
- Probes run in parallel; doctor returns after the slowest.
- Each probe has a tight timeout (1–2 s).

### 2. Inline UI protocol — the `show_*` tools

The agent calls these MCP tools. They return immediately with a synthetic
"awaiting user input" result. The renderer sees a UI block in the assistant
message and renders an inline widget. When the user submits, the widget
posts a follow-up tool result that the agent reads on its next turn.

Tools to add:

```
show_input(id, prompt, kind="text"|"password"|"number", default?)
  → renders an inline single-line text input

show_button(id, label, hint?)
  → renders an inline clickable button; "click" is the user response

show_picker(id, prompt, options[{value, label, description?}])
  → renders an inline single-select dropdown or pill list

show_dialog(id, title, body, buttons[{value, label}])
  → renders a small inline modal with N choices

show_form(id, prompt, fields[{id, kind, label, default?}])
  → renders a small multi-field form (e.g. paste token + email together)
```

All five share a common envelope:

```jsonc
// Tool call (agent → renderer)
{
  "name": "show_input",
  "input": { "id": "nuts_token", "prompt": "Paste your nuts.services token", "kind": "password" }
}

// Tool result (renderer → agent, after user submits)
{
  "ui_response": { "id": "nuts_token", "value": "tok_abc123", "submitted_at": <ts> }
}
```

If the user dismisses the widget without responding, the tool result is
`{ "ui_response": { "id": "...", "dismissed": true } }` and the agent
should treat it as "not now".

### 3. Renderer wiring (the big piece)

This is the part of the work that lives outside the sidecar. Two pieces:

a. **Message content type** — the chat panel needs to recognize a `ui_block`
   content type in assistant messages and route it to a UI renderer. Currently
   the chat panel only handles text + tool_use blocks. Add a `ui_block`
   variant that carries the show_* payload.

b. **Widget components** — small React components for each `show_*` kind:
   `InlineInput`, `InlineButton`, `InlinePicker`, `InlineDialog`, `InlineForm`.
   Each is rendered once per `ui_block` and emits a single user-response
   event which becomes the next tool_result message.

c. **Drop the top buttons** — once `show_button("edit_config", "Edit config",
   ...)` works, we can remove the static button bar at the top of the panel.
   Keep an "Open editor" action behind a slash command for power users.

### 4. Configuration agent — the persona itself

A new ghost-style session that runs with:

- A system prompt focused on settings, onboarding, and service setup
- A **whitelisted tool set**: `doctor`, `settings_get`, `settings_set`,
  `settings_list_profiles`, all `show_*` tools, plus `docker_run` (Docker
  only — no `terminal_run`, no `file_read`, no `tab_snapshot`)
- A **fallback model** — when the user has no model configured, the
  configuration agent uses a Hyperia-hosted service that proxies to a
  small frontier model with strict scope limits (system prompt enforces
  "config-only" behavior; tool whitelist enforces it server-side)

Open: where does the fallback service live? Likely `cloud.nuts.services`
behind a long-lived service token. Cost-bounded per anonymous user.

### 5. `docker_run` — the one terminal exception

```
docker_run(args[], wait_ms=8000)
  → runs `docker <args>` in a managed pane (visible to the user),
    streams output, returns when the command exits or wait_ms elapses
```

Tight scope:
- Only `docker` as the binary (no `bash`, no `sh -c`, no pipes)
- Args validated against a denylist (no `--privileged`, no host bind
  mounts of system paths, no exposed-port collisions)
- User sees the pane open and the command appear — never hidden

The agent uses this to bring up Shivvr, Ferricula, Maximus support
services. Example flow: doctor says shivvr not reachable → agent
suggests "want me to start it for you?" → user says yes → agent runs
`docker_run(["run", "-d", "-p", "8771:8771", "--name", "shivvr",
"deepbluedynamics/shivvr:latest"])`.

### 6. Model picker — natural-language → typed choice

User: "change my model"

Agent:
1. Calls `model_search("")` (empty query = list all)
2. Gets back a ranked list: `{ id, name, provider, context, tier, price }`
3. Calls `show_picker("model_choice", "Which model?", options)`
4. User picks one
5. Agent calls `settings_set("config.model.id", choice)`

`model_search(query)` is a sidecar tool:
- Initial implementation: BM25 over a static table baked into the binary
  (mirrors `MODEL_TABLE` constant; ~50 known models)
- Future: backed by Ferricula's `/search` so the table can be updated
  without recompiling, and so user-curated overrides persist

Stub the BM25 in code now with a struct + function; promote to Ferricula
later when there's signal that the table needs to evolve.

## Phasing

Phase 1 (build first — small, real value):
- [ ] `doctor` MCP tool with all probes
- [ ] `show_input`, `show_button`, `show_picker` tools (sidecar side only —
      they return placeholder responses for now)
- [ ] Renderer support for `ui_block` content type + Input/Button/Picker
      widgets
- [ ] Remove the top button bar; add `show_button("edit_config", "Edit config")`
      as the equivalent affordance
- [ ] Configuration agent system prompt + tool whitelist

Phase 2 (after phase 1 lands):
- [ ] `show_dialog`, `show_form` (less common, can wait)
- [ ] `model_search` with static BM25 table
- [ ] Drop the bottom model dropdown; route "change my model" → picker
- [ ] `docker_run` with denylist

Phase 3 (depends on backend work):
- [ ] Fallback model service at cloud.nuts.services
- [ ] `nuts_login` flow (existing tool? new? — check)
- [ ] Ferricula-backed model table (replaces static BM25)
- [ ] User-curated model overrides

## Open questions

1. **Tool-call streaming for show_***: the agent calls `show_input(...)`
   and needs to *block* until the user responds. Anthropic tool_use
   doesn't block — the next message is whatever the agent decides.
   So the renderer must inject a `tool_result` for the show_* call only
   after the user submits. That's a renderer-side state machine, not a
   protocol change.

2. **Multiple show_* in one message**: can the agent emit several
   show_inputs at once (a "form")? Or must each be its own turn?
   Suggest: use `show_form` for multiple-fields-at-once; everything else
   is one-at-a-time.

3. **`docker_run` permission model**: prompt the user before each run,
   or trust the agent + show the command? Suggest: show the command in
   the pane (already visible by definition) but no extra dialog — the
   user sees what runs.

4. **Where does the configuration agent live in the UI?** New tab type,
   new panel, replaces the ghost chat, or just a different system prompt
   in the existing ghost chat? Suggest: same chat surface, different
   system prompt + tool set when user invokes `/config` or clicks an
   onboarding affordance.

5. **Fallback model UX when nothing is configured**: how does the user
   even reach the chat if they have no token? Suggest: the chat panel
   opens straight into the configuration agent on first run, using the
   fallback model, and walks the user through doctor → token → done.

## Files this work will touch

- `sidecar/src/mcp.rs` — add `doctor` and `show_*` tools
- `sidecar/src/ghost/registry.rs` — same tools for the ghost agent
- `sidecar/src/ghost/settings_agent.rs` (new) — config agent session
- `lib/components/chat/` — `ui_block` renderer + Input/Button/Picker
  widgets
- `lib/components/header.tsx` (or wherever the top bar lives) — remove
  static buttons
- `lib/components/model-picker.tsx` (existing) — repurpose or remove
- `app/ghost.ts` — wire `/config` slash command (or equivalent) to
  spawn the config agent session

## Related

- Issue #53 — feat(settings): settings agent chat panel + sidecar
  SettingsSession (still open; this plan supersedes the original
  panel-based design)
- Issue #66 — feat(settings): settings agent can enable/disable/
  configure Maximus (subsumed by this)
- Issue #54 — feat(ghost): open_settings tool (subsumed: this is
  `show_button("edit_config", ...)` now)
