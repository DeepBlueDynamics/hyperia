import {spawn} from 'child_process';

import {shell} from 'electron';

import {cfgPath} from './paths';

// Fallback opener for Windows when no default .json handler is registered.
// Uses spawn with the path passed as a separate argv entry so the file path
// is never interpreted by a shell — CodeQL js/shell-command-injection-from-environment.
const openNotepad = (file: string) =>
  new Promise<boolean>((resolve) => {
    try {
      const child = spawn('notepad.exe', [file], {detached: true, stdio: 'ignore'});
      child.on('error', () => resolve(false));
      child.on('spawn', () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });

const openConfig = () => {
  // Config is now JSON — shell.openPath works on all platforms.
  // On Windows, .json files open in the user's preferred editor (VS Code, Notepad++, etc).
  return shell.openPath(cfgPath).then((error) => {
    if (error) {
      // Fallback to notepad if no default .json handler
      console.warn('shell.openPath failed, falling back to notepad:', error);
      return openNotepad(cfgPath);
    }
    return true;
  });
};

export default openConfig;
