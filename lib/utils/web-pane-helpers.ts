// Match a real Chrome UA so sites don't block the request
// Use the REAL Chromium UA, just stripped of the Electron + app product tokens.
// Keeping the genuine Chrome version keeps the UA consistent with the Sec-CH-UA
// client hints Chromium emits — a hardcoded/mismatched version trips Cloudflare/
// Wordfence bot checks, which 403 a site's /wp-content + /wp-includes assets and
// leave the page rendering bare (e.g. seths.blog).
export const BROWSER_UA = (() => {
  const FALLBACK =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
  try {
    let ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (!ua) return FALLBACK;
    // Drop "Electron/x.y.z" and the app product (Hyper/Hyperia/x.y.z).
    ua = ua.replace(/\s*(?:Electron|Hyper\w*)\/\S+/gi, '');
    // Freeze the Chrome version to real-Chrome's frozen form (major.0.0.0) so
    // navigator.userAgent matches the sec-ch-ua client hints the main process
    // rewrites onto outgoing requests (see app/ui/window.ts configureWebPaneSession).
    // A UA/client-hint mismatch is exactly what Cloudflare's "Just a moment…"
    // challenge flags as a bot.
    ua = ua.replace(/Chrome\/(\d+)\.\d+\.\d+(?:\.\d+)?/i, 'Chrome/$1.0.0.0');
    const moz = ua.indexOf('Mozilla/');
    return (moz > 0 ? ua.slice(moz) : ua).replace(/\s{2,}/g, ' ').trim();
  } catch {
    return FALLBACK;
  }
})();

export const getSecurityState = (urlStr: string): 'https' | 'http' | 'localhost' | 'error' => {
  try {
    const trimmed = urlStr.trim();
    if (!trimmed) return 'error';
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed);
    const hostname = parsed.hostname;

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.test')
    ) {
      return 'localhost';
    }

    if (parsed.protocol === 'https:') {
      return 'https';
    }

    if (parsed.protocol === 'http:') {
      return 'http';
    }

    return 'error';
  } catch (err) {
    return 'error';
  }
};

// Normalised key for de-duping history: lowercase scheme+host and strip trailing
// slashes off the path — so "x.com", "x.com/", and "https://x.com/" collapse to
// a single entry. Query + hash are kept (different ?q= are different pages).
export const normalizeUrlKey = (u: string): string => {
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return u.trim().toLowerCase().replace(/\/+$/, '');
  }
};

// The site's own favicon (no third-party lookup). Used in history rows instead
// of the lock/security glyphs; falls back to a globe if it 404s.
export const faviconForUrl = (u: string): string => {
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u);
    return `${parsed.protocol}//${parsed.host}/favicon.ico`;
  } catch {
    return '';
  }
};

const OAUTH_HOST_RE =
  /(^|\.)(accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|login\.live\.com|github\.com\/login\/oauth|gitlab\.com\/users\/sign_in)/i;
export const isOAuthUrl = (u: string): boolean => {
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return OAUTH_HOST_RE.test(parsed.host) || OAUTH_HOST_RE.test(parsed.host + parsed.pathname);
  } catch {
    return false;
  }
};

export const isValidUrl = (urlStr: string): boolean => {
  const trimmed = urlStr.trim();
  if (!trimmed) return false;

  if (/^(localhost|127\.0\.0\.1|.*\.local|.*\.test)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return true;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      new URL(trimmed);
      return true;
    } catch (_) {
      return false;
    }
  }

  if (/^[a-z0-9]+([-.][a-z0-9]+)*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return true;
  }

  return false;
};

// Group key: scheme://host/<first-path-segment>. Collapses e.g. every
// google.com/maps/@lat,lng,zoom URL under one "google.com/maps" root, so a
// session that spammed many URLs (Maps, search) becomes one expandable entry.
// Collapse key: scheme://host + full path truncated at the first "special"
// character (! ? @ # & = ; , ~ * + and more). Query/fragment already live in
// .search/.hash so they're excluded; the path truncation folds in-path noise
// (e.g. /maps/@lat,lng, /!bangs). Distinct pages keep their full path and stay
// separate — only variants of the SAME page collapse together.
export const historyRootKey = (value: string): string => {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(value) ? value : 'https://' + value);
    let path = u.pathname;
    const m = path.match(/[!?@#&=;,~*+$%^]/);
    if (m?.index !== undefined && m.index > 0) path = path.slice(0, m.index);
    return `${u.protocol}//${u.host}${path}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return value.split(/[!?@#&=;,~*+$%^]/)[0].toLowerCase();
  }
};
