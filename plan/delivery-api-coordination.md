# Delivery implementation handoff

Electrical Aardvark now owns delivery.rs implementation. Front Ermine is independent delivery correctness reviewer. Root integrates. No container builds/tests.

Publish this concrete minimal API first, then implement it in small edits. Do not spend a whole turn redesigning names.
- `DeliveryStore::open(path: PathBuf) -> Result<Self, Error>` async, mutex-serialized snapshot, atomic persistence; recover submitting to indeterminate and awaiting/queued to expired.
- `NewOperation { requester: String, target: String, kind: String, payload: serde_json::Value, submit: bool, idempotency_key: Option<String>, expires_ms: u64 }`.
- `Operation { id, requester, target, kind, payload, submit, idempotency_key, expires_ms, created_ms, state: State, consent_id: Option<String>, outcome: Option<serde_json::Value> }`.
- States AwaitingApproval, Queued, Submitting, Submitted, Failed, Denied, Expired, Cancelled, Indeterminate. serde snake_case.
- `create(new, approved: bool) -> Result<Operation, Error>`: durable first; requester/key exact request replay or conflict. Initial awaiting or queued.
- `get(id,requester)->Result<Operation,Error>`: caller-owned only.
- `associate(id,requester,consent_id)->Result<Operation,Error>`: exact pending operation, no prompts emitted by store.
- `resolve(consent_id,requester,allow)->Result<Vec<Operation>,Error>`: only matching awaiting ops; duplicate safe, no crosscaller changes.
- `queued()->Result<Vec<Operation>,Error>`: internal executor listing, expires stale.
- `claim(id)->Result<Option<Operation>,Error>`: queued->submitting atomic; exactly one winner.
- `complete(id,state:State,outcome:Value)->Result<Operation,Error>`: submitting->terminal outcome OR queued only when transport explicitly confirms no bytes were written (deferred).
- `cancel(id,requester)->Result<Operation,Error>`: not while submitting, caller-only.

Inject file path, use getrandom for local IDs, return IO failures without changing live memory. tempfile/persist cross-platform primitive if already available; do not delete destination before rename. No blind replay after uncertainty. Max body serialized payload ~128KB (mail JSON expansion), pending count cap 1000. Expiry max1h, default integration15m.

First implementation can use this exact simple API. Root alone prompts, dispatches transport and enforces authenticated ACL/classifier. Ermine reviews specific race, durability, and ownership behavior; no edits to delivery.rs. Tests can be written but NOT executed. All fixture dirs under /workspace when executed later.
