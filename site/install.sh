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
    case "$ARCH" in
      x86_64|amd64)
        # Prefer .deb on dpkg-based systems (Ubuntu/Debian/Mint/Pop!_OS),
        # fall back to AppImage everywhere else.
        if command -v dpkg >/dev/null 2>&1; then
          PATTERN="amd64.deb"
          INSTALL_KIND="deb"
        else
          PATTERN="x86_64.AppImage"
          INSTALL_KIND="appimage"
        fi
        ;;
      *)
        echo "Unsupported Linux architecture: $ARCH (only x86_64/amd64 builds exist)."
        echo "Check $RELEASES_URL for available packages."
        exit 1
        ;;
    esac
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

if [ "$OS" = "Linux" ]; then
  EXT="${INSTALL_KIND}"
  case "$INSTALL_KIND" in
    deb)      TMP_FILE="/tmp/hyperia-${VERSION}.deb" ;;
    appimage) TMP_FILE="$HOME/.local/bin/Hyperia-${VERSION}.AppImage" ;;
  esac
  mkdir -p "$(dirname "$TMP_FILE")"
  curl -L --progress-bar "$DOWNLOAD_URL" -o "$TMP_FILE"

  case "$INSTALL_KIND" in
    deb)
      echo "==> Installing .deb via apt (will prompt for sudo)..."
      if sudo apt-get install -y "$TMP_FILE"; then
        rm -f "$TMP_FILE"
        echo ""
        echo "Hyperia $VERSION installed. Launch from your application menu, or run: hyperia"
      else
        echo ""
        echo ".deb install failed. Try: sudo dpkg -i $TMP_FILE && sudo apt-get -f install"
        exit 1
      fi
      ;;
    appimage)
      chmod +x "$TMP_FILE"
      echo ""
      echo "Hyperia $VERSION AppImage saved to $TMP_FILE"
      echo "Run it: $TMP_FILE"
      ;;
  esac
  exit 0
fi

# --- macOS path ---
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
# Resolve the actual .app bundle inside the image. Its name follows productName
# (e.g. "Hyperia-Terminal.app"), so NEVER hardcode it — a hardcoded "Hyperia.app"
# is what broke installs after the app was renamed (cp: …/Hyperia.app: no such
# file or directory).
APP_PATH=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" | head -1)
if [ -z "$APP_PATH" ]; then
  echo "No .app found in the downloaded image — aborting."
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  rm -f "$TMP_DMG"
  exit 1
fi
APP_NAME=$(basename "$APP_PATH")

# Remove any previously-installed Hyperia under ANY of its past names so a rename
# never leaves a stale or duplicate app behind.
for OLD in "Hyperia.app" "Hyperia2.app" "Hyperia Terminal.app" "Hyperia-Terminal.app" "$APP_NAME"; do
  if [ -d "/Applications/$OLD" ]; then
    echo "    Removing existing /Applications/$OLD ..."
    rm -rf "/Applications/$OLD"
  fi
done

cp -R "$APP_PATH" /Applications/

echo "==> Cleaning up..."
hdiutil detach "$MOUNT_POINT" -quiet
rm -f "$TMP_DMG"
rmdir "$MOUNT_POINT" 2>/dev/null || true

echo ""
echo "Hyperia $VERSION installed successfully."
echo "Open it from /Applications/$APP_NAME or run: open \"/Applications/$APP_NAME\""
