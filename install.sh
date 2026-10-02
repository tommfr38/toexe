#!/bin/sh
# toexe installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/install.sh | sh -s -- --version v0.1.0
#
# Downloads the toexe release tarball from GitHub, verifies its SHA-256
# checksum, unpacks it into ~/.toexe and puts a `toexe` launcher in
# ~/.local/bin. No sudo, no npm, no global changes. Needs Node.js 18+.
#
# Options:
#   --version <tag>   install a specific release (e.g. v0.1.0) instead of the latest
#   --modify-path     append the PATH line to your shell rc file (zsh/bash) if needed
#   --dry-run         show what would happen, change nothing
#   --uninstall       remove toexe (same as uninstall.sh)
#   -h, --help        show this help
#
# Environment variables:
#   TOEXE_REPO         GitHub "owner/name" to download from   (default: see below)
#   TOEXE_HOME         install directory                       (default: ~/.toexe)
#   TOEXE_BIN          directory for the `toexe` launcher      (default: ~/.local/bin)
#   NO_COLOR           disable colored output
#
# Testing overrides (not for normal use):
#   TOEXE_TARBALL_URL  full URL of the tarball; file:///... works. Skips the
#                      GitHub URL logic and the TOEXE_REPO placeholder check.
#   TOEXE_SHA256_URL   URL of the checksum file (default: <TOEXE_TARBALL_URL>.sha256)
#
# The whole script is wrapped in main() and main is only called on the very
# last line, so a download that is cut off halfway through runs nothing.

# GitHub owner/name the release is downloaded from. Users can override it with
# the TOEXE_REPO environment variable.
DEFAULT_TOEXE_REPO="tommfr38/toexe"

MARKER="managed by toexe installer"
RC_MARKER="# toexe (added by install.sh)"

