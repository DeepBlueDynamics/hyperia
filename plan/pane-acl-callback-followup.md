# Follow-up: approval callback to the requesting pane

Requested by Kord on 2026-09-17. Investigate after pane access and the sticky startup regression.

## Observed

- After Hyperia restart and tab/session restore, a terminal_split request returned pending/held.
- Kord approved it. The new Public Locust pane (9521e364-78bb-4ace-ad41-f8c28889b57a) appeared to the right of the requesting Amused Lark pane (3180a99f-038d-41c5-beab-ca5ee1884eda).
- Root confirmed completion with terminal_status; no completion callback was observed in the conversation before that manual check.
- Freshly read n8 pane identity file still contained the older pane ID 19731031-2ba6-4611-9a98-34fc6bff6261. This is evidence of a stale mapping, not yet proof of the callback's cause.
- request_access for the new pane subsequently returned granted:true.

## Investigate later

Trace consent completion back to the requesting pane, including n8 re-attach mapping, the MCP identity/header's requester pane, and approval delivery after the synchronous wait expires. Determine whether the callback was absent, sent to an old pane, or not ingested by the resumed agent. Do not assume this caused the separate sticky startup bug.

Acceptance: approve a held request after app restart/session restore; the requesting live pane receives one accurate completion notification without a duplicate command or focus change.
