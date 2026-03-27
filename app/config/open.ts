import {exec} from 'child_process';

import {shell} from 'electron';

let Registry: typeof import('native-reg') | null = null;
try {
  Registry = require('native-reg');
} catch {
  console.warn('native-reg not available. Registry-based editor detection disabled.');
}

import {cfgPath} from './paths';

const getUserChoiceKey = () => {
  if (!Registry) return;
  try {
    // Load FileExts keys for .js files
    const fileExtsKeys = Registry.openKey(
      Registry.HKCU,
      'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.js',
      Registry.Access.READ
    );
    const keys = fileExtsKeys ? Registry.enumKeyNames(fileExtsKeys) : [];
    Registry.closeKey(fileExtsKeys);

    // Find UserChoice key
    const userChoice = keys.find((k) => k.endsWith('UserChoice'));
    return userChoice
      ? `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.js\\${userChoice}`
      : userChoice;
  } catch (error) {
    console.error(error);
    return;
  }
};

const hasDefaultSet = () => {
  const userChoice = getUserChoiceKey();
  if (!userChoice || !Registry) return false;

  try {
    // Load key values
    const userChoiceKey = Registry.openKey(Registry.HKCU, userChoice, Registry.Access.READ)!;
    const values: string[] = Registry.enumValueNames(userChoiceKey).map(
      (x) => (Registry.queryValue(userChoiceKey, x) as string) || ''
    );
    Registry.closeKey(userChoiceKey);

    // Look for default program
    const hasDefaultProgramConfigured = values.every(
      (value) => value && typeof value === 'string' && !value.includes('WScript.exe') && !value.includes('JSFile')
    );

    return hasDefaultProgramConfigured;
  } catch (error) {
    console.error(error);
    return false;
  }
};

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
