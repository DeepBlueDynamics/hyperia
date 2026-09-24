// Resolve the name a tab shows in the strip, mirroring lib/containers/header.ts's
// getTabs selector: an explicit rename (the root group's tabName) wins; a web-only
// tab uses its web name or URL host; a terminal tab uses its first terminal
// session's name. Shared so restore-time disambiguation (#183) compares against
// the SAME names the tab strip renders. A non-renamed tab has no tabName — its
// name comes from the session — so comparing tabName alone missed the collision
// and a restored copy kept the original's name.

type LeafGroup = {
  tabName?: string | null;
  children?: string[] | null;
  sessionUid?: string | null;
  webUrl?: string | null;
  webName?: string | null;
};

function leavesOf(termGroups: Record<string, any>, group: any): any[] {
  if (!group) return [];
  if (!group.children || group.children.length === 0) return [group];
  const out: any[] = [];
  for (const uid of group.children as string[]) out.push(...leavesOf(termGroups, termGroups[uid]));
  return out;
}

export function resolveTabDisplayName(
  root: LeafGroup,
  termGroups: Record<string, any>,
  sessions: Record<string, any>
): string {
  if (root.tabName) return root.tabName;
  const leaves = leavesOf(termGroups, root);
  const firstLeaf = leaves[0];
  const hasTerminal = leaves.some((l) => l?.sessionUid);
  const isWebTab = !!(firstLeaf && !firstLeaf.sessionUid) && !hasTerminal;
  if (isWebTab) {
    if (firstLeaf.webName) return firstLeaf.webName as string;
    const url = firstLeaf.webUrl as string;
    if (url) {
      if (url.startsWith('ai://')) return 'ask';
      try {
        return new URL(url).hostname || url;
      } catch {
        return url;
      }
    }
    return 'Browser';
  }
  const termLeaf = leaves.find((l) => l?.sessionUid);
  const session = termLeaf ? sessions[termLeaf.sessionUid as string] : null;
  return session ? session.tabName || session.title || 'Terminal' : 'Terminal';
}

// Display names of every open tab (root groups only), for restore-time collision
// checks — includes the auto/codenamed tabs that carry no explicit tabName.
export function openTabDisplayNames(termGroups: Record<string, any>, sessions: Record<string, any>): string[] {
  return Object.keys(termGroups)
    .filter((u) => termGroups[u] && !termGroups[u].parentUid)
    .map((u) => resolveTabDisplayName(termGroups[u], termGroups, sessions))
    .filter(Boolean);
}
