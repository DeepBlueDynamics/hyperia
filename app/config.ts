import {existsSync, readFileSync} from 'fs';

import {app} from 'electron';

import chokidar from 'chokidar';
import defaultShell from 'default-shell';

import type {parsedConfig, configOptions} from '../typings/config';

import {detectProfiles, pickDefaultProfile} from './config/detect';
import {_import, getDefaultConfig} from './config/import';
import _openConfig from './config/open';
import {cfgPath, cfgDir} from './config/paths';
import notify from './notify';
import {getColorMap} from './utils/colors';

const watchers: Function[] = [];
let cfg: parsedConfig = {} as any;
let _watcher: chokidar.FSWatcher;
let lastRawConfig = '';

export const getDeprecatedCSS = (config: configOptions) => {
  const deprecated: string[] = [];
  const deprecatedCSS = ['x-screen', 'x-row', 'cursor-node', '::selection'];
  deprecatedCSS.forEach((css) => {
    if (config.css?.includes(css) || config.termCSS?.includes(css)) {
      deprecated.push(css);
    }
  });
  return deprecated;
};

const checkDeprecatedConfig = () => {
  if (!cfg.config) {
    return;
  }
  const deprecated = getDeprecatedCSS(cfg.config);
  if (deprecated.length === 0) {
    return;
  }
  const deprecatedStr = deprecated.join(', ');
  notify('Configuration warning', `Your configuration uses some deprecated CSS classes (${deprecatedStr})`);
};

const _watch = () => {
  if (_watcher) {
    return;
  }

  const onChange = () => {
    // Need to wait 100ms to ensure that write is complete
    setTimeout(() => {
      try {
        if (existsSync(cfgPath)) {
          const raw = readFileSync(cfgPath, 'utf8');
          if (raw === lastRawConfig) {
            return;
          }
          lastRawConfig = raw;
        }
      } catch (err) {
        // ignore
      }
      cfg = _import();
      applyDetectedProfiles(cfg);
      notify('Configuration updated', 'Hyper configuration reloaded!');
      watchers.forEach((fn) => {
        fn();
      });
      checkDeprecatedConfig();
    }, 100);
  };

  _watcher = chokidar.watch(cfgPath);
  _watcher.on('change', onChange);
  _watcher.on('error', (error) => {
    console.error('error watching config', error);
  });

  app.on('before-quit', () => {
    if (Object.keys(_watcher.getWatched()).length > 0) {
      _watcher.close().catch((err) => {
        console.warn(err);
      });
    }
  });
};

export const subscribe = (fn: Function) => {
  watchers.push(fn);
  return () => {
    watchers.splice(watchers.indexOf(fn), 1);
  };
};

export const getConfigDir = () => {
  // expose config directory to load plugin from the right place
  return cfgDir;
};

export const getDefaultProfile = () => {
  // Find the first valid profile (where shell exists on this platform)
  const findValidProfile = () => {
    for (const profile of cfg.config.profiles || []) {
      if (profile.config?.shell) {
        try {
          if (existsSync(profile.config.shell)) {
            return profile.name;
          }
        } catch {
          // shell path doesn't exist, try next
        }
      }
    }
    return 'default';
  };

  // If defaultProfile is specified and valid, use it
  if (cfg.config.defaultProfile) {
    const profile = cfg.config.profiles?.find((p) => p.name === cfg.config.defaultProfile);
    if (profile?.config?.shell) {
      try {
        if (existsSync(profile.config.shell)) {
          return cfg.config.defaultProfile;
        }
      } catch {
        // configured default doesn't exist, fall through
      }
    }
  }

  // Fall back to first valid profile
  return findValidProfile();
};

// get config for the default profile, keeping it for backward compatibility
export const getConfig = () => {
  return getProfileConfig(getDefaultProfile());
};

export const getProfiles = () => {
  return cfg.config.profiles;
};

export const getProfileConfig = (profileName: string): configOptions => {
  const {profiles, defaultProfile, ...baseConfig} = cfg.config;
  const profileConfig = profiles.find((p) => p.name === profileName)?.config || {};
  for (const key in profileConfig) {
    if (typeof baseConfig[key] === 'object' && !Array.isArray(baseConfig[key])) {
      baseConfig[key] = {...baseConfig[key], ...profileConfig[key]};
    } else {
      baseConfig[key] = profileConfig[key];
    }
  }
  return {...baseConfig, defaultProfile, profiles};
};

export const openConfig = () => {
  return _openConfig();
};

