# MCP session identity

Streamable HTTP clients that initialize with a persistent agent token receive a
durable `Mcp-Session-Id`. Keep sending that ID and the original bearer credential
on subsequent requests. Each initialization creates a separate child identity,
even when several clients share the same parent token or client metadata.

Call `whoami` to see the immutable principal, display label, canonical mailbox
address, parent, session ID, pane association, and credential kind. Call
`set_label` to choose a unique label. Labels survive restarts; renaming does not
move mail, change receipts, or transfer permission grants. Bare parent labels
address the parent's separate mailbox. Child sessions neither consume nor
receive copies of parent or sibling mail.

A child has its own grants plus its parent's current grants. Child grants and
pending consent requests remain attributed to that child and do not transfer
to its parent or siblings. A parent's one-use creation grant is consumed once,
even if several children attempt to use it.

Known session IDs resume after a sidecar restart when presented with their
original owner's credential. Unknown, revoked, and foreign IDs fail closed.
DELETE /mcp with the ID and owner credential revokes the session. A deleted
identity cannot be revived by reconnecting. Clients that do not initialize
continue using their original identity and are marked `legacy` by whoami.

## Pane tokens

A pane token still identifies a pane; it never becomes an agent identity.
whoami reports `credential_kind: "pane token"` versus `"agent token"` so a
configuration mix-up is visible. Persistent container clients should use their
own registered agent credential, not the launching pane's token. The existing
HYPERIA_AGENT_TOKEN/HYPERIA_PANE_TOKEN environment contract is unchanged.

A pane token can claim one logical MCP session at a time. Another initializer
is refused with HTTP 409 while the first session has been used within the past
60 seconds or still has an in-flight request. Hyperia audits the conflict and
shows: “pane token for <pane> used by two live sessions — possible token crossing”.

After 60 quiet seconds, a new initialization takes over, revokes the old
session, and emits an audit entry and “pane <pane> re-bound to a new session”.
DELETE releases the claim immediately. Agent-token clients are not subject to
this exclusive pane claim.

## Storage and transport

Session metadata lives beside agents.json in mcp-sessions.json. Writes are
staged atomically; corrupt or unavailable storage fails closed. Unix metadata
files are created with mode 0600. Internal forwarding credentials are generated
in memory, rotated at restart, and never persisted or returned in identity or
initialize responses. Internal credentials are accepted only from a verified
loopback peer and cannot initialize descendant sessions.

The rmcp 0.15 transport remains stateless. Hyperia owns logical session identity
outside that transport; a disposable HTTP/SSE connection does not own or delete
the durable principal. Revocation cancels pending HTTP work and response
streams. Queued child operations check session validity before delivery.

## Validation

The focused suite is `cargo test mcp_sessions::tests`. It exercises real HTTP
MCP initialization, multiple clients, restart/resume, label and mailbox
isolation, grants, pane conflicts and takeovers, audit/notification delivery,
revocation, credential confinement, and corrupt storage. No test changes the
process's HOME or shared configuration.

The release gate also requires a real Claude Code restart/reconnect and an
Electron notice check on the host. Automated tests do not substitute for those
client and UI checks.
