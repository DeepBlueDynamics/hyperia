# Sticky refactor — canary

Status: PR #206 remains draft. Local 0.19.3 (build ca331d30, source ae62243b) was delivered; Kord reported blank note windows appearing on cold launch. The 2026-09-18 startup-presentation correction below has a failing installed-package regression and a passing corrected-target run. A fresh 0.19.4 local installer is the next artifact; 0.19.3 is already used. No merge or public release is authorized.

Tracking: GitHub #204 (sticky refactor), #205 (MCP failures). Then Fox filed both. Next safe version is 0.19.3; 0.19.2 is already used by a local jev installer.

## Scope and ownership

Recurring symptom: hidden notes reappear at startup. Then Fox reports PR #203 shipped a show-event guard in 0.19.1; field confirmation remains pending. Target: canary (verified clean at start). Jev remains parked.

Remote developer owns session/workspace restore. Do not edit app/workspace.ts, session/workspace restore functions, or their tests. Preserve ./sticky exports and caller contracts. Then Fox owns issues, versions, check-ins, PRs, builds and releases, coding only deployment. Per his standing release-cut instruction, version files remain unchanged until code is complete and judge-approved; reserve 0.19.3 for that gate. No production build/release is requested yet; 0.19.2 has already been built from jev, so 0.19.3 is reserved for the release cut. Then Fox confirmed ordinary PR CI builds are validation artifacts under the existing code-only PR workflow; that CI may run without a pre-bump. Release publishing and manual installer builds remain separate gates.

