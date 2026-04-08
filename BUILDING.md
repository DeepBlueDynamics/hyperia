# Building Hyperia for Release

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
