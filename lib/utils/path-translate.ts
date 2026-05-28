import type {PathTranslate} from '../../typings/config';

/**
 * Pure function to translate a Windows host path into the path format expected by
 * the target terminal profile (WSL, Docker bind mount, or identity/verbatim).
 */
export function translatePath(windowsPath: string, config?: PathTranslate): string {
  if (!config) return windowsPath;

  switch (config.kind) {
    case 'wsl': {
      // Convert C:\Users\kordl\.hyperia\assets\foo.png to /mnt/c/Users/kordl/.hyperia/assets/foo.png
      let p = windowsPath.replace(/\\/g, '/');
      const driveMatch = p.match(/^([a-zA-Z]):\/(.*)/);
      if (driveMatch) {
        const drive = driveMatch[1].toLowerCase();
        const rest = driveMatch[2];
        return `/mnt/${drive}/${rest}`;
      }
      return p;
    }
    case 'docker-mount': {
      // Substitute hostPrefix with containerPrefix
      const hostPrefix = config.hostPrefix || '~/.hyperia/assets';
      const containerPrefix = config.containerPrefix || '/host/paste';
      
      let normalizedPath = windowsPath.replace(/\\/g, '/');
      let normalizedHostPrefix = hostPrefix.replace(/\\/g, '/');
      
      if (normalizedHostPrefix.startsWith('~/')) {
        const home = (process.env.USERPROFILE || process.env.HOME || '').replace(/\\/g, '/');
        normalizedHostPrefix = normalizedHostPrefix.replace('~', home);
      }

      // Perform a case-insensitive prefix check to handle Windows drive/path variations robustly
      const pathLower = normalizedPath.toLowerCase();
      const prefixLower = normalizedHostPrefix.toLowerCase();
      
      if (pathLower.startsWith(prefixLower)) {
        const relative = normalizedPath.slice(normalizedHostPrefix.length);
        const relativeClean = relative.startsWith('/') ? relative : '/' + relative;
        return containerPrefix + relativeClean;
      }
      
      return windowsPath;
    }
    case 'identity':
    default:
      return windowsPath;
  }
}
