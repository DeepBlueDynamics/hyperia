# Messaging refactor handoff

Status: ready for the user's external build and validation. Electrical Aardvark, Front Ermine, and Grotesque Platypus recorded source-readiness verdicts for their assigned areas; coordinator integration review is complete. Latest changes are NOT built or tested. Source edits are frozen for handoff. Runtime fixed agreement awaits external results.

## Tool shapes

| Tool | Purpose |
| --- | --- |
| terminal_run | Shell command at a verified shell prompt; refuses agent/busy/unknown targets. |
| pane_send | Full text directly to a supported agent pane; separate submit flag. |
| terminal_keys | Explicit low-level terminal controls under drive permission; no implicit Enter on controls. |
| pane_bind | Associate authenticated persistent identity and active pane with a pane credential or human approval. |
| msg_send | Durable mailbox storage plus an eligible short notice. |
| msg_inbox | Preview own mailbox; no read-state mutation. |
| msg_check | Fetch unread mail and acknowledge exactly returned messages. |
| msg_read | Recipient-only acknowledgement of one message. |
| msg_search | Search own sent/received mail; no read-state mutation. |
| delivery_status | Inspect own retained operation and transport outcome. |
| terminal_ui_key | Application identity only; ordinary agents cannot drive consent dialogs. |

MCP and Ghost expose the messaging group through open_tools. Their shell-command tools use the same HTTP boundary.

## How delivery now works

Authenticated identity -> explicit, unambiguous target -> recipient/message permission or terminal-control permission -> persist operation -> associate exact consent request -> notify human. Approval resolves the matching retained operations to queued. The worker claims once and rechecks the pane before transport. Human focus defers agent input; unfocused supported agents do not wait for output silence.

Each operation has its own ID and requester-scoped idempotency key. A duplicate key with different input conflicts. Body and Enter are separate writes for agent input. If focus arrives after text, Enter is withheld and the outcome is indeterminate. No blind replay follows an uncertain write. Complete input transactions share a per-pane lock with authenticated stream input. Internal pulses and callbacks use the same guarded transaction; the obsolete collection path and screen-text-based extra Enter retries are removed. Orphaned locks are pruned only when no transaction or waiter holds them.

Pending submissions return HTTP 202 with an operation ID; terminal replays and status lookups return HTTP 200. If Electron cannot receive the approval prompt, the response still includes the retained ID and a notification warning, and the worker retries the prompt. If saving a transport outcome fails, the worker retries only completion metadata, never the input.

Idempotent replay precedes current denial/target policy and compares the original request metadata plus its single stored body. Unknown operation kinds and malformed payloads fail without transport.

Restart expires pending/queued work and marks submitting work indeterminate. An operation reaching submitted records transport acceptance, not an agent read acknowledgement.

## Why Allow previously did nothing

Verified original source: post_type_and_collect called the eight-second consent waiter before retaining any payload. Approval after that waiter returned could grant permission but had no command left to execute. The alternate post_type stored input only after waiting, with a fast-approval race. The old map was also keyed only by target pane, allowing pending callers to overwrite one another.

The retained-operation path replaces both behaviors; the old held-input map is removed. UI prompts are keyed by request ID and stay visible when the approval request fails.

## Addressing, read state and notices

Mail authority uses agent:<registered-name> or pane:<full-id>, never a display label. A persistent identity needs a verified binding to retrieve pane-addressed mail. Registration from an authenticated pane binds automatically; pane_bind handles existing identities. Hyperia exports HYPERIA_PANE_TOKEN separately so runtimes can preserve proof when substituting an agent token. External runtimes still must forward that credential or use the consent path.

The original messages/read-receipts JSONL layout remains. Inbox/search join canonical receipts without modifying them. Check/read persist recipient-owned receipts. Mail envelopes report stored separately from read.

A short coalesced notice uses the same focus-protected transport, without waiting for agent output silence. Notices never carry the body. Pending notices survive focus delays and retry definite pre-send disconnection; an uncertain transport outcome consumes that hint to avoid replay. Mail remains retrievable regardless of hint delivery. Establishing a binding re-arms its notice.

## ACL boundaries and compatibility

Permission requests, grants and owner checks use the same canonical principal key. Persisted permissions carry a schema version; migration uses the registered agent identities and drops ambiguous legacy grants for fresh approval. Pane tokens are preserved. Stale delivery approvals consume the prompt without granting access; storage-inspection failure stops approval.

Message grants are separate from terminal-control grants and restricted to a canonical recipient. Read receipts are recipient-only. Agent token listing is redacted, existing credentials cannot be retrieved by name alone, and reserved system/pane labels cannot be registered as agents.

Consent responses, pane-token retrieval, permission toggles, window UI keys and the Electron control WebSocket require the application identity. Electron main supplies it; the renderer does not receive it. Pane and tab streams check terminal-control permission on every incoming input frame; anonymous viewers remain read-only even when legacy enforcement is disabled. Ambiguous pane targets are rejected, and tab input is restricted to that tab. All stream writes share the input lock and renderer reservation.

Old clients should refresh their tool definitions. The old type-and-collect endpoint now returns a retained shell operation, not screen output; read output explicitly. Direct agent input uses pane_send. New TypeScript app files require the normal project-reference build before a noEmit-only check.

## Validation and remaining evidence

See external-messaging-validation.md for build commands and live acceptance cases. Earlier partial in-container results are historical only. Latest source changes require the user's external build, tests, approval round trip, focus behavior, and actual Alt+Up capture.

The configured MCP connector produced -32602 errors during research while fresh initialized HTTP MCP calls worked. The external run must test fresh and reused connector sessions after the new tool definitions load; this symptom has not been independently declared fixed.

Electrical Aardvark, Front Ermine and Grotesque Platypus review assigned areas. Their source reviews are not runtime proof. Final fixed agreement requires external results and resolution of any reported blockers.
