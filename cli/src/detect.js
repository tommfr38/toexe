'use strict';

// Table-driven framework detection.
//
// Each row is { id, name, kind, why, markers?, match(ctx) }.
//   - Rows are tried IN ORDER, most specific first; the first match wins.
//   - match(ctx) returns an array of human-readable evidence strings (truthy
//     when it matched) or a falsy / empty value.
//   - kind 'refuse'  : toexe will not convert this; prints "<name> based apps cannot become exe".
//   - kind 'convert' : there is a genuine (limited) conversion path.
//   - markers        : byte strings searched for in the main executable. They are
//                      all collected up front so the binary is scanned ONCE.
//
// To support a new framework, add one row in the right position. That is all.

const path = require('node:path');
const { javaEvidence } = require('./java');

const ev = (...items) => items.flat().filter(Boolean);
const dirEv = (ctx, rel) => (ctx.exists(rel) ? `Contents/${rel}` : null);

const TABLE = [
  {
    id: 'electron',
    name: 'Electron',
    kind: 'convert',
    why: 'Electron apps bundle Chromium and Node.js built for macOS. toexe can repackage the app code with the official Windows Electron runtime, but only when the version is readable and the app has no native macOS modules.',
    match: (ctx) => ev(
      dirEv(ctx, 'Frameworks/Electron Framework.framework'),
      dirEv(ctx, 'Resources/app.asar'),
      dirEv(ctx, 'Resources/electron.asar'),
      ctx.plist && ctx.plist.ElectronAsarIntegrity !== undefined && 'Info.plist key ElectronAsarIntegrity',
      ctx.linked(/Electron Framework/) && `main binary links ${ctx.linked(/Electron Framework/)}`,
    ),
  },
  {
    id: 'nwjs',
    name: 'NW.js',
    kind: 'refuse',
    why: 'NW.js apps embed a macOS build of Chromium and Node.js; they would need a Windows NW.js runtime and rebuilt native modules.',
    match: (ctx) => ev(
      ctx.frameworks.filter((f) => /^(nwjs|nw) Framework\.framework$/i.test(f)).map((f) => `Contents/Frameworks/${f}`),
      dirEv(ctx, 'Resources/app.nw'),
      dirEv(ctx, 'Resources/nw.pak'),
    ),
  },
  {
    id: 'tauri',
    name: 'Tauri',
    kind: 'refuse',
    why: 'Tauri apps are compiled Rust binaries using the macOS system WebKit view. They would need to be rebuilt from source for Windows (WebView2).',
    markers: ['__TAURI_INTERNALS__', '__TAURI__', 'tauri://localhost', 'tauri-runtime', 'tauri-plugin-'],
    match: (ctx) => ev(
      ['__TAURI_INTERNALS__', '__TAURI__', 'tauri://localhost', 'tauri-runtime', 'tauri-plugin-']
        .filter((m) => ctx.binaryHas(m)).slice(0, 2).map((m) => `main binary contains "${m}"`),
    ),
  },
  {
    id: 'wails',
    name: 'Wails',
    kind: 'refuse',
    why: 'Wails apps are compiled Go binaries using the macOS system WebKit view; they must be rebuilt from source for Windows.',
    markers: ['github.com/wailsapp/wails', 'wails://wails'],
    match: (ctx) => ev(
      ['github.com/wailsapp/wails', 'wails://wails'].filter((m) => ctx.binaryHas(m)).slice(0, 1).map((m) => `main binary contains "${m}"`),
    ),
  },
  {
    id: 'cef',
    name: 'Chromium Embedded Framework (CEF)',
    kind: 'refuse',
    why: 'CEF apps embed a macOS Chromium build plus a native macOS host application; the host code is compiled for macOS.',
    match: (ctx) => ev(
      dirEv(ctx, 'Frameworks/Chromium Embedded Framework.framework'),
      ctx.linked(/Chromium Embedded Framework/) && `main binary links ${ctx.linked(/Chromium Embedded Framework/)}`,
    ),
  },
  {
    id: 'chromium',
    name: 'Chromium',
    kind: 'refuse',
    why: 'Chromium-based browsers are compiled natively per platform; there is nothing to repackage.',
    match: (ctx) => {
      // Chromium layout: "<X> Framework.framework" plus "<X> Helper*.app" processes.
      for (const f of ctx.frameworks) {
        const m = /^(.+) Framework\.framework$/.exec(f);
        if (!m) continue;
        const base = m[1];
        const fwHelpers = ctx.find(`Frameworks/${f}`, (n, r, isD) => isD && n.startsWith(`${base} Helper`) && n.endsWith('.app'), { maxDepth: 4 });
        const topHelpers = ctx.frameworks.filter((x) => x.startsWith(`${base} Helper`) && x.endsWith('.app'));
        if (fwHelpers.length || topHelpers.length) {
          return [`Contents/Frameworks/${f}`, `${base} Helper*.app helper processes`];
        }
      }
      return null;
    },
  },
  {
    id: 'gecko',
    name: 'Gecko (Firefox)',
    kind: 'refuse',
    why: 'Gecko apps ship the macOS build of Firefox\'s engine and native libraries.',
    match: (ctx) => {
      const macos = ctx.list('MacOS');
      return ev(
        macos.includes('XUL') && 'Contents/MacOS/XUL',
        macos.filter((f) => /^(libxul|libmozavcodec|libnss3|libfreebl3|libmozglue)/.test(f)).slice(0, 2).map((f) => `Contents/MacOS/${f}`),
        dirEv(ctx, 'Resources/omni.ja'),
        dirEv(ctx, 'Resources/browser/omni.ja'),
        ctx.frameworks.includes('XUL.framework') && 'Contents/Frameworks/XUL.framework',
      );
    },
  },
  {
    id: 'qt',
    name: 'Qt',
    kind: 'refuse',
    why: 'Qt apps are compiled C++ against macOS Qt libraries. They must be rebuilt from source with a Windows Qt toolchain.',
    match: (ctx) => ev(
      ctx.frameworks.filter((f) => /^Qt[A-Za-z0-9]*\.framework$/.test(f) || /^libQt\d*[A-Za-z0-9]*\.dylib$/.test(f)).slice(0, 3).map((f) => `Contents/Frameworks/${f}`),
      dirEv(ctx, 'PlugIns/platforms/libqcocoa.dylib'),
      dirEv(ctx, 'Resources/qt.conf'),
      ctx.linked(/Qt(Core|Gui|Widgets)/) && `main binary links ${ctx.linked(/Qt(Core|Gui|Widgets)/)}`,
    ),
  },
  {
    id: 'flutter',
    name: 'Flutter',
    kind: 'refuse',
    why: 'Flutter desktop apps are AOT-compiled to native macOS code. They must be rebuilt from the Dart source with the Windows target.',
    match: (ctx) => ev(
      dirEv(ctx, 'Frameworks/FlutterMacOS.framework'),
      dirEv(ctx, 'Frameworks/App.framework/Resources/flutter_assets'),
      ctx.linked(/FlutterMacOS/) && `main binary links ${ctx.linked(/FlutterMacOS/)}`,
    ),
  },
  {
    id: 'unity',
    name: 'Unity',
    kind: 'refuse',
    why: 'Unity players are built per platform. The game must be re-exported from the Unity project with the Windows target.',
    match: (ctx) => ev(
      dirEv(ctx, 'Frameworks/UnityPlayer.dylib'),
      dirEv(ctx, 'Frameworks/GameAssembly.dylib'),
      dirEv(ctx, 'Resources/Data/globalgamemanagers'),
      dirEv(ctx, 'Resources/Data/data.unity3d'),
      dirEv(ctx, 'Resources/Data/Managed'),
      dirEv(ctx, 'Resources/Data/il2cpp_data'),
    ),
  },
  {
    id: 'unreal',
    name: 'Unreal Engine',
    kind: 'refuse',
    why: 'Unreal games are cooked and packaged per platform from the Unreal project.',
    match: (ctx) => ev(
      dirEv(ctx, 'UE4'),
      dirEv(ctx, 'UE5'),
      ctx.list('MacOS').filter((f) => /^UE[45]|-Mac-(Shipping|Debug|Development)/.test(f)).slice(0, 1).map((f) => `Contents/MacOS/${f}`),
    ),
  },
  {
    id: 'godot',
    name: 'Godot',
    kind: 'refuse',
    why: 'A Godot export ships a macOS build of the engine; the .pck data would need a Windows export template from the Godot project.',
    markers: ['Godot Engine'],
    match: (ctx) => ev(
      ctx.list('Resources').filter((f) => f.endsWith('.pck')).slice(0, 1).map((f) => `Contents/Resources/${f}`),
      ctx.binaryHas('Godot Engine') && 'main binary contains "Godot Engine"',
    ),
  },
  {
    id: 'kotlin-native',
    name: 'Kotlin/Native',
    kind: 'refuse',
    why: 'Kotlin/Native compiles to a native macOS binary; the project must be rebuilt for a Windows (mingw) target.',
    markers: ['Kotlin_initRuntimeIfNeeded', 'kfun:kotlin.', 'Konan_'],
    match: (ctx) => ev(
      ['Kotlin_initRuntimeIfNeeded', 'kfun:kotlin.', 'Konan_'].filter((m) => ctx.binaryHas(m)).slice(0, 1).map((m) => `main binary contains "${m}"`),
    ),
  },
  {
    id: 'react-native',
    name: 'React Native macOS',
    kind: 'refuse',
    why: 'React Native macOS apps pair a JS bundle with a native macOS shell (AppKit). The JS is portable in principle but the native shell is not, and needs react-native-windows to rebuild.',
    match: (ctx) => ev(
      dirEv(ctx, 'Resources/main.jsbundle'),
      ctx.frameworks.filter((f) => /^(hermes|React)[A-Za-z-]*\.framework$/.test(f)).slice(0, 2).map((f) => `Contents/Frameworks/${f}`),
    ),
  },
  {
    id: 'dotnet-mono',
    name: '.NET/Mono (Xamarin.Mac, Avalonia, MAUI)',
    kind: 'refuse',
    why: 'These apps run managed code against macOS-specific bindings and runtime libraries; the macOS UI layer has no Windows equivalent that toexe could swap in.',
    match: (ctx) => ev(
      dirEv(ctx, 'MonoBundle'),
      ctx.frameworks.filter((f) => /^(libmonosgen|libcoreclr|libhostfxr)/.test(f)).slice(0, 2).map((f) => `Contents/Frameworks/${f}`),
      ctx.list('MacOS').filter((f) => /^(libcoreclr|libhostfxr|libmonosgen)/.test(f)).slice(0, 2).map((f) => `Contents/MacOS/${f}`),
    ),
  },
  {
    id: 'python',
    name: 'Python (py2app/PyInstaller)',
    kind: 'refuse',
    markers: ['argv_pyi', 'pyi-runtime-tmpdir', '_MEIPASS'],
    why: 'Freezers bundle a macOS Python runtime and compiled extension modules. toexe cannot rebuild those for Windows; rebuild from source there.',
    match: (ctx) => ev(
      dirEv(ctx, 'Frameworks/Python.framework'),
      dirEv(ctx, 'Frameworks/base_library.zip'),
      dirEv(ctx, 'MacOS/base_library.zip'),
      dirEv(ctx, 'Resources/__boot__.py'),
      ['argv_pyi', 'pyi-runtime-tmpdir', '_MEIPASS'].filter((m) => ctx.binaryHas(m)).slice(0, 1).map((m) => `main binary contains "${m}" (PyInstaller bootloader)`),
      ctx.frameworks.filter((f) => /^libpython3/.test(f)).slice(0, 1).map((f) => `Contents/Frameworks/${f}`),
      ctx.plist && ctx.plist.PyRuntimeLocations !== undefined && 'Info.plist key PyRuntimeLocations',
      ctx.plist && ctx.plist.PythonInfoDict !== undefined && 'Info.plist key PythonInfoDict',
    ),
  },
  {
    id: 'applescript',
    name: 'AppleScript/Automator',
    kind: 'refuse',
    why: 'AppleScript and Automator applets drive macOS apps through Apple Events; they have no Windows equivalent.',
    match: (ctx) => ev(
      dirEv(ctx, 'Resources/Scripts/main.scpt'),
      dirEv(ctx, 'Resources/Scripts/main.scptd'),
      dirEv(ctx, 'Resources/document.wflow'),
      ctx.exeName && ['applet', 'droplet', 'Automator Application Stub'].includes(ctx.exeName) && `Contents/MacOS/${ctx.exeName}`,
    ),
  },
  {
    id: 'java',
    name: 'Java',
    kind: 'convert',
    why: 'Jar files are platform independent, so they can be wrapped with a Windows launcher script. This yields a wrapper that needs a Windows JRE, not a native .exe.',
    match: (ctx) => {
      const j = javaEvidence(ctx);
      return j.matches ? j.evidence : null;
    },
  },
  {
    id: 'catalyst',
    name: 'Mac Catalyst',
    kind: 'refuse',
    why: 'Catalyst apps are iPad UIKit apps built for macOS; they depend on Apple frameworks that do not exist on Windows.',
    match: (ctx) => ev(
      ctx.macho.isMachO && ctx.macho.platforms.includes('maccatalyst') && 'Mach-O build platform is MACCATALYST',
      ctx.linked(/iOSSupport|\/UIKit(MacHelper)?\.framework/) && `main binary links ${ctx.linked(/iOSSupport|\/UIKit(MacHelper)?\.framework/)}`,
    ),
  },
  {
    id: 'swiftui',
    name: 'SwiftUI',
    kind: 'refuse',
    why: 'SwiftUI apps are compiled Swift code that depends on Apple\'s UI frameworks, which do not exist on Windows.',
    match: (ctx) => ev(
      ctx.linked(/SwiftUI\.framework|libswiftSwiftUI/) && `main binary links ${ctx.linked(/SwiftUI\.framework|libswiftSwiftUI/)}`,
      ctx.frameworks.filter((f) => /^libswiftSwiftUI/.test(f)).slice(0, 1).map((f) => `Contents/Frameworks/${f}`),
    ),
  },
  {
    id: 'swift',
    name: 'Swift',
    kind: 'refuse',
    why: 'Swift apps are compiled to native macOS machine code against Apple frameworks (AppKit, Foundation, ...). Nothing can be repackaged; the source must be ported.',
    match: (ctx) => ev(
      ctx.linked(/libswift[A-Za-z0-9_]*\.dylib|\/Swift\.framework/) && `main binary links ${ctx.linked(/libswift[A-Za-z0-9_]*\.dylib|\/Swift\.framework/)}`,
      ctx.frameworks.filter((f) => /^libswift/.test(f)).slice(0, 2).map((f) => `Contents/Frameworks/${f}`),
      ctx.macho.isMachO && ctx.macho.loadCommandsInclude('__swift5_') && 'Mach-O has __swift5_* sections',
    ),
  },
  {
    id: 'mas-native',
    name: 'Mac App Store sandboxed native',
    kind: 'refuse',
    why: 'App Store builds are sandboxed native macOS binaries signed for Apple\'s ecosystem.',
    match: (ctx) => ev(ctx.isMAS && 'Contents/_MASReceipt (Mac App Store receipt)'),
  },
  {
    id: 'appkit',
    name: 'Objective-C/AppKit native',
    kind: 'refuse',
    why: 'Native AppKit apps are compiled macOS code (Objective-C, C, C++ or similar) linked to Apple frameworks. There is nothing to repackage.',
    match: (ctx) => ev(ctx.linked(/AppKit\.framework|Cocoa\.framework/) && `main binary links ${ctx.linked(/AppKit\.framework|Cocoa\.framework/)}`),
  },
  {
    id: 'carbon',
    name: 'Carbon/CoreFoundation native',
    kind: 'refuse',
    why: 'This is a compiled native macOS binary linked to legacy Carbon/CoreFoundation APIs. There is nothing to repackage.',
    match: (ctx) => ev(ctx.linked(/Carbon\.framework|CoreFoundation\.framework/) && `main binary links ${ctx.linked(/Carbon\.framework|CoreFoundation\.framework/)}`),
  },
];

