# Orders — complete `llm` integration across nemesis8 + Hyperia

**Status when these orders were written.** Hyperia-side image-paste pipeline is
already wired (`lib/utils/path-translate.ts` + `term.tsx handleImagePaste`):
detects an image on the clipboard, POSTs the PNG to the sidecar's existing
`/api/ghost/asset`, builds the host path, reads the profile's `pathTranslate`,
translates, pastes the translated string into xterm. **The renderer-side half
is done.** The integration side (n8 container, profile configs, `llm` itself)
is not. These orders finish it.

**Guiding principle.** Lean on `simonw/llm` as the runtime CLI surface so we
don't have to write per-CLI integrations (Claude Code Alt+V, Codex paste,
Antigravity `@<path>`, …). `llm -a <path>` and `llm -T <tool>` become *the*
contracts; our agents target those.

**Two repos in scope.** Edits below are tagged with the repo. Stop at the end
of each phase for review.

- `H` = `hyperia` (this repo)
- `N` = `nemesis8` (`C:\Users\kordl\Code\DeepBlueDynamics\nemesis8`)

---

## Phase 1 — Make `llm` exist in n8 and make paste-image reach it

The whole stack collapses without this. Three small edits.

1. **`N` — Install `llm` in the container.** Add to
   `nemesis8/Dockerfile.base:64-67` (the existing `uv pip install` step) or
   prepend to the providers install in `scripts/install-providers.py`:

   ```
   uv pip install --python "$MCP_VENV/bin/python3" \
     llm llm-anthropic llm-gemini
   ```

   Plus whatever provider plugins make sense (`llm-mlx` is Mac-only — skip
   on Linux n8). Verify with `docker compose exec n8 llm --version`.

2. **`N` — Bind the Hyperia asset dir into the container.** Add to
   `docker-compose.yml:12-13` under the `volumes:` block for the n8 service:

   ```yaml
   - ${USERPROFILE:-${HOME}}/.hyperia/assets:/host/paste:ro
   ```

   Read-only is sufficient — the agent reads pasted images, never writes back.

3. **`H` — Give profiles a `pathTranslate` block** so the renderer's
   `translatePath()` knows what world the shell lives in. Edit
   `app/config/config-default.json` and `typings/config.d.ts`:

   - WSL profile (existing, line ~104): add
     `"pathTranslate": { "kind": "wsl" }`.
   - Add a new n8 profile that opens a `docker exec` shell into the container,
     with
     `"pathTranslate": { "kind": "docker-mount", "hostPrefix": "~/.hyperia/assets", "containerPrefix": "/host/paste" }`.
   - Native shells (powershell, cmd) need no block — `translatePath` defaults
     to identity.

   Update `PathTranslate` type in `typings/config.d.ts` if it doesn't already
   accept all three variants (it should; `path-translate.ts` already imports
   it).

**Acceptance.** From a WSL pane: paste a screenshot → `/mnt/c/Users/<u>/.hyperia/assets/<id>.png`
lands at cursor, `cat` of that path inside WSL succeeds. From the new n8
profile: paste a screenshot → `/host/paste/<id>.png` lands, `cat` inside the
container succeeds. From PowerShell: paste a screenshot → raw Windows path
lands, `Get-Item` succeeds.

**Deliverable.** Diff of the three files. `docker compose build && up -d` clean.
Build Hyperia (`yarn build`), launch (`npx electron target`), screenshot the
three paste cases. **Stop. Wait.**

---

## Phase 2 — Route `llm` through our local providers + persist its state

`llm` already supports OpenAI-compatible endpoints via `extra-openai-models.yaml`
(0.6+; `supports_tools`, `supports_schema` added later).

