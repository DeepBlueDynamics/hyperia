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

# CLI launcher symlink — point /usr/local/bin/<executable> at the real
# binary in /opt. The previous template pointed at resources/bin/<exe>
# which doesn't exist in our packaging; `which hyperia` returned nothing
# on Ubuntu.
mkdir -p /usr/local/bin
ln -sf '/opt/${productFilename}/${executable}' '/usr/local/bin/${executable}'
