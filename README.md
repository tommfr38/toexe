# toexe

A terminal tool for macOS that checks whether a `.app` can become a Windows program, and converts the ones that can.

- Electron apps are repackaged with the official Windows Electron runtime into a folder with a real `.exe`.
- Simple Java/JAR apps get a Windows wrapper (needs a Java runtime on Windows).
- Everything else (Swift, Qt, Flutter, Tauri, ...) is refused with a message like `Swift based apps cannot become exe`.

Site: https://tommfr38.com/toexe/

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/tommfr38/toexe/main/install.sh | sh
```

See [INSTALL.md](INSTALL.md). Then run `toexe` in a folder that contains `.app` bundles.

## Layout

| Path | What |
|---|---|
| `cli/` | the tool (Node.js 18+, no dependencies) and its tests; see `cli/README.md` |
| `install.sh`, `uninstall.sh`, `scripts/` | curl installer and release build |
| `website/` | the static site |
| `test-apps/` | tiny C++, Swift, Java and Electron `.app`s for testing (`./test.sh`) |

## Status

Untested on Windows: toexe cannot run the Windows output it creates, so test converted apps on a Windows machine.

## License

[MIT](LICENSE)
