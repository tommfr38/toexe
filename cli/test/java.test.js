'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, rmrf, makeApp, writeJar } = require('../testlib/fixtures');
const { inspectBundle } = require('../src/inspect');
const { analyzeJava, writeJavaWrapper } = require('../src/java');

let dir;
test.before(() => { dir = tmpDir(); });
test.after(() => rmrf(dir));

function appbundlerApp(name, extra = {}) {
  const app = makeApp(dir, name, {
    exeName: 'JavaAppLauncher',
    plist: { JVMMainClassName: 'com.example.Main', JVMOptions: ['-Xmx512m', '-Xdock:name=Foo', '-Dapple.laf.useScreenMenuBar=true', '-Dfoo=bar'], JVMVersion: '11+', ...(extra.plist || {}) },
    files: extra.files,
  });
  writeJar(`${app}/Contents/Java/app.jar`, { mainClass: 'com.example.Main' });
  writeJar(`${app}/Contents/Java/lib/dep.jar`);
  return app;
}

test('analyze: plain jar app is wrappable; mac-only JVM options are dropped', () => {
  const a = analyzeJava(inspectBundle(appbundlerApp('Plain')));
  assert.equal(a.ok, true, a.problems.join('; '));
  assert.equal(a.plan.mainClass, 'com.example.Main');
  assert.deepEqual(a.plan.vmOptions, ['-Xmx512m', '-Dfoo=bar']);
  assert.equal(a.plan.classpath.length, 2);
  assert.ok(a.notes.some((n) => n.includes('-Xdock:name')));
});

test('write: creates a .bat wrapper, copies jars, README says it is not a native exe', () => {
  const ctx = inspectBundle(appbundlerApp('Wrapped'));
  const out = path.join(dir, 'out1');
  const res = writeJavaWrapper(ctx, analyzeJava(ctx), out);
  assert.equal(res.outputDir, path.join(out, 'Wrapped-java-wrapper'));
  const bat = fs.readFileSync(path.join(res.outputDir, 'Wrapped.bat'), 'utf8');
  assert.match(bat, /\r\n/);
  assert.match(bat, /where java/);
  assert.match(bat, /com\.example\.Main/);
  assert.match(bat, /"-Xmx512m"/);
  assert.match(bat, /%APP_DIR%app\\Java\\app\.jar/);
  assert.ok(!bat.includes('Xdock'));
  assert.ok(fs.existsSync(path.join(res.outputDir, 'app', 'Java', 'app.jar')));
  assert.ok(fs.existsSync(path.join(res.outputDir, 'app', 'Java', 'lib', 'dep.jar')));
  const readme = fs.readFileSync(path.join(res.outputDir, 'README-WINDOWS.txt'), 'utf8');
  assert.match(readme, /NOT a native Windows \.exe/);
  assert.ok(!fs.readdirSync(res.outputDir).some((f) => f.endsWith('.exe')));
});

test('write: refuses to overwrite without force, replaces with force', () => {
  const ctx = inspectBundle(appbundlerApp('Twice'));
  const out = path.join(dir, 'out2');
  writeJavaWrapper(ctx, analyzeJava(ctx), out);
  assert.throws(() => writeJavaWrapper(ctx, analyzeJava(ctx), out), /already exists/);
  assert.doesNotThrow(() => writeJavaWrapper(ctx, analyzeJava(ctx), out, { force: true }));
});

test('main class falls back to the jar manifest', () => {
  const app = makeApp(dir, 'ManifestOnly', { exeName: 'JavaAppLauncher', plist: { JVMVersion: '1.8+' } });
  writeJar(`${app}/Contents/Java/x.jar`, { mainClass: 'from.Manifest' });
  const a = analyzeJava(inspectBundle(app));
  assert.equal(a.ok, true);
  assert.equal(a.plan.mainClass, 'from.Manifest');
});

test('jpackage layout: reads .cfg main class, class path and java-options', () => {
  const app = makeApp(dir, 'Jpk', {
    files: {
      'app/Jpk.cfg': '[Application]\napp.mainjar=main.jar\napp.mainclass=jp.Main\napp.classpath=$APPDIR/main.jar:$APPDIR/other.jar\n[JavaOptions]\njava-options=-Dx=1\njava-options=-Djava.library.path=$APPDIR/../MacOS\n',
      'MacOS/libapplauncher.dylib': 'x',
    },
  });
  writeJar(`${app}/Contents/app/other.jar`);
  writeJar(`${app}/Contents/app/main.jar`);
  const a = analyzeJava(inspectBundle(app));
  assert.equal(a.ok, true, a.problems.join('; '));
  assert.equal(a.plan.mainClass, 'jp.Main');
  assert.equal(path.basename(a.plan.classpath[0]), 'main.jar');
  assert.deepEqual(a.plan.vmOptions, ['-Dx=1']);
});

test('refuses: bundled macOS native libraries (.dylib/.jnilib)', () => {
  const a = analyzeJava(inspectBundle(appbundlerApp('Native', { files: { 'Java/libfoo.jnilib': 'x' } })));
  assert.equal(a.ok, false);
  assert.equal(a.macSpecific, true);
  assert.match(a.problems.join(' '), /macOS native librar/);
});

test('refuses: SWT-Cocoa / macOS-only jars', () => {
  const app = appbundlerApp('Swt');
  writeJar(`${app}/Contents/Java/swt-4.30-cocoa-macosx-aarch64.jar`);
  const a = analyzeJava(inspectBundle(app));
  assert.equal(a.ok, false);
  assert.equal(a.macSpecific, true);
});

test('refuses: no jars at all', () => {
  const app = makeApp(dir, 'NoJars', { exeName: 'JavaAppLauncher', plist: { JVMMainClassName: 'a.B' } });
  const a = analyzeJava(inspectBundle(app));
  assert.equal(a.ok, false);
  assert.match(a.problems.join(' '), /no \.jar files/);
});

test('refuses: cannot determine the main class', () => {
  const app = makeApp(dir, 'NoMain', { exeName: 'JavaAppLauncher', plist: { JVMVersion: '11+' } });
  writeJar(`${app}/Contents/Java/x.jar`);
  const a = analyzeJava(inspectBundle(app));
  assert.equal(a.ok, false);
  assert.match(a.problems.join(' '), /main class/);
});

test('bundled JRE directories are not scanned for native libs', () => {
  const app = appbundlerApp('WithJre', { files: { 'runtime/Contents/Home/lib/libjvm.dylib': 'x', 'PlugIns/jdk17.jdk/Contents/Home/lib/libnet.dylib': 'x' } });
  const a = analyzeJava(inspectBundle(app));
  assert.equal(a.ok, true, a.problems.join('; '));
});
