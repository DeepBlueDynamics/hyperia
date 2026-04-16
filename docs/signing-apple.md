# Apple Code Signing & Notarization Runbook

This covers everything needed to sign and notarize Hyperia for macOS distribution
outside the App Store (Developer ID). Do this once per developer machine / cert cycle.

---

## Prerequisites

- A Mac (signing and notarization must be done on macOS)
- Xcode installed (for Keychain Access and `codesign`)
- Apple Developer Program membership — **Organization** type required
- D-U-N-S number for your legal entity (see Step 1)

---

## Step 1 — Obtain a D-U-N-S Number

Apple requires a D-U-N-S number to verify your legal entity when enrolling as an
Organization. If your company already has one, skip to Step 2.

1. Go to: https://developer.apple.com/enroll/duns-lookup/
2. Enter your legal business name and address exactly as registered.
3. If found, Apple will use that number — no action needed.
4. If not found, click **Submit** to request a new D-U-N-S number from Dun & Bradstreet.
   - New numbers take **5–14 business days**.
   - The name and address on the D-U-N-S **must match your legal entity exactly**.
     Abbreviations or DBA names will cause Apple's verification to fail.

> **DeepBlue Dynamics LLC** — ensure the legal name matches exactly across
> D&B, your Apple enrollment, and your certificate's Common Name.

---

## Step 2 — Enroll in the Apple Developer Program (Organization)

1. Go to: https://developer.apple.com/programs/enroll/
2. Sign in with your Apple ID (create one if needed — use a company email).
3. Select **Enrolling as an Organization**.
4. Enter:
   - Legal entity name
   - D-U-N-S number
   - Business address and phone
5. Pay $99/year.
6. Apple will send a verification email and **may call your business phone** to confirm.
   - This call usually happens within 1–5 business days.
   - Answer as the legal entity's authorized representative.

Once approved, your account is activated at https://developer.apple.com/account/

---

## Step 3 — Create a Developer ID Application Certificate

Do this on the Mac you will build from. The private key lives in your Keychain.

### Generate a Certificate Signing Request (CSR)

1. Open **Keychain Access** → menu: **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority**
2. Fill in:
   - **User Email Address**: your Apple ID email
   - **Common Name**: `DeepBlue Dynamics LLC` (or your name — this appears in the cert)
   - **CA Email Address**: leave blank
   - Select **Saved to disk**
3. Save the `.certSigningRequest` file somewhere safe.

### Submit to Apple and Download

1. Go to: https://developer.apple.com/account/resources/certificates/add
2. Select **Developer ID Application** (for distributing outside the App Store).
3. Upload your `.certSigningRequest` file.
4. Download the resulting `.cer` file.
5. Double-click it — Keychain Access will install it automatically.

Verify it's installed:
```bash
security find-identity -v -p codesigning
```
You should see a line like:
```
1) ABCDEF1234... "Developer ID Application: DeepBlue Dynamics LLC (TEAMID)"
```
Copy the **Team ID** (10-character string in parentheses) — you'll need it everywhere.

### Export a .p12 (for CI or other machines)

If you need to sign on another machine or in CI:

1. Keychain Access → find the cert → right-click → **Export**
2. Choose `.p12` format, set a strong password.
3. Store securely (this is your signing identity — treat like a private key).

---

## Step 4 — Generate an App-Specific Password for Notarization

Apple's notary service requires your Apple ID credentials, but not your main password.

1. Go to: https://appleid.apple.com/account/manage
2. Under **Sign-In and Security** → **App-Specific Passwords** → click **+**
3. Label it `hyperia-notarize` (or similar).
4. Copy the generated password (format: `xxxx-xxxx-xxxx-xxxx`).
   You won't see it again.

---

## Step 5 — Configure electron-builder

### `electron-builder.json` — add identity and notarize

In the `"mac"` section, add:

```json
"mac": {
  "identity": "Developer ID Application: DeepBlue Dynamics LLC (TEAMID)",
  "notarize": {
    "teamId": "TEAMID"
  },
  ...
}
```

Replace `TEAMID` with your 10-character Team ID from Step 3.

### Environment variables at build time

Set these in your shell before running `yarn dist`:

```bash
export APPLE_ID="your-appleid@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

If using a `.p12` file instead of the system Keychain:
```bash
export CSC_LINK="/path/to/certificate.p12"
export CSC_KEY_PASSWORD="your-p12-password"
```

If the certificate is already installed in the system Keychain (most common on your
own Mac), `CSC_LINK` / `CSC_KEY_PASSWORD` are not needed — electron-builder finds
the cert automatically via `identity`.

---

## Step 6 — Full Mac Build Sequence

With signing configured:

```bash
# 1. Bump version in package.json, app/package.json, sidecar/Cargo.toml
# 2. Build the sidecar for the target architecture
cd sidecar
cargo build --release --target aarch64-apple-darwin   # Apple Silicon
# or:
cargo build --release --target x86_64-apple-darwin    # Intel
cd ..

# 3. Set credentials
export APPLE_ID="you@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"

# 4. Build, sign, and notarize
yarn dist
```

electron-builder will:
1. Build the `.app`
2. Sign it with your Developer ID cert (`codesign`)
3. Submit it to Apple's notary service and wait for approval
4. Staple the notarization ticket to the `.app`
5. Package it into a `.dmg`

Output: `dist/Hyperia-X.Y.Z-mac-arm64.dmg` (and/or `x64`)

---

## Verification

After building, verify the signature and notarization:

```bash
# Check signature
codesign --verify --verbose=4 dist/mac-arm64/Hyperia.app

# Check notarization staple
spctl --assess --verbose=4 dist/mac-arm64/Hyperia.app
# Should output: "source=Notarized Developer ID"

# Check the DMG
spctl --assess --verbose=4 dist/Hyperia-X.Y.Z-mac-arm64.dmg
```

---

## Certificate Renewal

Developer ID certificates are valid for **5 years**. When it expires:

1. Create a new CSR (Step 3).
2. Submit at `developer.apple.com/account/resources/certificates/add`.
3. Download and install the new cert.
4. Update `"identity"` in `electron-builder.json` if the fingerprint changed
   (usually it stays the same format — just the dates change).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `"no identity found"` | Cert not in Keychain | Double-click the `.cer` to install |
| `"errSecInternalComponent"` during codesign | Keychain locked | Unlock Keychain Access |
| Notarization rejected: `"The binary is not signed"` | Unsigned binary inside the app | Check `asarUnpack` paths and sign all native binaries |
| Gatekeeper blocks app after install | Not notarized or stapling failed | Run `xcrun stapler staple Hyperia.app` manually |
| D-U-N-S lookup fails | Name mismatch with legal records | Use exact legal name — no punctuation differences |
| Apple enrollment call never comes | Wrong phone on file | Log into developer.apple.com and update contact info |
