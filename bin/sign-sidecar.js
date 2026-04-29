/**
 * beforePack hook — signs hyperia-sidecar.exe on Windows before electron-builder
 * bundles it via extraResources. The main sign.js hook only fires for binaries
 * electron-builder packs itself; extraResources are copied verbatim and skipped.
 */

const path = require('path');
const fs = require('fs');
const {spawnSync} = require('child_process');

const SIGNTOOL = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe';
const DLIB = path.join(__dirname, '..', 'build', 'win', 'trustedsigning', 'bin', 'x64', 'Azure.CodeSigning.Dlib.dll');

function loadSigningEnv() {
  const envFile = path.join(__dirname, '..', '.signing.env');
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

exports.default = async function (context) {
  if (process.platform !== 'win32') return;

  loadSigningEnv();

  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!clientSecret) {
    console.warn('AZURE_CLIENT_SECRET not set — skipping sidecar signing');
    return;
  }

  const sidecarPath = path.resolve(__dirname, '..', 'sidecar', 'target', 'release', 'hyperia-sidecar.exe');
  if (!fs.existsSync(sidecarPath)) {
    console.warn(`Sidecar not found at ${sidecarPath} — skipping signing`);
    return;
  }

  const os = require('os');
  const metadata = {
    Endpoint: 'https://eus.codesigning.azure.net/',
    CodeSigningAccountName: 'nuts-services',
    CertificateProfileName: 'hyperia-signing'
  };
  const configPath = path.join(os.tmpdir(), `hyperia-sidecar-signing-${Date.now()}.json`);
  fs.writeFileSync(configPath, JSON.stringify(metadata, null, 2), 'utf8');

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
       '/dlib', DLIB, '/dmdf', configPath, sidecarPath],
      {env, encoding: 'utf8', timeout: 60000}
    );

    if (result.status === 0) {
      console.log('Signed: hyperia-sidecar.exe');
    } else {
      const msg = (result.stderr || result.stdout || '').slice(0, 400);
      console.warn('Sidecar signing failed:', msg);
    }
  } finally {
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  }
};
