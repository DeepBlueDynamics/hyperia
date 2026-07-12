import type {HyperState} from '../../typings/hyper';
import rpc from '../rpc';

// Mirror web-pane URLs to the main process (#84): push a {termGroupUid → url}
// snapshot over RPC whenever it changes, so layout save (#82) can read URLs
// from the bridge without a renderer roundtrip at close time. A snapshot
// (rather than per-action deltas) is idempotent and uniformly covers open /
// convert / split / new-tab / in-page navigation / clear / group exit —
// including reducer-generated uids an action can't name.
//
// Wired via store.subscribe in lib/index.tsx — NOT as a redux middleware:
// anything imported from the store graph joins the hyper.d.ts → configure-store
// type cycle and collapses HyperDispatch (breaking every thunk dispatch).
// The JSON dedupe below makes the per-dispatch cost a cheap no-op.

let lastSnapshot = '';

// rpc.emit() THROWS 'Not ready' until the ipc channel id is assigned (async, on
// the 'init' event). This runs from a store.subscribe listener that fires on the
// very first boot dispatch — a throw here escapes into the dispatch chain and
// aborts renderer init (black screen after splash, no picker). So: (1) never emit
// before rpc is ready, and (2) swallow any error so a store listener can NEVER
// crash the app. Web URLs only appear after a web pane is opened — long after
// 'ready' — so gating on readiness loses no real update.
let rpcReady = false;
rpc.once('ready', () => {
  rpcReady = true;
});

export function syncWebUrls(state: HyperState): void {
  if (!rpcReady) return;
  try {
    const groups = state.termGroups.termGroups;
    const urls: Record<string, string> = {};
    for (const uid of Object.keys(groups)) {
      const url = (groups[uid] as any).webUrl;
      if (url) urls[uid] = url;
    }
    // Only cross the IPC boundary when the snapshot actually changed.
    const json = JSON.stringify(urls);
    if (json !== lastSnapshot) {
      lastSnapshot = json;
      rpc.emit('session web url', {urls});
    }
  } catch {
    /* never let a store-subscribe side effect crash the renderer */
  }
}
