import {existsSync} from 'fs';
import vm from 'vm';

import merge from 'lodash/merge';

import type {parsedConfig, rawConfig, configOptions} from '../../typings/config';
import notify from '../notify';
import mapKeys from '../utils/map-keys';

// Per-platform shell candidates in priority order. Each entry is probed
// against the filesystem; only those that actually exist are returned.
// On Windows: pwsh 7 > powershell 5.1 > cmd > wsl.
// On macOS: zsh > bash > fish (system paths first, then Homebrew on Apple
//   Silicon, then Homebrew on Intel).
// On Linux: zsh > bash > fish > sh.
function shellCandidates(): Array<{name: string; shell: string; shellArgs: string[]}> {
  if (process.platform === 'win32') {
    return [
      {name: 'PowerShell', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', shellArgs: []},
      {
        name: 'Windows PowerShell',
        shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        shellArgs: []
      },
      {name: 'CMD', shell: 'C:\\Windows\\System32\\cmd.exe', shellArgs: []},
      // WSL — only present if the optional Windows feature is installed
      {name: 'WSL', shell: 'C:\\Windows\\System32\\wsl.exe', shellArgs: []}
    ];
  }
  if (process.platform === 'darwin') {
    // First match wins per name. System paths beat Homebrew; Apple Silicon
    // Homebrew (/opt/homebrew) beats Intel Homebrew (/usr/local).
    return [
      {name: 'zsh', shell: '/bin/zsh', shellArgs: ['--login']},
      {name: 'bash', shell: '/bin/bash', shellArgs: ['--login']},
      {name: 'zsh (brew)', shell: '/opt/homebrew/bin/zsh', shellArgs: ['--login']},
      {name: 'fish', shell: '/opt/homebrew/bin/fish', shellArgs: ['--login']},
      {name: 'zsh (brew x86)', shell: '/usr/local/bin/zsh', shellArgs: ['--login']},
      {name: 'fish (x86)', shell: '/usr/local/bin/fish', shellArgs: ['--login']}
    ];
  }
  // Linux (and anything else POSIX)
  return [
    {name: 'zsh', shell: '/bin/zsh', shellArgs: ['--login']},
    {name: 'bash', shell: '/bin/bash', shellArgs: ['--login']},
    {name: 'fish', shell: '/usr/bin/fish', shellArgs: ['--login']},
    {name: 'sh', shell: '/bin/sh', shellArgs: ['--login']}
  ];
}

// Probe the candidate list and return profile definitions for whichever
// shells exist on this machine.
function detectShells(): Array<{name: string; config: {shell: string; shellArgs: string[]}}> {
  return shellCandidates()
    .filter((c) => existsSync(c.shell))
    .map((c) => ({name: c.name, config: {shell: c.shell, shellArgs: c.shellArgs}}));
}

// Decide a sensible default profile name from the available profiles,
// preferring the platform's standard interactive shell.
function pickDefault(profileNames: string[]): string | null {
  let preference: string[];
  if (process.platform === 'win32') {
    preference = ['PowerShell', 'Windows PowerShell', 'CMD', 'WSL'];
  } else if (process.platform === 'darwin') {
    preference = ['zsh', 'bash', 'zsh (brew)', 'zsh (brew x86)', 'fish', 'fish (x86)'];
  } else {
    preference = ['zsh', 'bash', 'fish', 'sh'];
  }
  for (const name of preference) {
    if (profileNames.includes(name)) return name;
  }
  return null;
}

const _extract = (script?: vm.Script): Record<string, any> => {
  const module: Record<string, any> = {};
  script?.runInNewContext({module}, {displayErrors: true});
  if (!module.exports) {
    throw new Error('Error reading configuration: `module.exports` not set');
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return module.exports;
};

const _syntaxValidation = (cfg: string) => {
  try {
    return new vm.Script(cfg, {filename: '.hyper.js'});
  } catch (_err) {
    const err = _err as {name: string};
    notify(`Error loading config: ${err.name}`, JSON.stringify(err), {error: err});
  }
};

const _extractDefault = (cfg: string) => {
  return _extract(_syntaxValidation(cfg));
};

// init config
const _init = (userCfg: rawConfig, defaultCfg: rawConfig): parsedConfig => {
  return {
    config: (() => {
      if (userCfg?.config) {
        const conf = userCfg.config;
        conf.defaultProfile = conf.defaultProfile || 'default';
        // Coerce profiles to a real array before anything calls .map on it. A
        // config write can land a malformed value here — e.g. settings_set given
        // a JSON-encoded STRING stores "[{...}]" as a string, and `.map` then
        // throws an UNCAUGHT exception that crashes the whole main process at
        // launch (an unrecoverable state: the app won't start to let you fix it).
        // Parse a stringified array, and fall back to [] for anything that still
        // isn't an array, so a bad value degrades to defaults instead of a crash.
        // `profiles` is typed as an array, so read through `unknown` to make the
        // runtime string/array checks legal (a malformed config violates the type).
        const rawProfiles: unknown = conf.profiles;
        if (typeof rawProfiles === 'string') {
          try {
            conf.profiles = JSON.parse(rawProfiles);
          } catch {
            conf.profiles = [];
          }
        }
        if (!Array.isArray(conf.profiles)) {
          conf.profiles = [];
        }
        conf.profiles = conf.profiles.length > 0 ? conf.profiles : [{name: 'default', config: {}}];
        conf.profiles = conf.profiles.map((p, i) => ({
          ...p,
          name: p.name || `profile-${i + 1}`,
          config: p.config || {}
        }));

        // Probe for installed shells on this platform (Windows: pwsh / cmd /
        // wsl; macOS: zsh / bash / fish; Linux: zsh / bash / fish / sh) and
        // merge profiles for any that exist. User's existing profiles win on
        // name collision so a user-customized "zsh" or "PowerShell" entry
        // keeps its overrides.
        const detected = detectShells();
        if (detected.length > 0) {
          const existingNames = new Set(conf.profiles.map((p) => p.name));
          for (const d of detected) {
            if (!existingNames.has(d.name)) {
              conf.profiles.push(d);
            }
          }
        }

        // Resolve defaultProfile. If the user explicitly set one that
        // resolves, honor it. Otherwise pick the platform's standard
        // interactive shell from whatever's actually installed, falling
        // back to the first profile only if nothing matches.
        const profileNames = conf.profiles.map((p) => p.name);
        if (!profileNames.includes(conf.defaultProfile) || conf.defaultProfile === 'default') {
          const platformDefault = pickDefault(profileNames);
          conf.defaultProfile = platformDefault || conf.profiles[0].name;
        }
        return merge({}, defaultCfg.config, conf);
      } else {
        notify('Error reading configuration: `config` key is missing');
        return defaultCfg.config || ({} as configOptions);
      }
    })(),
    // Merging platform specific keymaps with user defined keymaps
    keymaps: mapKeys({...defaultCfg.keymaps, ...userCfg?.keymaps}),
    // Ignore undefined values in plugin and localPlugins array Issue #1862
    plugins: userCfg?.plugins?.filter(Boolean) || [],
    localPlugins: userCfg?.localPlugins?.filter(Boolean) || []
  };
};

export {_init, _extractDefault};