main() {
  set -eu

  : "${HOME:?HOME is not set}"
  TOEXE_REPO="${TOEXE_REPO:-$DEFAULT_TOEXE_REPO}"
  TOEXE_HOME="${TOEXE_HOME:-$HOME/.toexe}"
  TOEXE_BIN="${TOEXE_BIN:-$HOME/.local/bin}"
  TAG=""
  DRY_RUN=0
  MODIFY_PATH=0
  UNINSTALL=0
  TMP=""
  STAGE=""
  OLD=""

  setup_colors

  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage; return 0 ;;
      --dry-run) DRY_RUN=1 ;;
      --modify-path) MODIFY_PATH=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --version)
        [ $# -ge 2 ] || die "--version needs a value, e.g. --version v0.1.0"
        TAG="$2"; shift ;;
      --version=*) TAG="${1#--version=}" ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
    shift
  done

  check_paths

  if [ "$UNINSTALL" = 1 ]; then
    do_uninstall
    return 0
  fi

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  if [ -n "$TAG" ]; then
    case "$TAG" in
      *[!A-Za-z0-9._-]*|"") die "invalid release tag: $TAG" ;;
      v*) : ;;
      *) TAG="v$TAG" ;;
    esac
  fi

  check_os
  check_node
  resolve_urls

  if [ "$DRY_RUN" = 1 ]; then
    info "Dry run: nothing will be downloaded or changed."
    plan "download   $TARBALL_URL"
    plan "download   $SHA_URL"
    plan "verify     SHA-256 of the tarball"
    if [ -e "$TOEXE_HOME" ]; then
      plan "replace    $TOEXE_HOME (existing install is swapped out only after a successful unpack)"
    else
      plan "install    $TOEXE_HOME"
    fi
    plan "launcher   $TOEXE_BIN/toexe"
    if path_has_bin; then
      plan "PATH       $TOEXE_BIN is already on your PATH"
    elif [ "$MODIFY_PATH" = 1 ]; then
      plan "PATH       append '$(path_line)' to $(rc_file_for_shell)"
    else
      plan "PATH       $TOEXE_BIN is not on your PATH; would print the line to add (use --modify-path to add it)"
    fi
    plan "check      run: toexe --version"
    return 0
  fi

  info "Installing toexe"
  need_cmd curl "curl is required (it ships with macOS)."
  need_cmd tar "tar is required (it ships with macOS)."
  find_sha_tool

  TMP="$(mktemp -d "${TMPDIR:-/tmp}/toexe-install.XXXXXX")" || die "could not create a temporary directory"

  info "Downloading $TARBALL_URL"
  if ! curl -fsSL --retry 2 -o "$TMP/toexe.tar.gz" "$TARBALL_URL"; then
    die "download failed: $TARBALL_URL
  Check your connection. If you used --version, make sure that release exists.
  If this is a fresh repo, a GitHub release with toexe.tar.gz must be published first (see INSTALL.md)."
  fi
  if ! curl -fsSL --retry 2 -o "$TMP/toexe.tar.gz.sha256" "$SHA_URL"; then
    die "could not download the checksum file: $SHA_URL
  Refusing to install without verifying the download."
  fi

  info "Verifying checksum"
  EXPECTED="$(awk 'NR==1 {print $1}' "$TMP/toexe.tar.gz.sha256" | tr 'A-F' 'a-f')"
  case "$EXPECTED" in
    *[!0-9a-f]*|"") die "the checksum file is malformed" ;;
  esac
  [ "${#EXPECTED}" -eq 64 ] || die "the checksum file is malformed"
  ACTUAL="$(sha256_of "$TMP/toexe.tar.gz")"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    die "checksum mismatch, aborting. Nothing was installed or changed.
  expected: $EXPECTED
  actual:   $ACTUAL"
  fi
  ok "SHA-256 matches"

  # Refuse archives with absolute paths or '..' components.
  if tar -tzf "$TMP/toexe.tar.gz" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null 2>&1; then
    die "the archive contains unsafe paths, aborting. Nothing was installed or changed."
  fi

  # Never clobber something that is not a toexe install.
  if [ -e "$TOEXE_HOME" ] || [ -L "$TOEXE_HOME" ]; then
    [ -f "$TOEXE_HOME/bin/toexe.js" ] ||
      die "$TOEXE_HOME exists but does not look like a toexe install. Not touching it.
  Choose another location with TOEXE_HOME=/some/dir, or remove it yourself."
  fi
  if [ -e "$TOEXE_BIN/toexe" ] || [ -L "$TOEXE_BIN/toexe" ]; then
    is_our_launcher "$TOEXE_BIN/toexe" ||
      die "$TOEXE_BIN/toexe already exists and was not created by this installer. Not touching it.
  Move it away, or choose another directory with TOEXE_BIN=/some/dir."
  fi

  mkdir -p "$(dirname "$TOEXE_HOME")" "$TOEXE_BIN"

  # Unpack next to the final location (same filesystem) so the swap is a rename.
  STAGE="$TOEXE_HOME.new.$$"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  info "Unpacking"
  tar -xzf "$TMP/toexe.tar.gz" -C "$STAGE" || die "could not unpack the archive"
  [ -f "$STAGE/bin/toexe.js" ] && [ -f "$STAGE/package.json" ] ||
    die "the archive does not have the expected layout (bin/toexe.js, package.json). Nothing was changed."
  chmod +x "$STAGE/bin/toexe.js" 2>/dev/null || true

  if [ -e "$TOEXE_HOME" ] || [ -L "$TOEXE_HOME" ]; then
    OLD="$TOEXE_HOME.old.$$"
    rm -rf "$OLD"
    mv "$TOEXE_HOME" "$OLD" || die "could not move the old install out of the way"
    if ! mv "$STAGE" "$TOEXE_HOME"; then
      mv "$OLD" "$TOEXE_HOME" 2>/dev/null || true
      OLD=""
      die "could not put the new install in place; the previous install was restored"
    fi
    STAGE=""
    rm -rf "$OLD"
    OLD=""
    ok "Upgraded $TOEXE_HOME"
  else
    mv "$STAGE" "$TOEXE_HOME" || die "could not move the new install into place"
    STAGE=""
    ok "Installed to $TOEXE_HOME"
  fi

  write_launcher
  ok "Launcher: $TOEXE_BIN/toexe"

  handle_path

  info "Checking the install"
  if VERSION_OUT="$("$TOEXE_BIN/toexe" --version 2>&1)"; then
    ok "$VERSION_OUT"
  else
    die "the installed toexe failed its self-check (toexe --version):
