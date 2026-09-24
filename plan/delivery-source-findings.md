# Root review of initial delivery.rs

Implementation file is now present; root integrated service using exact agreed API. No builds/tests per user.

Required fixes for Aardvark in delivery.rs:
1. open() must expire ALL AwaitingApproval and Queued entries on restart, not only already timed-out entries. Ephemeral consent and prior process claims cannot authorize replay. Contract explicitly requires fresh submission.
2. associate must reject changing an existing different consent_id; immutable association after persistence. Also prevent a consent_id from being shared with a different requester or target. Same requester+same target group is intentional.
3. resolve must match exact requester; remove requester=="system" wildcard here. Main authenticates System decision but passes original req.requester.
4. complete(... Queued ...) must require outcome.state=="deferred" proving zero-byte rejection; arbitrary requeue risks duplicate writes.
5. FIFO tie ordering needs deterministic (created_ms,id) ordering.
6. Tests currently hard-code /workspace path; external user host may be Windows. Use CARGO_MANIFEST_DIR parent/target/test_fixtures/delivery so artifacts remain under project on every host.
7. Need save failure/reopen/fast+delayed approve/multiplecaller/multiplepending exactclaim tests written for external execution. Do not run them.
8. atomic snapshot replacement must replace an existing file on Windows without deletion gap. Verify std::fs::rename behavior or use existing tempfile persisted atomic replace; do not claim host coverage without external results.
9. If complete persistence fails after transport wrote, in-memory operation stays Submitting, correct no repeat. Document this condition for external status.

Root service files: delivery_service.rs, main.rs routes/decision/worker; review notes to Ermine follow. Root owns service/main.
