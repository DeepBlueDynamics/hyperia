# Hyperia v0.21.11 — overwatch: your agents, their files and their network in 3D 🛰️

The dashboard's proto_viz becomes a live 3D overwatch of everything your agents do: the files they touch, the network they use, what's on their screens and what they say on the radio. Hyperia also learns what agents running directly on your machine are doing, and mail notices stop getting stuck.

## Overwatch (dashboard → proto_viz)

- **A 3D floor.** Agents and panes stand on a disk, each in a slice of its own Hyperia colour, grouped by tab, with the tab's name on the rim. Drag to move around, **Ctrl+drag** to tip and orbit, scroll to zoom. **3D/2D** buttons switch between the tilted view and straight down. Names keep their place on the ring.
- **Files above the floor.** Files agents touched in the last 15 minutes float above the disk as a directory tree, with folders as junctions (`crates/` links its crates). Threads drop to the panes that changed them, and dotted threads to the panes that only read them. History mode shows the last 24 hours or 7 days.
- **Edit in place.** Double-click a file to open it in an editor window: tabs, line numbers, syntax colours, find/replace, go to line. Saves are conflict-checked against changes an agent made meanwhile. Markdown (and text files that read as Markdown) has a **Rendered** view, including README HTML like `<div align="center">`. Links in it work.
- **Screens.** Hover a pane's slice to see its live terminal on a little retro monitor at the rim. Click it and the camera flies in until the screen fills the view; the ring keeps turning below. Click again to fly out. **▣ screens** turns them off.
- **Activity.** A working pane's name gets a halo that pulses with its output and spins while it prints.
- **Network.** Containers hang off a blue marble (Docker or Podman) below a NET uplink. Received traffic drops down into the marble and branches out to each container; sent traffic rises. Agents running directly on your machine link straight to the uplink. Idle chatter looks idle; busy traffic stands out.
- **Radio.** Every spoken transmission is logged with its audio. While one plays, waves and a live audio spectrum radiate from the agent that sent it. The radio panel lists them, newest first, with the summary and a replay button.
- **Sound.** Optional sound effects for comms, file changes and selections (♪ to toggle).

## Agents on your machine, not just in containers

- **Their files.** Hyperia watches the folder of each agent pane, and of any terminal an agent is driving, so a build an agent runs shows up. The view keeps its file history through restarts.
- **Their network.** New agent panes route HTTPS through a small byte-counting proxy inside Hyperia (local only, nothing is decrypted), so each pane's traffic is exact. Panes already running show an approximation from process I/O, marked `~`. A proxy you set yourself always wins. Set `agentNetworkProxy: false` to turn it off.
- **Claude Code telemetry.** Claude Code in a pane reports tokens and file edits to Hyperia, and Hyperia forwards file activity to the n8 gateway.

## Radio call signs

When hertz radio may reach an agent pane, the pane gets a two-word call sign (like BRAVO TANGO) in a gold badge, shown while the radio is in use. Say it on the radio to reach that pane. Each sign works once and is replaced the moment it's used, so a sign heard over the air or replayed can't be reused. Signs no longer change while an agent is busy running a tool.

## Fixes

- **Mail notices** no longer get held when you've left Hyperia for another app. Hyperia now reports whether it's in front every couple of seconds, so one missed focus change can't leave a pane's notices waiting.
- **Shell state survives a sidecar reconnect.** A reconnect no longer wipes what each pane is running, which had stopped mail notices to agents.
- **Pane names** survive a sidecar restart.
- **Renaming a tab:** selecting text in the rename box no longer ends the rename.

Coming from further back? [v0.21.8](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.21.8) brought web-pane downloads, the first proto_viz and mail notices for agents in n8 containers.
