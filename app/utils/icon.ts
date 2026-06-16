import {existsSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';
import {nativeImage} from 'electron';
import {icon, cfgPath} from '../config/paths';

let cachedWindowIcon: Electron.NativeImage | undefined | null = null;

export function getAppIcon(): Electron.NativeImage | string {
  if (cachedWindowIcon === null) {
    cachedWindowIcon = undefined;
    const dbg: string[] = [`[icon] ts=${Date.now()}`, `[icon] icon path = ${icon}`, `[icon] icon exists = ${existsSync(icon)}`];
    try {
      const img = nativeImage.createFromPath(icon);
      dbg.push(`[icon] createFromPath: empty=${img.isEmpty()} size=${JSON.stringify(img.getSize())}`);
      if (!img.isEmpty()) cachedWindowIcon = img;
    } catch (e) {
      dbg.push(`[icon] createFromPath threw: ${(e as Error).message}`);
    }
    if (!cachedWindowIcon) {
      try {
        const png = join(dirname(icon), 'icon.png');
        dbg.push(`[icon] png path = ${png} exists=${existsSync(png)}`);
        const img = nativeImage.createFromBuffer(readFileSync(png));
        dbg.push(`[icon] createFromBuffer(png): empty=${img.isEmpty()} size=${JSON.stringify(img.getSize())}`);
        if (!img.isEmpty()) cachedWindowIcon = img;
      } catch (e) {
        dbg.push(`[icon] png fallback threw: ${(e as Error).message}`);
      }
    }
    dbg.push(`[icon] RESULT = ${cachedWindowIcon ? 'nativeImage (logo)' : 'STRING-FALLBACK (likely broken)'}`);
    try {
      writeFileSync(join(dirname(cfgPath), 'icon-debug.log'), dbg.join('\n') + '\n');
    } catch {
      /* best-effort diagnostic */
    }
  }
  return cachedWindowIcon ?? icon;
}
