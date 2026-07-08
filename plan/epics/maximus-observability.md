# Maximus — watch + extract + alert observability layer over panes

> Status: **design / backlog.** Captured 2026-06-10 from a planning request. This is the
> "when we go back and work on Maximus" north star. Tickets below.

## What Maximus is today

`sidecar/src/ghost/compressor.rs` — `ContextCompressor` ("tokenmax"). A **local-Ollama**
pull-extractor:

- `extract_maximus(content, focus, raw)` → classify content-type → derive an extraction
  strategy → iteratively `apply_strategy` (max 3 iters, stabilize at <10% delta) → annotate
  `[tokenmax …]`.
- Learns patterns per content-type into Ferricula (`maximus-patterns` channel).
- Heuristic `detect_content_type` for cargo-test / json / git-diff / rust-compiler / http.
- Also compresses Ghost message history when it grows past 10 messages.

**It is a pull model, called by the Ghost on a single tool result.** That's the whole scope.

## The pain (why this isn't enough)

The user wants Maximus to be "a full kit for being able to extract knowledge" from what
happens in panes — modeled on how Claude Code *notices errors in the shell and surfaces them
only when actionable*. Concretely, today Maximus:

1. **Doesn't watch.** It can't observe a pane over time. It can't tell "this tab is still
   changing" from "it has settled" from "it's hung." It only sees a blob someone hands it.
2. **Doesn't know an error is an error.** It classifies content, but there's no exit-code,
   no severity, no "this command failed." No silent-detect / surface-when-actionable loop.
3. **Has no change/diff knowledge.** No "what files changed, how many lines" after a command.
4. **Has no normalized event or alert model.** Nothing Splunk/Loggly-shaped — no event
   schema, no severity, no dedup, no routing, no query surface.
5. **Is Ghost-only, not provider-agnostic.** A nemesis8 container agent (Gemini/antigravity)
   or an external Claude Code gets *none* of this. "Has to work across multiple providers."

## North star

> Every command run in a pane becomes a **Block**. A stability detector decides when the
> Block has settled/finished/hung and strips repaint noise. On finish, exit-code + content
> markers set a severity and a git diff attaches file changes. Everything is emitted as one
> **normalized, OTel-shaped event** through a **Source→Parse→Transform→Dedup→Route→Sink**
> pipeline, so only actionable, deduped signal surfaces — to the Ghost, to a toast, to
> Ferricula, and to any external/container agent via an MCP query tool.

## Design spine (composition of the parts)

```
Block (atomic unit)                       ── §A
  └─ quiescence + ANSI-grid diff          ── §B  → stability: changing|settled|done|hung
       └─ on done: exit_code + markers     ── §C  → severity
                  + git --numstat          ── §D  → files/lines changed
            └─ normalized OTel event       ── §E
                 └─ Source→…→Dedup→Route→Sink  ── §F  → alert / Ferricula / MCP query
                      └─ provider-agnostic ingest + query ── §G
```

## Research findings worth copying (grounded; sources at bottom)

**A. Block as the atomic unit (Warp).** Wrap each command: `{command, exit_code, duration,
stdout, stderr, cwd, stable_id, start_ts, end_ts}`. Failed blocks get an *opt-in, actionable*
affordance — not a forced popup. Needs shell integration (OSC 133 prompt markers / exit-code
capture) to know command boundaries.

**B. Stability = quiescence + ANSI-aware screen diff.** Emit "settled" only after a quiet
window with no new output (debounce **300–750 ms**, tune). `done = settled && exit_code_seen`;
`possibly_hung = settled && !exit_code && elapsed > hard_timeout` (**30–120 s**, tune). Diff
the **rendered VT screen grid** between quiescence points, *not the byte stream* — spinners /
progress bars repaint the same line via `\r`, `\x1b[2K`, cursor-moves and collapse to ~nothing
(reported npm install 12,847 → 142 chars). Track bytes-changed/sec decay as a winding-down cue.

**C. Error detection (exit-code-first, content-markers second).** `process.exit_code != 0` is
the canonical error rule (OTel CLI semconv). Do **not** scan for the word "error." Use strong
content markers only to *upgrade* severity or when no exit code is observable: `panic:`,
`Traceback`, stack-frame shapes, `file:line:col: error:`. Keep a per-command
**allowed-nonzero-exit** list (`grep`/`diff`/`test`-in-TDD legitimately exit non-zero).
Warnings are a separate severity that never alerts. Claude Code hooks use a tri-state:
`0 = ok, 2 = blocking error, other = non-blocking`.

**D. Diff/file-change extraction.** Use `git diff --numstat` (machine-readable
`added<TAB>deleted<TAB>path`, full paths; binary → `-  -`) + `--porcelain` for status. Durable
unified-diff primitive = hunk header `@@ -old_start,old_len +new_start,new_len @@`. Per-change
record: `{path, status:A/M/D/R, insertions, deletions, hunks:[{old_start,old_len,new_start,new_len}]}`.
Attribute to a Block by snapshotting `git rev-parse HEAD` + `git status --porcelain` at Block
start and diffing at close; join on `block.id` + `cwd`. Non-git cwd → mtime/inode scan. Use an
off-the-shelf unified-diff parser, don't hand-roll.

