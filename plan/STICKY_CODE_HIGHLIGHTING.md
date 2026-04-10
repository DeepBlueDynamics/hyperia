# Sticky Note Code Highlighting — Plan

## Overview

Two things:
1. **Code themes** — add "Code Light" and "Code Dark" as special color selections in the note context menu. They set a full code-appropriate color scheme (bg + text + syntax) instead of just a background tint.
2. **Modular highlighter** — a pluggable highlight backend where one implementation is static (highlight.js) and another is AI-powered: the agent analyzes the note content and returns semantic highlight rules specific to what's actually in the note.

---

## Part 1 — Code Theme Color Selections

### Context menu change (`sticky.ts`)

Add two special entries to the color picker submenu, visually separated from the plain colors:

```
Color ▶
  ─────────────
  Yellow   ■
  Pink     ■
  Green    ■
  Blue     ■
  Peach    ■
  Lavender ■
  Khaki    ■
  Plum     ■
  Tomato   ■
  Gold     ■
  Mint     ■
  Salmon   ■
  ─────────────
  Code Light  ◧   ← special
  Code Dark   ◨   ← special
```

### What "Code Light" and "Code Dark" mean

They're not just a background color — they set a full theme token stored on the note:

| Token | Code Light | Code Dark |
|-------|------------|-----------|
| bg | `#f8f8f2` | `#1e1e2e` |
| text | `#383a42` | `#cdd6f4` |
| theme | `atom-one-light` | `catppuccin-mocha` |
| mode | `code` | `code` |

The `color` field stored in `notes.json` would be `code:light` or `code:dark` — not a hex value. `sticky.html` detects this prefix and applies the theme instead of a background hex.

### highlight.js theme swap

Currently `sticky.html` hardlinks `github.min.css`. Replace with a `<link id="hlTheme">` tag whose `href` is swapped at runtime:

```javascript
const THEMES = {
  'code:light': 'atom-one-light.min.css',
  'code:dark':  'catppuccin-mocha.min.css',
  default:      'github.min.css'
};
```

Both themes are self-hosted in `app/` (copy from highlight.js dist) — no CDN dependency.

---

## Part 2 — Modular Highlighter Architecture

### Interface

```typescript
// sidecar/src/ghost or app/sticky.html (JS side)
interface HighlightResult {
  language?: string;
  rules: HighlightRule[];
}

interface HighlightRule {
  pattern: string;    // regex string
  flags?: string;     // regex flags, default 'g'
  className: string;  // CSS class to apply, e.g. 'hljs-keyword'
  color?: string;     // optional inline color override
}
```

### Implementations

**1. StaticHighlighter** (existing, default)
- Runs highlight.js `hljs.highlightAuto()` on content
- Instant, offline, good for known languages
- Used when: note is in code mode, no agent available, or user hasn't requested AI highlighting

**2. AgentHighlighter** (new)
- POSTs content to `/api/notes/highlight` on the sidecar
- Sidecar sends a focused prompt to Claude: *"You are a syntax highlighter. Given this content, return a JSON array of highlight rules: `{pattern, className, color}`. Identify keywords, literals, identifiers, operators, and any domain-specific terms that deserve visual distinction. Return only JSON, no explanation."*
- Result cached per note-content hash so it doesn't re-run on every keystroke
- Used when: user explicitly enables "AI Highlight" from context menu, or note mode is `code:ai`

### Sidecar endpoint (`main.rs`)

```
POST /api/notes/highlight
Body: { content: string, hint?: string }
Returns: { rules: HighlightRule[] }
```

The agent call is a **single-turn, non-streaming** Claude call (not a full ghost session) — just:
```
system: "You are a syntax highlighter. Return only valid JSON."
user:   "Highlight this:\n\n{content}"
```

Max input ~4000 chars (truncate if larger). Cache key = SHA1(content). Cache lives in memory for the session.

### Rendering pipeline in `sticky.html`

```
noteContent
  → chooseHighlighter(mode)           // 'static' | 'agent'
  → highlighter.highlight(content)    // returns HighlightResult
  → applyRules(content, rules)        // builds annotated HTML
  → inject into <pre><code>
```

`applyRules()` applies rules in order (lower-priority rules first, higher last), wrapping matches in `<span class="{className}" style="color:{color}">`.

### Context menu addition

```
─────────────
Highlight ▶
  Auto (highlight.js)   ← current default
  AI Highlight          ← triggers AgentHighlighter, shows spinner
  Off                   ← plain text
```

---

## File Map

| File | Change |
|------|--------|
| `app/sticky.ts` | Add Code Light/Dark to color menu; add Highlight submenu; emit `sticky-set-theme` IPC |
| `app/sticky.html` | Detect `code:*` color prefix; swap hljs theme CSS; add `applyRules()` renderer; add spinner for AI highlight |
| `sidecar/src/main.rs` | Add `POST /api/notes/highlight` — single-turn Claude call, in-memory cache |
| `app/` | Add `atom-one-light.min.css`, `catppuccin-mocha.min.css` (self-hosted hljs themes) |

## Order of Work

1. Self-host the two hljs theme CSS files
2. Add Code Light / Code Dark to context menu + apply in sticky.html
3. Add `applyRules()` renderer + StaticHighlighter wiring
4. Sidecar: `/api/notes/highlight` endpoint + single-turn Claude call + cache
5. Context menu: Highlight submenu (Auto / AI / Off)
6. Wire AgentHighlighter to the endpoint with loading state
