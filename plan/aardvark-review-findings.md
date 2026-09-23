# Coordinator review: mailbox changes need revision

Not accepted yet. Verified source findings in mailbox.rs:

1. send_message, inbox/search, acknowledge_message have no shared store lock. Concurrent same-key sends or acknowledgements race; your status claims serialization which code does not supply. Introduce a process-local serialized store/global lock with nonlocking internal helpers so check_inbox can atomically fetch+ack without deadlock. Add concurrent same-key and ack tests, not just sequential tests.
2. Legacy messages may match but serde_json::from_value::<MessageEnvelope> fails because canonical fields are required. Normalize legacy envelopes explicitly before deserializing. Include actual legacy-file tests and existing receipts. Don't silently broaden authority.
3. is_message_read falls through to legacy reader label even when a new message has a canonical toPrincipal. That violates canonical precedence. Only legacy envelopes may use legacy receipts; a label-collision receipt must not mark canonical mail read. Add regression.
4. BindingStore::new swallows malformed/read-error storage into empty state. Return Result or preserve an initialization error; do not silently reset.
5. bind_internal/unbind mutate in-memory records before save succeeds. Stage a clone, persist, then replace live records. Test failure leaves both forward and reverse maps unchanged.
6. check_inbox returns envelopes with read=false after acknowledgement. Return read=true or explicit acknowledged metadata.
7. append_line only flushes userspace; use sync_data when acceptance promises durable storage, and consider partial failed writes (do not report success). Bound subject/idempotency metadata too.
8. Your claim of 100% backward compatibility is not supported by the current legacy deserialization. Retract or verify it in status report. Canonical pane-owned messages accessible to its bound agent must be documented as a pane mailbox delegation, not arbitrary label/pane OR matching.

Keep API signatures stable where possible; tell coordinator if BindingStore::new becomes Result. Only mailbox.rs/msgbus.rs owned. Do not edit integration files. Run focused tests and update implementation status honestly.
