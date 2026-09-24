// Pure wording/layout decisions for the centered 🛂 consent prompt
// (components/consent-modal.tsx). Kept free of Electron/React so the three
// variants — pane access, messaging, mailbox binding — are unit-testable.

export type ConsentKind = 'access' | 'message' | 'bind';

export type ConsentVariant = {
  kind: ConsentKind;
  /** Middle of the header: "<requester> {verb} <target>". */
  verb: string;
  /** Header tail after the target, e.g. "— approving delivers the waiting message." */
  tail: string;
  /** Fixed, non-interactive Access chip; null → the interactive pane/tab/any choice. */
  accessChip: string | null;
  /** Whether the For (15 min · 1 hour · Always) row applies. */
  showDuration: boolean;
};

export function consentVariant(action?: string): ConsentVariant {
  if (action?.startsWith('message:')) {
    return {
      kind: 'message',
      verb: ' wants to send a message to ',
      tail: '— approving delivers the waiting message.',
      accessChip: 'This recipient',
      showDuration: true
    };
  }
  if (action?.startsWith('bind:')) {
    return {
      kind: 'bind',
      verb: ' wants to associate its mailbox with ',
      tail: '— approving links its mailbox to this pane.',
      accessChip: 'This pane',
      // A binding is a one-time association — there's no grant to time-box.
      showDuration: false
    };
  }
  return {
    kind: 'access',
    verb: ' wants to control ',
    tail: '— its tab is flashing 🔔. Approving releases the waiting operation.',
    accessChip: null,
    showDuration: true
  };
}

/** The request fields the target-name resolution reads. */
export type ConsentTarget = {
  targetPane: string;
  action?: string;
  /** Sidecar-supplied friendly recipient (agent label or pane name), messaging only. */
  recipientLabel?: string;
};

/**
 * Friendly name for the prompt's "where". Messaging prefers the recipient
 * agent's label (sidecar-supplied, else parsed from `message:agent:<name>`),
 * then the pane's own name. A raw id fragment only when nothing better is known.
 */
export function consentTargetName(req: ConsentTarget, sessionName?: string): string {
  // Sentinel targets aren't panes: __audio__ gates host audio (epic #162).
  if (req.targetPane === '__audio__') return '🔊 audio on this machine';
  if (consentVariant(req.action).kind === 'message') {
    const label = req.recipientLabel?.trim();
    if (label) return label;
    const agent = req.action?.startsWith('message:agent:') ? req.action.slice('message:agent:'.length).trim() : '';
    if (agent) return agent;
  }
  if (sessionName) return sessionName;
  return `pane ${req.targetPane.replace(/^(pane|agent):/, '').slice(0, 8)}`;
}

/** Longest subject shown before the ellipsis (full text stays in a tooltip). */
export const SUBJECT_MAX = 80;

/**
 * The "Subject: …" line for a messaging prompt, or null when there's none to
 * show. Only the subject — the message body never reaches the prompt.
 */
export function consentSubject(
  req: {action?: string; subject?: string},
  max = SUBJECT_MAX
): {text: string; full: string} | null {
  if (consentVariant(req.action).kind !== 'message') return null;
  const full = (req.subject || '').replace(/\s+/g, ' ').trim();
  if (!full) return null;
  const chars = Array.from(full); // code points, so an emoji is never split
  const text =
    chars.length > max
      ? chars
          .slice(0, max - 1)
          .join('')
          .trimEnd() + '…'
      : full;
  return {text, full};
}
