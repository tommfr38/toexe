'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { tmpDir, rmrf, makeApp, machoThin, writeJar, LIB } = require('../testlib/fixtures');
const { run, EXIT } = require('../src/cli');
const pkg = require('../package.json');

const BIN = path.join(__dirname, '..', 'bin', 'toexe.js');

let root;
test.before(() => { root = tmpDir(); });
test.after(() => rmrf(root));

function fresh(name) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const electron = (d, name = 'Foo') => makeApp(d, name, { files: { 'Frameworks/Electron Framework.framework/x': 'x', 'Resources/app.asar': 'x' } });
const swift = (d, name = 'Bar') => makeApp(d, name, { exe: machoThin({ libs: [LIB.system, LIB.swiftCore] }) });
const java = (d, name = 'Jay') => {
  const app = makeApp(d, name, { exeName: 'JavaAppLauncher', plist: { JVMMainClassName: 'com.example.Main' } });
  writeJar(`${app}/Contents/Java/app.jar`, { mainClass: 'com.example.Main' });
  return app;
};

async function runCli(args, { cwd, stdin = '', tty = false } = {}) {
  const input = new PassThrough();
  if (tty) input.isTTY = true;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let o = '';
  let e = '';
  stdout.on('data', (c) => { o += c; });
  stderr.on('data', (c) => { e += c; });
  input.end(stdin);
  const code = await run(args, { stdin: input, stdout, stderr, cwd, env: { NO_COLOR: '1' } });
  return { code, out: o, err: e };
}

test('--help prints usage and exits 0', async () => {
  const r = await runCli(['--help'], { cwd: root });
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage:/);
  assert.match(r.out, /--out <dir>/);
  assert.match(r.out, /cannot become exe/);
});

test('--version prints the package version', async () => {
  const r = await runCli(['--version'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), `toexe ${pkg.version}`);
});

test('unknown option is a usage error', async () => {
  const r = await runCli(['--nope'], { cwd: root });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /unknown option/);
});

test('no apps in folder: helpful message, non-zero exit', async () => {
  const r = await runCli([], { cwd: fresh('empty') });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /No \.app bundles found/);
  assert.match(r.err, /toexe \/path\/to\/Foo\.app/);
});

test('missing explicit path: non-zero exit', async () => {
  const r = await runCli(['/definitely/not/here.app'], { cwd: root });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /Not found/);
});

test('single Electron app: refused with the exact message, exit 1, nothing written', async () => {
  const d = fresh('single');
  electron(d);
  const r = await runCli([], { cwd: d });
  assert.equal(r.code, EXIT.FAILED);
  assert.ok(r.err.split('\n').some((l) => l.trim() === 'Electron based apps cannot become exe'), r.err);
  assert.ok(!fs.existsSync(path.join(d, 'toexe-out')));
});

test('explicit path to a Swift app: exact refusal text', async () => {
  const d = fresh('explicit');
  const app = swift(d);
  const r = await runCli([app], { cwd: root });
  assert.equal(r.code, 1);
  assert.ok(r.err.split('\n').some((l) => l.trim() === 'Swift based apps cannot become exe'), r.err);
});

test('unknown app: says unrecognized app type, does not fake output, exit 1', async () => {
  const d = fresh('unknown');
  const app = makeApp(d, 'Mystery', { exe: '#!/bin/sh\n' });
  const r = await runCli([app], { cwd: d });
  assert.equal(r.code, 1);
  assert.match(r.err, /Unrecognized app type/);
  assert.match(r.err, /Nothing was produced/);
  assert.ok(!fs.existsSync(path.join(d, 'toexe-out')));
});

test('multiple apps: numbered list, then a single number', async () => {
  const d = fresh('multi1');
  electron(d, 'A');
  swift(d, 'B');
  java(d, 'C');
  const r = await runCli([], { cwd: d, stdin: '2\n' });
  assert.match(r.out, /1\) A\.app/);
  assert.match(r.out, /2\) B\.app/);
  assert.match(r.out, /3\) C\.app/);
  assert.match(r.err, /Swift based apps cannot become exe/);
  assert.ok(!/Electron based/.test(r.err));
  assert.ok(!/Java/.test(r.out.split('Which to convert?')[1] || ''));
  assert.equal(r.code, 1);
});