1. **`N` — Ship a default `extra-openai-models.yaml`** in the image at
   `/etc/llm/extra-openai-models.yaml`, configured against the Hyperia sidecar
   reachable via `host.docker.internal:9800` (the `extra_hosts` line at
   `docker-compose.yml:17` is already set). Aliases like:

   ```yaml
   - model_id: local-sonnet
     api_base: http://host.docker.internal:9800/v1
     supports_tools: true
     supports_schema: true
     vision: true
   - model_id: local-ollama
     api_base: http://host.docker.internal:9800/v1
   ```

   The sidecar already exposes the relevant `/v1` endpoints via
   `OllamaProvider` and the Anthropic-via-token path (see task #52). Confirm
   exact endpoint shapes before writing.

2. **`N` — On container start, symlink/copy** that file into
   `$XDG_CONFIG_HOME/io.datasette.llm/extra-openai-models.yaml`
   (i.e. `/root/.config/io.datasette.llm/`). Add to the entrypoint
   (`nemisis8-entry`, `Dockerfile:100`) so first-run users don't have to
   configure anything.

3. **`N` — Persist the `llm` state dir.** Add to `docker-compose.yml`
   `volumes:` block:

   ```yaml
   - nemesis8-llm-state:/root/.config/io.datasette.llm
   ```

   And declare `nemesis8-llm-state:` in the top-level `volumes:` mapping. Now
   logs/keys/templates survive `down/up`.

**Acceptance.** Inside the container: `llm -m local-sonnet "say hi"` streams a
response via Hyperia. `llm logs` shows entries. `docker compose down && up -d`;
logs still there.

**Deliverable.** Diff of the YAML + compose + entrypoint changes. **Stop.**

---

## Phase 3 — Emit `-a <path>` shape when the foreground command is `llm`

Hyperia already tracks the foreground shell command via `shell_state`. The
renderer's `handleImagePaste` (in `lib/components/term.tsx`, ~line 697) pastes
the raw translated path today. Extend it:

1. **`H` — Read the current foreground command** for this session (the same
   data the `shell_state` MCP tool returns). Available in the renderer through
   the redux session state (`sessionFgCommand` or similar — check
   `lib/reducers/sessions.ts` for the field name added during OSC 7 work).
2. **`H` — If `fg.startsWith('llm')` and it isn't `llm chat` mid-stream**, prepend
   `' -a '` (note the leading space if there's already text at cursor) before the
   translated path. So instead of `/host/paste/abc.png` you get
   ` -a /host/paste/abc.png` — drops right into a half-typed `llm prompt …`.
3. **For `llm chat` interactive sessions**, the situation is different: there's
   no `-a` flag mid-chat (only `!fragment <id>` per 0.26a1). Skip the prefix in
   that case; paste raw path; document that the user can wrap with their own
   syntax. (Future: when `llm chat` gains an attach command, swap in.)

**Acceptance.** From a pane running `llm "describe this:"` (cursor at end):
paste → buffer reads `llm "describe this:" -a /host/paste/abc.png`, ready to
send. From a pane running `llm chat`: paste → raw path lands, no prefix.

**Deliverable.** `term.tsx` diff + screenshot of both cases. **Stop.**

---

## Phase 4 — `llm-hyperia` plugin: expose MCP tools to `llm`'s tool system

The big unifier. Once shipped, *any* `llm` invocation in *any* container can
drive Hyperia.

1. **New repo `llm-hyperia`** (own Python package, not bundled into n8) under
   `nemesis8/llm-hyperia/` or a separate repo. Use the `register_tools` hook
   (added in 0.26 / 0.26a1). Pattern:

   ```python
   import llm, httpx

   class HyperiaToolbox(llm.Toolbox):
       def __init__(self, base_url="http://host.docker.internal:9800"):
           self.base_url = base_url

       def terminal_run(self, command: str, pane: str | None = None) -> str:
           """Run a shell command in a Hyperia pane and return its output."""
           r = httpx.post(f"{self.base_url}/mcp/terminal_run", json={...})
           return r.text

       # …terminal_status, tab_snapshot, terminal_keys, sticky_note_*…

   @llm.hookimpl
   def register_tools(register):
       register(HyperiaToolbox)
   ```

   Wrap each of the MCP tools listed in the README under "hyperia": keep the
   same names so muscle memory carries.

2. **`N` — Install it** in the same step as `llm` (Phase 1 item 1):
   `uv pip install llm-hyperia` (once published) or
   `uv pip install -e /opt/llm-hyperia` (if vendoring during development).

3. **Document** in `nemesis8/MCP/` how the agent reaches the tools:
   `llm -T 'Hyperia()' "Open a powershell pane and tail the sidecar log"`.

**Acceptance.** `llm tools list` inside n8 shows the Hyperia toolbox and its
methods. `llm prompt -T Hyperia "list open tabs"` returns a real answer via
the sidecar.

**Deliverable.** New package + n8 install hook diff + a `README.md` with one
worked example. **Stop.**

---

## Phase 5 — Fragment loaders for Hyperia surfaces

Same plugin, additional hook (`register_fragment_loaders`, added in 0.24).
Optional but cheap once Phase 4 is in.

- `hyperia:tab/<name>` → tab scrollback (calls `tab_snapshot`).
- `hyperia:asset/<id>` → asset bytes (calls `/api/ghost/asset/:id`; return as
  `llm.Attachment` for image content types so vision models receive it
  natively — supported since 0.25).
- `n8:log/sidecar` → recent sidecar log lines (calls `/api/logs`).

**Acceptance.** `llm -f hyperia:tab/agent -m local-sonnet "summarize what just
happened"` works. `llm -f hyperia:asset/<id> -m local-sonnet "describe this"`
works for an image asset.

**Deliverable.** Diff of the plugin + 2 usage examples. **Stop.**

---

## Phase 6 — Template repo (optional, low priority)

Publish `deepbluedynamics/llm-templates` on GitHub with a few starter
templates (refactor-orders, screenshot-driven-css, onboarding). Then
`llm -t gh:deepbluedynamics/refactor-orders "..."` works for anyone with
`llm-templates-github` installed.

**Acceptance.** `llm install llm-templates-github && llm -t gh:deepbluedynamics/refactor-orders "test"`
runs end-to-end.

---

## Constraints — read these

- **Behavior unchanged** for existing PowerShell/cmd panes. The paste-image
  pipeline already works there.
- **No yarn install/add/remove** in Hyperia from inside the n8 agent — that
  breaks node-pty (see [[build-hazards]] / past sessions).
- **One phase per build.** End each with a clean rebuild + checkpoint. Don't
  pre-stage later phases.
- **For Phase 4**, keep tool names matching MCP tool names exactly. We
  rename in Hyperia or in the plugin, never half-rename.
- **Out of scope** here: any change to Hyperia's pane chrome, the screenshot-
  paste detection logic itself (already working), or sidecar provider code
  except where Phase 2 needs us to confirm endpoint shapes.

## Cadence

Phase 1 → diff of the 3 files (Dockerfile/install-providers + compose +
config-default), build, screenshot WSL + n8 + PowerShell paste. Await review.
Phase 2 → YAML + compose + entrypoint diffs, smoke test `llm -m local-sonnet`
inside the container. Await review.
Phase 3 → `term.tsx` diff, screenshots. Await review.
Phase 4 → plugin package + integration. Await review.
Phase 5 → fragment loader additions. Await review.
Phase 6 → template repo (optional, do last or never).
