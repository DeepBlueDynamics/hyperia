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
  loadSigningEnv();
  const file = config.path;

  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!clientSecret) {
    // In CI a tagged release MUST be signed — fail loudly instead of silently
    // shipping an unsigned installer. Locally, allow an unsigned dev build.
    if (process.env.CI) {
      throw new Error('AZURE_CLIENT_SECRET not set in CI — refusing to ship an UNSIGNED build');
    }
    console.warn('AZURE_CLIENT_SECRET not set — skipping signing (local dev build)');
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

    // A non-zero exit OR a spawn error (e.g. signtool not found) means this file
    // is UNSIGNED. Throw so electron-builder fails the build — never let an
    // unsigned artifact pass as a successful release.
    if (result.error) {
      throw new Error(`signtool could not be run (${SIGNTOOL}): ${result.error.message}`);
    }
    if (result.status === 0) {
      console.log('Signed:', path.basename(file));
    } else {
      const msg = (result.stderr || result.stdout || '').slice(0, 600);
      throw new Error(`Signing FAILED for ${path.basename(file)} (signtool exit ${result.status}): ${msg}`);
    }
  } finally {
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  }
};
