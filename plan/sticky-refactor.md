# Sticky refactor — canary

Status: main and renderer implementation reviewed by Productive Cod, 2026-09-17; no remaining code blockers. Paths frozen for Then Fox's final host checks and a draft PR to canary. Existing CI blockers below remain pending owner authorization; manual installer build and release are not authorized.

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

Renderer verification covers bootstrap dependency loading, packaged asset paths, editor/search/file/code/schedule modes and existing IPC contracts. Run relevant unit tests, lint and type checks with actual results. Then Fox performs a host smoke/build when authorized against the exact revision/version. Never kill/restart the installed app for diagnostics.

Field smoke checklist: hide stickies then restart, explicit open, show/hide all, edit/update while hidden, scheduled reminder, close/archive, search/reopen, linked file and code note. Field result is not claimed until observed.
