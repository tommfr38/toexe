'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { tmpDir, rmrf, makeApp, plistXml, writeZip, writeAsar } = require('../testlib/fixtures');
const { inspectBundle } = require('../src/inspect');
const { analyzeElectron, writeElectronApp, listAsar } = require('../src/electron');
const { run } = require('../src/cli');

const VERSION = '30.1.2';
const WIN_ZIP = `electron-v${VERSION}-win32-x64.zip`;

let root;
let server;
let mirror;
const hits = { zip: 0, sums: 0 };
let tamper = false;

test.before(async () => {
  root = tmpDir();
  const zipFile = path.join(root, 'served.zip');
  writeZip(zipFile, { 'electron.exe': 'MZ-fake-electron', 'resources/default_app.asar': 'default', 'locales/en-US.pak': 'pak', 'icudtl.dat': 'icu' });
  const zip = fs.readFileSync(zipFile);
  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  server = http.createServer((req, res) => {
    if (req.url === `/v${VERSION}/SHASUMS256.txt`) {
      hits.sums++;
      res.end(`${tamper ? '0'.repeat(64) : sha} *${WIN_ZIP}\n`);
    } else if (req.url === `/v${VERSION}/${WIN_ZIP}`) {
      hits.zip++;
      res.end(zip);
    } else { res.statusCode = 404; res.end('nope'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  mirror = `http://127.0.0.1:${server.address().port}/`;
});
test.after(async () => { await new Promise((r) => server.close(r)); rmrf(root); });

let n = 0;
function electronApp(dir, name, { version = VERSION, files = {}, asar = { 'main.js': 'console.log(1)', 'package.json': '{"main":"main.js"}' } } = {}) {
  const fw = 'Frameworks/Electron Framework.framework/Resources/Info.plist';
  const app = makeApp(dir, name, { files: { [fw]: version ? plistXml({ CFBundleVersion: version }) : plistXml({}), 'Resources/other.txt': 'hello', 'Resources/en.lproj/x.strings': 'x', ...files } });
  if (asar) writeAsar(path.join(app, 'Contents/Resources/app.asar'), asar);
  return app;
}
const fresh = () => { const d = path.join(root, `case${n++}`); fs.mkdirSync(d); return d; };
const env = (extra = {}) => ({ NO_COLOR: '1', TOEXE_ELECTRON_MIRROR: mirror, TOEXE_CACHE_DIR: path.join(root, 'cache'), ...extra });

async function runCli(args, { cwd, environment } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let o = '';
  let e = '';
  stdout.on('data', (c) => { o += c; });
  stderr.on('data', (c) => { e += c; });
  const input = new PassThrough();
  input.end('');
  const code = await run(args, { stdin: input, stdout, stderr, cwd, env: environment || env() });
  return { code, out: o, err: e };
}

test('listAsar reads file paths from the header', () => {
  const f = path.join(root, 'x.asar');
  writeAsar(f, { 'a.js': '1', 'node_modules/m/build/m.node': '2' });
  assert.deepEqual(listAsar(f).sort(), ['a.js', 'node_modules/m/build/m.node']);
  assert.equal(listAsar(path.join(root, 'served.zip')), null);
});

test('analyze: reads the version and the asar payload', () => {
  const a = analyzeElectron(inspectBundle(electronApp(fresh(), 'Good')));
  assert.equal(a.ok, true);
  assert.deepEqual(a.plan, { version: VERSION, payload: 'app.asar' });
});

test('analyze: no readable version is a problem', () => {
  const a = analyzeElectron(inspectBundle(electronApp(fresh(), 'NoVer', { version: null })));
  assert.equal(a.ok, false);
  assert.match(a.problems.join('\n'), /Electron version/);
});

test('analyze: no app code is a problem', () => {
  const a = analyzeElectron(inspectBundle(electronApp(fresh(), 'NoCode', { asar: null })));
  assert.equal(a.ok, false);
  assert.match(a.problems.join('\n'), /no app code/);
});

test('analyze: .node inside the asar blocks conversion unless forced', () => {
  const app = electronApp(fresh(), 'Native', { asar: { 'main.js': '1', 'node_modules/x/x.node': 'MACHO' } });
  const blocked = analyzeElectron(inspectBundle(app));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.nativeBlocks, true);
  assert.match(blocked.nativeModules[0], /x\.node/);
  assert.equal(analyzeElectron(inspectBundle(app), { force: true }).ok, true);
});

test('writeElectronApp builds <Name>.exe, keeps app code, drops the default app, uses the cache', async () => {
  const out = fresh();
  const ctx = inspectBundle(electronApp(fresh(), 'My App'));
  const res = await writeElectronApp(ctx, analyzeElectron(ctx), out, { env: env({ TOEXE_CACHE_DIR: path.join(root, 'cache-a') }) });
  const d = res.outputDir;
  assert.equal(path.basename(d), 'My App-win32-x64');
  assert.equal(fs.readFileSync(path.join(d, 'My App.exe'), 'utf8'), 'MZ-fake-electron');
  assert.ok(!fs.existsSync(path.join(d, 'electron.exe')));
  assert.ok(fs.existsSync(path.join(d, 'resources/app.asar')));
  assert.ok(!fs.existsSync(path.join(d, 'resources/default_app.asar')));
  assert.ok(fs.existsSync(path.join(d, 'resources/other.txt')));
  assert.ok(!fs.existsSync(path.join(d, 'resources/en.lproj')));
  assert.ok(fs.existsSync(path.join(d, 'locales/en-US.pak')));
  assert.match(fs.readFileSync(path.join(d, 'README-WINDOWS.txt'), 'utf8'), /Not run on Windows/);
  assert.deepEqual(fs.readdirSync(out), ['My App-win32-x64'], 'no staging leftovers');

  const before = hits.zip;
  const again = await writeElectronApp(ctx, analyzeElectron(ctx), out, { force: true, env: env({ TOEXE_CACHE_DIR: path.join(root, 'cache-a') }) });
  assert.equal(again.cached, true);
  assert.equal(hits.zip, before, 'zip served from cache');
});

test('writeElectronApp refuses to overwrite without force', async () => {
  const out = fresh();
  const ctx = inspectBundle(electronApp(fresh(), 'Twice'));
  await writeElectronApp(ctx, analyzeElectron(ctx), out, { env: env() });
  await assert.rejects(writeElectronApp(ctx, analyzeElectron(ctx), out, { env: env() }), /already exists/);
});

test('a checksum mismatch aborts and writes nothing', async () => {
  const out = fresh();
  const ctx = inspectBundle(electronApp(fresh(), 'Bad'));
  tamper = true;
  try {
    await assert.rejects(writeElectronApp(ctx, analyzeElectron(ctx), out, { env: env({ TOEXE_CACHE_DIR: path.join(root, 'cache-bad') }) }), /checksum mismatch/);
  } finally { tamper = false; }
  assert.deepEqual(fs.readdirSync(out), []);
  assert.ok(!fs.existsSync(path.join(root, 'cache-bad', WIN_ZIP)), 'bad download is not kept');
});

test('an unknown Electron version fails with a clear error', async () => {
  const ctx = inspectBundle(electronApp(fresh(), 'Old', { version: '1.2.3' }));
  await assert.rejects(writeElectronApp(ctx, analyzeElectron(ctx), fresh(), { env: env() }), /HTTP 404/);
});

test('CLI: converts an Electron app end to end', async () => {
  const cwd = fresh();
  electronApp(cwd, 'Cli App');
  const r = await runCli(['--yes', '--out', 'o'], { cwd });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Created a Windows app/);
  assert.ok(fs.existsSync(path.join(cwd, 'o/Cli App-win32-x64/Cli App.exe')));
  assert.match(r.out, /Not run on Windows/);
});

test('CLI: --check does not download or write anything', async () => {
  const cwd = fresh();
  electronApp(cwd, 'Checked');
  const before = { ...hits };
  const r = await runCli(['--check', '--yes'], { cwd });
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`Electron ${VERSION.replace(/\./g, '\\.')}`));
  assert.deepEqual(hits, before);
  assert.ok(!fs.existsSync(path.join(cwd, 'toexe-out')));
});

test('CLI: native modules are refused with a clear sentence, --force overrides', async () => {
  const cwd = fresh();
  electronApp(cwd, 'Nat', { asar: { 'main.js': '1', 'node_modules/y/y.node': 'M' } });
  const r = await runCli(['--yes'], { cwd });
  assert.equal(r.code, 1);
  assert.ok(r.err.split('\n').some((l) => l.trim() === 'Electron apps with native macOS modules cannot become exe'), r.err);
  assert.ok(!fs.existsSync(path.join(cwd, 'toexe-out')));
  const f = await runCli(['--yes', '--force'], { cwd });
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /native macOS modules were copied/i);
});

test('CLI: an Electron app whose version cannot be read prints the exact refusal line', async () => {
  const cwd = fresh();
  electronApp(cwd, 'Mystery', { version: null });
  const r = await runCli(['--yes'], { cwd });
  assert.equal(r.code, 1);
  assert.ok(r.err.split('\n').some((l) => l.trim() === 'Electron based apps cannot become exe'), r.err);
});

test('CLI: --arch is validated', async () => {
  const r = await runCli(['--arch', 'mips'], { cwd: root });
  assert.equal(r.code, 2);
  assert.match(r.err, /--arch must be one of/);
});
