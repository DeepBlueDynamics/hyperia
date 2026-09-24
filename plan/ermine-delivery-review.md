# Ermine — Approval & Delivery Lifecycle Review

Role: Front Ermine. Scope: approval queues, immediate/delayed allow, deny, concurrency, requester
isolation, delivery recovery. Reviewed against `plan/messaging-delivery-refactor.md` and the current
source. Research only — no implementation.

Reviewed files (evidence line ranges):
- `sidecar/src/main.rs` — `post_type` (958-1063), `post_type_and_collect` (1065-1130),
  `enforce_drive`/`enforce_drive_with_purpose` (1571-1666), `pending_202` (1766-1781),
  `post_perm_respond` (2080-2205).
- `sidecar/src/bridge.rs` — `HeldAction` (86-94), `held_actions`/`held_creates` init (239-242, 304-306),
  `hold_action`/`take_action`/`hold_create`/`take_create`/`resolve_create_early`/`take_resolved_create`
  (571-641).
- `sidecar/src/msgbus.rs` — two-file JSONL, `record`/`record_read`/`inbox`/`search` (full file).

---

## 1. Verified defects (my area)

### D1 — `post_type_and_collect` never holds, but the shared 202 message promises it is held

`post_type_and_collect` (main.rs:1090-1092) returns a pending `202` straight from `enforce_drive`
without calling `hold_action` (unlike `post_type` at 1013-1025). `pending_202()` (1766-1781) then tells
the requester "Your command is HELD and will run AUTOMATICALLY the instant they approve." For the
type-and-collect path nothing is held, so approval can never flush it. This is exactly the plan's
"post_type_and_collect returns pending approval without retaining its body." Confirmed contract breach:
the response promises auto-delivery that the code path cannot deliver.

### D2 — Hold/approve race: approval lands in the 8s wait window and drops the payload anyway

`enforce_drive` (1649-1659) waits `16 × 500ms` polling `authorize_drive`. `post_type` calls
`hold_action` **only after** `enforce_drive` returns `pending_202()` (i.e. ~8s). `post_perm_respond`
(2121-2122) flushes via `take_action(&req.target_pane)`. Sequence that drops a command:

