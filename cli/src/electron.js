'use strict';

// Electron path: repackage an Electron .app for Windows.
//
// An Electron app is a prebuilt Electron runtime plus the app's own JavaScript
// (Contents/Resources/app.asar or Contents/Resources/app/). The JavaScript is
// platform independent, so we take the official WINDOWS Electron build of the
// same version and drop the app's resources into it. The result is a folder
// with <Name>.exe that is a real Windows executable (the Electron runtime), not
// a wrapper.
//
// What can go wrong, and what we do about it:
//   - native Node modules (.node files) were compiled for macOS and cannot load on
//     Windows: refuse unless --force.
//   - the Electron version cannot be read from the bundle: refuse (we will not guess).
//   - the app uses macOS-only Electron APIs: cannot be detected here, so it is
//     listed as a caveat in the output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { readPlist } = require('./plist');

const ARCHS = ['x64', 'arm64', 'ia32'];
const DEFAULT_MIRROR = 'https://github.com/electron/electron/releases/download/';

const safeName = (n) => String(n).replace(/[^A-Za-z0-9._ -]/g, '_').trim() || 'app';

// ---- reading the bundle ----------------------------------------------------

function electronVersion(ctx) {
  const fw = 'Frameworks/Electron Framework.framework';
  const candidates = [`${fw}/Resources/Info.plist`, `${fw}/Versions/A/Resources/Info.plist`];
  for (const c of candidates) {
    if (!ctx.exists(c)) continue;
    const { value } = readPlist(ctx.abs(c));
    if (!value) continue;
    for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) {
      const v = value[key];
      if (typeof v === 'string' && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) return v;
    }
  }
  return null;
}

// Paths of files inside an asar archive (header only; the content is never read).
function listAsar(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) < 16) return null;
    const jsonLen = head.readUInt32LE(12);
    if (head.readUInt32LE(0) !== 4 || jsonLen === 0 || jsonLen > 64 * 1024 * 1024) return null;
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    const root = JSON.parse(json.toString('utf8'));
    const out = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.files) walk(child, p);
        else out.push(p);
      }
    };
    walk(root, '');
    return out;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function findNativeModules(ctx) {
  const hits = [];
  const asar = 'Resources/app.asar';
  if (ctx.exists(asar)) {
    const files = listAsar(ctx.abs(asar));
    if (files) for (const f of files) if (/\.node$/i.test(f)) hits.push(`${asar}: ${f}`);
  }
  for (const dir of ['Resources/app.asar.unpacked', 'Resources/app']) {
    if (!ctx.isDir(dir)) continue;
    for (const f of ctx.find(dir, (n, r, isD) => !isD && /\.node$/i.test(n), { maxDepth: 12, limit: 200 })) hits.push(f);
  }
  return hits;
}

/**
 * Pure inspection. Returns { ok, problems[], nativeModules[], plan? }.
 * `ok` is false when we must refuse; `nativeModules` non-empty makes ok false unless force.
 */
function analyzeElectron(ctx, { force = false } = {}) {
  const problems = [];
  const version = electronVersion(ctx);
  if (!version) problems.push('could not read the Electron version from Contents/Frameworks/Electron Framework.framework');

  const asar = ctx.exists('Resources/app.asar');
  const dir = ctx.isDir('Resources/app');
  if (!asar && !dir) problems.push('no app code found (expected Contents/Resources/app.asar or Contents/Resources/app/)');

  const nativeModules = findNativeModules(ctx);
  const nativeBlocks = nativeModules.length > 0 && !force;

  const caveats = [
    'Not run on Windows by toexe. Test the result on a Windows machine.',
    'No icon or version info is embedded in the .exe (that needs Windows tooling).',
    'Code that uses macOS-only Electron APIs (dock, systemPreferences, macOS menus) may not behave the same on Windows.',
  ];
  return {
    ok: problems.length === 0 && !nativeBlocks,
    problems,
    nativeModules,
    nativeBlocks,
    caveats,
    plan: problems.length ? null : { version, payload: asar ? 'app.asar' : 'app/' },
  };
}

// ---- downloading ---------------------------------------------------------

