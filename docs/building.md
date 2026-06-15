# Building Hyperia for Release

For the end-to-end release flow (CI + signing + GitHub release + auto-update channel + install-script deploy), use **`deploy/operations/release-build.md`** — that's the operations runbook. This file covers the per-platform local-build mechanics only.

## Prerequisites

- **Node.js** + **Yarn**
- **Rust** (stable toolchain via rustup)
- **Windows SDK** — `signtool.exe` must exist at:
  `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe`
- **Azure Trusted Signing** — one env var required at build time:
  ```
  AZURE_CLIENT_SECRET=<value>
  ```
  Tenant ID, Client ID, endpoint, and account name are hardcoded in `build/win/sign.js`.
  If `AZURE_CLIENT_SECRET` is not set, signing is skipped with a warning — the build still completes unsigned.

## Important: Close Hyperia Before Building

The build replaces `sidecar/target/release/hyperia-sidecar.exe`. If Hyperia is running it holds
that file open and the Rust build will fail with "Access is denied." Close Hyperia first.

**Closing the window is not enough in dev.** A `yarn start` session runs an `electronmon`
watcher that **respawns `electron` every time you kill it** — and the respawned app re-locks
both `hyperia-sidecar.exe` and `node-pty`'s native `.node` files. Kill the whole chain, not
just the windows. On Windows:

```bash
# kill every node/electron/cmd process whose command line mentions this repo, plus the sidecar
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'hyperia-sidecar.exe') -or ((\$_.Name -in 'node.exe','electron.exe','cmd.exe') -and \$_.CommandLine -like '*hyperia*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

## Step 1 — Bump the Version

Before every release build, increment the patch version in **all three** files:

- `package.json` — `"version": "X.Y.Z"`
- `app/package.json` — `"version": "X.Y.Z"` ← the real source; `tsc -b` copies this to `target/package.json`
- `sidecar/Cargo.toml` — `version = "X.Y.Z"`

`target/package.json` is generated from `app/package.json` by `tsc -b`. Do not edit `target/package.json` directly — it will be overwritten. The installer artifact name comes from `target/package.json`, so if `app/package.json` is wrong the installer will be named with the old version.

## Step 2 — Build the Rust Sidecar

```bash
cd sidecar
cargo build --release
cd ..
```

Output: `sidecar/target/release/hyperia-sidecar.exe`

This must complete before packaging. `electron-builder` picks up the binary via `extraResources`
in `electron-builder.json`.

## Step 3 — Build and Package

```bash
set AZURE_CLIENT_SECRET=<your secret>
yarn run dist
```

`yarn run dist` runs in sequence:
1. `webpack` (production mode)
2. `tsc -b` (TypeScript compile)
3. `babel` minification pass on the renderer bundle
4. `electron-builder` — produces the NSIS installer in `dist/`

Output: `dist/Hyperia-X.Y.Z-x64.exe`

## Signing Details

Signing uses Azure Trusted Signing via the Microsoft dlib bundled at
`build/win/trustedsigning/bin/x64/Azure.CodeSigning.Dlib.dll`.

- Account: `nuts-services`
- Certificate profile: `hyperia-signing`
- Timestamp: `http://timestamp.acs.microsoft.com`
- Tenant ID and Client ID are hardcoded in `build/win/sign.js`

The signing config is written to a temp JSON file at runtime and deleted after each file is signed.

## Full Build Sequence (Windows, after closing Hyperia)

```bat
cd sidecar && cargo build --release && cd ..
set AZURE_CLIENT_SECRET=<your secret>
yarn run dist
```

---

## Troubleshooting build hangs & failures

These have each cost real time. Check here before assuming a build is "stuck."

### `yarn run dist` hangs for minutes in the native-module rebuild

`electron-builder` defaults to `npmRebuild: true`, which **recompiles native modules
(`node-pty`) from source** against the Electron headers on every package. That step can stall
indefinitely (node-gyp / network / file locks) and produces no output — the build looks frozen.
The native modules are already built for the pinned Electron during `postinstall`
(`electron-builder install-app-deps`), so the rebuild is redundant. **Skip it:**

```bash
# build the renderer/sidecar once (yarn run build), then package with the rebuild disabled:
npx electron-builder --config.npmRebuild=false
```

