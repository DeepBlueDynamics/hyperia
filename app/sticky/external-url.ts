// shell.openExternal hands a URL to the OS; sticky text is agent-writable, so only web and mail links pass.
export function isSafeExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

// An agent-requested page (open_in_browser): a web page and nothing else.
export function isWebPageUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}
