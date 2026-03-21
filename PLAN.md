# Hyperia — Implementation Plan

The shell that remembers everything and acts on it.

This plan maps the README vision to concrete engineering work.


## Architecture

    ┌──────────────────────────────────────────────────────┐
    │                  Electron Shell                       │
    │                                                      │
    │  ┌─────────┐  ┌──────────┐  ┌────────────────────┐  │
    │  │ xterm.js│  │ Browser  │  │ Notification        │  │
    │  │ + WebGL │  │ Panes    │  │ Surface             │  │
    │  │ + PTY   │  │ (CDP)    │  │ (rings, sidebar)    │  │
    │  └────┬────┘  └────┬─────┘  └────────┬───────────┘  │
    │       │             │                 │              │
    │       └─────────────┼─────────────────┘              │
    │                     │ IPC                            │
    │              ┌──────┴──────┐                         │
    │              │ Memory UI   │                         │
    │              │ recall, ask │                         │
    │              │ timeline    │                         │
    │              └──────┬──────┘                         │
    └─────────────────────┼────────────────────────────────┘
                          │ HTTP :9800
    ┌─────────────────────┼────────────────────────────────┐
    │               Rust Sidecar                            │
    │                                                      │
    │  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
    │  │ Observer  │  │ Memory    │  │ Agent Engine     │  │
    │  │ (stream   │  │ Store     │  │ (Claude API,     │  │
    │  │  watcher) │  │ (chonk +  │  │  tool_use loop,  │  │
    │  │          │  │  local db) │  │  prompt packs)   │  │
    │  └────┬─────┘  └─────┬─────┘  └───────┬──────────┘  │
    │       │               │                │             │
    │  ┌────┴───────────────┴────────────────┴──────────┐  │
    │  │              Context Engine                     │  │
    │  │  ingest → embed → store → decay → consolidate  │  │
    │  │  recall → rank → surface → narrate             │  │
    │  └────────────────────────────────────────────────┘  │
    │                                                      │
    │  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
    │  │ MCP      │  │ Stream    │  │ Signal Hub       │  │
    │  │ Server   │  │ Deck      │  │ (nemisis8)       │  │
    │  │ (stdio)  │  │ (:9850)   │  │                  │  │
    │  └──────────┘  └───────────┘  └──────────────────┘  │
    └──────────────────────────────────────────────────────┘
                          │
    ┌─────────────────────┼────────────────────────────────┐
    │             Storage Layer                             │
    │                                                      │
    │  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
    │  │ chonk    │  │ SQLite    │  │ ~/.hyperia/       │  │
    │  │ (embed)  │  │ (events,  │  │ config, keys,    │  │
    │  │ :8080    │  │  patterns)│  │ project profiles │  │
    │  └──────────┘  └───────────┘  └──────────────────┘  │
    └──────────────────────────────────────────────────────┘


## What exists today

    Component           Location                    Status
    ─────────────────────────────────────────────────────────
    Electron shell      hyperia/app, hyperia/lib    Hyper fork, runs
    Rust sidecar        hyperia/sidecar/            Compiles, minimal main
    Stream Deck         hyperia/sidecar/src/deck/   Full (HID, agent, HTTP)
    Agent engine        hyperia/sidecar/src/chat.rs Full (Claude, tools, packs)
    MCP server          hyperia/sidecar/src/mcp.rs  Full (17 tools, stdio)
    Embedding service   gnosis-chunk/               Running (Docker, 384d)
    Memory system       memex/                      Python prototype
    Peer signaling      nemisis8/                   Separate project
    GPU plan            hyperia/GPU.md              Doc only


## What we're building

### Phase 0: Shell Foundation (get Hyper running as "ours")

Goal: Hyperia boots, opens a terminal, runs commands. Our branding,
our config, our entry points. No memory yet — just a working fork.

    [ ] Rename package: hyper → hyperia
    [ ] Replace branding (icons, about, window title)
    [ ] Update config path: ~/.hyper.js → ~/.hyperia/config.js
    [ ] Add sidecar spawn on app launch (child_process, :9800)
    [ ] Verify: yarn dev + yarn app → terminal works
    [ ] Add GPU flags to Electron init (GPU.md Layer 1)
    [ ] Verify WebGL addon is active (GPU.md Layer 2)

Deliverable: `yarn run app` opens Hyperia with a working terminal.


### Phase 1: The Observer (the shell starts watching)

Goal: Every command and its output flows through the sidecar.
Nothing is stored yet — we just prove the pipe works.

The observer sits between the PTY and the renderer. In Electron,
node-pty emits data events. We intercept them:

    node-pty
      │
      ├──→ xterm.js (render as usual)
      │
      └──→ sidecar observer (HTTP POST :9800/api/observe)
           {
             "type": "output",
             "session": "abc-123",
             "cwd": "/home/kord/project",
             "data": "$ make build\nerror: ...",
             "timestamp": 1709769600
           }

On the input side, intercept before writing to PTY:

    keystroke → POST :9800/api/observe { type: "input", ... }
               → write to PTY (unchanged)

