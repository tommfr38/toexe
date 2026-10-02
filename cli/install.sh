#!/usr/bin/env bash
# Installs the `toexe` command globally from this directory.
#
#   ./install.sh              npm install -g  (copies the package into your global prefix)
#   ./install.sh --link       npm link        (symlinks; edits here take effect immediately)
#   ./install.sh --uninstall  remove the global command
#
# Needs Node.js 18+ and npm. If your npm global prefix is not writable, see the hint printed on failure.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="install"
for arg in "$@"; do
  case "$arg" in
    --link) MODE="link" ;;
    --uninstall) MODE="uninstall" ;;
    -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required but 'node' was not found. Install it from https://nodejs.org or with Homebrew: brew install node" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18 or newer is required (found $(node -v))." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. It normally ships with Node.js." >&2
  exit 1
fi

fail_hint() {
  cat >&2 <<HINT

npm could not write to its global prefix ($(npm config get prefix)).
Options:
  - Use a user-owned prefix:   npm config set prefix "\$HOME/.npm-global"  and add \$HOME/.npm-global/bin to PATH
  - Or run with sudo (not recommended):   sudo ./install.sh
HINT
  exit 1
}

case "$MODE" in
  install)
    npm install -g "$DIR" || fail_hint
    ;;
  link)
    (cd "$DIR" && npm link) || fail_hint
    ;;
  uninstall)
    npm uninstall -g toexe || fail_hint
    echo "toexe removed."
    exit 0
    ;;
esac

echo
echo "Installed. Try:  toexe --help"
echo "Then cd into a folder that contains .app bundles and run:  toexe"
