// A link in terminal output is written by whatever program printed it, so only
// web and mail links may reach the OS (which runs file: and app-scheme links).
export function isSafeExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
