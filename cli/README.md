# toexe

`toexe` looks at macOS `.app` bundles and tells you, honestly, whether they can become a Windows program.

Run it in a folder that contains `.app` bundles. It finds them, identifies what each one is built with, and either converts it (Electron and Java apps) or refuses with a clear reason (most apps).

```
$ toexe
Found 2 apps in /Users/me/Apps:
  1) Chat.app
  2) Notes.app

Which to convert? [number, 1,3, 2-4, all, q] all

Chat.app
  Created a Windows app (Electron 33.2.1, win32-x64)
  ...
Notes.app
  Swift based apps cannot become exe
  ...
```

**Read the Limitations section before you rely on this.** Most Mac apps cannot be converted, and toexe will not pretend otherwise. Converted Electron apps have not been run on Windows by toexe.

## Requirements

- Node.js 18 or newer (no other dependencies).
- macOS is where you will normally use it. It only inspects bundle files, so it works the same on Intel and Apple Silicon Macs. For binary property lists it calls the macOS `plutil` tool; XML plists are parsed in-process.

## Install

From this directory:

```sh
./install.sh            # npm install -g .   (copies the package to your global prefix)
./install.sh --link     # npm link           (symlink; edits take effect immediately)
./install.sh --uninstall
```

or directly: `npm install -g .` / `npm link`.

If npm complains about permissions, point npm at a user-owned prefix (`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`) rather than using `sudo`.

You can also run it without installing: `node bin/toexe.js`.

## Usage

```
toexe                      find .app bundles in the current folder and pick which to convert
toexe /path/to/Foo.app     convert a specific app (several paths are allowed)
toexe /path/to/folder      look for .app bundles inside a folder

-o, --out <dir>   where to write output (default: ./toexe-out)
-y, --yes         do not ask for confirmation
-a, --all         when several apps are found, convert all of them without asking
    --check       only inspect and report; write nothing
    --force       replace an existing output folder of the same name
    --no-color    disable colored output (NO_COLOR is also respected)
-h, --help
-v, --version
```

How apps are found when you pass no path: direct children of the current folder first; if there are none, one level deeper. It never descends into a `.app`.

- **No apps found**: prints a hint and exits with status 2.
- **Exactly one app**: asks `Convert Foo.app? [Y/n]` (skipped with `--yes`, or when stdin is not a terminal).
- **Several apps**: prints a numbered list and asks which to convert. Accepts `2`, `1,3`, `1 3`, `2-4`, `all` (also `a` or `*`), and `q` to quit. Invalid input re-prompts. If stdin is closed with no answer, it exits with an error instead of guessing (use `--all` or pass explicit paths in scripts).

Exit codes: `0` everything selected was converted, `1` something was refused or failed, `2` usage error or no apps found.

## What it does with each app

toexe inspects the bundle (it never modifies it):

- `Contents/Info.plist`
- the main Mach-O binary in `Contents/MacOS`: linked libraries and build platform read from the load commands (thin and universal binaries), plus a single scan for telltale strings
- `Contents/Frameworks`, `Contents/Resources`, `PlugIns`, `_MASReceipt`

Rules are tried most-specific first and the first match wins. When it recognizes a framework that cannot be converted it prints, and exits non-zero:

```
Swift based apps cannot become exe
```

(with the detected framework in place of "Swift"), followed by why and the evidence it found. If it cannot identify the runtime at all, it says `Unrecognized app type`, produces nothing, and exits non-zero. It never writes an `.exe` that might not work.

### Detected frameworks and results

| Detected as | How it is recognized (examples) | Result |
|---|---|---|
| Electron | `Frameworks/Electron Framework.framework`, `Resources/app.asar`, `ElectronAsarIntegrity` in Info.plist | **Converted** to a folder with a real Windows `<Name>.exe` (see "Electron apps" below). Refused with "Electron apps with native macOS modules cannot become exe" if the app has `.node` modules, or "Electron based apps cannot become exe" if its version or app code cannot be read |
| NW.js | `nwjs Framework.framework`, `nw.pak`, `app.nw` | Refused |
| Tauri | `__TAURI_INTERNALS__` / `tauri://localhost` strings in the binary | Refused |
| Wails | Wails module path in the Go binary | Refused |
| Chromium Embedded Framework (CEF) | `Chromium Embedded Framework.framework` | Refused |
| Chromium (browsers) | `<X> Framework.framework` plus `<X> Helper*.app` | Refused |
| Gecko (Firefox) | `omni.ja`, `XUL`, `libxul`/`libmozavcodec` | Refused |
| Qt | `QtCore.framework`, `libQt*.dylib`, `libqcocoa.dylib`, `qt.conf` | Refused |
| Flutter | `FlutterMacOS.framework`, `flutter_assets` | Refused |
| Unity | `UnityPlayer.dylib`, `GameAssembly.dylib`, `Resources/Data/...` | Refused |
| Unreal Engine | `Contents/UE4`, `Contents/UE5` | Refused |
| Godot | `.pck` in Resources, "Godot Engine" string | Refused |
| Kotlin/Native | Kotlin/Native runtime symbols in the binary (stripped binaries may be missed and fall through to Swift/AppKit) | Refused |
| React Native macOS | `main.jsbundle`, `hermes`/`React*.framework` | Refused |
| .NET/Mono (Xamarin.Mac, Avalonia, MAUI) | `MonoBundle`, `libmonosgen`, `libcoreclr` | Refused |
| Python (py2app/PyInstaller) | `Python.framework`, `__boot__.py`, PyInstaller bootloader strings | Refused |
| AppleScript/Automator | `main.scpt`, `document.wflow`, `applet`/`droplet` stub | Refused |
| **Java** | `JavaAppLauncher`/`JavaApplicationStub`, jpackage `.cfg`, JVM keys in Info.plist, `.jar` files | **Wrapper created** if it has no macOS-specific parts; otherwise refused |
| Mac Catalyst | build platform MACCATALYST, UIKit/iOSSupport links | Refused |
| SwiftUI | links `SwiftUI.framework` | Refused |
| Swift | links `libswift*.dylib`, bundled `libswift*`, `__swift5_*` sections | Refused |
| Mac App Store sandboxed native | `Contents/_MASReceipt` (when nothing more specific matched) | Refused |
| Objective-C/AppKit native | links `AppKit`/`Cocoa` (catch-all for native Mac apps) | Refused |
| Carbon/CoreFoundation native | links `Carbon`/`CoreFoundation` only | Refused |
| anything else | nothing above matched | "Unrecognized app type", nothing produced |