$VERSION_OUT"
  fi

  printf '\n%sDone.%s Try: toexe --help\n' "$C_BOLD" "$C_RESET"
}

# ---------------------------------------------------------------- helpers

usage() {
  cat <<'EOF_USAGE'
toexe installer (macOS)

Usage:
  curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/install.sh | sh -s -- [options]

Options:
  --version <tag>   install a specific release (e.g. v0.1.0) instead of the latest
  --modify-path     append the PATH line to your shell rc file (zsh/bash) if needed
  --dry-run         show what would happen, change nothing
  --uninstall       remove toexe
  -h, --help        show this help

Environment variables:
  TOEXE_REPO        GitHub owner/name to download from
  TOEXE_HOME        install directory                  (default: ~/.toexe)
  TOEXE_BIN         directory for the toexe launcher   (default: ~/.local/bin)
  NO_COLOR          disable colored output

Needs Node.js 18 or newer. No sudo required.
EOF_USAGE
}

setup_colors() {
  C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_RESET=""
  E_BOLD=""; E_RED=""; E_YELLOW=""; E_RESET=""
  if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    if [ -t 1 ]; then
      C_BOLD="$(printf '\033[1m')"; C_DIM="$(printf '\033[2m')"
      C_RED="$(printf '\033[31m')"; C_GREEN="$(printf '\033[32m')"
      C_YELLOW="$(printf '\033[33m')"; C_RESET="$(printf '\033[0m')"
    fi
    if [ -t 2 ]; then
      E_BOLD="$(printf '\033[1m')"; E_RED="$(printf '\033[31m')"
      E_YELLOW="$(printf '\033[33m')"; E_RESET="$(printf '\033[0m')"
    fi
  fi
}

info() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '  %s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
plan() { printf '  %s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$E_YELLOW" "$E_RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$E_RED" "$E_RESET" "$*" >&2; exit 1; }

cleanup() {
  # Runs on every exit path. Removes temp files and any half-finished staging.
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
  [ -n "${STAGE:-}" ] && rm -rf "$STAGE"
  # If we died between "move old away" and "move new in", put the old one back.
  if [ -n "${OLD:-}" ] && [ -e "$OLD" ] && [ ! -e "$TOEXE_HOME" ]; then
    mv "$OLD" "$TOEXE_HOME" 2>/dev/null || true
  fi
  return 0
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$2"
}

check_paths() {
  for p in "$TOEXE_HOME" "$TOEXE_BIN"; do
    case "$p" in
      /*) : ;;
      *) die "paths must be absolute (got: $p)" ;;
    esac
    # These would break the generated launcher script.
    case "$p" in
      *'"'*|*'$'*|*'`'*|*\\*) die "path contains a character this installer does not support (\" \$ \` or backslash): $p" ;;
    esac
  done
}

check_os() {
  OS="$(uname -s 2>/dev/null || echo unknown)"
  case "$OS" in
    Darwin) : ;;
    Linux)
      printf 'toexe: Linux support is coming soon.\n' >&2
      printf 'toexe currently inspects macOS .app bundles and only installs on macOS.\n' >&2
      exit 1 ;;
    *)
      printf 'toexe: unsupported operating system: %s (macOS only for now).\n' "$OS" >&2
      exit 1 ;;
  esac
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js 18 or newer is required but 'node' was not found.
  Install it, then run this installer again:
    Homebrew:   brew install node
    Download:   https://nodejs.org
  (This installer does not install Node.js for you.)"
  fi
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  case "$NODE_MAJOR" in
    ""|*[!0-9]*) NODE_MAJOR=0 ;;
  esac
  if [ "$NODE_MAJOR" -lt 18 ]; then
    die "Node.js 18 or newer is required (found $(node -v 2>/dev/null || echo unknown)).
  Upgrade with 'brew upgrade node' or from https://nodejs.org, then run this installer again."
  fi
}

resolve_urls() {
  if [ -n "${TOEXE_TARBALL_URL:-}" ]; then
    TARBALL_URL="$TOEXE_TARBALL_URL"
    SHA_URL="${TOEXE_SHA256_URL:-$TARBALL_URL.sha256}"
    return 0
  fi
  case "$TOEXE_REPO" in
    *"<"*|*">"*)
      die "this copy of install.sh still has the placeholder repo '$TOEXE_REPO'.
  Set TOEXE_REPO=owner/toexe, or (maintainers) edit DEFAULT_TOEXE_REPO at the top of install.sh." ;;
    */*) : ;;
    *) die "TOEXE_REPO must look like owner/name (got: $TOEXE_REPO)" ;;
  esac
  case "$TOEXE_REPO" in
    *[!A-Za-z0-9._/-]*) die "invalid TOEXE_REPO: $TOEXE_REPO" ;;
  esac
  if [ -n "$TAG" ]; then
    BASE="https://github.com/$TOEXE_REPO/releases/download/$TAG"
  else
    BASE="https://github.com/$TOEXE_REPO/releases/latest/download"
  fi
  TARBALL_URL="$BASE/toexe.tar.gz"
  SHA_URL="$BASE/toexe.tar.gz.sha256"
}

find_sha_tool() {
  if command -v shasum >/dev/null 2>&1; then
    SHA_TOOL="shasum -a 256"
  elif command -v sha256sum >/dev/null 2>&1; then
    SHA_TOOL="sha256sum"
  else
    die "need shasum or sha256sum to verify the download (shasum ships with macOS)."
  fi
}

sha256_of() {
  # shellcheck disable=SC2086
  $SHA_TOOL "$1" | awk '{print $1}' | tr 'A-F' 'a-f'
}