function cacheDir(env) {
  if (env.TOEXE_CACHE_DIR) return path.resolve(env.TOEXE_CACHE_DIR);
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'toexe', 'electron');
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    const e = new Error(`download failed (HTTP ${res.status}): ${url}`);
    e.status = res.status;
    throw e;
  }
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { got += c.length; if (onProgress) onProgress(got, total); });
  const tmp = `${dest}.part`;
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): ${url}`);
  return res.text();
}

/** Download (or reuse from cache) the official Windows Electron zip and verify its SHA-256. */
async function getElectronZip(version, arch, { env = process.env, onProgress } = {}) {
  const mirror = (env.TOEXE_ELECTRON_MIRROR || DEFAULT_MIRROR).replace(/\/?$/, '/');
  const name = `electron-v${version}-win32-${arch}.zip`;
  const base = `${mirror}v${version}/`;
  const dir = cacheDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, name);

  const sums = await fetchText(`${base}SHASUMS256.txt`);
  const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(` *${name}`) || l.trim().endsWith(`  ${name}`));
  const expected = line && line.trim().split(/\s+/)[0].toLowerCase();
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`no checksum for ${name} in ${base}SHASUMS256.txt (is Electron ${version} available for win32-${arch}?)`);
  }

  if (fs.existsSync(zip) && sha256File(zip) === expected) return { zip, cached: true };
  fs.rmSync(zip, { force: true });
  await download(`${base}${name}`, zip, onProgress);
  const actual = sha256File(zip);
  if (actual !== expected) {
    fs.rmSync(zip, { force: true });
    throw new Error(`checksum mismatch for ${name} (expected ${expected}, got ${actual}); refusing to use it`);
  }
  return { zip, cached: false };
}

function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  try {
    execFileSync('unzip', ['-q', '-o', zip, '-d', dest], { stdio: 'pipe' });
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`could not unzip ${path.basename(zip)}: ${String(e.stderr || e.message).trim()}`);
    execFileSync('ditto', ['-x', '-k', zip, dest], { stdio: 'pipe' }); // macOS fallback
  }
}

// ---- writing the output --------------------------------------------------

/**
 * Build <outDir>/<Name>-win32-<arch>/ with <Name>.exe. Call analyzeElectron first.
 * Returns { outputDir, exe, notes[] }.
 */
async function writeElectronApp(ctx, analysis, outDir, { arch = 'x64', force = false, env = process.env, onProgress } = {}) {
  if (!analysis.plan) throw new Error('cannot convert: analysis reported problems');
  if (!ARCHS.includes(arch)) throw new Error(`unsupported --arch ${arch} (use ${ARCHS.join(', ')})`);
  const { version } = analysis.plan;
  const name = safeName(ctx.name);
  const dest = path.join(path.resolve(outDir), `${name}-win32-${arch}`);
  if (fs.existsSync(dest)) {
    if (!force) {
      const err = new Error(`${dest} already exists (use --force to replace it)`);
      err.code = 'EEXIST_OUT';
      throw err;
    }
  }

  const { zip, cached } = await getElectronZip(version, arch, { env, onProgress });

  // Build next to the destination, then swap in, so a failure leaves nothing half-written.
  const staging = `${dest}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    unzip(zip, staging);
    const exeSrc = path.join(staging, 'electron.exe');
    if (!fs.existsSync(exeSrc)) throw new Error('the Windows Electron download has no electron.exe');
    const exe = `${name}.exe`;
    fs.renameSync(exeSrc, path.join(staging, exe));

    const res = path.join(staging, 'resources');
    fs.mkdirSync(res, { recursive: true });
    fs.rmSync(path.join(res, 'default_app.asar'), { force: true });
    for (const entry of fs.readdirSync(ctx.abs('Resources'))) {
      if (/\.lproj$/i.test(entry) || entry === 'default_app.asar') continue;
      fs.cpSync(ctx.abs(path.join('Resources', entry)), path.join(res, entry), { recursive: true, dereference: true });
    }
    fs.writeFileSync(path.join(staging, 'README-WINDOWS.txt'), buildReadme(ctx, analysis, { version, arch, exe }));

    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
    return { outputDir: dest, exe, cached, version, notes: analysis.nativeModules.length ? ['Native macOS modules were copied (--force); they will not load on Windows.'] : [] };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

function buildReadme(ctx, analysis, { version, arch, exe }) {
  const lines = [
    `${ctx.name} - Windows build generated by toexe`,
    '',
    `Run ${exe}. This folder is the app: keep ${exe}, resources/ and the other files together.`,
    `It is the official Windows Electron ${version} (${arch}) runtime with this app's code from the macOS .app.`,
    '',
    'Caveats:',
    ...analysis.caveats.map((c) => `  - ${c}`),
  ];
  if (analysis.nativeModules.length) {
    lines.push('', 'Native macOS modules were found and copied because --force was used. They cannot load on Windows:');
    for (const m of analysis.nativeModules.slice(0, 20)) lines.push(`  - ${m}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { analyzeElectron, writeElectronApp, electronVersion, listAsar, findNativeModules, getElectronZip, ARCHS, DEFAULT_MIRROR };
