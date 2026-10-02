#!/bin/sh
# toexe uninstaller.
#
#   curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/uninstall.sh | sh
#
# Removes the install directory (~/.toexe) and the launcher (~/.local/bin/toexe)
# that install.sh created. It never edits your shell startup files; if it finds
# lines in them that mention the launcher directory it tells you where they are.
#
# Options:  --dry-run (show what would be removed)   -h, --help
# Environment: TOEXE_HOME (default ~/.toexe), TOEXE_BIN (default ~/.local/bin)
#
# Equivalent to: install.sh --uninstall
# Wrapped in main() so a truncated download cannot run a partial script.

MARKER="managed by toexe installer"
RC_MARKER="# toexe (added by install.sh)"

main() {
  set -eu

  : "${HOME:?HOME is not set}"
  TOEXE_HOME="${TOEXE_HOME:-$HOME/.toexe}"
  TOEXE_BIN="${TOEXE_BIN:-$HOME/.local/bin}"
  DRY_RUN=0

  C_BOLD=""; C_GREEN=""; C_DIM=""; C_RESET=""; E_RED=""; E_YELLOW=""; E_RESET=""
  if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    if [ -t 1 ]; then
      C_BOLD="$(printf '\033[1m')"; C_GREEN="$(printf '\033[32m')"
      C_DIM="$(printf '\033[2m')"; C_RESET="$(printf '\033[0m')"
    fi
    if [ -t 2 ]; then
      E_RED="$(printf '\033[31m')"; E_YELLOW="$(printf '\033[33m')"; E_RESET="$(printf '\033[0m')"
    fi
  fi

  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      -h|--help)
        printf 'Usage: uninstall.sh [--dry-run]\nRemoves %s and %s/toexe.\nEnv: TOEXE_HOME, TOEXE_BIN\n' "$TOEXE_HOME" "$TOEXE_BIN"
        return 0 ;;
      *) printf '%serror:%s unknown option: %s\n' "$E_RED" "$E_RESET" "$arg" >&2; return 1 ;;
    esac
  done

  case "$TOEXE_HOME" in /*) : ;; *) printf 'error: TOEXE_HOME must be absolute\n' >&2; return 1 ;; esac
  case "$TOEXE_BIN" in /*) : ;; *) printf 'error: TOEXE_BIN must be absolute\n' >&2; return 1 ;; esac

  printf '%s==>%s Uninstalling toexe\n' "$C_BOLD" "$C_RESET"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  %s[dry-run]%s remove     %s\n' "$C_DIM" "$C_RESET" "$TOEXE_HOME"
    printf '  %s[dry-run]%s remove     %s/toexe\n' "$C_DIM" "$C_RESET" "$TOEXE_BIN"
    return 0
  fi

  removed=0
  if [ -e "$TOEXE_HOME" ] || [ -L "$TOEXE_HOME" ]; then
    if [ -f "$TOEXE_HOME/bin/toexe.js" ]; then
      rm -rf "$TOEXE_HOME"
      printf '  %sRemoved %s%s\n' "$C_GREEN" "$TOEXE_HOME" "$C_RESET"
      removed=1
    else
      printf '%swarning:%s %s does not look like a toexe install; leaving it alone.\n' "$E_YELLOW" "$E_RESET" "$TOEXE_HOME" >&2
    fi
  fi

  l="$TOEXE_BIN/toexe"
  if [ -e "$l" ] || [ -L "$l" ]; then
    ours=0
    if [ -L "$l" ]; then
      t="$(readlink "$l" 2>/dev/null || true)"
      case "$t" in "$TOEXE_HOME"/*) ours=1 ;; esac
    elif [ -f "$l" ] && grep -q "$MARKER" "$l" 2>/dev/null; then
      ours=1
    fi
    if [ "$ours" = 1 ]; then
      rm -f "$l"
      printf '  %sRemoved %s%s\n' "$C_GREEN" "$l" "$C_RESET"
      removed=1
    else
      printf '%swarning:%s %s was not created by this installer; leaving it alone.\n' "$E_YELLOW" "$E_RESET" "$l" >&2
    fi
  fi

  if [ "$removed" = 0 ]; then
    printf 'Nothing to remove: no toexe install found.\n'
  fi

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
  printf '\nDone.\n'
}

main "$@"