This is the single biggest cause of "the build won't finish." Watch the live phase with
`Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*hyperia*' }` — if it sits in
`@electron/rebuild` / `app-builder-lib...remote-rebuild` for more than ~1 min, it's this.

### `EACCES: permission denied, lstat '...\.antigravitycli\*.json'` (Windows)

The electron-builder file walker dies on a **broken symlink** in the repo root —
`.antigravitycli/<uuid>.json → /opt/nemesis8/.gemini/...` — a Gemini/antigravity-CLI artifact
that points at a Unix path which doesn't resolve on Windows. It's gitignored but still on disk.
Remove it before packaging: `rm -rf .antigravitycli`.

### "Access is denied" replacing `hyperia-sidecar.exe`

A running Hyperia (or the respawning `electronmon` dev app) still holds the binary. See
**Close Hyperia Before Building** above — kill the whole `electronmon`/`electron` chain, not
just the windows.

---

## Building on macOS

### Prerequisites

- **Node.js** + **Yarn**
- **Rust** (stable toolchain via rustup)
- **Rust targets** — install the target(s) you need:
  ```bash
  rustup target add aarch64-apple-darwin   # Apple Silicon
  rustup target add x86_64-apple-darwin    # Intel
  ```

### Important: use `--target`, not bare `cargo build --release`

The `afterPack` script (`bin/cp-sidecar.js`) copies the sidecar from
`sidecar/target/<rust-target>/release/hyperia-sidecar`.
A bare `cargo build --release` puts the binary at `sidecar/target/release/hyperia-sidecar`
(no target triple in the path) and the script **will not find it**.

### Step 1 — Bump version (same three files as Windows)

### Step 2 — Build the Rust sidecar with the correct target

```bash
# Apple Silicon (arm64):
cd sidecar && cargo build --release --target aarch64-apple-darwin && cd ..

# Intel (x64):
cd sidecar && cargo build --release --target x86_64-apple-darwin && cd ..
```

### Step 3 — Package

```bash
yarn dist
```

`electron-builder` auto-detects macOS and calls `cp-sidecar.js` to copy the binary into
`Hyperia.app/Contents/Resources/sidecar/hyperia-sidecar`.

### Full Mac build sequence (Apple Silicon example)

```bash
cd sidecar && cargo build --release --target aarch64-apple-darwin && cd ..
yarn dist
```

### macOS signing & notarization

`yarn dist` on a Mac will attempt to sign with the Developer ID cert and
notarize via Apple's service IF the right env vars are set. The full
walkthrough — D-U-N-S, enrollment, cert creation, CSR, app-specific
password, and the env vars electron-builder reads — is in
**`docs/signing-apple.md`**. Do that setup once per developer machine
or cert cycle, then `yarn dist` produces a signed and stapled `.dmg`.

### Building on macOS — known gotchas

- `bin/cp-sidecar.js` reads from `sidecar/target/<rust-target>/release/`. A bare `cargo build --release` puts the binary at `sidecar/target/release/` (no triple) — the script won't find it and the `.app` ships without a sidecar (silently — only a `Sidecar binary not found … — skipping` line in the build log). Always use `--target`.
- `electron-builder.json` hardcodes `mac.identity: "Developer ID Application: DeepBlue Dynamics LLC"`. With no cert present, electron-builder rejects that prefix. Either: install the cert per `signing-apple.md`, OR pass `--config.mac.identity=null` + set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing.

### CI builds (GitHub Actions)

`.github/workflows/build.yml` runs the cross-platform release build on
`v*` tag push. As of v0.10.7 the workflow:

- Uses **Node 22** (`rcedit@5.0.2` from electron-builder requires ≥22.12)
- Does **not** run `generate-schema` in `postinstall` — the committed `app/config/schema.json` is the source of truth; regenerate manually with `yarn run generate-schema` after editing `typings/config.d.ts`
- Builds the sidecar with explicit `--target x86_64-apple-darwin` on the macOS runner (see gotcha above)
- **Disables macOS signing on CI** via `CSC_IDENTITY_AUTO_DISCOVERY=false` and `--config.mac.identity=null` because the Apple cert + secrets aren't wired into repo yet. This is a workaround — see `deploy/operations/release-build.md` for the path to retire it.

Releases are uploaded as a **draft**. Real release notes + signing-status flag are added in `release-build.md` Step 7c before the draft is flipped to a (pre-)release.