test('multiple apps: comma-separated selection', async () => {
  const d = fresh('multi2');
  electron(d, 'A');
  swift(d, 'B');
  java(d, 'C');
  const r = await runCli([], { cwd: d, stdin: '1,3\n' });
  assert.match(r.err, /Electron based apps cannot become exe/);
  assert.ok(!/Swift based/.test(r.err));
  assert.match(r.out, /Created a Java WRAPPER/);
  assert.ok(fs.existsSync(path.join(d, 'toexe-out', 'C-java-wrapper', 'C.bat')));
});

test('multiple apps: "all"', async () => {
  const d = fresh('multi3');
  electron(d, 'A');
  swift(d, 'B');
  const r = await runCli([], { cwd: d, stdin: 'all\n' });
  assert.match(r.err, /Electron based apps cannot become exe/);
  assert.match(r.err, /Swift based apps cannot become exe/);
  assert.match(r.out, /0 converted, 2 refused/);
});

test('multiple apps: invalid answer re-prompts, then accepts', async () => {
  const d = fresh('multi4');
  electron(d, 'A');
  swift(d, 'B');
  const r = await runCli([], { cwd: d, stdin: 'banana\n9\n1\n' });
  assert.match(r.err, /not a number/);
  assert.match(r.err, /out of range/);
  assert.match(r.err, /Electron based apps cannot become exe/);
});

test('multiple apps: quit cancels with non-zero exit', async () => {
  const d = fresh('multi5');
  electron(d, 'A');
  swift(d, 'B');
  const r = await runCli([], { cwd: d, stdin: 'q\n' });
  assert.match(r.out, /Cancelled/);
  assert.notEqual(r.code, 0);
});

test('multiple apps: closed stdin gives a clear error instead of hanging', async () => {
  const d = fresh('multi6');
  electron(d, 'A');
  swift(d, 'B');
  const r = await runCli([], { cwd: d, stdin: '' });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.err, /No input received/);
});

test('single app on an interactive terminal asks for confirmation; "n" cancels', async () => {
  const d = fresh('confirm-no');
  electron(d);
  const r = await runCli([], { cwd: d, stdin: 'n\n', tty: true });
  assert.match(r.out, /Convert Foo\.app\? \[Y\/n\]/);
  assert.match(r.out, /Cancelled/);
  assert.doesNotMatch(r.err, /cannot become exe/);
  assert.notEqual(r.code, 0);
});

test('single app on an interactive terminal: Enter accepts', async () => {
  const d = fresh('confirm-yes');
  electron(d);
  const r = await runCli([], { cwd: d, stdin: '\n', tty: true });
  assert.match(r.err, /Electron based apps cannot become exe/);
});

test('--all skips the prompt', async () => {
  const d = fresh('multi7');
  electron(d, 'A');
  swift(d, 'B');
  const r = await runCli(['--all'], { cwd: d });
  assert.doesNotMatch(r.out, /Which to convert/);
  assert.match(r.out, /0 converted, 2 refused/);
});

test('Java app: --out puts a labelled wrapper in the chosen folder', async () => {
  const d = fresh('java1');
  const app = java(d);
  const out = path.join(d, 'custom out');
  const r = await runCli([app, '--out', out], { cwd: d });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /WRAPPER/);
  assert.match(r.out, /NOT a native \.exe/);
  assert.match(r.out, /Windows Java runtime/);
  assert.ok(fs.existsSync(path.join(out, 'Jay-java-wrapper', 'Jay.bat')));
});

test('--check writes nothing', async () => {
  const d = fresh('check');
  const app = java(d);
  const r = await runCli([app, '--check'], { cwd: d });
  assert.equal(r.code, 0);
  assert.match(r.out, /Would create a Java WRAPPER/);
  assert.ok(!fs.existsSync(path.join(d, 'toexe-out')));
});

test('a folder path is searched for apps', async () => {
  const d = fresh('folderarg');
  electron(d, 'Z');
  const r = await runCli(['--yes', d], { cwd: root });
  assert.match(r.err, /Electron based apps cannot become exe/);
});

test('bin script end to end: real process, exact refusal text on stderr, exit 1', () => {
  const d = fresh('spawn');
  electron(d);
  const r = spawnSync(process.execPath, [BIN], { cwd: d, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, input: '' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.split('\n').some((l) => l.trim() === 'Electron based apps cannot become exe'), r.stderr);
});

test('bin script: --help exits 0 and --version matches package.json', () => {
  const h = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(v.stdout.trim(), `toexe ${pkg.version}`);
});