**E. Normalized OTel-shaped event (provider-agnostic).** Split fixed producer identity
(`resource`) from per-event facts (`attributes`); use OTel `process.*` semconv names. Severity
as a normalized int (INFO 9, WARN 13, **ERROR 17**, FATAL 21). Minimal schema:

```jsonc
{
  "ts": "<RFC3339>", "observed_ts": "<capture time>",
  "severity_num": 17, "severity_text": "ERROR",
  "kind": "command_result",            // command_result | file_change | error | summary | progress
  "body": "<ANSI-collapsed text or struct>",
  "resource": {                        // fixed producer identity = the pane/agent
    "pane.id": "…", "agent.provider": "anthropic|openai|google|unknown",
    "agent.name": "claude-code|codex|aider|cursor|warp|shell",
    "host.name": "…", "session.id": "…"
  },
  "attributes": {                      // per-event facts, reuse OTel process.*
    "process.command": "yarn build", "process.exit_code": 1,
    "duration_ms": 8421, "cwd": "/repo", "block.id": "blk_…",
    "error.markers": ["panic:"],
    "files_changed": [ {"path":"a.ts","status":"M","added":12,"deleted":4} ],
    "dedup.key": "<hash(pane.id+norm_body+severity)>",
    "stability.state": "done|settled|changing|possibly_hung"
  }
}
```

**F. Pipeline + dedup (Splunk/Loggly/Vector kit).** `Source → Parse → Transform(enrich/
normalize/redact) → Dedup → Route(alert rules) → Sink`. Dedup = LRU keyed on
`{pane.id, norm_message_hash, severity}` (Vector default cache ~5000 events) so a repeated
identical error collapses to one alert. Route: only `severity_num >= ERROR` AND deduped →
surface. Sinks: Ferricula memory, audit log, a toast/notify, and the MCP query tool (G).

**G. Provider-agnostic ingest + query.** `resource.agent.provider/name` makes the event
producer-neutral. External/container agents (nemesis8 Gemini, external Claude Code) need (a) an
ingest path that tags events with *their* identity (ties into the pane/agent token work) and
(b) an MCP tool to **query** events/errors/changes for a pane/tab — `maximus_watch` /
`maximus_events(pane, since, severity, kind)`.

## Ticket breakdown

- **Epic** — Maximus observability layer (this doc).
- **M1 Block model** (§A) — command-boundary + exit-code capture per pane via shell
  integration; `Block{…}` store keyed by `stable_id`. Foundation for everything else.
- **M2 Stability detector** (§B) — headless VT screen-buffer + quiescence debounce →
  `stability.state`; ANSI-grid diff to strip repaint noise.
- **M3 Error extraction** (§C) — exit-code-first severity + content-marker upgrade +
  allowed-nonzero-exit list; silent-detect / surface-when-actionable.
- **M4 Diff & file-change extraction** (§D) — pre/post git snapshot, `--numstat`/`--porcelain`,
  hunk primitives attached to `block.id`.
- **M5 Normalized event schema** (§E) — the OTel-shaped record; one emitter all producers use.
- **M6 Pipeline + dedup + alert routing** (§F) — Source→…→Sink, LRU dedup, ERROR-gated routing,
  sinks to Ferricula/audit/toast.
- **M7 Provider-agnostic ingest + MCP query surface** (§G) — identity-tagged ingest for
  external/container agents + `maximus_events`/`maximus_watch` MCP tools.

Suggested order: M5 (schema first, it's the contract) → M1 → M2 → M3 → M4 → M6 → M7.

## Sources
- OTel logs data model (LogRecord, severity): https://opentelemetry.io/docs/specs/otel/logs/data-model/
- OTel CLI spans (exit_code != 0 = error): https://opentelemetry.io/docs/specs/semconv/cli/cli-spans/
- OTel process attributes: https://opentelemetry.io/docs/specs/semconv/registry/attributes/process/
- Warp blocks-as-context: https://docs.warp.dev/agent-platform/warp-agents/agent-context/blocks-as-context
- Claude Code hook control flow (exit-code tri-state, stderr): https://stevekinney.com/courses/ai-development/claude-code-hook-control-flow
- Agent harness internals (capture tuple): https://medium.com/jonathans-musings/inside-the-agent-harness-how-codex-and-claude-code-actually-work-63593e26c176
- ClipGate output tagging (error markers): https://clipgate.github.io/blog/pipe-terminal-output-to-claude-cursor-aider/
- ANSI repaint collapse: https://dev.to/ji_ai/ansi-spinners-progress-bars-decorations-all-gone-2p0j
- swift-async-algorithms Debounce (quiescence): https://github.com/apple/swift-async-algorithms/blob/main/Sources/AsyncAlgorithms/AsyncAlgorithms.docc/Guides/Debounce.md
- git diff-format / --numstat: https://git-scm.com/docs/diff-format · https://git-scm.com/docs/diff-options/2.40.0
- Vector log data model / VRL / dedupe: https://vector.dev/docs/architecture/data-model/log/ · https://vector.dev/docs/reference/vrl/ · https://vector.dev/docs/reference/configuration/transforms/dedupe/
