#!/bin/sh
# Builds the release artifacts for toexe:
#
#   dist/toexe.tar.gz          package.json, bin/, src/, README.md from cli/
#   dist/toexe.tar.gz.sha256   "<sha256>  toexe.tar.gz"
#
# The tarball has no wrapper directory: extracting it into an empty folder gives
#   package.json  bin/toexe.js  src/*.js  README.md
# which is exactly what install.sh unpacks into ~/.toexe.
#
# Usage: scripts/build-release.sh [vX.Y.Z]
#   If a tag is given, it must match the version in cli/package.json.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/cli"
DIST="$ROOT/dist"

[ -f "$CLI/package.json" ] || { echo "build-release: $CLI/package.json not found" >&2; exit 1; }

VERSION="$(node -p "require('$CLI/package.json').version")"
if [ $# -ge 1 ]; then
  if [ "${1#v}" != "$VERSION" ]; then
    echo "build-release: tag '$1' does not match cli/package.json version '$VERSION'" >&2
    exit 1
  fi
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/toexe-build.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT INT TERM HUP

cp "$CLI/package.json" "$CLI/README.md" "$STAGE/"
cp -R "$CLI/bin" "$CLI/src" "$STAGE/"
find "$STAGE" \( -name '.DS_Store' -o -name '._*' -o -name 'node_modules' \) -prune -exec rm -rf {} +
chmod -R u+rwX,go+rX,go-w "$STAGE"
chmod +x "$STAGE/bin/toexe.js"

rm -rf "$DIST"
mkdir -p "$DIST"
# COPYFILE_DISABLE stops macOS tar from adding AppleDouble (._*) entries.
COPYFILE_DISABLE=1 tar -czf "$DIST/toexe.tar.gz" -C "$STAGE" package.json README.md bin src

(
  cd "$DIST"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 toexe.tar.gz > toexe.tar.gz.sha256
  else
    sha256sum toexe.tar.gz > toexe.tar.gz.sha256
  fi
)

echo "Built toexe $VERSION"
echo "  $DIST/toexe.tar.gz"
echo "  $DIST/toexe.tar.gz.sha256 ($(cut -d' ' -f1 "$DIST/toexe.tar.gz.sha256"))"