export const getPlugins = (): {plugins: string[]; localPlugins: string[]} => {
  return {
    plugins: cfg.plugins,
    localPlugins: cfg.localPlugins
  };
};

export const getKeymaps = () => {
  return cfg.keymaps;
};

const applyDetectedProfiles = (configObj: parsedConfig) => {
  if (!configObj.config) return;
  const detected = detectProfiles();
  if (detected.length > 0) {
    configObj.config.profiles = configObj.config.profiles || [];
    for (const d of detected) {
      const idx = configObj.config.profiles.findIndex((p) => p.name === d.name);
      if (idx >= 0) {
        // Refresh system-detected profiles to the CURRENT detection (so e.g.
        // Nemesis8's command or a PowerShell version stays current) — but never
        // clobber a user-saved custom profile (those carry a `kind`).
        if (!(configObj.config.profiles[idx] as any).kind) {
          configObj.config.profiles[idx] = d;
        }
      } else {
        configObj.config.profiles.push(d);
      }
    }
    // Dedup system profiles that point at the SAME shell+args (stale duplicates
    // made several identical PowerShell buttons). Keep the first; never touch a
    // user-saved custom profile (those carry a `kind`).
    const normalizeShell = (shell: string): string => {
      if (!shell) return defaultShell.toLowerCase();
      let resolved = shell.trim().toLowerCase();
      if (process.platform === 'win32') {
        resolved = resolved.replace(/\//g, '\\').replace(/\\+/g, '\\');
        if (resolved === 'powershell.exe' || resolved === 'powershell') {
          return 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe';
        }
        if (resolved === 'pwsh.exe' || resolved === 'pwsh') {
          return 'c:\\program files\\powershell\\7\\pwsh.exe';
        }
        if (resolved === 'cmd.exe' || resolved === 'cmd') {
          return 'c:\\windows\\system32\\cmd.exe';
        }
      }
      return resolved;
    };
    const hasSpecificWsl = configObj.config.profiles.some((p) => p.name.startsWith('WSL:'));
    if (hasSpecificWsl) {
      configObj.config.profiles = configObj.config.profiles.filter((p) => p.name !== 'WSL' || (p as any).kind);
    }

    const seenShell = new Set<string>();
    configObj.config.profiles = configObj.config.profiles.filter((p: any) => {
      const resolvedShell = normalizeShell(p.config?.shell);
      const key = `${resolvedShell} ${JSON.stringify(p.config?.shellArgs || [])}`;
      if (p.kind) {
        seenShell.add(key);
        return true;
      }
      if (seenShell.has(key)) return false;
      seenShell.add(key);
      return true;
    });
    // Only override defaultProfile if it isn't set or doesn't exist in profiles list
    const current = configObj.config.defaultProfile;
    const valid = current && configObj.config.profiles.find((p) => p.name === current);
    if (!valid) {
      configObj.config.defaultProfile = pickDefaultProfile(detected);
    }
  }
};

export const setup = () => {
  cfg = _import();
  applyDetectedProfiles(cfg);
  try {
    if (existsSync(cfgPath)) {
      lastRawConfig = readFileSync(cfgPath, 'utf8');
    }
  } catch (err) {
    // ignore
  }
  _watch();
  checkDeprecatedConfig();
};

export {get as getWin, recordState as winRecord, defaults as windowDefaults} from './config/windows';

export const fixConfigDefaults = (decoratedConfig: configOptions) => {
  const defaultConfig = getDefaultConfig().config!;
  decoratedConfig.colors = getColorMap(decoratedConfig.colors) || {};
  // We must have default colors for xterm css.
  decoratedConfig.colors = {...defaultConfig.colors, ...decoratedConfig.colors};
  return decoratedConfig;
};

export const htermConfigTranslate = (config: configOptions) => {
  const cssReplacements: Record<string, string> = {
    'x-screen x-row([ {.[])': '.xterm-rows > div$1',
    '.cursor-node([ {.[])': '.terminal-cursor$1',
    '::selection([ {.[])': '.terminal .xterm-selection div$1',
    'x-screen a([ {.[])': '.terminal a$1',
    'x-row a([ {.[])': '.terminal a$1'
  };
  Object.keys(cssReplacements).forEach((pattern) => {
    const searchvalue = new RegExp(pattern, 'g');
    const newvalue = cssReplacements[pattern];
    config.css = config.css?.replace(searchvalue, newvalue);
    config.termCSS = config.termCSS?.replace(searchvalue, newvalue);
  });
  return config;
};
