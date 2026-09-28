# Debugging the UI yourself (agents)

Use this to check a renderer or layout fix in a real Hyperia window without asking the human to click and take screenshots. You run a dev copy with Chrome DevTools Protocol (CDP) enabled, measure the DOM, and take screenshots. `scripts/cdp.js` does the CDP side.

Example: the quick-layout preview fix (PR #273). Measuring showed the grid columns at 110px around a 48px preview. After the fix they were 57px. Before and after screenshots proved it, and nobody had to eyeball anything.

## Ground rules (read first)

- **Only while the installed Hyperia is closed.** The dev copy and the installed app share the sidecar port (9800), and startup kills every `hyperia-sidecar.exe` by name, so running both breaks the human's session. Ask the human to close it. Never close it yourself.
- **Check before launching:** `tasklist` shows no `Hyperia.exe` or `hyperia-sidecar.exe`, and nothing is LISTENING on `:9800` (`TIME_WAIT` is fine).
- **The dev copy uses the human's real state** in `~/.hyperia`: workspace, stickies, identities. Look, don't change anything. Don't close their tabs or edit their notes.
- **Never kill processes by image name.** `electron.exe` and `node.exe` are shared with other apps. Match on a command line that contains `DeepBlueDynamics\hyperia`.
- **Don't run `cargo`** while any Hyperia dev instance is up. It fights over the sidecar binary.
- **Bind 127.0.0.1 only.** CDP here is loopback-only, so there are no firewall prompts.
- **Clean up** when you're done (see "Shut down") so the human can reopen their app.

## Launch

From the repo root, on the branch you're testing:

```bash
npx tsc --build        # main process -> target/
npx webpack            # renderer -> target/renderer/bundle.js
yarn app --remote-debugging-port=9333      # run in the background
```

- Use `yarn app`, not `yarn start`. electronmon passes extra arguments on to Electron, while `yarn start` hands them to `concurrently`, which drops them. `ELECTRON_EXTRA_LAUNCH_ARGS` doesn't work on Electron 41.
- Launch it as a background task and don't pipe its stdout through `head` or `tail`. A closed pipe makes the main process hit EPIPE.
- If you redirect the output to a log file, make sure the directory exists first. Otherwise the launch fails straight away.
- Wait for CDP: poll `curl -s http://127.0.0.1:9333/json` until it answers (about 5 s), then give the renderer a few more seconds to mount.

## Drive it with `scripts/cdp.js`

```bash
node scripts/cdp.js targets                  # list pages (main window + one per sticky)
node scripts/cdp.js eval "document.title"    # run JS in the main window, JSON result
node scripts/cdp.js shot out.png 250 58 390 125   # screenshot a region (CSS px, rendered 2x)
node scripts/cdp.js reload                   # after re-running webpack (like Ctrl+R)
node scripts/cdp.js quit                     # clean app.quit()
```

The script targets the main window (`target/index.html`) and skips the many sticky windows. Set `CDP_PORT` to use a port other than 9333. Wrap calls in `timeout 20` so a hung page can't stall you.

Open the PNG with your image-reading tool to look at it.

## Techniques

**Measure instead of guessing.** `getBoundingClientRect()` and `getComputedStyle()` settle most layout questions:

```bash
node scripts/cdp.js eval "(() => {
  const g = document.querySelector('.pane-band-layout-grid');
  const r = (el) => { const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round); };
  return {cols: getComputedStyle(g).gridTemplateColumns, items: [...g.children].map((i) => ({item: r(i), preview: r(i.firstElementChild)}))};
})()"
```

**Show hover-only UI.** Tooltips and hover menus are hidden until hovered, and CDP mouse events are unreliable for them. Force the element visible with a tagged style instead:

```js
tip.setAttribute('data-dbg', '1');
const st = document.createElement('style'); st.id = 'dbg';
st.textContent = '[data-dbg]{display:block!important;visibility:visible!important;opacity:1!important;z-index:99999!important}';
document.head.appendChild(st);
// ...measure / screenshot...  then: document.getElementById('dbg').remove()
```

**Before and after from a single build.** Build the fixed code. To show the old behavior, set the old CSS back inline on the element (`el.style.gridTemplateColumns = 'repeat(3, 1fr)'`), take a screenshot, then clear it (`el.style.cssText = ''`) and take another. That gives you two screenshots to compare without a second build.

**Iterate on renderer code.** Edit, run `npx webpack`, then `node scripts/cdp.js reload`. Changes under `app/` (main process) need a full quit and relaunch.

**Resize the window.** CDP `Browser.setWindowBounds` isn't available in Electron, so resize from the renderer:
`require('@electron/remote').getCurrentWindow().setSize(900, 600)`.

**Create panes or splits.** Use the renderer's `window.rpc`. CDP key events skip Electron's menu accelerators, so keyboard shortcuts won't fire.

## Shut down

```bash
node scripts/cdp.js quit      # saves state cleanly
```

`quit` leaves the electronmon and cross-env node processes behind. Kill them by command line and confirm nothing is left (PowerShell):

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*DeepBlueDynamics\hyperia*' -and $_.CommandLine -match 'electronmon|cross-env' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*DeepBlueDynamics\hyperia*' -and $_.Name -in 'node.exe','electron.exe' } | Measure-Object).Count   # expect 0
```

Confirm `hyperia-sidecar.exe` is gone too, then tell the human they can reopen Hyperia. Delete your screenshots or keep them in a scratch directory, not the repo.

## Reporting

In the PR or your reply, give the measured numbers (before and after) and attach or describe the screenshots. Say plainly what you checked and what you didn't. For example, you might have checked the pane band but not the new-tab menu, or Windows but not macOS.

## Automated lifecycle harness

`node scripts/dev-harness.js` builds, then launches **sandboxed** dev copies (temp home and AppData, sidecar on :9801, CDP on :9333) and runs scripted scenarios: picker/shell swaps, last-tab close, stray-tab sweep, web views across a renderer reload, autosave and its pulse, autosave under title churn, the saved-tabs badge, and main surviving an externally destroyed web view. Scenarios that can close the window or crash main get their own launch. It refuses to start while Hyperia or a sidecar is running. `--no-build` reuses `target/`; `--only s1,s4` picks scenarios. Each group's logs stay in its sandbox folder, which is printed at the end.
