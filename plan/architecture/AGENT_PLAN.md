# Stream Deck Agent: Bidirectional Integration Plan

## The Idea

The Stream Deck runs its own agent. Other processes (terminal, radio, MCP clients) can:
1. **Send requests** to the deck agent ("show system status", "flash alert on button 3")
2. **Register for callbacks** so the deck agent notifies them when knobs turn, buttons press, or the touchstrip is touched

The deck agent is a peer, not a peripheral. It has its own Claude instance, its own context, and it can reason about what to do with physical input before forwarding it.

---

## Current State (What Exists)

```
gnosis-streamdeck/
  HTTP :9850        — REST API (set colors, images, brightness, screenshots)
  MCP stdio         — 9 tools for Claude Code / MCP clients
  Claude agent      — Reacts to button/encoder/touch, calls tools (set_button_color, generate_image, etc.)
  Device actor      — HID thread, 50ms polling, event broadcast channel
```

The agent already intercepts all physical input and can drive visuals. But it's **isolated** — no way for external agents to talk to it or receive events from it.

---

## What We're Adding

### 1. Callback Registry (deck notifies you)

External services register a webhook URL. When physical input happens, the deck POSTs the event to all registered callbacks.

```
POST /api/callbacks/register
{
  "url": "http://localhost:9090/api/signal",  // where to POST events
  "id": "terminal-main",                      // caller's identity
  "events": ["button", "encoder", "touch"],   // which events (default: all)
  "agent_filter": true                        // if true, only forward events the agent didn't handle
}

Response: { "ok": true, "callback_id": "cb_a1b2c3" }
```

```
DELETE /api/callbacks/{callback_id}
GET /api/callbacks                            // list registered callbacks
```

**When a button is pressed**, the deck:
1. Runs its own agent loop (agent decides what to do with the press)
2. POSTs the event to all registered callbacks:

```json
POST http://localhost:9090/api/signal
{
  "from": "streamdeck",
  "to": "terminal-main",
  "type": "button_press",
  "payload": {
    "key": 3,
    "action": "trigger",
    "label": "Split",
    "agent_response": "Split pane horizontally"  // what the deck agent decided
  }
}
```

Same for encoder twists, touchstrip taps, etc.

### 2. Agent Messaging (you talk to the deck agent)

Send a message to the deck's Claude agent. It processes it with its own context (device state, conversation history) and responds.

```
POST /api/agent/message
{
  "from": "terminal-agent",
  "message": "Show CPU usage on the touchstrip and flash button 1 red if it's over 80%",
  "context": { "cpu_percent": 92 }    // optional extra context
}

Response (streamed or polled):
{
  "ok": true,
  "request_id": "req_x1y2z3",
  "response": "Done. Button 1 is flashing red — CPU is at 92%.",
  "actions_taken": [
    {"tool": "set_touchstrip_text", "args": {"text": "CPU: 92%", "bg": [80,0,0]}},
    {"tool": "set_alert", "args": {"key": 1, "color": [255,0,0]}}
  ]
}
```

For async/long-running requests:
```
POST /api/agent/message    → returns { "request_id": "req_..." }
GET /api/agent/result/{request_id}  → poll for completion
```

### 3. Agent System Prompt Extension

The deck agent's system prompt gets extended to know about connected peers:

```
You are the Stream Deck agent for the gnosis system. You control an Elgato Stream Deck Plus.
You have 8 LCD buttons, 4 rotary encoders, and a touchstrip.

Connected peers:
- terminal-main (http://localhost:9090) — the primary terminal instance
- terminal-slave (http://localhost:9090/api/signal?for=slave1) — a slave terminal

When you receive a message from a peer, respond by taking actions on the device
and/or forwarding information back via their callback URL.

When physical input occurs:
- First decide if this is something YOU should handle (visual feedback, status display)
- Then notify registered callbacks so peers can react
```

### 4. Encoder Binding (knob → parameter)

Encoders should be bindable to parameters that other agents care about. Example: encoder 2 controls "agent temperature", encoder 3 controls "radio volume".

```
POST /api/encoder/bind
{
  "encoder": 2,
  "label": "Agent Temp",
  "min": 0.0, "max": 1.0, "step": 0.05,
  "value": 0.7,
  "callback_url": "http://localhost:9090/api/signal"  // notified on change
}
```

