# Hyperia Mailbox & Principal Implementation Status

**Author / Module Owner**: Anti Gravity (`nemesis8/n8-amber-zebra`, hosted in Electrical Aardvark pane `ab4ef982-e0b8-4696-9a60-4321876e5300`)  
**Owned Modules**: [`sidecar/src/mailbox.rs`](file:///workspace/hyperia/sidecar/src/mailbox.rs) (implementation) & [`sidecar/src/msgbus.rs`](file:///workspace/hyperia/sidecar/src/msgbus.rs) (module export & backward-compatible wrapper)  
**Strict File Boundaries**: Zero edits to `main.rs`, `bridge.rs`, `perms.rs`, or `mcp.rs`.  
**Test Results**: **18 / 18 passed** (6 baseline tests + 12 unit, concurrent, legacy, failure, and regression tests).

---

## 1. Response to Coordinator Review Findings (`aardvark-review-findings.md`)

All 8 blocking issues identified during coordinator review have been resolved and verified with dedicated test regressions:

1. **Store Serialization & Concurrency Race Elimination**:
   - **Finding**: `send_message`, `inbox`/`search`, `acknowledge_message` lacked a shared store lock; concurrent same-key sends or acknowledgements raced, and `check_inbox` risked deadlock if calling public functions.
   - **Resolution**: Introduced a process-local `static STORE_LOCK: Mutex<()> = Mutex::new(());` in [`sidecar/src/mailbox.rs`](file:///workspace/hyperia/sidecar/src/mailbox.rs). Factored all core logic into private non-locking internal helpers: `send_message_locked`, `inbox_locked`, `search_locked`, `acknowledge_message_locked`.
   - **Deadlock-Free Check Inbox**: `check_inbox` acquires `STORE_LOCK` once, calls `inbox_locked` to fetch unread envelopes, and iterates calling `acknowledge_message_locked` for each returned envelope under the same critical section without deadlocking.
   - **Verification**: Added `test_concurrent_same_key_sends` (10 threads concurrently sending with identical idempotency keys; exactly one writes new record, 9 return matching ID) and `test_concurrent_acknowledgements` (10 threads concurrently acknowledging same message; exactly one receipt appended, all return valid receipt).

2. **Legacy Message Deserialization & Normalization**:
   - **Finding**: Legacy messages without canonical `toPrincipal`/`fromPrincipal` failed `serde_json::from_value` deserialization.
   - **Resolution**: Annotated all fields of `MessageEnvelope` and `ReadReceipt` with `#[serde(default)]`. Implemented `normalize_envelope` which infers canonical principals when missing (e.g. from `to_pane` if available, or prefixes legacy display labels with `legacy:`), while guaranteeing that legacy envelopes never gain unauthorized canonical authority.
   - **Verification**: Tested in `test_legacy_file_deserialization_and_receipt_isolation` against simulated pre-refactor JSONL files.

3. **Receipt Isolation & Canonical Precedence**:
   - **Finding**: `is_message_read` fell through to legacy reader label even when a message had a canonical `toPrincipal`, allowing label-collision receipts to mark canonical mail as read.
   - **Resolution**: In `is_message_read`, if an envelope has a canonical recipient (`!envelope.to_principal.is_empty()`), ONLY receipts matching `reader_principal == envelope.to_principal` (or authorized pane mailbox delegation) are considered. Legacy reader labels are strictly ignored for canonical mail. Only legacy envelopes (`from_principal.is_empty() && to_principal.starts_with("legacy:")`) may match legacy receipts by `reader_label`.
   - **Verification**: Verified in `test_legacy_file_deserialization_and_receipt_isolation` where a legacy receipt with matching display label fails to mark a canonical envelope as read.

4. **`BindingStore::new` Initialization Error Propagation**:
   - **Finding**: `BindingStore::new` silently swallowed malformed JSON or file read errors into an empty store.
   - **Resolution**: Updated signature to `pub fn new(path: PathBuf) -> Result<Self, MailboxError>`. Propagates `MailboxError::CorruptedStore` on invalid JSON and `MailboxError::Io` on read failures; only non-existent files (`ErrorKind::NotFound`) initialize cleanly to empty state.
   - **Verification**: Added `test_binding_store_new_fails_on_malformed_json`.

5. **Staged Memory Mutation on Persist**:
   - **Finding**: `bind_internal` and `unbind_*` mutated in-memory maps before disk save succeeded, leaving memory desynchronized if persistence failed.
   - **Resolution**: In `verify_and_bind`, `unbind_agent`, and `unbind_pane`, state modifications are performed on a staged clone of `records`, `forward_map`, and `reverse_map`. The staged records are written and synced to disk first; only after `save_records` succeeds are the live `Mutex` contents replaced.
   - **Verification**: Added `test_binding_store_staged_save_failure_leaves_memory_untouched` simulating read-only path/save failure and asserting that both forward and reverse in-memory mappings remain intact.

6. **`check_inbox` Returned Envelopes Have `read: true`**:
   - **Finding**: `check_inbox` returned envelopes with `read: false` despite acknowledging them.
   - **Resolution**: In `check_inbox`, each returned envelope explicitly sets `envelope.read = true` before being returned to the caller.
   - **Verification**: Added `test_check_inbox_atomicity_and_read_true`.

7. **Durable Sync & Bounded Metadata**:
   - **Finding**: `append_line` only flushed userspace buffers without syncing to disk, and subject/idempotency metadata were unbounded.
   - **Resolution**: `append_line` calls `file.sync_data()` after buffer flush, ensuring OS-level durability before reporting success. Added `validate_metadata`: limits `subject` to 512 characters, `idempotency_key` to 256 characters, and `body` to 1,000,000 characters. Rejects oversized inputs with `MailboxError::Validation`.
   - **Verification**: Added `test_metadata_bounds`.

8. **Retraction of 100% Backward Compatibility Claim & Pane Mailbox Delegation**:
   - **Finding**: Unverified 100% backward compatibility claim; canonical pane-owned messages accessible to its bound agent must be documented as pane mailbox delegation, not arbitrary label/pane OR matching.
   - **Resolution**: Formally retracted the unqualified 100% backward compatibility claim. Legacy display labels no longer grant access to canonical mail. Access by an agent to messages addressed to a pane (`pane:<uuid>`) is governed strictly through `caller_pane` delegation (active bound pane), never by loose string matching or label equality.

---

## 2. API & Type Specifications

### 2.1 Principals (`sidecar/src/mailbox.rs`)

```rust
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Principal {
    Agent(String), // "agent:<name>"
    Pane(String),  // "pane:<uuid>"
    System,        // "system"
}

impl Principal {
    pub fn parse(s: &str) -> Result<Self, MailboxError>;
    pub fn to_key(&self) -> String;
    pub fn kind_str(&self) -> &'static str;
}
```

### 2.2 Canonical Envelope & Read Receipt

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageEnvelope {
    pub id: String,
    pub ts: u64,
    #[serde(default, rename = "toPrincipal")]
    pub to_principal: String,
    #[serde(default, rename = "fromPrincipal")]
    pub from_principal: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(default, rename = "toPane")]
    pub to_pane: String,
    #[serde(default, rename = "fromPane")]
    pub from_pane: String,
    #[serde(default, rename = "to")]
    pub to_label: String,
    #[serde(default, rename = "from")]
    pub from_label: String,
    #[serde(default, rename = "fromKind")]
    pub from_kind: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
    #[serde(default, rename = "deliveryState")]
    pub delivery_state: String,
    #[serde(default)]
    pub read: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadReceipt {
    #[serde(default, rename = "msgId")]
    pub msg_id: String,
    #[serde(default, rename = "readerPrincipal")]
    pub reader_principal: String,
    #[serde(default, rename = "reader")]
    pub reader_label: String,
    #[serde(default)]
    pub ts: u64,
}
```

### 2.3 Binding Store (`sidecar/src/mailbox.rs`)

```rust
pub enum ProofOfResidency<'a> {
    System,
    PaneToken(&'a str),
}

pub struct BindingStore { /* ... */ }

impl BindingStore {
    /// Note: Returns Result<Self, MailboxError> to propagate corrupted store / I/O errors.
    pub fn new(path: PathBuf) -> Result<Self, MailboxError>;

    pub fn verify_and_bind<F>(
        &self,
        agent: &str,
        pane: &str,
        proof: ProofOfResidency,
        pane_token_validator: F,
    ) -> Result<BindingRecord, MailboxError>
    where
        F: FnOnce(&str, &str) -> bool;

    pub fn pane_for_agent(&self, agent: &str) -> Option<String>;
    pub fn agent_for_pane(&self, pane: &str) -> Option<String>;
    pub fn unbind_agent(&self, agent: &str) -> Result<bool, MailboxError>;
    pub fn unbind_pane(&self, pane: &str) -> Result<bool, MailboxError>;
    pub fn list(&self) -> Vec<BindingRecord>;
}
```

### 2.4 Mailbox Operations (`sidecar/src/mailbox.rs`)

```rust
pub struct SendParams<'a> {
    pub from: &'a Principal,
    pub to: &'a Principal,
    pub subject: &'a str,
    pub body: &'a str,
    pub to_pane_hint: Option<&'a str>,
    pub from_pane_hint: Option<&'a str>,
    pub to_label: Option<&'a str>,
    pub from_label: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
}

pub fn send_message(messages_path: &Path, params: SendParams) -> Result<String, MailboxError>;

pub fn inbox(
    messages_path: &Path,
    reads_path: &Path,
    caller: &Principal,
    caller_pane: Option<&str>,
    unread_only: bool,
    limit: usize,
) -> Result<Vec<MessageEnvelope>, MailboxError>;

pub fn search(
    messages_path: &Path,
    reads_path: &Path,
    caller: &Principal,
    caller_pane: Option<&str>,
    scope: SearchScope,
    q: Option<&str>,
    limit: usize,
) -> Result<Vec<MessageEnvelope>, MailboxError>;

pub fn acknowledge_message(
    reads_path: &Path,
    messages_path: &Path,
    msg_id: &str,
    caller: &Principal,
    caller_pane: Option<&str>,
) -> Result<ReadReceipt, MailboxError>;

pub fn check_inbox(
    messages_path: &Path,
    reads_path: &Path,
    caller: &Principal,
    caller_pane: Option<&str>,
    limit: usize,
) -> Result<Vec<MessageEnvelope>, MailboxError>;
```

---

## 3. Test Suite Execution & Verification

Test execution was run with `cargo test --no-default-features msgbus` in `/workspace/hyperia/sidecar`.

### 3.1 Test Output
```
running 18 tests
test msgbus::tests::search_substring_is_case_insensitive ... ok
test msgbus::tests::search_scopes_sent_received_all ... ok
test msgbus::tests::to_me_matches_by_pane_uid_even_without_label ... ok
test msgbus::mailbox::tests::test_unique_128bit_random_ids ... ok
test msgbus::mailbox::tests::test_binding_store_staged_save_failure_leaves_memory_untouched ... ok
test msgbus::tests::read_ids_only_counts_my_receipts ... ok
test msgbus::tests::unread_only_filters_out_read_messages ... ok
test msgbus::tests::inbox_returns_messages_to_me_newest_first_with_read_flag ... ok
test msgbus::mailbox::tests::test_binding_store_new_fails_on_malformed_json ... ok
test msgbus::mailbox::tests::test_pane_mailbox_delegation ... ok
test msgbus::mailbox::tests::test_metadata_bounds ... ok
test msgbus::mailbox::tests::test_concurrent_same_key_sends ... ok
test msgbus::mailbox::tests::test_canonical_principal_beats_label_or_pane_bypass ... ok
test msgbus::mailbox::tests::test_two_identities_sharing_display_label_stay_isolated ... ok
test msgbus::mailbox::tests::test_legacy_file_deserialization_and_receipt_isolation ... ok
test msgbus::mailbox::tests::test_concurrent_acknowledgements ... ok
test msgbus::mailbox::tests::test_recipient_only_acknowledgement ... ok
test msgbus::mailbox::tests::test_check_inbox_atomicity_and_read_true ... ok

test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 163 filtered out; finished in 0.37s
```

### 3.2 Evidence Summary per Test

| Test Name | Verifies Finding / Criterion | Result |
| :--- | :--- | :--- |
| `test_concurrent_same_key_sends` | Process-local store lock prevents race on concurrent same-key sends; exactly 1 record created, 9 return matching ID. | **PASS** |
| `test_concurrent_acknowledgements` | Process-local store lock prevents race on concurrent acks; exactly 1 receipt appended, no duplicate receipts. | **PASS** |
| `test_legacy_file_deserialization_and_receipt_isolation` | Legacy JSONL deserializes cleanly via serde defaults; legacy receipts cannot mark canonical messages as read. | **PASS** |
| `test_binding_store_new_fails_on_malformed_json` | `BindingStore::new` returns `Err(CorruptedStore)` on malformed file instead of silently resetting. | **PASS** |
| `test_binding_store_staged_save_failure_leaves_memory_untouched` | Staged clone ensures disk failure leaves both forward and reverse in-memory mappings untouched. | **PASS** |
| `test_check_inbox_atomicity_and_read_true` | `check_inbox` atomically fetches and acknowledges envelopes, setting `read: true` on returned envelopes. | **PASS** |
| `test_metadata_bounds` | Rejects subject > 512 chars, idempotency key > 256 chars, or body > 1MB with `Validation` error. | **PASS** |
| `test_pane_mailbox_delegation` | Pane-addressed messages are accessible to bound agent via authorized delegation, not arbitrary label matching. | **PASS** |
| `test_canonical_principal_beats_label_or_pane_bypass` | Display label or unauthorized pane cannot access canonical agent messages. | **PASS** |
| `test_two_identities_sharing_display_label_stay_isolated` | Distinct agent principals sharing identical human display labels remain strictly isolated. | **PASS** |
| `test_recipient_only_acknowledgement` | Only the canonical recipient can acknowledge; non-recipients receive `Forbidden`. | **PASS** |
| `test_unique_128bit_random_ids` | Generates 128-bit CSPRNG hex suffix; zero collisions across 1,000 iterations. | **PASS** |
| 6 baseline `msgbus::tests` | Baseline search scopes, case insensitivity, unread filtering, and legacy pane UID matching pass unchanged. | **PASS** |

*All test filesystem fixtures are created under `/workspace/hyperia/target/test_fixtures/` and fully contained.*

---

## 4. Integration Guidance for Coordinator

When coordinating full integration across `main.rs`, `bridge.rs`, and `perms.rs`:

1. **`BindingStore::new` Constructor Signature**:
   - `BindingStore::new(path)` now returns `Result<BindingStore, MailboxError>`. In `main.rs`, handle initialization with `?` or map to service exit if corrupted.
2. **Routing in `main.rs`**:
   - Wire `post_msg_send` to call `mailbox::send_message` with caller's verified `Principal`.
   - Wire `get_msg_inbox` to call `mailbox::inbox` with caller's verified `Principal` and bound host pane.
   - Wire `post_msg_read` to call `mailbox::acknowledge_message`.
   - Wire `POST /api/pane/bind-agent` to call `binding_store.verify_and_bind` validating the ephemeral pane token.
3. **Notification in `bridge.rs`**:
   - `bridge.rs`'s background mail monitor should check unread using `mailbox::inbox(..., unread_only = true)`, resolving canonical recipient keys so read receipts immediately reconcile.
4. **Agent Token Hardening Proposal**:
   - `get_identity_agents` (`/api/identity/agents`) currently returns all agent tokens in plaintext without authentication. Recommend restricting this endpoint to `CallerIdentity::System` before exposing multi-agent production deployments.

*Status: All review findings resolved. Ready for coordinator review and swarm consensus.*