- Antigravity: app/sticky.ts and app/sticky/**; test/unit/sticky-main*.test.ts and test/helpers/sticky-main-fixture.ts.
- Grok: app/sticky.html and app/sticky-renderer/**; test/unit/sticky-renderer*.test.ts; webpack.config.ts only to copy new static assets.
- Planner: plan, integration, verification and app/tsconfig.json asset exclusion; no overlapping implementation edits.
- Productive Cod: independent review, read-only.
- Then Fox: DevOps and GitHub gateway.

## Baseline

- app/sticky.ts: 1655 lines including trailing newline; persistence, naming, colors, file binding, windows, IPC/menus, scheduler, summary.
- app/sticky.html: 2175 lines; markup, styles and renderer logic.
- Main updateNote calls show/focus. Hide-all persists a global flag, but the guard applies only to started-hidden windows. ready-to-show closes over initial startHidden. These are source observations; runtime regressions must be demonstrated with tests.
- Main, renderer and sidecar share notes.json; maintain ALL unknown fields and existing file formats. No schema migration. Do not claim a single writer.

## Implementation sequence

1. Extract main into cohesive modules (types, names, preferences/theme, store, visibility/windows, files, menu/IPC, scheduler, summary). Preserve ./sticky as a facade with all current exports and shapes. Use explicit dependencies and avoid cycles.
2. Extract renderer into static CommonJS modules loaded through a small bootstrap in sticky.html, plus cohesive CSS files. No new webpack entry/bundler. CopyWebpackPlugin owns the new directory's JS and CSS; app/tsconfig.json excludes sticky-renderer from tsc emit to avoid overwriting copied modules. Preserve TypeScript's default dependency/output exclusions. Existing vendored-JS emission is pre-existing and remains outside this change. Prefer explicit imports/module interfaces to ordered scripts with hidden shared globals. Preserve UI behavior, persistence and IPC channel names.
3a. Antigravity adds lifecycle tests using existing proxyquire-style Electron stubs (see test/unit/workspace-boot.test.ts; read only, do not edit that file). Run against extracted-but-unchanged code; report which regressions fail and which existing invariants already pass. Judge reviews the baseline evidence before behavior changes. Do not force already-correct behavior to fail.
3b. After that review, Antigravity centralizes desired visibility in a controller: readiness uses current intent; hide-before-ready, hide-after-ready, duplicate hidden restore, background update and scheduler cannot reveal or focus hidden notes. Explicit open/show-all releases hide. Show-all then hide again remains hidden. Keep a show-event guard to catch stray shows.
4. Antigravity owns close/archive, hide and delete distinctness. No resurrection after delete. Explicit search replacement closes must set open:false before reopening the selected notes. Preserve active/open persistence across app quit. Leave the remote restore entrypoints unchanged.
5. Preserve schema and existing writers during this refactor. Consolidating all writers is a separate change that needs its own cross-process contract. No consent-gate or sidecar route changes in this scope.

Scheduled notifications respect an explicit hidden state: send the OS notification and run the scheduled job, but keep a hidden sticky hidden. Clicking the notification is an explicit user open. Visible notes may refresh without focus. This policy is a reviewed behavior change, not part of structural extraction.

Sidecar PATCH/DELETE use non-atomic writes today; that is pre-existing debt outside this scope. No concurrency/atomicity claims for the shared writers.

Explicit sticky_note_create/sticky_note_open requests may reveal their requested note even while Hide-All is set; they must not reveal other notes or clear the global hidden preference. Agent-originated presentations use showInactive and never focus. Automatic updates, timers and startup restoration are background operations and cannot release a hide. Add create-while-hidden and open-one-while-hidden tests.

Passive agent/background updates must not focus or reopen notes. Explicit user requests can focus; passive presentations use showInactive. Show policy changes are reviewed separately from structural extraction.

## Visibility controller contract (phase 3b)

One controller owns each live note's readiness, desired visibility and pending focus intent. Register with desiredVisible = !startHidden. Native ready-to-show reads current desired state; it never closes over original options. hide(id) records hidden intent even before the native window is visible. show(id, focus=false) records intent and presents once ready. hide/show-all iterate note entries excluding SEARCH_WIN_ID and update the existing global preference. A native show event immediately hides a window whose desired state is hidden; do not require the startup marker to enforce a later hide. Unregister on close.

Duplicate startHidden opens leave the existing window's current intent alone. An explicit normal open may reveal that note only. All automatic updates only refresh content; they do not call show/focus or reopen a closed note. Scheduler fires notify/execute without changing visibility; notification click goes through explicit open. A missing/deleted persistent note ID returns no window instead of recreating the record. Keep file/code and search creation working. User-originated IPC opens may request focus; exported tool opens default to showInactive.

The controller is the sole native show/hide/focus adapter. Preserve macOS floating/workspace flags and geometry/opacity behavior. Tests exercise both its event sequences and the facade/initSticky wiring.

## Size limits

Target <=400 lines per handwritten module. Anything >500 needs a meaningful additional split or a written cohesion reason reviewed by the judge. Entry/facade files stay small. Do not compress formatting or create meaningless tiny fragments to meet the limit. Existing oversized files touched only to wire assets should get a targeted extraction if the change materially grows them.

## Baseline checks

Before implementation, yarn test:unit exited 1: workspace-capture restoreWorkspace reopens existing stickys and skips deleted ones throws readStickyHidden is not a function (app/workspace.ts:285, test/unit/workspace-capture.test.ts:133). The test stub lacks that export. This is pre-existing and in the remote restore owner's scope; do not fix it in this work. All other listed tests passed in that run.

Main baseline checkpoint: after correcting fake-window hide/blur behavior, the planner independently ran the 17-test sticky suite: 12 passed, 5 failed. Failures reproduce background-update reveal, scheduler reveal, hide-before-ready, missing-ID creation, and stale notification click resurrecting a deleted note. Startup restore now drives readiness and stray-show events; those existing invariants pass. Judge approved this finite baseline gate before controller implementation.

Post-controller checkpoint: the planner ran `TMPDIR=/workspace/.hyperia-test-temp yarn -s ava test/unit/sticky-main-lifecycle.test.ts test/unit/sticky-main-visibility.test.ts`: 27 tests passed, exit 0. The five original failing behaviors now pass; added cases cover search exclusion/reopen, creator preservation, passive tool opens, closed scheduler notes and explicit search replacement archiving.

## Existing CI blockers for owner review

Full host lint found one pre-existing error in unchanged app/ui/window.ts:431: local `shell` shadows the Electron import. Proposed bounded correction: rename that local and its comparison use to `paneShell`.

The remote-owned workspace-capture test needs two coordinated expectation updates: add `readStickyHidden: () => false` to its `./sticky` mock and include `startHidden: false` in the expected reopened-note options. The restore function already passes this option. These changes are proposed only; ownership exception requested from the user via a review sticky. Do not edit those files until authorized.

## Acceptance

Behavioral tests must drive window events and public functions; a pure boolean predicate test alone cannot prove the regression fixed. Cases: hide-before-ready; hide-after-ready plus update; started-hidden duplicate open; explicit show before readiness; show-all then hide again; scheduler while hidden; fresh controller reads persisted hidden; close sets open:false while hide preserves it; delete cannot reappear; background operations do not focus. Preserve unknown fields on notes.json updates and creator identity when creating a note. Caller focus intent is an explicit option (default false), never inferred from creator metadata.

Renderer verification covers bootstrap dependency loading, packaged asset paths, editor/search/file/code/schedule modes and existing IPC contracts. Run relevant unit tests, lint and both `npx tsc --noEmit -p app/tsconfig.json` and `npx tsc --noEmit -p tsconfig.json` with actual results. The root project includes tests; AVA's transpile-only execution and the app-only type check do not catch their strict TypeScript errors. The first local installer attempt exposed this coverage gap. A successful full build remains the packaging gate. Then Fox performs a host smoke/build when authorized against the exact revision/version. Never kill/restart the installed app for diagnostics.

Field smoke checklist: hide stickies then restart, explicit open, show/hide all, edit/update while hidden, scheduled reminder, close/archive, search/reopen, linked file and code note. Field result is not claimed until observed.

## Cold-start field failure and presenter correction — 2026-09-18

- Host inspection found Hide All persisted as true, 180 stored notes, 18 active notes (17 with text), and 20 last-session sticky references. Only aggregate metadata was reported; note contents were not printed. The user can open/search notes normally after startup.
- Git history identifies a14c8312 (#171, 2026-08-28): boot startup collected BrowserWindow.getAllWindows(), then called show() after did-finish-load and again in a two-second fallback. This included hidden sticky windows as well as terminal windows.
- Previous tests asserted that notes ended hidden. A native show followed by the sticky guard's hide still satisfied that check, so transient exposure was missed.
- New real-Electron full-startup regression loads the installed app.asar with 20 synthetic notes and a last-session fixture. On unmodified 0.19.3: 20 notes loaded content, 40 native sticky show events, 20 before ready-to-show, zero visible notes at the end. The new zero-show assertion fails. This demonstrates exposure before the first paint notification; it supports the blank-surface explanation without claiming to have observed Kord's desktop during his launch.
- Corrected compiled target: 20 notes loaded, zero native sticky show events, zero before ready-to-show, zero load errors; regression passes. Single-factory cold renderer checks also passed against source and installed assets without the earlier renderer-injection preload.
- Fix: select the app's terminal windowSet for startup presentation, and extract the existing presenter into app/ui/startup-windows.ts. app/workspace.ts and its restore functions/tests are unmodified. The existing large app/index.ts shrinks; this bounded extraction avoids pulling remote-owned restore logic into the change.
- Test isolation: distinct home, appData/userData/sessionData; external-sidecar mode with an unused port; no sidecar spawn/kill; browser HTTP denied; CLI/plugin installers disabled; nonfocusable transparent test windows. The first full-startup harness missed app/index.ts's userData override; subsequent runs explicitly isolate appData and assert the resulting profile path. A later harness initialization-order error caused the reported JavaScript dialog; it was a test error, not sticky evidence, and the test exited. Module interception now preserves production initialization order and catches entry-load errors.
- Passing automated checks do not substitute for Kord's next cold-start field check. Remaining persistent blank behavior, if any, must be investigated rather than declared covered by this transient-show regression.

## Security follow-up for PR #206

CodeQL alert #21 reports js/disabling-electron-websecurity at the extracted window.ts:145; alert #16 is the same pre-existing setting in the original monolith. Relocation does not establish safety. The user raised this finding and the prior security acceptance has been reopened.

The planner also reproduced attribute injection using applyRules: an agent-provided className or color containing a quote adds an unintended HTML attribute. Content escaping does not protect attributes. Sidecar post_notes_highlight validates only that rules is an array; its prompt is not validation. This is verified source and a benign string-output reproduction, not an exploit run against the installed app.

Follow-up ownership and contract:

- Antigravity: explicit webSecurity:true and allowRunningInsecureContent:false; deny renderer navigation, redirects, popups and webviews. Preserve trusted main loadFile. Add sticky-highlight IPC with a fixed localhost endpoint, registered sticky sender and exact main-frame validation, content limited to 4000 characters, bounded timeout and HTTP failure handling. The final request is {content:string}, response {ok:boolean,rules:unknown[],error?:string}. No arbitrary URL proxy or global CORS change.
- Grok: validate untrusted highlight rules at the rendering sink; class tokens and exact supported hex colors cannot break out of attributes. Malformed rules and non-global regex flags cannot hang the simple scan loop. Replace browser fetch with the narrow IPC call, preserving local highlighting fallback. Add CSP and a small external entry script; no inline JavaScript or browser network connection is required.
- Planner: isolated real Electron test under test/security/**, loading the actual HTML and renderer with the exported main security settings/guards/IPC handler. A test preload injects a temporary notes directory; windows remain hidden; only the HTTP response is mocked. No Hyperia entrypoint, live sidecar call, installed-app restart, or package build.
- Productive Cod: review security changes and smoke evidence before replacing the prior approval.
- Then Fox: run the isolated host smoke and verification, then commit/push the reviewed follow-up to the same draft PR. Keep findings open until the fix is verified; do not dismiss based on historical rationale.

Security acceptance: baseline attribute breakout test fails before the change and passes after; effective loaded-window browser protections are enabled; code, note and search modes load with CSP; AI IPC success/failure both render; injected attributes stay inert; inline handlers/scripts and browser connections are blocked; navigation to an untrusted local HTML fixture emits the guard event and is denied, and popup creation is denied. The first host run found that explicit about:blank navigation bypasses will-navigate, matching upstream Electron #21136; the smoke records this separately and does not claim this guard supplies complete navigation isolation. Existing lifecycle tests stay green. Checks must distinguish unit/stub coverage, actual Electron source-asset smoke, packaged verification and installed-app field checks.

Remaining debt is explicit: nodeIntegration:true and contextIsolation:false still support the legacy renderer's filesystem/CommonJS access. This follow-up does not make stickies sandboxed. Issue #208 tracks the separate preload and persistence migration to remove those privileges; no claim of complete renderer isolation is permitted. Generated JavaScript regular expressions still run in the renderer: syntax/rule-count limits do not provide a bound on pathological regex execution. That residual needs an execution budget or isolation in follow-up work.
