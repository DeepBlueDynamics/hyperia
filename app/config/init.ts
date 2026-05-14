import {existsSync} from 'fs';
import vm from 'vm';

import merge from 'lodash/merge';

import type {parsedConfig, rawConfig, configOptions} from '../../typings/config';
import notify from '../notify';
import mapKeys from '../utils/map-keys';

// Probe candidate Windows shells in priority order. Returns the profile
// definitions for whichever ones actually exist on this machine.
// Skipped entirely on non-Windows platforms.
function detectWindowsShells(): Array<{name: string; config: {shell: string; shellArgs: string[]}}> {
  if (process.platform !== 'win32') return [];
  const candidates: Array<{name: string; shell: string; shellArgs: string[]}> = [
    // PowerShell 7+ (Microsoft Store + MSI install paths)
    {name: 'PowerShell', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', shellArgs: []},
    // Windows PowerShell 5.1 (always present on modern Windows)
    {
      name: 'Windows PowerShell',
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      shellArgs: []
    },
    // Command Prompt (always present)
    {name: 'CMD', shell: 'C:\\Windows\\System32\\cmd.exe', shellArgs: []},
    // WSL — only present if the optional Windows feature is installed
    {name: 'WSL', shell: 'C:\\Windows\\System32\\wsl.exe', shellArgs: []}
  ];
  return candidates
    .filter((c) => existsSync(c.shell))
    .map((c) => ({name: c.name, config: {shell: c.shell, shellArgs: c.shellArgs}}));
}

// Decide a sensible default profile name from a list of profile names,
// preferring shells in the order pwsh > powershell > cmd > wsl > first.
function pickWindowsDefault(profileNames: string[]): string | null {
  if (process.platform !== 'win32') return null;
  const preference = ['PowerShell', 'Windows PowerShell', 'CMD', 'WSL'];
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
        conf.profiles = conf.profiles || [];
        conf.profiles = conf.profiles.length > 0 ? conf.profiles : [{name: 'default', config: {}}];
        conf.profiles = conf.profiles.map((p, i) => ({
          ...p,
          name: p.name || `profile-${i + 1}`,
          config: p.config || {}
        }));

        // Windows: probe for installed shells and merge in profiles for any
        // we find that aren't already configured (PowerShell, Windows
        // PowerShell, CMD, WSL). User's existing profiles win on name
        // collision.
        const detected = detectWindowsShells();
        if (detected.length > 0) {
          const existingNames = new Set(conf.profiles.map((p) => p.name));
          for (const d of detected) {
            if (!existingNames.has(d.name)) {
              conf.profiles.push(d);
            }
          }
        }

        // Resolve defaultProfile. If user explicitly set one that resolves,
        // honor it. Otherwise on Windows prefer pwsh > powershell > cmd > wsl;
        // otherwise fall back to the first profile.
        const profileNames = conf.profiles.map((p) => p.name);
        if (!profileNames.includes(conf.defaultProfile) || conf.defaultProfile === 'default') {
          const winDefault = pickWindowsDefault(profileNames);
          conf.defaultProfile = winDefault || conf.profiles[0].name;
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