const collectMarkers = (table = TABLE) => [...new Set(table.flatMap((r) => r.markers || []))];

function describeBinary(ctx) {
  const m = ctx.macho;
  if (!ctx.exePath) return 'no executable found in Contents/MacOS';
  if (m.isMachO) return `Mach-O (${m.archs.join(', ')}) ${path.basename(ctx.exePath)}`;
  if (m.shebang) return `script (#!${m.shebang}) ${path.basename(ctx.exePath)}`;
  return `non-Mach-O file ${path.basename(ctx.exePath)}`;
}
/**
 * Detect the framework family of a bundle (see ctx from inspect.inspectBundle).
 * Returns { id, name, kind, why, evidence[] }. kind is 'refuse', 'convert' or 'unknown'.
 */
function detect(ctx, table = TABLE) {
  for (const row of table) {
    const evidence = row.match(ctx);
    if (evidence && evidence.length) {
      return { id: row.id, name: row.name, kind: row.kind, why: row.why, evidence };
    }
  }
  const facts = [describeBinary(ctx)];
  if (ctx.macho.isMachO && ctx.macho.libs.length) {
    facts.push(`links ${ctx.macho.libs.length} librar${ctx.macho.libs.length === 1 ? 'y' : 'ies'} (none identify a known runtime)`);
  }
  if (ctx.plistError) facts.push(`Info.plist: ${ctx.plistError}`);
  return {
    id: 'unknown',
    name: null,
    kind: 'unknown',
    why: 'toexe could not identify a convertible runtime in this bundle, so it will not guess.',
    evidence: facts,
  };
}

module.exports = { TABLE, detect, collectMarkers };
