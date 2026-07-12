#!/bin/bash
# postinst — runs after dpkg/rpm unpack. ${...} placeholders are
# substituted by electron-builder at packaging time.
set -e

# Electron's SUID sandbox helper must be owned by root and mode 4755 or
# Electron aborts at startup with:
#   FATAL: sandbox/linux/suid/client/setuid_sandbox_host.cc:166
#   The SUID sandbox helper binary was found, but is not configured correctly.
# electron-builder doesn't apply this by default, so a fresh .deb / .rpm
# install crashes on first launch. This block sets it explicitly. See
# https://github.com/electron/electron/issues/17972 for the upstream issue.
if [ -f '/opt/${productFilename}/chrome-sandbox' ]; then
  chown root:root '/opt/${productFilename}/chrome-sandbox' || true
  chmod 4755 '/opt/${productFilename}/chrome-sandbox' || true
fi

# CLI launcher symlink (#137). Prefer the MCP CLI wrapper (build/${os}/hyperia,
# packaged into resources/bin/) so `hyperia status|run|call|doctor|...` drives
# the running sidecar and bare `hyperia` still launches the GUI. Pointing the
# symlink at the raw GUI binary — as this template previously did — made
# `hyperia <anything>` hit the app's "does not accept command line arguments"
# guard, shadowing the whole CLI. Fall back to the GUI binary if the wrapper
# isn't present, so behavior is never worse than before.
mkdir -p /usr/local/bin
HYPERIA_CLI_WRAPPER='/opt/${productFilename}/resources/bin/hyperia'
if [ -f "$HYPERIA_CLI_WRAPPER" ]; then
  chmod +x "$HYPERIA_CLI_WRAPPER" || true
  ln -sf "$HYPERIA_CLI_WRAPPER" '/usr/local/bin/${executable}'
else
  ln -sf '/opt/${productFilename}/${executable}' '/usr/local/bin/${executable}'
fi
