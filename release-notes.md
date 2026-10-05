# Hyperia v0.21.7 — mail that reads like mail, toasts you can see 📬

Agent mail notices now arrive for every message, approval toasts show over web pages, and restored tabs stop doubling their prompt.

## Agent mail

- **A notice for every message.** Each new message drops a one-line, email-style header into the recipient's pane: who it's from, when, the subject, and how many are unread. Bursts arriving within 5 seconds merge into one notice.
- **Approvals no longer send mail.** Approving an agent's queued operation used to mail the sender a "delivered" note it already knew about, and that noise could hold back real notices. It's gone. Denials still tell the sender.

## Toasts over web panes

- Approval cards and notifications at the top of the window now draw **above web panes** instead of hiding behind them, without freezing the page underneath.
- On Windows, the minimized pill and the card buttons up in the title-bar strip are clickable again, not just their border.

## Restore

- Restored shells start at the size they were saved at, so a restored pane no longer shows its prompt twice.

## For contributors

The dev harness now checks the toast layer too: `node scripts/dev-harness.js`.

Coming from further back? [v0.21.4](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.21.4) fixed stray tabs and sticky saving and added autosave for saved tabs.
