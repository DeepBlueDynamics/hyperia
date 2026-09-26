// shell.openExternal hands a URL to the OS; sticky text is agent-writable, so only web and mail links pass.
export function isSafeExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
