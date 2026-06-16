# Shell Integration — CWD / foreground-app reporting + safe `cd`

**Status:** spec / proposal
**Owner:** —
**Depends on:** existing OSC 7 CWD pipeline (`app/session.ts:213-247`), foreground-process detection (`sidecar/src/process.rs`), Keys injection + human-activity lockout (`app/bridge.ts:207-260`).

## 1. Goal

Every shell Hyperia spawns should, on startup, install a small integration hook that:

1. **Reports its working directory** to Hyperia whenever it changes.
2. **Reports the foreground app** it is running — name, the command line as typed, and the **resolved binary path**.
3. **Reports whether it is "loose" (idle at a prompt) or blocked** (a foreground app owns the tty).
4. **Accepts a directory change from Hyperia** — but applies it **only when loose**. While a foreground app blocks the tty, a `cd` request is *queued*, never injected into the app's stdin, and lands the next time the shell returns to its prompt.

The framing the user gave: *"take a change directory if loose in a shell, but not a running app that blocks."* That property is the spine of this design — every mechanism below is chosen so that it is **structurally impossible** to send `cd` into a blocking app.

## 2. What already exists (don't rebuild)

| Capability | Where | Notes |
|---|---|---|
| Spawn-time env injection | `app/session.ts:149-160` | Already sets `HYPERIA_PANE`, `HYPERIA_MCP_URL`, `HYPERIA_AGENT_TOKEN`. Add integration vars here. |
| OSC 7 CWD parse → store → expose | `app/session.ts:213-247` → `bridge.ts` `updateSessionCwd` → `bridge.rs` `SessionCwd` → `info.cwd` → `terminal_status.cwd` (`bridge.rs:668`) | **The receive side is done.** We only need shells to *emit* OSC 7. |
| Foreground process *name* (empty = idle) | `sidecar/src/process.rs` `foreground_process_with`, surfaced as `terminal_status.process` (`bridge.rs:661`) | OS process-tree walk from shell PID. No path, no command line, and races around prompt redraw. Use as **corroboration**, not the authoritative idle signal. |
| Input injection w/ human lockout | `app/bridge.ts:207-260` `enqueueOrWrite` → `session.write` (`app/session.ts:302`) | Queues agent keys while the human is typing. We extend the gate with a **shell-idle** condition. |
| Bridge protocol (typed JSON over WS, `seq`/`ToolResult`) | `app/bridge.ts`, `sidecar/src/bridge.rs:313-348` | Add two message types: a richer shell-state event and a `cd` request. |

The two genuinely missing pieces: (a) shells must **emit** the telemetry, and (b) there is **no authoritative "now at prompt" edge** — needed to gate `cd` safely.

## 3. Architecture overview

```
 ┌─────────────┐  OSC 7 (cwd) + OSC 133 (A/B/C/D) + OSC 697 (Hyperia payload)
 │   shell     │ ───────────────────────────────────────────────► PTY stream
 │ + hyperia   │
 │ integration │ ◄─── reads $HYPERIA_CTL_DIR/<pane>/cd  (pending dir, applied at precmd)
 └─────────────┘
        ▲                          app/session.ts parses OSC → bridge → sidecar
        │ bare-Enter nudge                       │
        │ (only when idle)                       ▼
 ┌─────────────────┐  ShellState event   ┌──────────────────┐  terminal_status / terminal_cd
 │ app/bridge.ts   │ ◄──────────────────►│ sidecar (mcp.rs) │ ◄────────────────────────────► agent
 │ enqueueOrWrite  │  Cd request          │ per-pane state   │
 └─────────────────┘                      └──────────────────┘
```

Two independent transports, by direction:

