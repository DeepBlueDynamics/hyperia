# KeyStore — hardware secure-enclave backing for identity tokens

> Status: **design / backlog. DECISION-FIRST.** Captured 2026-06-12. Pick the fork in
> §3 (K0) before any code — Design 1 and Design 2 share only the `KeyStore` abstraction.

## What a secure enclave actually does

It does **not** store a retrievable secret. It holds a **non-extractable private key** and
performs crypto ops (sign / ECDH) on request. That single fact forks the whole design: you
either (1) use it to *encrypt a token store at rest*, or (2) use it to *replace bearer tokens
with signatures*. They solve different problems.

## How tokens work today (the starting point)

- Tokens are **bearer secrets** — plaintext strings (`hyp_agent_…`, `hyp_pane_…`,
  `hyp_sys_…`) from `util::random_token` (OS CSPRNG ⊕ sdrrand true-random relay).
- **Agent tokens** — stored **plaintext** in `~/.hyperia/agents.json`
  (`sidecar/src/identity.rs` `IdentityStore::persist`, `std::fs::write`).
- **Pane tokens** — in-memory in `sidecar/src/perms.rs`, **and injected into the PTY env** as
  `HYPERIA_AGENT_TOKEN` (`app/session.ts`) → readable by any process in the pane.
- **System token** — Electron-minted (`app/system-token.ts`), passed to the sidecar child env.
- **Auth check is string equality**: `a.token == token` (`identity.rs` `resolve`); bearer sent
  in the `Authorization` header, forwarded across the MCP proxy hop (`mcp.rs forwarded_auth`)
  and resolved in the HTTP middleware (`main.rs identity_mw`).

So the secret exists at rest (json), in process memory, in the pane env, and on every wire
hop. That exposure is the thing this work targets.

## The fork (K0 — decide first)

| | **Design 1 — Enclave-wrapped store** | **Design 2 — Enclave-backed key auth** |
|---|---|---|
| Idea | Seal an encryption key in the enclave; encrypt `agents.json` + pane map at rest | Each identity = a keypair generated IN the enclave; auth = sign a server nonce |
| Tokens stay bearer? | Yes | No — replaced by challenge/response signatures |
| Solves | At-rest theft of the token file | **The entire bearer-leak class** (pane env, MCP hop, headers) |
| Does NOT solve | Runtime exposure in memory / env / wire | Linux has no real enclave (software fallback) |
| Wire protocol change | None | Yes — challenge endpoint + signed header |
| Effort | ~days | ~weeks (protocol + per-OS FFI + panes) |

**Recommendation:** if the goal is "stop tokens leaking" (the actual recurring pain) →
**Design 2, scoped to persistent agent identities only** at first; keep pane tokens as
short-TTL bearers (they already die with the pane). That captures ~80% of the value without
the signing-agent socket. If the goal is merely "no plaintext secret on disk" → **Design 1**
with the `keyring` crate, days not weeks.

## Cross-platform reality (Hyperia ships Win/mac/Linux)

There is no single "secure enclave." Need a `KeyStore`/`SecretBackend` abstraction with per-OS
impls + **graceful software fallback** (mirrors the sdrrand "hardware if available, CSPRNG
otherwise" pattern in `util.rs`).

| OS | Real enclave? | API |
|---|---|---|
| **macOS** | ✅ Secure Enclave (Apple Silicon/T2) | Keychain `SecKeyCreateRandomKey` + `kSecAttrTokenIDSecureEnclave` (P-256, non-extractable; optional Touch ID via `LAContext`); `security-framework` FFI |
| **Windows** | ⚠️ no enclave; equivalents | TPM 2.0 via CNG Platform Crypto Provider; Windows Hello (`KeyCredentialManager`); DPAPI for at-rest; `windows` crate |
| **Linux** | ❌ none | TPM 2.0 (tpm2-tss / PKCS#11) if present, else Secret Service / kernel keyring (software) |

The `keyring` crate covers **Design 1** (store/fetch a secret across Keychain / Credential
Manager / Secret Service) but does **not** give non-extractable enclave keys — **Design 2**
needs per-OS FFI.

## Ticket breakdown

- **EPIC** — KeyStore secure-enclave backing (this doc).
- **K0 DECISION** — Design 1 (wrapped store) vs Design 2 (key auth). Blocks everything below.
- **K1** — `KeyStore` abstraction: a trait + backend selection + **software fallback**
  (sdrrand pattern). Shared by both designs. Foundation.
- **K2** — macOS Secure Enclave backend (SecKey / Keychain FFI).
- **K3** — Windows backend (TPM 2.0 CNG / Windows Hello / DPAPI).
- **K4** — Linux backend (TPM 2.0 / Secret Service / software fallback).
- **K5** *(Design 1 only)* — at-rest sealing: encrypt `agents.json` + pane-token store via
  `KeyStore.seal/unseal`; migrate a detected plaintext file on first run.
- **K6** *(Design 2 only)* — signature auth protocol: store **public keys** not tokens;
  `resolve` → signature verify; add `GET /auth/challenge` nonce; rework `identity_mw`
  (`main.rs`) and **every MCP tool's `forwarded_auth`** (`mcp.rs`) to sign instead of forward
  a bearer.
- **K7** *(Design 2 only)* — panes: the hard part. A shell can't reach the enclave "as the
  pane." Decide: (a) keep pane tokens as short-TTL bearers (don't enclave-back them) — simplest,
  ~80% value; or (b) a local **signing-agent socket** (ssh-agent-style) the pane talks to,
  removing the secret from the env entirely.
- **K8** *(Design 2 only)* — UX: Touch ID / Windows Hello gating + a cached unlocked-enclave
  session with a TTL (per-sign prompts are intrusive for an automated agent).
- **K9** — migration + **document the uneven cross-platform guarantee** (Linux = software
  fallback; an enclave never protects a secret intentionally placed in the pane env).

Order: **K0 → K1 → K2/K3/K4** (foundation), then the chosen branch (Design 1: K5 · Design 2:
K6→K7→K8), then K9.

## Caveats to state up front
- Linux has no true enclave → uneven security guarantee across platforms; decide if acceptable.
- An enclave does not protect a secret that is *intentionally* injected into the pane env;
  only Design 2-with-signing-agent (K7b) removes that exposure.
- Hardware-gate (Touch ID/Hello) UX must not block an automated agent on every call.
