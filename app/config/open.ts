import {exec} from 'child_process';

import {shell} from 'electron';

import {cfgPath} from './paths';

// This mimics shell.openItem, true if it worked, false if not.
const openNotepad = (file: string) =>
  new Promise<boolean>((resolve) => {
    exec(`start notepad.exe ${file}`, (error) => {
      resolve(!error);
    });
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
