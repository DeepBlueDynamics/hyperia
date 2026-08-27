// Native
import path from 'path';

// Packages
import test from 'ava';
import fs from 'fs-extra';
import {_electron} from 'playwright';
import type {ElectronApplication} from 'playwright';

let app: ElectronApplication;

test.before(async () => {
  let pathToBinary;

  switch (process.platform) {
    case 'linux':
      pathToBinary = path.join(__dirname, '../dist/linux-unpacked/hyperia');
      break;

    case 'darwin': {
      // electron-builder emits BOTH arch dirs (mac = x64, mac-arm64) — probe
      // HOST arch first. Launching the x64 app on an arm64 runner runs under
      // Rosetta, whose cold-start translation hangs electron.launch past the
      // suite timeout (the "mac E2E flake" that went solid-red).
      const dirs =
        process.arch === 'arm64' ? ['mac-arm64', 'mac-universal', 'mac'] : ['mac', 'mac-universal', 'mac-arm64'];
      const candidates = dirs.map((dir) => path.join(__dirname, `../dist/${dir}/Hyperia.app/Contents/MacOS/Hyperia`));
      pathToBinary = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
      break;
    }

    case 'win32':
      pathToBinary = path.join(__dirname, '../dist/win-unpacked/Hyperia.exe');
      break;

    default:
      throw new Error('Path to the built binary needs to be defined for this platform in test/index.js');
  }

  console.log(`[e2e] launching ${pathToBinary}`);
  app = await _electron.launch({
    executablePath: pathToBinary,
    // GitHub runners can't use Chromium's setuid sandbox from an unpacked
    // build dir — without this the packaged binary dies at launch on Linux.
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  });
  // Surface the app's OWN output — a silent launch hang (mac, since the
  // splash removal) is undiagnosable when the main process's words are
  // discarded. Everything it prints lands in the ava log.
  app.process().stdout?.on('data', (d: Buffer) => console.log(`[app:out] ${String(d).trimEnd()}`));
  app.process().stderr?.on('data', (d: Buffer) => console.log(`[app:err] ${String(d).trimEnd()}`));
  console.log('[e2e] launched; waiting for first window');
  await app.firstWindow();
  console.log('[e2e] first window up; settling 5s');
  await new Promise((resolve) => setTimeout(resolve, 5000));
});

test.after(async () => {
  await app
    .evaluate(({BrowserWindow}) =>
      BrowserWindow.getFocusedWindow()
        ?.capturePage()
        .then((img) => img.toPNG().toString('base64'))
    )
    .then((img) => Buffer.from(img || '', 'base64'))
    .then(async (imageBuffer) => {
      // outputFile (not writeFile): dist/tmp doesn't exist on a fresh build.
      await fs.outputFile(`dist/tmp/${process.platform}_test.png`, imageBuffer);
    });
  // app.close() waits for process EXIT — but Hyperia (tray keep-alive on
  // Windows) outlives its windows, so an unbounded close hangs ava until the
  // suite times out even after every test passed. Bound it, then hard-kill.
  const proc = app.process();
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10000))]);
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
});

test('see if dev tools are open', async (t) => {
  t.false(await app.evaluate(({webContents}) => !!webContents.getFocusedWebContents()?.isDevToolsOpened()));
});
