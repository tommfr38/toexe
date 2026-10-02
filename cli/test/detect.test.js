'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, rmrf, makeApp, machoThin, machoFat, writeJar, LIB, CPU_X86_64, CPU_ARM64 } = require('../testlib/fixtures');
const { inspectBundle } = require('../src/inspect');
const { detect, collectMarkers, TABLE } = require('../src/detect');
const { refusalMessage } = require('../src/messages');

let dir;
test.before(() => { dir = tmpDir(); });
test.after(() => rmrf(dir));

const detectApp = (app) => detect(inspectBundle(app, { markers: collectMarkers() }));
const swiftBin = (extra = {}) => machoThin({ libs: [LIB.system, LIB.foundation, LIB.appkit, LIB.swiftCore], ...extra });

test('Electron: framework dir + asar', () => {
  const app = makeApp(dir, 'ElectronFw', { files: { 'Frameworks/Electron Framework.framework/Electron Framework': 'x', 'Resources/app.asar': 'x' } });
  const d = detectApp(app);
  assert.equal(d.id, 'electron');
  assert.equal(d.kind, 'convert'); // conversion itself is covered in electron.test.js
  assert.equal(refusalMessage(d.name), 'Electron based apps cannot become exe'); // used when the app can't be repackaged
  assert.ok(d.evidence.some((e) => e.includes('Electron Framework.framework')));
});

test('Electron: only app.asar is enough', () => {
  const app = makeApp(dir, 'AsarOnly', { files: { 'Resources/app.asar': 'x' } });
  assert.equal(detectApp(app).id, 'electron');
});

test('Electron: ElectronAsarIntegrity plist key', () => {
  const app = makeApp(dir, 'Integrity', { plist: { ElectronAsarIntegrity: { 'Resources/app.asar': { algorithm: 'SHA256', hash: 'abc' } } } });
  assert.equal(detectApp(app).id, 'electron');
});

test('Electron wins over Swift/AppKit signals (most specific first)', () => {
  const app = makeApp(dir, 'ElectronSwift', { exe: swiftBin(), files: { 'Frameworks/Electron Framework.framework/x': 'x' } });
  assert.equal(detectApp(app).id, 'electron');
});

test('Swift: links libswiftCore', () => {
  const d = detectApp(makeApp(dir, 'SwiftLinked', { exe: swiftBin() }));
  assert.equal(d.id, 'swift');
  assert.equal(refusalMessage(d.name), 'Swift based apps cannot become exe');
  assert.ok(d.evidence[0].includes('libswiftCore'));
});

test('Swift: bundled libswift*.dylib in Frameworks', () => {
  const app = makeApp(dir, 'SwiftBundled', { files: { 'Frameworks/libswiftCore.dylib': 'x' } });
  assert.equal(detectApp(app).id, 'swift');
});

test('Swift: __swift5 sections in the Mach-O load commands', () => {
  const app = makeApp(dir, 'SwiftSections', { exe: machoThin({ libs: [LIB.system, LIB.appkit], extraText: ['__swift5_types'] }) });
  assert.equal(detectApp(app).id, 'swift');
});

test('SwiftUI: links SwiftUI (more specific than Swift)', () => {
  const d = detectApp(makeApp(dir, 'SwiftUIApp', { exe: swiftBin({ libs: [LIB.system, LIB.swiftCore, LIB.swiftUI] }) }));
  assert.equal(d.id, 'swiftui');
  assert.equal(refusalMessage(d.name), 'SwiftUI based apps cannot become exe');
});

test('Mac Catalyst: MACCATALYST build platform', () => {
  const d = detectApp(makeApp(dir, 'CatalystApp', { exe: machoThin({ libs: [LIB.system, LIB.swiftCore, LIB.swiftUI], platform: 6 }) }));
  assert.equal(d.id, 'catalyst');
});

test('Mac Catalyst: links UIKitMacHelper', () => {
  const d = detectApp(makeApp(dir, 'CatalystApp2', { exe: machoThin({ libs: [LIB.system, LIB.uikit] }) }));
  assert.equal(d.id, 'catalyst');
});

