#!/bin/sh
# Hyperia installer for macOS (arm64 + x64) and Linux
# Usage: curl -fsSL https://hyperia.nuts.services/install.sh | sh
set -e

REPO="DeepBlueDynamics/hyperia"
API="https://api.github.com/repos/$REPO/releases/latest"
RELEASES_URL="https://github.com/$REPO/releases"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)   PATTERN="mac-arm64.dmg" ;;
      x86_64)  PATTERN="mac-x64.dmg" ;;
      *)
        echo "Unsupported Mac architecture: $ARCH"
        exit 1
        ;;
    esac
    ;;
  Linux)
    echo "Linux builds are not yet available in automated form."
    echo "Check $RELEASES_URL for the latest packages."
    exit 1
    ;;
  *)
    echo "Unsupported OS: $OS. For Windows use:"
    echo "  powershell -c \"irm https://hyperia.nuts.services/install.ps1 | iex\""
    exit 1
    ;;
esac

echo "==> Fetching latest Hyperia release..."
DOWNLOAD_URL=$(curl -fsSL "$API" \
  | grep '"browser_download_url"' \
  | grep "$PATTERN" \
  | head -1 \
  | sed 's/.*"browser_download_url": "\(.*\)".*/\1/')

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Could not find a release asset matching $PATTERN"
  echo "Check $RELEASES_URL for manual download."
  exit 1
fi

VERSION=$(echo "$DOWNLOAD_URL" | grep -o '[0-9]*\.[0-9]*\.[0-9]*' | head -1)
echo "==> Downloading Hyperia $VERSION ($ARCH)..."

# BSD mktemp (macOS) only substitutes X's at the end of the template.
# Use -t to get a safe base path, then append .dmg.
TMP_BASE=$(mktemp -t hyperia)
TMP_DMG="${TMP_BASE}.dmg"
mv "$TMP_BASE" "$TMP_DMG"

curl -L --progress-bar "$DOWNLOAD_URL" -o "$TMP_DMG"

echo "==> Mounting disk image..."
# Use -mountpoint so we control the path — avoids parsing volume names with spaces.
MOUNT_POINT=$(mktemp -d -t hyperia-mount)
hdiutil attach "$TMP_DMG" -nobrowse -mountpoint "$MOUNT_POINT" -quiet

echo "==> Installing to /Applications..."
if [ -d "/Applications/Hyperia.app" ]; then
  echo "    Removing existing installation..."
  rm -rf "/Applications/Hyperia.app"
fi
cp -R "$MOUNT_POINT/Hyperia.app" /Applications/

echo "==> Cleaning up..."
hdiutil detach "$MOUNT_POINT" -quiet
rm -f "$TMP_DMG"
rmdir "$MOUNT_POINT" 2>/dev/null || true

echo ""
echo "Hyperia $VERSION installed successfully."
echo "Open it from /Applications/Hyperia.app or run: open /Applications/Hyperia.app"
