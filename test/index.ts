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
      // electron-builder's output dir varies by arch (mac / mac-arm64 /
      // mac-universal) — CI runners have moved to arm64, so probe them all.
      const candidates = ['mac', 'mac-arm64', 'mac-universal'].map((dir) =>
        path.join(__dirname, `../dist/${dir}/Hyperia.app/Contents/MacOS/Hyperia`)
      );
      pathToBinary = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
      break;
    }

    case 'win32':
      pathToBinary = path.join(__dirname, '../dist/win-unpacked/Hyperia.exe');
      break;

    default:
      throw new Error('Path to the built binary needs to be defined for this platform in test/index.js');
  }

  app = await _electron.launch({
    executablePath: pathToBinary,
    // GitHub runners can't use Chromium's setuid sandbox from an unpacked
    // build dir — without this the packaged binary dies at launch on Linux.
    args: process.platform === 'linux' ? ['--no-sandbox'] : []
  });
  await app.firstWindow();
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
  await app.close();
});

test('see if dev tools are open', async (t) => {
  t.false(await app.evaluate(({webContents}) => !!webContents.getFocusedWebContents()?.isDevToolsOpened()));
});