The sidecar receives the stream but does nothing with it yet.
This is the plumbing that everything else depends on.

    [ ] Add observer endpoint to sidecar: POST /api/observe
    [ ] Intercept node-pty onData in Electron renderer
    [ ] Intercept terminal input (before write to PTY)
    [ ] Detect command boundaries (shell prompt → command → output)
    [ ] Parse CWD from OSC 7 escape sequences
    [ ] Batch and buffer (don't POST every byte — batch per line/event)
    [ ] Log observed events to sidecar console (verify flow)

Deliverable: Sidecar logs every command + output in real time.


### Phase 2: Memory Store (the shell starts remembering)

Goal: Observed events get ingested into a persistent store.
When you close the terminal and reopen it, it remembers.

Two storage tiers:

    Tier 1: Event log (SQLite)
    ─────────────────────────
    Every observed event: command, output, error, timestamp, CWD,
    session ID, exit code. Structured, queryable, fast.
    This is your shell history on steroids.

    Tier 2: Semantic memory (chonk embeddings)
    ──────────────────────────────────────────
    Summarized chunks: "build failed with linker error in auth service",
    "deployed v2.3.1 to staging successfully". Embedded as 384d vectors.
    This is what the AI searches against.

Ingestion pipeline:

    observe event
      │
      ├──→ SQLite (raw event, always)
      │
      └──→ if significant (error, command+output, file change):
           summarize → embed (chonk) → store vector
           tag with: project, cwd, session, error_class

    [ ] Add SQLite to sidecar (rusqlite, ~/.hyperia/memory.db)
    [ ] Schema: events(id, session, type, cwd, data, ts, exit_code)
    [ ] Ingest all observed events into SQLite
    [ ] Add significance detector (errors, long output, exit != 0)
    [ ] For significant events: summarize to one-liner
    [ ] Embed summary via chonk /memory/default/ingest
    [ ] Add recall endpoint: GET /api/recall?q=...&limit=10
    [ ] Recall searches both SQLite (recent, exact) and chonk (semantic)

Deliverable: `GET /api/recall?q=linker error` returns the build
failure from three days ago with full context.


### Phase 3: Proactive Surface (the shell starts talking)

Goal: Hyperia notices things and tells you without being asked.
This is the feature that makes it feel alive.

Surface triggers:

    ┌────────────────────────────────────────────────────┐
    │ Trigger              │ Example                      │
    ├────────────────────────────────────────────────────┤
    │ Recurring error      │ "This error has appeared     │
    │                      │  3 times this week"          │
    │                      │                              │
    │ Risky command        │ "Last time you ran rm -rf    │
    │                      │  in this dir it deleted      │
    │                      │  node_modules — 47 min       │
    │                      │  rebuild"                    │
    │                      │                              │
    │ Session resume       │ "When you left off: building │
    │                      │  auth service, test suite    │
    │                      │  was failing on JWT parse"   │
    │                      │                              │
    │ Anomaly              │ "Build time jumped from 12s  │
    │                      │  to 4m — something changed"  │
    │                      │                              │
    │ Pattern match        │ "You usually run tests       │
    │                      │  after this — want me to?"   │
    └────────────────────────────────────────────────────┘

Implementation:

    sidecar context engine
      │
      ├──→ on each command: recall similar past events
      │    if pattern match or anomaly → emit notification
      │
      ├──→ on session start: recall last session's state
      │    emit "welcome back" summary
      │
      └──→ on error: search for this error in memory
           if seen before → emit "you've hit this before: [fix]"

Notification delivery: sidecar → HTTP → Electron IPC → UI surface.
UI surface options: notification bar, sidebar panel, inline ghost text.

    [ ] Add notification endpoint: POST /api/notify (sidecar → Electron)
    [ ] Electron notification renderer (subtle bar, not modal)
    [ ] Session resume: on connect, recall last 5 events for this CWD
    [ ] Error recall: on exit != 0, search memory for similar errors
    [ ] Recurring error detection: count(error_class) in last 7 days
    [ ] Pattern detection: after command X, user usually runs Y
    [ ] Risk detection: recall past consequences of similar commands
    [ ] Anomaly detection: compare timing/output length to baseline

Deliverable: Open terminal in a project, see "Last session: you were
debugging the JWT parser. Tests were failing on line 42."


### Phase 4: AI-Native Context (the shell feeds your tools)

Goal: When you talk to Claude (or any LLM), Hyperia automatically
provides relevant project context. No more re-explaining.

    User types in chat panel:
    "why is the auth service failing?"

    Hyperia agent:
    1. Searches memory for "auth service" + "fail" + "error"
    2. Finds: 3 errors this week, all JWT-related
    3. Finds: you changed jwt.config.ts on Tuesday
    4. Finds: tests passed before that change, fail after
    5. Responds with full context, not just "check the logs"

This is the agent engine (chat.rs) connected to the memory store.

    [ ] Add recall tool to agent: search_memory(query, time_range)
    [ ] Add project_context tool: get current project profile
    [ ] Agent system prompt includes recent session summary
    [ ] Agent can reference specific past events with timestamps
    [ ] MCP server exposes memory tools for external clients
    [ ] Context export: GET /api/context?project=foo → JSON blob
        suitable for pasting into any LLM conversation

Deliverable: Ask the agent "what changed?" and it tells you, with
specifics, dates, and diffs.


### Phase 5: Project Awareness (the shell understands your code)

Goal: Hyperia knows your project structure, dependencies, and
relationships — not just your command history.

    On first visit to a directory:
    - Detect project type (package.json, Cargo.toml, go.mod, etc.)
    - Index key files: README, config, CI, Dockerfile
    - Track dependency graph (what imports what)
    - Note test commands, build commands, deploy commands

    On subsequent visits:
    - Detect changes since last visit (git diff)
    - Update dependency graph if structure changed
    - Correlate errors with recent changes

    [ ] Project detector: scan CWD for project markers
    [ ] Project profile: store in ~/.hyperia/projects/{hash}.json
    [ ] Git integration: track branch, recent commits, dirty files
    [ ] Dependency graph: parse imports/requires at surface level
    [ ] Change correlation: "error appeared after commit abc123"
    [ ] Project-scoped memory: recall filtered by project context

Deliverable: Switch to a project you haven't touched in 2 weeks,
Hyperia shows what changed (upstream commits, dependency updates,
CI status) without you asking.


### Phase 6: Hardware + Extensions

Goal: Stream Deck, peer signaling, plugin API.

    [ ] Stream Deck shows memory status (recent errors, session health)
    [ ] Encoder bindings: scroll through recall results
    [ ] Button: "what was I doing?" → session resume on demand
    [ ] nemisis8 integration: multiple Hyperia instances share context
    [ ] Plugin API: extend observer, surface triggers, UI panels

This is Phase 6 because it's polish on a working system.
The core value is in Phases 1-4.


## Data model

    Event (SQLite)
    ──────────────
    id          INTEGER PRIMARY KEY
    session     TEXT        -- UUID per terminal session
    type        TEXT        -- "command", "output", "error", "signal"
    cwd         TEXT        -- working directory at time of event
    project     TEXT        -- detected project name/hash
    data        TEXT        -- raw content (command text, output, etc.)
    exit_code   INTEGER     -- for command events
    ts          INTEGER     -- unix timestamp
    tags        TEXT        -- JSON array: ["build", "error", "jwt"]

    Memory (chonk vectors)
    ──────────────────────
    id          TEXT        -- matches event ID or summary ID
    text        TEXT        -- human-readable summary
    embedding   FLOAT[384]  -- bge-small-en-v1.5
    project     TEXT        -- project scope
    ts          INTEGER     -- when this happened
    decay       FLOAT       -- memex-style decay (anicca)

    Project (JSON file)
    ───────────────────
    path        TEXT        -- filesystem path
    type        TEXT        -- "node", "rust", "python", "go", etc.
    name        TEXT        -- from package.json/Cargo.toml/etc.
    last_visit  INTEGER     -- timestamp
    commands    OBJECT      -- { build: "make", test: "pytest", ... }
    deps        ARRAY       -- key dependencies
    branch      TEXT        -- current git branch
    errors      ARRAY       -- recent error summaries


## What we're NOT building (yet)

    - Shell replacement (bash/zsh/pwsh still runs inside Hyperia)
    - Cloud sync (all local, self-hostable means self-hosted)
    - Team features (this is a solo developer tool first)
    - Full IDE (we're a terminal, not VS Code)
    - Auto-fix (we surface context, the human or their LLM decides)


## Existing tech that feeds in

    gnosis-chunk (chonk)    Embedding service, already running.
                            384d bge-small, axum + ONNX + sled.
                            Hyperia uses it for semantic memory.

    memex                   Memory lifecycle (decay, consolidation,
                            anchoring). Python prototype. The math
                            (adaptive alpha, fidelity gates) ports
                            into the sidecar's context engine.

    nemisis8                Peer signaling. Multiple Hyperia instances
                            (or other gnosis services) can share
                            context through signal channels.

    diyclaw prompt packs    Agent system prompt compiler. Already
                            integrated in chat.rs. Gives the agent
                            its execution contract and personality.

    Stream Deck             Physical interface. Already works in
                            sidecar. Buttons, encoders, touchstrip
                            become a control surface for memory ops.


## Build order

    Phase 0 ─── 2-3 days ─── working Hyperia shell
    Phase 1 ─── 2-3 days ─── observer pipe (PTY → sidecar)
    Phase 2 ─── 3-5 days ─── memory store (SQLite + chonk)
    Phase 3 ─── 3-5 days ─── proactive surfacing
    Phase 4 ─── 2-3 days ─── AI context (agent + memory)
    Phase 5 ─── 3-5 days ─── project awareness
    Phase 6 ─── ongoing  ─── hardware + extensions

    Phases 0-2 are the foundation. Ship after Phase 3.
    Phase 4 is the killer feature for AI-era developers.
    Phase 5 is what makes it feel like it knows your project.
    Phase 6 never ends.
