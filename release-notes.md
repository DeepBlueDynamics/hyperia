# Hyperia v0.20.20 — every agent gets its own voice 🐙

Spoken summaries got a rebuild, web panes got a Stop button, and a batch of agent-plumbing fixes make the swarm quieter and more reliable.

## A voice for every pane

Text-to-speech is rewritten in Rust on top of the Kokoro model: no Python, no espeak. Pronunciation comes from the misaki 0.9.4 dictionaries, downloaded once on first use. Every English voice is available.

Each agent now speaks in its own voice. The pane's name is hashed into a blend of voices, so two agents never sound alike, and the same pane always sounds the same. An agent signs off with its pane name as its callsign and ends with "Over and out." Agents running several sessions speak as the pane they live in.

## Web panes: Stop, and a Back that works

- A **Stop** button (and **Esc**) halts a page that's stuck loading. It turns back into Reload when the page is done.
- **Back** and **Forward** stop the current load first, so going back from a slow page is instant.
- The spinner follows the page itself, not ads and embedded frames that never finish, and no longer clears early while the next page is still starting.
- Switching tabs no longer re-checks the page or flashes white.

## Picker opens the shell it shows

The directory picker's **Go** button and new panes now launch the shell the pulldown shows: your last-used shell. Launching a shell no longer quietly changes your default profile.

The recent-directory chips have a **clear** button.

## Consent prompts that clean up after themselves

A permission prompt disappears as soon as its request is gone: answered elsewhere, expired, or its pane closed. Clicking a stale prompt no longer does nothing. Access, messaging and pane-binding prompts share one layout.

## Agent messaging and identity

- Agents using a pane token can check their mail again (a deadlock is fixed).
- Delivery responses say what actually happened. Queued messages no longer claim to be "waiting for approval".
- Container agents can register as a single session, and child sessions read their parent's mail.
- Clearer notices when two agents claim the same pane, plus stable identity error codes.

## Small fixes

- **Ctrl+^** reaches the terminal, so nemesis8's detach key works.
- Tests only listen on 127.0.0.1, which ends the Windows Firewall prompts during development.

Coming from further back? [v0.20.12](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.20.12) made the picker's install buttons open a real shell, and [v0.20.11](https://github.com/DeepBlueDynamics/hyperia/releases/tag/v0.20.11) brought the directory picker, correctly sized terminals and per-session agent identity.