test('Qt: QtCore.framework', () => {
  const d = detectApp(makeApp(dir, 'QtFw', { files: { 'Frameworks/QtCore.framework/QtCore': 'x' } }));
  assert.equal(d.id, 'qt');
  assert.equal(refusalMessage(d.name), 'Qt based apps cannot become exe');
});

test('Qt: libQt6Core.dylib + cocoa platform plugin', () => {
  const d = detectApp(makeApp(dir, 'Qt6', { files: { 'Frameworks/libQt6Core.dylib': 'x', 'PlugIns/platforms/libqcocoa.dylib': 'x' } }));
  assert.equal(d.id, 'qt');
});

test('Flutter: FlutterMacOS.framework', () => {
  const d = detectApp(makeApp(dir, 'FlutterApp', { files: { 'Frameworks/FlutterMacOS.framework/FlutterMacOS': 'x', 'Frameworks/App.framework/Resources/flutter_assets/AssetManifest.json': '{}' }, exe: swiftBin() }));
  assert.equal(d.id, 'flutter');
  assert.equal(refusalMessage(d.name), 'Flutter based apps cannot become exe');
});

test('CEF: Chromium Embedded Framework', () => {
  const d = detectApp(makeApp(dir, 'CefApp', { files: { 'Frameworks/Chromium Embedded Framework.framework/x': 'x' } }));
  assert.equal(d.id, 'cef');
});

test('Chromium browser: "<X> Framework.framework" plus Helper apps', () => {
  const d = detectApp(makeApp(dir, 'Browser', { files: { 'Frameworks/Browser Framework.framework/Versions/1/Browser Framework': 'x', 'Frameworks/Browser Framework.framework/Versions/1/Helpers/Browser Helper (GPU).app/Contents/Info.plist': 'x' } }));
  assert.equal(d.id, 'chromium');
});

test('Gecko: omni.ja + libxul-style libs', () => {
  const d = detectApp(makeApp(dir, 'Gecko', { files: { 'Resources/omni.ja': 'x' } }));
  assert.equal(d.id, 'gecko');
});

test('NW.js', () => {
  const d = detectApp(makeApp(dir, 'NwApp', { files: { 'Frameworks/nwjs Framework.framework/x': 'x', 'Resources/nw.pak': 'x' } }));
  assert.equal(d.id, 'nwjs');
  assert.equal(refusalMessage(d.name), 'NW.js based apps cannot become exe');
});

test('Tauri: binary markers (single scan)', () => {
  const exe = machoThin({ libs: [LIB.system, 'WebKit'], payload: Buffer.from('....__TAURI_INTERNALS__....tauri://localhost....') });
  const d = detectApp(makeApp(dir, 'TauriApp', { exe }));
  assert.equal(d.id, 'tauri');
});

test('Unity: UnityPlayer.dylib', () => {
  assert.equal(detectApp(makeApp(dir, 'UnityGame', { files: { 'Frameworks/UnityPlayer.dylib': 'x' } })).id, 'unity');
});

test('Godot: .pck in Resources', () => {
  assert.equal(detectApp(makeApp(dir, 'GodotGame', { files: { 'Resources/game.pck': 'x' } })).id, 'godot');
});

test('Kotlin/Native: runtime symbol in binary', () => {
  const exe = machoThin({ libs: [LIB.system], payload: Buffer.from('Kotlin_initRuntimeIfNeeded') });
  assert.equal(detectApp(makeApp(dir, 'KN', { exe })).id, 'kotlin-native');
});

test('React Native macOS: main.jsbundle', () => {
  assert.equal(detectApp(makeApp(dir, 'RN', { files: { 'Resources/main.jsbundle': 'x' } })).id, 'react-native');
});

test('Python: PyInstaller bootloader marker', () => {
  const exe = machoThin({ libs: [LIB.system], payload: Buffer.from('failed to append to argv_pyi') });
  assert.equal(detectApp(makeApp(dir, 'PyInst', { exe })).id, 'python');
});

