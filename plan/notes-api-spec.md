# Notes API — Missing Endpoints Spec

## 1. DELETE /api/notes/:id

Remove a note permanently by ID.

**Request:**
```
DELETE /api/notes/note-1775521416281-ox6x
```

**Response (success):**
```json
{ "ok": true }
```

**Response (not found):**
```
HTTP 404
```

**Behaviour:**
- Look up note by `id` in the notes store
- If found, remove it from persistent storage and send a `NoteDelete` event to Electron so the overlay window closes/disappears
- If not found, return 404

---

## 2. GET /api/notes?q=:query

Search notes by text content (case-insensitive substring match is fine for now).

**Request:**
```
GET /api/notes?q=demo
```

**Response:**
```json
[
  {
    "id": "note-abc123",
    "text": "demo for reza",
    "color": "#fff9c4",
    ...
  }
]
```

**Behaviour:**
- If `q` param is absent or empty, return all notes (existing behaviour)
- If `q` is present, filter notes where `text` contains `q` (case-insensitive)
- Return same note shape as current list response

---

## Notes
- Both endpoints should follow the same Rust sidecar → Electron bridge pattern as `NoteCreate`
- Wire up `NoteDelete` in `app/bridge.ts` alongside the existing `createStickyNote` handler
- MCP tool `note_close` already exists — `DELETE` should do the same thing but also purge from storage, not just close the window
