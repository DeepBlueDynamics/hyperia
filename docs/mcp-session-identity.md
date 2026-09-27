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

## Pane consent slots

nemesis8 containers mint a new random agent identity on every start
(`agent:nemesis8/n8-proud-kiwi` becomes `agent:nemesis8/n8-olive-crow`). If
grants were keyed on that name, every restart would turn each sender→recipient
pair into a new prompt. Instead, drive and message grants for an agent with a
**verified pane binding** are remembered under that pane: `pane:<uid>`.

- **Sender key.** When an agent's binding is verified and its pane is live,
  new drive grants (including `terminal_keys`) and message grants (`msg_send`,
  `pane_send`) are stored as `pane:<uid>`. Any agent later bound to the same
  pane holds them. Its own older `agent:` grants still apply. A child session
  (`mcp-session/…`) uses its parent's binding. A revoked child has no slot.
  Agents without a binding keep per-identity grants, as before.
- **Recipient key.** A message to `agent:X` whose verified binding is pane P is
  checked and approved as `message:pane:P`, so addressing X by name or by pane
  shares one grant. Grants stored under the old `message:agent:X` form still
  count.
- **Prompt.** The consent prompt names both, e.g. "n8-olive-crow (in pane Eldest
  Dog)". Approving it remembers the grant for that pane, not for that name.
- **Lifetime.** Closing the pane removes its slot and every grant keyed on it.
  Denials use the same key, so a "no" also holds when the container restarts.

Security: the slot comes only from the binding store (`agent-bindings.json`),
which records a binding only after proof of residency: the pane's own token,
or the human approving a `bind:` prompt. A pane id sent by the caller, such as
the requester pane on a request, never selects a slot. It is re-derived from the
store on every authorization, so an identity whose binding was replaced loses
the slot at once. A container that restarts in the same pane occupies the same
human-approved slot. That is the intended trust boundary: anything running in
that pane could already present the pane's token. Capability and create grants
stay per identity and never use the slot.

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
