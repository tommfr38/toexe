# Installing toexe

```sh
curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/install.sh | sh
```

Requirements: macOS (Intel or Apple Silicon) and Node.js 18 or newer
(`brew install node` or https://nodejs.org). No sudo. Linux is not supported yet;
the installer says so and exits.

## What the installer does

1. Checks that this is macOS and that `node` is version 18 or newer (it never installs Node for you).
2. Downloads `toexe.tar.gz` and `toexe.tar.gz.sha256` from the latest GitHub Release (or the one you pin) into a temp dir.
3. Verifies the SHA-256 checksum. On mismatch it aborts and changes nothing.
4. Unpacks into a staging folder next to `~/.toexe`, then swaps it in with a rename, so re-running is a clean upgrade and a failed upgrade leaves the old install intact.
5. Writes a small launcher script at `~/.local/bin/toexe` (it runs `node ~/.toexe/bin/toexe.js`).
6. If `~/.local/bin` is not on your `PATH`, prints the exact line to add to your shell rc file. It only edits the file if you pass `--modify-path`.
7. Runs `toexe --version` as a self-check.

It will not overwrite a `~/.toexe` or `~/.local/bin/toexe` that it did not create.

## Flags

Pass flags through the pipe with `sh -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/install.sh | sh -s -- --version v0.1.0
```

| Flag | Meaning |
| --- | --- |
| `--version <tag>` | Install a specific release (`v0.1.0` or `0.1.0`) instead of the latest |
| `--modify-path` | Append the PATH line to `~/.zshrc` (zsh) or `~/.bash_profile` / `~/.bashrc` (bash) |
| `--dry-run` | Print what would happen; download and change nothing |
| `--uninstall` | Remove toexe (same as `uninstall.sh`) |
| `-h`, `--help` | Show help |

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOEXE_REPO` | `tommfr38/toexe` | GitHub `owner/name` to download from |
| `TOEXE_HOME` | `~/.toexe` | Install directory |
| `TOEXE_BIN` | `~/.local/bin` | Directory for the `toexe` launcher |
| `NO_COLOR` | unset | Disable colored output (colors are only used on a terminal anyway) |
| `TOEXE_TARBALL_URL` | unset | Testing only: full tarball URL, `file:///...` works. The checksum is fetched from `<url>.sha256` unless `TOEXE_SHA256_URL` is set |

Paths must be absolute and must not contain `"`, `$`, backticks or backslashes.

## Uninstalling

```sh
curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/uninstall.sh | sh
# or, equivalently
curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/install.sh | sh -s -- --uninstall
```

Removes `~/.toexe` and `~/.local/bin/toexe`. It never edits your shell rc files;
if it finds lines in them that mention `~/.local/bin` (including one added by
`--modify-path`), it lists the file and line number so you can remove them by hand.

## Cutting a release

1. Make sure `version` in `cli/package.json` is what you want (e.g. `0.1.0`).
2. Optional local check: `sh scripts/build-release.sh v0.1.0` builds `dist/toexe.tar.gz` and `dist/toexe.tar.gz.sha256` (`dist/` is git-ignored). The script fails if the tag does not match `cli/package.json`.
3. Tag and push:
   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. `.github/workflows/release.yml` runs the CLI tests on Node 20, builds the artifacts and attaches both files to a new GitHub Release. Once the release is published, `releases/latest/download/...` (the installer's default) points at it.

## Hosting

Both parts live on GitHub: `install.sh` is served from the repo's raw URL, and the code comes from the latest GitHub Release (`toexe.tar.gz` plus its `.sha256`). To use a fork, set `DEFAULT_TOEXE_REPO` near the top of `install.sh` (users can also set `TOEXE_REPO`) and change the owner in the one-liner URLs in this file and the website.

## About `cli/install.sh`

`cli/install.sh` is a developer installer from the CLI author (`npm install -g` / `npm link` from a checkout). It is for working on toexe itself. The root `install.sh` is the user-facing installer.