When the user twists encoder 2, the deck:
1. Updates the bound value (0.7 → 0.75)
2. Shows the value on the touchstrip briefly
3. POSTs the new value to the callback URL

```json
{ "from": "streamdeck", "type": "encoder_value", "payload": { "encoder": 2, "label": "Agent Temp", "value": 0.75 } }
```

---

## Integration with Terminal (Slave Mode Signal Channel)

The terminal's `/api/signal` endpoint (being built for slave mode) is the natural callback target. The flow:

```
                    ┌─────────────────┐
                    │   Stream Deck   │
                    │   Agent (:9850) │
                    └────┬───────┬────┘
                         │       │
              callbacks  │       │  agent messages
                         ▼       ▼
    ┌─────────────────────────────────────────┐
    │  Terminal Master (:9090)                 │
    │  /api/signal ← receives deck events     │
    │  POST :9850/api/agent/message → asks    │
    │                                         │
    │  Terminal Agent (chat.rs)                │
    │  - has "deck_message" tool              │
    │  - has "deck_set_button" tool           │
    │  - receives signals from deck via poll  │
    └─────────────────────────────────────────┘
```

### Terminal Agent Tools (chat.rs additions)

```json
{
  "name": "deck_message",
  "description": "Send a message to the Stream Deck agent. It will process it and take visual actions.",
  "input_schema": {
    "properties": {
      "message": { "type": "string" }
    }
  }
}
```

```json
{
  "name": "deck_set_button",
  "description": "Set a Stream Deck button color or text directly (bypasses deck agent).",
  "input_schema": {
    "properties": {
      "key": { "type": "integer" },
      "color": { "type": "array", "items": { "type": "integer" } }
    }
  }
}
```

---

## Implementation Order

### Phase 1: Callback Registry (small, high value)
- Add `callbacks: Vec<CallbackRegistration>` to SharedState
- Add `/api/callbacks/register`, `/api/callbacks`, `DELETE /api/callbacks/{id}`
- After device_actor broadcasts an event AND the agent processes it, POST to all callbacks
- Wire up terminal to register on startup if `--deck` flag is set

### Phase 2: Agent Messaging (medium)
- Add `/api/agent/message` endpoint
- Route incoming messages into the agent's conversation as a "user" turn
- Return the agent's response + actions taken
- Add `deck_message` tool to terminal's chat.rs

### Phase 3: Encoder Bindings (small)
- Add `/api/encoder/bind` endpoint
- Track bindings in SharedState
- On encoder twist, update bound value + notify callback
- Show value on touchstrip (brief overlay, then fade)

### Phase 4: Peer Discovery (optional)
- Deck probes known ports on startup (9090 for terminal, 9080 for radio)
- Auto-registers callbacks with discovered services
- Services that start later can register with the deck

---

## Config (streamdeck.json additions)

```json
{
  "callbacks": {
    "auto_register": [
      { "url": "http://localhost:9090/api/signal", "id": "terminal", "events": ["button", "encoder"] }
    ]
  },
  "encoder_bindings": [
    { "encoder": 0, "type": "brightness" },
    { "encoder": 1, "type": "scroll", "target": "terminal" },
    { "encoder": 2, "type": "custom", "label": "Vol", "min": 0, "max": 100, "step": 5 },
    { "encoder": 3, "type": "custom", "label": "Temp", "min": 0.0, "max": 1.0, "step": 0.05 }
  ]
}
```

---

## Key Design Decisions

1. **Deck agent processes first, then forwards.** The deck isn't a dumb relay — it sees the input, decides if it needs to do something visual, THEN tells peers. This means the deck can handle "flash acknowledgment" without waiting for the terminal to respond.

2. **Callbacks, not WebSockets.** Simple HTTP POST webhooks. Every gnosis service already has an HTTP server. No new protocol needed. If a callback fails, log it and move on (fire-and-forget with retry=1).

3. **Agent messaging is synchronous-ish.** POST → agent thinks → response. For the deck's small agent (sonnet, 10 tool loops max), this is fast enough. No need for async polling unless we hit latency issues.

4. **Encoder bindings are first-class.** Knobs are the killer feature of the Plus. Making them bindable to arbitrary parameters (with min/max/step) turns them into a universal control surface.
