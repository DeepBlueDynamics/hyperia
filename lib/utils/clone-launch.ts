/**
 * What a "clone" re-launches for a pane — the single decision shared by the
 * split clone buttons, the pane:clone* keybindings and clone quick layouts.
 * Pure (no electron/store) so ava can exercise it.
 */
import {reportedCommand, wasRunning} from './workspace-tab';

export type CloneLaunch = {
  /** Profile the new pane launches (agent profiles ARE the program: "claude code", "nemesis8 danger"). */
  profile: string;
  /** Shell-integration-reported foreground command to run once in the new shell (e.g. `n8 --danger`). */
  command?: string;
  cwd?: string;
};

type ProfileLike = {name?: string; kind?: string};

// Mirrors the picker's AGENT_NAMES: detected agent profiles arrive under these names.
const AGENT_PROFILE_NAMES = new Set([
  'claude code',
  'nemesis8',
  'nemesis8 danger',
  'antigravity',
  'codex',
  'opencode',
  'grok',
  'hermes',
  'pi'
]);

export const isAgentProfile = (name: string, profiles: ProfileLike[] = []): boolean => {
  const lower = name.trim().toLowerCase();
  if (AGENT_PROFILE_NAMES.has(lower)) return true;
  return profiles.some((p) => p?.name === name && p.kind === 'agent');
};

/**
 * Decide what cloning `session` launches. Profile always carries over (its
 * shell + shellArgs resolve in main); a plain shell that is RUNNING a program
 * also re-runs that program. Only the trusted shell-reported command is used
 * (never the screen-scraped lastCommand), and never n8Binding.resume — that
 * would attach every clone to the SAME n8 session instead of a fresh one.
 */
export const cloneLaunchFor = (session: any, profiles: ProfileLike[] = []): CloneLaunch => {
  const profile = typeof session?.profile === 'string' && session.profile ? session.profile : '';
  if (!profile || profile === 'picker') {
    return {profile: 'picker', cwd: session?.cwd || undefined};
  }
  const out: CloneLaunch = {profile, cwd: session.cwd || undefined};
  if (!isAgentProfile(profile, profiles)) {
    const cmd = reportedCommand(session);
    if (cmd && wasRunning(session)) out.command = cmd;
  }
  return out;
};

/** Short human description for hints: "`n8 --danger` (in pwsh)", "claude code", or "". */
export const describeCloneLaunch = (launch: CloneLaunch | undefined): string => {
  if (!launch || launch.profile === 'picker') return '';
  return launch.command ? `\`${launch.command}\` (in ${launch.profile})` : launch.profile;
};
