import {randomBytes} from 'crypto';

// Per-run internal-trust token. Hyperia's OWN HTTP calls to the sidecar (e.g.
// the sticky n8shell runner) send it as a Bearer token so they bypass the
// agent create-consent gate; the sidecar resolves it to the `System` identity.
//
// CRITICAL: this token must NEVER reach `process.env`. Every PTY the terminal
// spawns inherits the main process's env (app/session.ts → getDecoratedEnv), so
// putting it there would let any shell in any pane read it (`echo $TOKEN`) and
// bypass ALL permission enforcement. Instead we hold it in this leaf module and
// hand it to the sidecar ONLY via the sidecar child's spawn env.
export const SYSTEM_TOKEN = `hyp_sys_${randomBytes(24).toString('hex')}`;
