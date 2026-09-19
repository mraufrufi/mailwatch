#!/usr/bin/env bash
# Installs Mail Watch for the current user.
set -euo pipefail
UUID="mailwatch@rauf"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC="$(cd "$(dirname "$0")" && pwd)"

command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/
glib-compile-schemas "$DEST/schemas"
chmod +x "$DEST/helper/imap_helper.py"

echo "Installed to $DEST"
echo "On Wayland, log out and back in so GNOME Shell discovers the extension, then run:"
echo "  gnome-extensions enable $UUID && gnome-extensions prefs $UUID"
