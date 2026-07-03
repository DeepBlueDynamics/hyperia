// Smart omnibox routing shared by the new-pane picker (term.tsx → submitUrl) and
// the web pane (web-pane.tsx → navigateWebview). Turns a raw input-box value into
// something a webview can load:
//
//   1. Already absolute (has a scheme: http://, https://, file://, ai://, …) → as-is.
//   2. localhost / loopback (optionally :port/path) → http:// — the ONLY http case.
//   3. A whitespace-free token made entirely of URL-legal characters (a dotted
//      host like example.com, or e.g. a single-label host:port) → https://
//      (NEVER http:// for these).
//   4. Anything else (contains whitespace, or characters not valid in a URL) →
//      a DuckDuckGo search query.
//
// A dotted host that LOOKS valid but fails to resolve (e.g. news.hackernews.com)
// is caught downstream by the web pane's did-fail-load → DDG fallback.
export function toNavigableUrl(input: string): string {
  const t = (input || '').trim();
  if (!t) return t;

  // 1. Already has a scheme (http/https/file/ai/…) — pass through untouched.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;

  // 2. Loopback hosts are the only thing we serve over plain http://.
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:\d+)?(\/.*)?$/i.test(t)) {
    return 'http://' + t;
  }

  // 3. Host-LIKE tokens only: a dotted host (example.com, sub.host.io/path) or
  //    an explicit host:port (myhost:8080). A bare word ("hello") is NOT a
  //    host — it won't resolve, so it falls through to search instead of
  //    dead-ending at https://hello.
  if (/^[\w-]+(\.[\w-]+)+([:/?#].*)?$/.test(t) || /^[\w-]+:\d+([/?#].*)?$/.test(t)) {
    return 'https://' + t;
  }

  // 4. Everything else (bare words, free text, spaces) → search.
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(t);
}
