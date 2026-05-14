# macOS Code Signing — Next Steps (handoff)

Written 2026-05-13. This file is a checkpoint for the next agent or developer
picking up macOS code signing for Hyperia. The Windows side is already complete
(Azure Trusted Signing, see closed issue #40). What follows is for the Mac side
only.

---

## What's done

- Apple Developer Program membership active under **DeepBlue Dynamics LLC**.
- **Developer ID Application** certificate created on Apple Developer site:
  - Profile Type: **G2 Sub-CA (Xcode 11.4.1 or later)**.
  - CSR generated on Kord's Mac via Keychain Access → Certificate Assistant →
    Request a Certificate From a Certificate Authority. Common Name was
    `DeepBlue Dynamics LLC`, "Saved to disk", 2048-bit RSA.
  - `.cer` downloaded and double-clicked into the login keychain on Kord's Mac.
  - Verified in Keychain Access → login → My Certificates: the cert expands to
    show a paired private key — signing identity is usable on that Mac.

## What's still to do, in order

### 1. Confirm the signing identity name

On the Mac, in Terminal:

```bash
security find-identity -v -p codesigning
```

Expect a line like:

```
1) ABC123... "Developer ID Application: DeepBlue Dynamics LLC (TEAMID10)"
```

Copy the full string in quotes. That's the signing identity electron-builder
needs.

### 2. Get the Team ID

Visible in the top-right of developer.apple.com once signed in — 10-character
alphanumeric. Also embedded in parentheses in the signing identity name above.

### 3. Create an app-specific password for notarization

`appleid.apple.com` → Sign-In and Security → App-Specific Passwords → **+**.
Label it `hyperia-notarization`. Save the password — Apple only shows it once.

### 4. Wire electron-builder for macOS

Edit `electron-builder.json` (currently Windows-only). Add a `mac` block:

```json
"mac": {
  "category": "public.app-category.developer-tools",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist",
  "notarize": {
    "teamId": "<TEAM_ID_FROM_STEP_2>"
  },
  "target": ["dmg", "zip"]
}
```

Create `build/entitlements.mac.plist` if it doesn't exist — minimal contents for
a Node-based Electron app:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

### 5. Build and sign on the Mac

The sidecar must be built for the right Apple Silicon / Intel target. See
`docs/building.md` Mac section. The full sequence on Apple Silicon:

```bash
cd sidecar
cargo build --release --target aarch64-apple-darwin
cd ..

# electron-builder reads these env vars to find the cert and notarize
export APPLE_ID="<apple_id_email>"
export APPLE_APP_SPECIFIC_PASSWORD="<from step 3>"
export APPLE_TEAM_ID="<from step 2>"

yarn dist
```

electron-builder finds the Developer ID Application cert automatically by
matching the team ID against the keychain. If signing fails, fall back to
explicit `CSC_LINK` (path to an exported `.p12`) and `CSC_KEY_PASSWORD`.

### 6. Verify

After `yarn dist` completes:

```bash
codesign -dv --verbose=4 dist/mac-arm64/Hyperia.app
spctl --assess --type execute --verbose dist/mac-arm64/Hyperia.app
```

`spctl --assess` should say `accepted` and `source=Notarized Developer ID`.

If notarization is incomplete, run:

```bash
xcrun stapler staple dist/mac-arm64/Hyperia.app
```

### 7. Test install

Open the produced `.dmg` on a clean Mac (or a Mac that's never trusted the dev
cert manually). Gatekeeper should let it open without warnings.

---

## Files this change will touch

- `electron-builder.json` — add `mac` block (currently only `win` is configured)
- `build/entitlements.mac.plist` — new file
- `docs/building.md` — update macOS section with the new env vars + verification
- `bin/cp-sidecar.js` — already handles the target-triple sidecar path, no change

## Where the existing macOS build info lives

- `docs/building.md` lines 81-127 cover Mac builds but predate signing.
- `bin/cp-sidecar.js` copies the sidecar from
  `sidecar/target/<rust-target>/release/hyperia-sidecar` into the .app bundle.

## Related issues

- #40 (closed) — Code signing Windows + macOS. Windows side delivered; macOS
  flagged as separate follow-up. This file documents the state of that
  follow-up.

## Open questions / gotchas

- The sidecar binary must be signed too. electron-builder signs files in
  `extraResources` automatically if they're inside the .app bundle, but verify
  with `codesign -dv dist/mac-arm64/Hyperia.app/Contents/Resources/sidecar/hyperia-sidecar`.
- Hardened runtime requires entitlements for any Node native modules that JIT
  (Electron itself does). The entitlements file above covers the common case.
- Notarization can take from a few seconds to ~20 minutes. electron-builder
  blocks until it completes. Have patience on the first run.