The rules live in one table, `src/detect.js`. Adding a framework means adding one `{ id, name, kind, why, match(ctx) }` row in the right position.

### The Java wrapper

Jar files are platform independent, so for Java apps toexe can copy the jars and write a Windows launcher:

```
toexe-out/Foo-java-wrapper/
  Foo.bat               launcher: checks `java` is on PATH, then runs your main class
  app/...               the jar files (and class directories) from the .app, same layout
  README-WINDOWS.txt    what this is and its limits
```

This is a **wrapper, not a native `.exe`**:

- Windows needs a Java runtime installed. The macOS JRE inside the `.app` is not copied (it cannot run on Windows).
- Only jars are copied. If the app reads other files from its bundle, they are not carried over.
- Mac-only JVM flags (`-Xdock:*`, `-XstartOnFirstThread`, `-Dapple.*`, ...) are dropped and listed in the output.
- toexe has not run the result on Windows. It is a best-effort conversion of the launch command.
- toexe refuses (and says why) when the app bundles `.dylib`/`.jnilib` files, uses macOS-specific jars such as SWT-Cocoa, has no jars, or no main class can be determined. It cannot see inside jars, so a jar that embeds only macOS natives will still fail at run time.
- Large IDEs and similar (for example the JetBrains IDEs) ship dozens of native `.dylib`s and are correctly refused.

### Electron apps

For an Electron app toexe reads the Electron version from `Contents/Frameworks/Electron Framework.framework`, downloads `electron-v<version>-win32-<arch>.zip` from the official GitHub release (set `TOEXE_ELECTRON_MIRROR` to use a mirror), checks it against the release's `SHASUMS256.txt`, then builds `<out>/<Name>-win32-<arch>/` containing `<Name>.exe` plus the app's `Contents/Resources` (`app.asar` or `app/`). Downloads are cached in `~/.cache/toexe/electron` (`TOEXE_CACHE_DIR` to change it). Choose the architecture with `--arch x64|arm64|ia32` (default `x64`). It needs the `unzip` tool (built into macOS).

## Limitations

Please read this honestly:

- **Most Mac apps cannot be converted.** A native Mac app (Swift, SwiftUI, Objective-C/AppKit, Catalyst) is machine code for Apple silicon or Intel that calls Apple frameworks (AppKit, Foundation, Metal, ...). Windows has neither the CPU instructions nor the frameworks. There is no switch that turns that into a Windows program; the app has to be rebuilt from source for Windows.
- **Tauri, Qt, Flutter, Unity, Godot and similar** are built per platform from the project's source. The `.app` you have is the macOS build output, not the source, so toexe refuses them.
- **Electron is the exception**, because the app's code is JavaScript. toexe repackages it with the Windows Electron runtime, but it cannot run the result: test it on Windows. No icon or version info is embedded in the `.exe`, native `.node` modules are refused, and macOS-only Electron APIs (dock, systemPreferences, macOS menus) may behave differently.
- **Java** apps get a wrapper that needs a Windows JRE (see above).
- Detection is heuristic (file layout, linked libraries, strings). It can misidentify an app (for example a Python-frozen app that also links AppKit is reported as Python, and a heavily stripped binary may be reported as plain native AppKit). In every refusal case the result is the same: nothing is produced. A false "unrecognized" is also a refusal, never a conversion.
- `Unrecognized app type` means toexe could not tell what the app is built with. It is not a promise that the app is convertible.
- Binary strings are scanned in the main executable only, not in helper binaries or frameworks.
- toexe does not emulate or translate Mac apps (it is not Wine or Rosetta in reverse), and it does not decompile anything.
- Works on Intel and Apple Silicon Macs alike because it only inspects bundles; it does not run them.

## Development

```sh
cd cli
npm test          # node --test, no dependencies
node bin/toexe.js --help
```

Tests build fixture `.app` directories (including tiny synthetic Mach-O files and jars) in a temp directory and cover detection and Electron conversion (against a local mock mirror) for Electron, Swift, SwiftUI, Qt, Flutter, Java, unknown and more, the multi-app selection parser, the exact refusal text, and the CLI end to end.

```
bin/toexe.js        entry point (the `toexe` command)
src/cli.js          argument parsing, prompts, output, exit codes
src/detect.js       the detection table
src/inspect.js      read-only view of a bundle (lazy)
src/macho.js        Mach-O load-command reader (thin + fat)
src/plist.js        Info.plist reader
src/java.js         Java analysis and wrapper writer
src/zip.js          tiny jar reader (manifest Main-Class)
src/select.js       "which app(s)?" answer parser
src/find.js         .app discovery
src/messages.js     the refusal sentence
src/ui.js           ANSI colors
test/, testlib/     tests and fixture builders
install.sh          global install helper
```