test('Mac App Store sandboxed native (no other signal)', () => {
  const d = detectApp(makeApp(dir, 'MasApp', { files: { '_MASReceipt/receipt': 'x' } }));
  assert.equal(d.id, 'mas-native');
});

test('Objective-C/AppKit native', () => {
  const d = detectApp(makeApp(dir, 'PlainAppKit'));
  assert.equal(d.id, 'appkit');
  assert.equal(refusalMessage(d.name), 'Objective-C/AppKit native based apps cannot become exe');
});

test('Java: appbundler layout is detected as convertible, not refused', () => {
  const app = makeApp(dir, 'JavaApp', { exeName: 'JavaAppLauncher', plist: { JVMMainClassName: 'com.example.Main' } });
  writeJar(`${app}/Contents/Java/app.jar`, { mainClass: 'com.example.Main' });
  const d = detectApp(app);
  assert.equal(d.id, 'java');
  assert.equal(d.kind, 'convert');
});

test('Java: jpackage layout (Contents/app/*.cfg + bundled runtime)', () => {
  const app = makeApp(dir, 'JPackaged', { files: { 'app/JPackaged.cfg': '[Application]\napp.mainjar=main.jar\n', 'runtime/Contents/Home/lib/libjli.dylib': 'x' } });
  writeJar(`${app}/Contents/app/main.jar`, { mainClass: 'a.B' });
  assert.equal(detectApp(app).id, 'java');
});

test('Unknown: shell-script executable, nothing recognisable', () => {
  const app = makeApp(dir, 'Mystery', { exe: '#!/bin/sh\necho hi\n' });
  const d = detectApp(app);
  assert.equal(d.id, 'unknown');
  assert.equal(d.kind, 'unknown');
  assert.equal(d.name, null);
  assert.ok(d.evidence.join(' ').includes('script'));
});

test('Unknown: Mach-O that only links libSystem', () => {
  const d = detectApp(makeApp(dir, 'Bare', { exe: machoThin({ libs: [LIB.system] }) }));
  assert.equal(d.id, 'unknown');
});

test('Universal (fat) binaries are parsed', () => {
  const fat = machoFat([
    machoThin({ libs: [LIB.system, LIB.swiftCore], cputype: CPU_X86_64 }),
    machoThin({ libs: [LIB.system, LIB.swiftCore], cputype: CPU_ARM64 }),
  ]);
  const ctx = inspectBundle(makeApp(dir, 'FatSwift', { exe: fat }));
  assert.deepEqual(ctx.macho.archs, ['x86_64', 'arm64']);
  assert.equal(detect(ctx).id, 'swift');
});

test('detection is table-driven: a custom table works and order matters', () => {
  const app = makeApp(dir, 'Custom', { files: { 'Resources/foo.txt': 'x' } });
  const ctx = inspectBundle(app);
  const table = [
    { id: 'a', name: 'Alpha', kind: 'refuse', why: 'w', match: (c) => c.exists('Resources/foo.txt') && ['foo'] },
    { id: 'b', name: 'Beta', kind: 'refuse', why: 'w', match: () => ['always'] },
  ];
  assert.equal(detect(ctx, table).name, 'Alpha');
  assert.equal(detect(ctx, table.slice().reverse()).name, 'Beta');
});

test('every table row is well formed and ids are unique', () => {
  const ids = new Set();
  for (const row of TABLE) {
    assert.ok(row.id && row.name && row.why, `row ${row.id} needs id, name, why`);
    assert.ok(['refuse', 'convert'].includes(row.kind));
    assert.equal(typeof row.match, 'function');
    assert.ok(!ids.has(row.id), `duplicate id ${row.id}`);
    ids.add(row.id);
  }
  assert.ok(TABLE.findIndex((r) => r.id === 'electron') < TABLE.findIndex((r) => r.id === 'swift'));
  assert.ok(TABLE.findIndex((r) => r.id === 'swiftui') < TABLE.findIndex((r) => r.id === 'swift'));
});

test('refusal message has the exact required wording', () => {
  assert.equal(refusalMessage('Electron'), 'Electron based apps cannot become exe');
  assert.equal(refusalMessage('Swift'), 'Swift based apps cannot become exe');
});
