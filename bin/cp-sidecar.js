const path = require('path');
const fs = require('fs');
const {Arch} = require('electron-builder');
const cpSnapshot = require('./cp-snapshot.js');

exports.default = async (context) => {
  // First run the snapshot copy
  await cpSnapshot.default(context);

  // Only copy sidecar for macOS
  if (process.platform !== 'darwin') {
    return;
  }

  const arch = Arch[context.arch]; // 'x64' or 'arm64'
  const rustTarget = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';

  const sourcePath = path.resolve(
    __dirname,
    '..',
    'sidecar',
    'target',
    rustTarget,
    'release',
    'hyperia-sidecar'
  );

  const targetDir = path.join(context.appOutDir, 'Hyperia.app', 'Contents', 'Resources', 'sidecar');
  const targetPath = path.join(targetDir, 'hyperia-sidecar');

  if (!fs.existsSync(sourcePath)) {
    console.warn(`Sidecar binary not found at ${sourcePath} — skipping`);
    return;
  }

  // Create target directory if it doesn't exist
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  console.log(`Copying sidecar (${arch}) from ${sourcePath} to ${targetPath}`);
  fs.copyFileSync(sourcePath, targetPath);

  // Make it executable
  fs.chmodSync(targetPath, 0o755);
  console.log(`Sidecar binary copied and marked executable`);
};
