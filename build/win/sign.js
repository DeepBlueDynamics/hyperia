/**
 * Azure Trusted Signing via Microsoft.Trusted.Signing.Client dlib + signtool.exe
 * Auth via DefaultAzureCredential environment variables.
 *
 * Env var required at build time:
 *   AZURE_CLIENT_SECRET
 */

const {spawnSync} = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Resolve signtool.exe from the newest installed Windows 10/11 SDK rather than
// hardcoding an SDK build number — the GitHub runner image bumps that version
// periodically, and a stale path would make signtool "not found" (which used to
// be swallowed → unsigned build shipped green). Falls back to the last-known path.
function resolveSigntool() {
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  try {
    const vers = fs.readdirSync(base).filter((d) => /^10\./.test(d)).sort().reverse();
    for (const v of vers) {
      const cand = path.join(base, v, 'x64', 'signtool.exe');
      if (fs.existsSync(cand)) return cand;
    }
  } catch {
    /* fall through to the hardcoded path */
  }
  return path.join(base, '10.0.26100.0', 'x64', 'signtool.exe');
}

const SIGNTOOL = resolveSigntool();
const DLIB = path.join(__dirname, 'trustedsigning', 'bin', 'x64', 'Azure.CodeSigning.Dlib.dll');

// nemesis8-style graceful degrade (see DeepBlueDynamics/nemesis8 release.yml's
// `continue-on-error: true` on the Sign step): a flaky or billing-held Azure
// Trusted Signing service must NOT block the entire cross-platform release —
// Linux + macOS sign/build fine. On signing failure we ship the Windows artifact
// UNSIGNED with a loud GitHub ::warning::; users get a SmartScreen "unknown
// publisher" prompt until the next release signs cleanly once Azure recovers.
function shipUnsigned(reason) {
  console.warn(`::warning::Windows build is UNSIGNED — ${reason}`);
}

// Only Authenticode-signable PE binaries (DOS "MZ" header) can be handed to
// signtool. Deps like node-pty bundle darwin/linux prebuilds (`.node` = Mach-O /
// ELF) INSIDE the Windows package; `win.signExts: [".node"]` matches them by
// extension, but signtool rejects them ("file format cannot be signed"). Those
// files never execute on Windows, so skip them QUIETLY — otherwise the graceful
// degrade below would fire a false `::warning::…UNSIGNED`, crying wolf over the
// real signal that flags a genuinely unsigned Windows binary.
function isPeFile(f) {
  try {
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(2);
      fs.readSync(fd, buf, 0, 2, 0);
      return buf[0] === 0x4d && buf[1] === 0x5a; // 'MZ'
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true; // unreadable → let signtool decide rather than silently skip
  }
}

// Load .signing.env from the repo root if AZURE_CLIENT_SECRET isn't already set
function loadSigningEnv() {
  const envFile = path.join(__dirname, '..', '..', '.signing.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (val && !process.env[key]) process.env[key] = val;
  }
}

exports.default = async function (config) {
  // Explicit unsigned build: HYPERIA_SKIP_SIGNING=1 yarn run dist — ships every
  // artifact unsigned even when .signing.env is present (for diagnostics / quick
  // local builds). Returning here leaves the file unsigned.
  const file = config.path;
  if (process.env.HYPERIA_SKIP_SIGNING) {
    console.warn(`HYPERIA_SKIP_SIGNING set — shipping ${path.basename(file)} UNSIGNED`);
    return;
  }
  // Non-PE files (darwin/linux `.node` prebuilds shipped inside the win package)
  // can't be Authenticode-signed and don't run on Windows — skip without alarm.
  if (!isPeFile(file)) {
    console.log(`Skip (not a PE binary): ${path.basename(file)}`);
    return;
  }
  loadSigningEnv();

  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!clientSecret) {
    // No secret → can't sign. Ship unsigned rather than blocking the release
    // (local dev builds, or CI when the signing secret is unavailable).
    if (process.env.CI) {
      shipUnsigned('AZURE_CLIENT_SECRET not set in CI');
    } else {
      console.warn('AZURE_CLIENT_SECRET not set — skipping signing (local dev build)');
    }
    return;
  }

  // Metadata JSON — only the three fields the dlib expects
  const metadata = {
    Endpoint: 'https://eus.codesigning.azure.net/',
    CodeSigningAccountName: 'nuts-services',
    CertificateProfileName: 'hyperia-signing'
  };

  const configPath = path.join(os.tmpdir(), `hyperia-signing-${Date.now()}.json`);
  fs.writeFileSync(configPath, JSON.stringify(metadata, null, 2), 'utf8');

  // DefaultAzureCredential reads these env vars for service principal auth
  const env = Object.assign({}, process.env, {
    AZURE_TENANT_ID: '455aff82-f565-4d92-819b-0a2a69124d93',
    AZURE_CLIENT_ID: 'df75cc63-5ed4-40ab-9270-15e92ff74c9a',
    AZURE_CLIENT_SECRET: clientSecret
  });

  try {
    const result = spawnSync(
      SIGNTOOL,
      ['sign', '/v', '/fd', 'SHA256', '/td', 'SHA256',
       '/tr', 'http://timestamp.acs.microsoft.com',
       '/dlib', DLIB, '/dmdf', configPath, file],
      {env, encoding: 'utf8', timeout: 60000}
    );

    // A non-zero exit OR a spawn error (e.g. signtool not found, Azure 403 /
    // operation status:Failed) means this file is UNSIGNED. Degrade to an
    // unsigned build with a loud warning rather than failing the whole release.
    if (result.error) {
      shipUnsigned(`signtool could not be run (${SIGNTOOL}): ${result.error.message}`);
    } else if (result.status === 0) {
      console.log('Signed:', path.basename(file));
    } else {
      const msg = (result.stderr || result.stdout || '').slice(0, 600);
      shipUnsigned(`signtool exit ${result.status} for ${path.basename(file)}: ${msg}`);
    }
  } finally {
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  }
};