- **Shell → Hyperia: OSC sequences on the PTY stream.** Already the channel Hyperia parses; survives ssh/sudo/containers (they're just bytes on the tty).
- **Hyperia → shell: a per-pane control file** read by the shell's prompt hook. The hook only runs at the prompt, so a pending `cd` *cannot* reach a blocking app. A keystroke fallback (gated on the process-tree idle heuristic) covers shells where the integration isn't installed (e.g. a remote ssh session).

## 4. Forward telemetry (shell → Hyperia)

### 4.1 Sequences emitted

Reuse standards where they exist; add one Hyperia-private OSC for the fields standards don't carry.

- **OSC 7** — `ESC ] 7 ; file://<host><path> BEL` — CWD. Already parsed; just emit it. (Hyperia's parser at `app/session.ts:224` already normalizes Windows paths.)
- **OSC 133** — semantic prompt marks (FinalTerm/iTerm/VS Code convention). The authoritative lifecycle:
  - `ESC ] 133 ; A BEL` — **prompt start** (shell is about to draw its prompt → *idle/loose*).
  - `ESC ] 133 ; B BEL` — prompt end / command input start.
  - `ESC ] 133 ; C BEL` — **command begins executing** (preexec → *running/blocked*).
  - `ESC ] 133 ; D ; <exit> BEL` — command finished with exit code.
  The `A` (and `D`) edge is the **"now at prompt" signal** that gates `cd`. Adopting OSC 133 also unlocks future UI (command navigation, mark-to-mark selection, exit-code gutter) for free.
- **OSC 697** *(Hyperia-private — pick a free code; 697 = "HYP" leet, reserved here)* — `ESC ] 697 ; key=val ; key=val ... BEL` carrying the structured fields 133 can't:
  - `cmd=<base64 command line as typed>`
  - `app=<base64 resolved absolute path of argv[0]>`
  - `argv0=<base64 the bare token>`
  - `pid=<shell pid>` (corroborates the OS-side pid)
  - emitted at **C** (so `app`/`cmd` describe the running foreground process) and cleared at **D**.

  Base64 because command lines contain spaces, quotes, `;`, and non-ASCII — keeps the OSC body unambiguous to parse.

### 4.2 Per-shell hook contents

The integration script (one per shell family, shipped in `static/shell-integration/`) wraps the user's existing prompt without clobbering it:

- **bash** — append to `PROMPT_COMMAND` (emit OSC 7 + OSC 133 A); `trap ... DEBUG` or a `preexec`-style shim for OSC 133 C + OSC 697; `PS0` can also carry the C mark.
- **zsh** — `precmd` hook (OSC 7 + 133 A + apply pending `cd`); `preexec` hook (133 C + 697).
- **fish** — `fish_prompt` / event functions `fish_preexec` / `fish_postexec`.
- **PowerShell** — wrap `prompt` function (emit on each prompt) + `Set-PSReadLineKeyHandler`/`PSConsoleHostReadLine` boundary for the run/idle edge; resolve path via `(Get-Command <x>).Source`.
- **cmd.exe** — **out of scope** (no per-prompt hook beyond the `PROMPT` string; best-effort CWD only). Document the limitation.

Resolving `app` path per shell: `type -P` / `command -v` (bash/zsh), `type --path` (fish), `(Get-Command x).Source` (pwsh).

### 4.3 Injection of the hook at spawn

Hyperia owns the spawn (`app/session.ts:189`), so wire the hook per shell **without replacing the user's rc**:

- **zsh** — set `ZDOTDIR` to a Hyperia temp dir whose `.zshrc` sources the user's real `.zshrc` then the hook; restore `ZDOTDIR` inside.
- **bash** — launch with `--rcfile <hyperia.bash>` that sources `~/.bashrc` then the hook (VS Code's approach).
- **fish** — prepend a conf.d dir via `XDG_DATA_DIRS`, or `--init-command`.
- **pwsh** — `-NoExit -Command ". '<hook.ps1>'"` after the user profile loads.
- Add env at `app/session.ts:149-160`:
  - `HYPERIA_SHELL_INTEGRATION=1`
  - `HYPERIA_INTEGRATION_DIR=<resources>/shell-integration`
  - `HYPERIA_CTL_DIR=<userData>/panes/<uid>` (the reverse-channel dir, §5)

Opt-out: a config flag (`shellIntegration: false`) and respecting a user's existing `VSCODE_SHELL_INTEGRATION`-style markers so we don't double-instrument.

### 4.4 Receive side (main process)

Extend the `onData` parser at `app/session.ts:214` (already buffering for OSC 7):
- add OSC 133 A/B/C/D → derive `state: 'idle' | 'running'` + `lastExit`.
- add OSC 697 → decode `cmd`/`app`/`argv0`.
- emit a single `'shellstate'` event → new bridge message `SessionShellState { uid, state, app:{name,path,cmdline,pid}, lastExit }` → sidecar stores it on `SessionInfo` alongside `cwd`.

## 5. Reverse channel (Hyperia → shell): safe `cd`

### 5.1 Primary mechanism — control file applied by the prompt hook

1. Agent calls `terminal_cd { pane, path }` (§6). Sidecar validates `path` is an existing directory, then asks the bridge to write it to `HYPERIA_CTL_DIR/<uid>/cd` (atomic write: temp + rename).
2. The shell's **precmd/prompt hook** — which by definition runs *only when the shell is at its prompt* — reads that file, and if present:
   - `cd -- "$dir"` (**never `eval`**; the value is treated strictly as a path, quoted),
   - truncates/removes the file (ack),
   - emits a fresh OSC 7 so Hyperia sees the new CWD.
3. **Blocking app? Nothing happens.** While a foreground app owns the tty, the prompt hook isn't executing, so the pending `cd` simply waits. When the app exits and the next prompt draws, the hook applies it. This is the property the user asked for, enforced by construction.

**Immediacy while idle:** if the shell is *already* sitting idle at a prompt (hook already ran), the file won't be consumed until the next prompt redraw. To apply right away, Hyperia injects a **bare Enter (`\r`)** — but *only* when state is authoritatively `idle` (OSC 133 A seen, no C since) **and** the human-activity lockout is clear. A bare Enter at an idle prompt is harmless (one empty prompt line); at a blocking app it would be input — hence the strict idle gate. (Enhancement: in zsh, `zle reset-prompt` can re-fire the hook without a visible newline.)

### 5.2 Fallback — gated keystroke injection

When the integration hook isn't installed (remote ssh, an exotic shell, integration disabled), fall back to writing `cd '<path>'\r` through the existing `enqueueOrWrite` path — but **only** when *both* signals agree the shell is loose:
- OSC 133 says idle **or** (no 133 available) `process.rs` foreground == shell / empty, and
- `enqueueOrWrite`'s human-activity lockout is clear.

If either says "running," the request is **queued** (return `queued`), and a watcher drains it when the pane goes idle — mirroring the existing key-queue drain in `app/bridge.ts`. The fallback pollutes scrollback with the literal `cd` line; the control-file path does not.

### 5.3 The idle gate (single source of truth)

`state = idle` **iff** the last OSC 133 mark was `A`/`B` or `D` (not `C`). If no 133 marks have ever arrived for the pane (shell without integration), fall back to: `process.rs` foreground process is empty/equal-to-shell **and** `userActiveSecsAgo > threshold`. Any ambiguity ⇒ treat as running ⇒ queue, never inject. Fail safe, not fast.

## 6. MCP / API surface

- **Extend `terminal_status`** (`sidecar/src/bridge.rs:657`) per pane:
  - `state: "idle" | "running"`
  - `app: { name, path, cmdline, pid } | null` (null when idle)
  - keep existing `cwd`, `process` (process becomes the corroborating fallback).
- **New tool `terminal_cd { window?, tab?, pane?, path }`** → resolves pane (or focused), validates dir, drives §5. Returns `{ applied: true }` | `{ queued: true, reason: "foreground app running" }` | `{ refused, reason }`. Gated by the same consent model as other mutations (`enforce_drive`).
- The richer state also feeds the existing `/dashboard` and any "where is this agent working" views.

## 7. Security & edge cases

- **No `eval` of control-channel content, ever.** Only `cd -- "$dir"` with quoting. The file holds a path and nothing else; treat anything unexpected as invalid and discard.
- **Per-pane isolation:** `HYPERIA_CTL_DIR` is scoped to the pane uid; one pane cannot steer another via the file channel.
- **Consent:** `terminal_cd` is a mutation → routed through `enforce_drive` / consent like `terminal_run`. A `cd` is low-stakes but still the human's call.
- **Remote shells (ssh/sudo/container):** OSC telemetry flows back over the tty if the *remote* shell is also instrumented; the control file is local-only, so remote `cd` uses the keystroke fallback (still idle-gated). Document clearly.
- **Nested shells / TUIs that emit their own OSC 133** (e.g. an inner shell): last-writer-wins on state is fine — a TUI that marks itself "running" only makes us *more* conservative about injecting.
- **Races:** OSC 7 already buffers fragmented sequences (`app/session.ts:245`); apply the same 4 KB buffer discipline to 133/697.
- **cmd.exe / unsupported shells:** telemetry degrades to OSC-7-if-emittable; `terminal_cd` falls back to keystroke injection gated purely on the process-tree heuristic, or refuses with a clear reason.

## 8. Suggested phasing (epic shape)

1. **Telemetry emit** — ship `static/shell-integration/` scripts (zsh, bash, fish, pwsh) + spawn wiring (`app/session.ts`); make every shell emit OSC 7 + 133. *Win on its own:* reliable CWD + idle/running in `terminal_status` with no new receive code beyond the 133 parse.
2. **Rich app reporting** — OSC 697 (cmd/app path) → `SessionShellState` → `terminal_status.app`.
3. **`terminal_cd` via control file** — reverse channel + precmd applier + idle-gated nudge.
4. **Keystroke fallback + queue drain** — for un-instrumented/remote shells.
5. **Polish** — `zle reset-prompt` no-newline nudge, dashboard surfacing, opt-out config, cmd.exe best-effort.

## 9. Open questions

- Confirm OSC **697** doesn't collide with anything Hyperia or a common tool already emits (sweep the codebase + xterm addons before committing the number).
- Windows/conpty: does node-pty reliably surface OSC 133 from PowerShell through conpty, or do we lean on PSReadLine boundaries + process-tree there?
- Do we want `terminal_cd` to also support pushd/popd semantics, or strictly absolute `cd`?
