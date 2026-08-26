# Epic: Agent audio streaming — containers speak through the host

## Problem

Agents in n8 containers have no audio devices and no way to make sound on
the host beyond `hyperia_spoken_summary` (TTS). An agent that wants to play
a chime, stream generated audio, relay a recording, or ship any non-speech
sound has no channel at all.

## What already exists (reuse, don't rebuild)

- **Host audio output**: the sidecar's TTS stack already plays through
  rodio/cpal — device handling and "Rust makes sound on the host" are done.
- **Network path**: containers reach the sidecar over HTTP
  (`HYPERIA_MCP_URL`); the sidecar already serves WebSockets
  (`/ws/pixels/{id}`). Linux deploys must bind 0.0.0.0 (already the rule).
- **Identity**: Bearer pane/agent tokens per request; pane-token lifecycle
  (dies with the pane) is the natural stream lifetime.

## Design

### 1. Streaming ingest — `ws://<sidecar>:9800/ws/audio`

- Connect with Bearer token (pane or agent). Anonymous = refused.
- First frame is a JSON hello: `{"format":"s16le","rate":24000,"channels":1}`
  (accept `s16le` and `f32le`; 8–48kHz; 1–2 channels).
- Then binary frames of raw PCM. No codec — LAN bandwidth is trivial
  (24kHz mono s16 ≈ 48KB/s) and raw keeps container tooling to
  ffmpeg-or-ten-lines-of-python.
- Sidecar side: one rodio `Sink` per stream fed through a bounded jitter
  buffer (~200ms, drop-oldest on overflow). Multiple streams mix.
- Socket close = stream ends. Pane close tears down its tokens' streams.
- Server → client JSON status frames: `{"ok":true}` after hello,
  `{"error":...}` before close, `{"muted":true}` when consent/mute drops
  the stream (so agents aren't shouting into the void unknowingly).

### 2. One-shot clips — `POST /api/audio/play`

- Body: WAV bytes (or `{"pcm_base64":..., format fields}`). Plays once
  through the same mixer. Covers most agent wants with zero stream plumbing.

### 3. MCP tools

- `audio_play` — one-shot clip (wraps /api/audio/play).
- `audio_stream_open` — returns the ws URL + format contract + the caller's
  token reminder, so agents discover the channel like everything else.
- Tool descriptions steer: "for SPEECH use hyperia_spoken_summary — it's
  simpler and needs no consent."

### 4. Consent & control (raw audio ONLY)

Audio is focus-steal for the ears — gate it like drive:

- First raw-audio use per agent raises a consent prompt
  ("🔊 <callsign> wants to play audio"), enforce_drive-style with the
  pending-pill behavior (never silently vanish).
- Per-pane mute toggle in the pane band + a global mute; mute drops frames
  server-side (stream stays connected, gets `{"muted":true}`).
- Attribution: toast "🔊 from <callsign>" when a stream starts; no
  anonymous sound, ever.
- Duration/rate sanity caps (e.g. warn at sustained >10 min).

**Explicit carve-out: `hyperia_spoken_summary` (TTS) stays UNGATED.** It is
ungated today (identity only resolves the callsign for the radio frame) and
remains so — the radio framing is already self-attributing, and gating it
would break the spoken-summary workflow. Consent applies to the new raw
PCM/clip channel only.

## Out of scope (for now)

- Audio FROM the host to containers (mic capture) — separate epic, real
  privacy surface, do not bundle.
- Codecs (opus) — revisit only if someone streams over WAN.
- Per-stream volume UI — global + per-pane mute is enough for v1.

## Effort

~300 lines sidecar (ws handler + mixer source + clip endpoint), 2 MCP
tools, consent wiring reusing the drive-prompt machinery, pane-band mute
button, docs (mcp-tools.md + configuration.md if any config keys land —
likely `audio: {enabled, maxStreams}`).