1. Agent calls `/api/type`; consent prompt raised; wait loop starts.
2. Human approves at t=8.1s (inside/just after the window, before the loop's last poll).
3. `post_perm_respond`: `take_action(target_pane)` → `None` (nothing held yet) → keys dropped; the
   early-create parity (`resolve_create_early`) exists for CREATE but has **no analog for held keystrokes**.
4. `post_type` resumes, gets `pending`, calls `hold_action` → orphan held forever.

Same family as the plan's observed failure ("approval log records allow after that interval"). The
`resolve_create_early` mechanism proves the maintainers knew the fast-approval race; it was never ported
to the keystroke path.

### D3 — Held actions keyed by target pane only → two callers to one pane overwrite each other

`held_actions: Mutex<HashMap<String, HeldAction>>` keyed by `target_uid` (bridge.rs:240, 573-576):
`hold_action` **overwrites** any prior held action for the pane. `take_action(&req.target_pane)`
(581-586) drains by target pane only. Consequences:

- Caller A holds keys for pane P; caller B holds keys for P → B silently replaces A, A's command is
  lost while A was told it was held.
- Human approves a request owned by B → respond flushes whatever is held **for pane P**, which may be
  A's keys if B hadn't held yet. Cross-requester execution of the wrong payload.

Also note `HeldAction.requester` is `#[allow(dead_code)]` — the requester is carried but never used, so
there is no enforcement path even where the field exists. Plan is correct: key by
request/operation + requester + destination, never destination alone.

### D4 — No exactly-once: retry re-raises wait and can double-submit; ids from wall-clock ms

`enforce_drive` has no idempotency key. A caller retrying an in-flight request re-enters the 8s wait
against the same `(label, target)` consent; if approval lands before the retry's first poll, both the
original call and the retry resolve to `Allow` and both send bytes → duplicate submission. No
idempotency key exists anywhere (`post_type`/`post_type_and_collect` accept no key). And msg IDs are
`msg_<hex-ts>` from `now_ms()` (msgbus.rs) — two messages in the same millisecond collide on id.

### D5 — In-memory-held state dies on restart; durable grants outlive held payloads → indeterminate

`held_actions`, `held_creates`, `resolved_creates` are plain `Mutex<HashMap>` in `BridgeInner`, never
persisted (bridge.rs:239-242, 304-306; no file IO anywhere near them). By contrast agent tokens
(`identity.rs`, `~/.hyperia/agents.json`) and the consent/grant store (`perms::PermStore` pane tokens)
are durable. So after a sidecar restart:

- A pending-but-unapproved hold is silently gone; the renderer's still-visible prompt, if approved,
  flushes `take_action` → `None`, nothing runs. Neither caller nor system can tell the difference
  between "approved and executed" and "approved and lost."
- A durable grant approves a subsequent call, but the payload the human approved at crash time was never
  retained → the plan's mandated "preserve indeterminate state" is unmet.

No reconciliation on restart exists anywhere in the drive path (unlike pulses, which are persisted and
re-armed, bridge.rs:210, 773).

### D6 — `post_type_and_collect` lacks the human-activity queue; only `post_type` forwards `interrupt`

Minor but in-scope: `post_type` forwards `addr.interrupt` to the renderer's `enqueueOrWrite` queue
(1045-1059) so a busy human-targeted pane queues or refuses honestly. `post_type_and_collect` has no
`interrupt` path (1100-1126) — it writes unconditionally into the target. For approval lifecycle this
means an approved type-and-collect fires into a pane the human is using, contradicting "focused human
input protected." (Owned by Platypus for the idle/focus contract; noted here as a delivery-state gap.)

### D7 — msgbus read state violates isolation/ownership

- `record_read(msg_id, reader_label)` (msgbus.rs) verifies neither that the message exists nor that
  `reader_label` is the recipient; any caller that knows an id can ack any message.
- Recipient matching is label **OR** pane (`to_me`, msgbus.rs): a display-name collision or arbitrary
  `toPane` reaches another's mail; `reads_for` keys receipts by label only, so reattach/rename
  desynchronizes unread state.
- `append_line` swallows write failures (`let _ = …`), so durability is not surfaced.

These are confirmed and match the plan's outcome 4 / ACL + read-state matrix rows.

---

## 2. Proposed implementation boundaries (my area)

Concretely, what I would implement under the plan, and where it lands:

1. **Operation record before consent.** A pending drive request must materialize a durable record
   `{ op_id, idempotency_key, requester_id, requester_pane, target_uid, destination_kind
   (pane|agent|create), payload, created_ms, state }` **before** `enforce_drive` enters its wait, not
   after. Then the wait, the hold, and `post_perm_respond` all key on `op_id`, never on target pane.
2. **Single approval-claims path.** `post_perm_respond` must claim by `op_id`/requester, atomically
   transition `awaiting_approval → submitted|denied|expired`, and execute exactly once. `resolve_create_early`
   generalizes to a shared "early decision consumed by the in-flight wait" primitive for **all** held
   actions (keystrokes included) — D2's gap.
3. **Immediate and delayed allow use the same transport.** Whether the human clicks before or after the
   8s window, the flush path must be identical: claim op → submit through `deliver_keys`/`send_command`
   → mark `submitted` (or `failed`). No distinct "fast approval" vs "held flush" code.
4. **Persist pending ops** in a JSONL/append-only store next to `consent.jsonl`; on restart reconcile
   against resolved grants and mark orphans `expired`/`indeterminate` rather than silently vanishing.
   Reuse the pulses persistence/`persist_pulses` pattern (bridge.rs:818-829) for a clean precedent.
5. **Collision-resistant ids + idempotency keys.** Monotonic/random ids (not `now_ms`), and require the
   caller's idempotency key on `post_type`/`post_type_and_collect`; a replayed key returns the existing
   op's state instead of re-arming the wait. This is the only honest path to "exactly one submission"
   (plan explicitly forbids claiming crash-exactly-once without receiver dedup).
6. **Read/receipt ownership in msgbus.** Make read state per-recipient-identity (stable key from
   Electronic Aardvark's shared contract), reject ack of non-existent or non-recipient messages, surface
   write failures.

Boundary: identity/ACL resolution, pane↔agent association keys, and the storage-format decision are
owned by Aardvark/Coordinator — I implement against the agreed stable keys, not define them. `terminal_run`
classification, the idle/focus policy, and Alt+Up belong to Platypus — I only ensure the held flush honors
the approved interrupt/focus policy (`deliver_keys` with the correct `interrupt`), I don't redefine it.

---

## 3. Plan objections

1. **"Timeout never discards it while claiming it is held" (Outcome 1) is not currently satisfiable by
   the existing two-file JSONL / in-memory hold design, and the plan defers the storage decision.**
   D5 shows held payloads are in-memory only while grants are durable — a crash between approval and
   flush returns an indeterminate state the current layout cannot represent. The refactor must either
   (a) persist ops, or (b) stop claiming durability and return truthful `failed`/`indeterminate`. The
   plan should not claim outcome 1 before this is resolved. This is a blocking precondition, not a
   cosmetic gap.
2. **"Approving a pending operation performs that operation automatically, exactly once" is
   unreachable without an idempotency key.** D4: retries can double-submit; crash recovery is explicitly
   indeterminate per the plan itself. The acceptance matrix row "Retries: duplicate idempotency key does
   not duplicate send" already requires the key, but no work package names who adds it to the drive
   endpoints. It belongs in Ermine's package and must be stated, or the "exactly once" wording stays.

Remaining plan sections (Transport -32602, Alt+Up, storage format) are out of my scope; I take no
position on their completeness beyond noting they are marked open by the plan itself.

---

## 4. Tests I propose to own (write before/with implementation)

- **Fast-approve flush** — human approves inside the 8s poll window; the in-flight wait consumes the
  decision via the generalized early-decision primitive and submits exactly once (D2 regression).
- **Delayed-approve flush** — approve after the 8s window; durable held op transitions
  `awaiting_approval → submitted`, exactly one submission, and the 202-then-approve path executes.
- **Deny drops** — deny after 202; held op → `denied`, never submitted, payload released.
- **Expiry** — op expires; no flush, state `expired`, requester informed truthfully.
- **Cross-caller isolation to one pane** — callers A and B target pane P concurrently; A's approve
  claims only A's op, B's never flushes A's payload, neither overwrites the other (D3; fail-pre-fix).
- **Idempotent retry** — same key retried mid-flight returns the prior op state, no double submit (D4).
- **Restart recovery** — kill sidecar with a pending op; on relaunch op is `indeterminate`/`expired`,
  never silently executed or silently vanished; durable grant does not fire an unretained payload (D5).
- **Read ownership** — ack of a non-recipient id rejected; display-name-collision recipient cannot
  reach another's mail; reattach keeps unread state on the stable identity (D7).
- **msg id uniqueness** — two ops in the same millisecond yield distinct ids (D4/msgbus).

Each must fail on the current code (reproduction), pass post-fix, be deterministic and isolated.
Verification per plan gate 7: independent pass/fail/not-tested per acceptance-matrix criterion, live
approved send reaching the addressed agent once.

Status: research complete; awaiting the shared identity-key/storage-format contract before writing
implementation.