is_our_launcher() {
  f="$1"
  if [ -L "$f" ]; then
    t="$(readlink "$f" 2>/dev/null || true)"
    case "$t" in "$TOEXE_HOME"/*) return 0 ;; esac
    return 1
  fi
  [ -f "$f" ] && grep -q "$MARKER" "$f" 2>/dev/null
}

write_launcher() {
  tmp_l="$TOEXE_BIN/.toexe.$$"
  {
    printf '#!/bin/sh\n'
    printf '# %s. Safe to delete; install.sh --uninstall removes it.\n' "$MARKER"
    printf 'exec node "%s/bin/toexe.js" "$@"\n' "$TOEXE_HOME"
  } > "$tmp_l"
  chmod 755 "$tmp_l"
  mv -f "$tmp_l" "$TOEXE_BIN/toexe"
}

path_has_bin() {
  case ":$PATH:" in
    *":$TOEXE_BIN:"*) return 0 ;;
  esac
  return 1
}

# The PATH line as the user would type it (uses $HOME when the dir is inside it).
path_line() {
  case "$TOEXE_BIN" in
    "$HOME"/*) printf 'export PATH="$HOME/%s:$PATH"' "${TOEXE_BIN#"$HOME"/}" ;;
    *) printf 'export PATH="%s:$PATH"' "$TOEXE_BIN" ;;
  esac
}

shell_name() {
  basename "${SHELL:-sh}"
}

rc_file_for_shell() {
  case "$(shell_name)" in
    zsh) printf '%s/.zshrc' "$HOME" ;;
    bash)
      # macOS Terminal starts bash as a login shell, which reads .bash_profile.
      if [ -f "$HOME/.bash_profile" ] || [ ! -f "$HOME/.bashrc" ]; then
        printf '%s/.bash_profile' "$HOME"
      else
        printf '%s/.bashrc' "$HOME"
      fi ;;
    *) printf '' ;;
  esac
}

handle_path() {
  if path_has_bin; then
    return 0
  fi
  line="$(path_line)"
  rc="$(rc_file_for_shell)"
  if [ "$(shell_name)" = "fish" ]; then
    printf '\n%s%s is not on your PATH.%s Add it with:\n    fish_add_path %s\n' "$C_YELLOW" "$TOEXE_BIN" "$C_RESET" "$TOEXE_BIN"
    return 0
  fi
  if [ -z "$rc" ]; then
    printf '\n%s%s is not on your PATH.%s Add this line to your shell startup file:\n    %s\n' "$C_YELLOW" "$TOEXE_BIN" "$C_RESET" "$line"
    return 0
  fi
  if [ "$MODIFY_PATH" = 1 ]; then
    if [ -f "$rc" ] && grep -qF "$RC_MARKER" "$rc" 2>/dev/null; then
      info "$rc already has the toexe PATH line"
    else
      {
        printf '\n%s\n%s\n' "$RC_MARKER" "$line"
      } >> "$rc"
      ok "Added the PATH line to $rc"
    fi
    printf '  Open a new terminal (or run: %s) to pick it up.\n' "$line"
  else
    printf '\n%s%s is not on your PATH.%s To use `toexe` from any terminal, add this line to %s:\n\n    %s\n\n' "$C_YELLOW" "$TOEXE_BIN" "$C_RESET" "$rc" "$line"
    printf '  or re-run the installer with --modify-path to have it do that for you.\n'
    printf '  Then open a new terminal.\n'
  fi
}

# Report (never edit) rc lines that mention the launcher dir or our marker.
report_rc_lines() {
  found=0
  for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.zshenv" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    hits="$(grep -nF -e "$RC_MARKER" -e "$TOEXE_BIN" -e '.local/bin' "$rc" 2>/dev/null || true)"
    if [ -n "$hits" ]; then
      if [ "$found" = 0 ]; then
        printf '\nThese shell startup lines mention the toexe launcher directory (%s).\nThis script does not edit them. Remove them by hand if you no longer want them\n(keep them if other tools in that directory still need it):\n' "$TOEXE_BIN"
        found=1
      fi
      printf '  %s:\n' "$rc"
      printf '%s\n' "$hits" | sed 's/^/    line /'
    fi
  done
}

do_uninstall() {
  info "Uninstalling toexe"
  if [ "$DRY_RUN" = 1 ]; then
    plan "remove     $TOEXE_HOME"
    plan "remove     $TOEXE_BIN/toexe"
    return 0
  fi
  removed=0
  if [ -e "$TOEXE_HOME" ] || [ -L "$TOEXE_HOME" ]; then
    if [ -f "$TOEXE_HOME/bin/toexe.js" ]; then
      rm -rf "$TOEXE_HOME"
      ok "Removed $TOEXE_HOME"
      removed=1
    else
      warn "$TOEXE_HOME does not look like a toexe install; leaving it alone."
    fi
  fi
  if [ -e "$TOEXE_BIN/toexe" ] || [ -L "$TOEXE_BIN/toexe" ]; then
    if is_our_launcher "$TOEXE_BIN/toexe" || { [ "$removed" = 1 ] && [ -L "$TOEXE_BIN/toexe" ] && [ ! -e "$TOEXE_BIN/toexe" ]; }; then
      rm -f "$TOEXE_BIN/toexe"
      ok "Removed $TOEXE_BIN/toexe"
      removed=1
    else
      warn "$TOEXE_BIN/toexe was not created by this installer; leaving it alone."
    fi
  fi
  if [ "$removed" = 0 ]; then
    printf 'Nothing to remove: no toexe install found.\n'
  fi
  report_rc_lines
  printf '\nDone.\n'
}

main "$@"
