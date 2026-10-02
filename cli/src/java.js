'use strict';

// Java path: the one app family toexe can genuinely help with.
//
// A Java .app is a launcher plus .jar files (plus a macOS JRE). The jars are
// platform independent, so we can copy them next to a Windows .bat launcher.
// The result is a WRAPPER, not a native .exe, and a Windows JRE is required.
// We refuse (rather than emit something broken) when the app depends on
// macOS-specific pieces: .dylib/.jnilib files, SWT-Cocoa, JavaFX mac natives, ...

const fs = require('node:fs');
const path = require('node:path');
const { manifestMainClass } = require('./zip');

const JAVA_LAUNCHERS = new Set(['JavaAppLauncher', 'JavaApplicationStub', 'universalJavaApplicationStub']);
const JAVA_PLIST_KEYS = [
  'JVMMainClassName', 'JVMRuntime', 'JVMVersion', 'JVMOptions', 'JVMArguments', 'JVMClassPath', 'Java', 'JavaX',
];
// Where jars normally live inside a Java .app (relative to Contents), with search depth.
const JAR_ROOTS = [
  { dir: 'Java', depth: 4, standard: true },
  { dir: 'Resources/Java', depth: 4, standard: true },
  { dir: 'app', depth: 4, standard: true },
  { dir: 'lib', depth: 4, standard: true },
  { dir: 'Resources', depth: 1, standard: false },
  { dir: 'MacOS', depth: 1, standard: false },
];

const RUNTIME_DIR_RE = /^(runtime|jre|jbr|jdk|_CodeSignature)$|\.(jre|jdk)$/i;
const skipRuntime = (name) => RUNTIME_DIR_RE.test(name);

// Jar names that are tied to a specific OS (SWT, JavaFX, LWJGL natives, ...).
const PLATFORM_JAR_RE = /(^|[-_.])(mac|macos|macosx|osx|darwin|cocoa)([-_.]|$)/i;
// Mac launcher-only JVM flags that make no sense on Windows.
const MAC_ONLY_OPTION_RE = /^(-Xdock:|-XstartOnFirstThread|-Dapple\.|-Dcom\.apple\.|-Dsun\.java2d\.metal|-Djava\.library\.path)/;
// Native libs that are part of Java launchers themselves and harmless.
const HARMLESS_NATIVE = new Set(['libapplauncher.dylib']);
const UNSAFE_BAT_CHARS = /["&|<>^]/;

function findJars(ctx) {
  const seen = new Map(); // rel path -> { rel, standard }
  for (const root of JAR_ROOTS) {
    if (!ctx.isDir(root.dir)) continue;
    const hits = ctx.find(root.dir, (n, r, isD) => !isD && /\.jar$/i.test(n), {
      maxDepth: root.depth, skipDir: skipRuntime, limit: 2000,
    });
    for (const rel of hits) if (!seen.has(rel)) seen.set(rel, { rel, standard: root.standard });
  }
  return [...seen.values()];
}

// Cheap signals used by detection.
function javaEvidence(ctx) {
  const ev = [];
  let strong = false;
  const plist = ctx.plist || {};
  for (const k of JAVA_PLIST_KEYS) {
    if (plist[k] !== undefined) { ev.push(`Info.plist key ${k}`); strong = true; }
  }
  if (ctx.exeName && JAVA_LAUNCHERS.has(ctx.exeName)) { ev.push(`Contents/MacOS/${ctx.exeName}`); strong = true; }
  const cfgs = ctx.list('app').filter((f) => f.endsWith('.cfg'));
  if (cfgs.length) { ev.push(`Contents/app/${cfgs[0]} (jpackage config)`); strong = true; }
  for (const d of ['runtime', 'jre', 'jbr']) {
    if (ctx.isDir(d)) { ev.push(`Contents/${d}/ (bundled JRE)`); strong = true; }
  }
  for (const d of ctx.list('PlugIns')) {
    if (/\.(jre|jdk)$/i.test(d)) { ev.push(`Contents/PlugIns/${d} (bundled JRE)`); strong = true; }
  }
  const jars = findJars(ctx);
  const stdJars = jars.filter((j) => j.standard);
  if (jars.length) ev.push(`${jars.length} .jar file(s), e.g. Contents/${jars[0].rel}`);
  return { evidence: ev, matches: strong || stdJars.length > 0, jars };
}

function parseCfg(file) {
  const out = { section: {}, javaOptions: [] };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (section === 'JavaOptions' && k === 'java-options') out.javaOptions.push(v);
    else if (section === 'Application' || section === '') out.section[k] = v;
  }
  return out;
}

const asArray = (v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

function jvmVersionHint(ctx) {
  const plist = ctx.plist || {};
  const v = plist.JVMVersion || (plist.Java && plist.Java.JVMVersion) || (plist.JavaX && plist.JavaX.JVMVersion);
  if (v) return String(v);
  for (const base of ['runtime/Contents/Home', 'jre/Contents/Home', 'jbr/Contents/Home']) {
    try {
      const rel = fs.readFileSync(ctx.abs(path.join(base, 'release')), 'utf8');
      const m = /JAVA_VERSION="?([^"\n]+)"?/.exec(rel);
      if (m) return `${m[1]} (version of the bundled macOS runtime)`;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Work out whether (and how) the app can be wrapped. Pure inspection, no writes.
 * Returns { ok, problems[], notes[], plan? }.
 */
function analyzeJava(ctx) {
  const problems = []; // each: { text, macSpecific }
  const notes = [];
  const plist = ctx.plist || {};
  const J = plist.Java || plist.JavaX || {};
  const jvmOptsRaw = plist.JVMOptions;
  const optsDict = jvmOptsRaw && !Array.isArray(jvmOptsRaw) && typeof jvmOptsRaw === 'object' ? jvmOptsRaw : null; // JetBrains style

  const cfgFile = ctx.list('app').find((f) => f.endsWith('.cfg'));
  const cfg = cfgFile ? parseCfg(ctx.abs(path.join('app', cfgFile))) : { section: {}, javaOptions: [] };

  const { jars: foundJars } = javaEvidence(ctx);
  const javaRoot = ctx.isDir('Java') ? 'Java' : ctx.isDir('Resources/Java') ? 'Resources/Java' : ctx.isDir('app') ? 'app' : 'lib';

  const expand = (s) => String(s)
    .replace(/\$\{?(APP_ROOT|APP_PACKAGE)\}?/g, ctx.appPath)
    .replace(/\$\{?JAVAROOT\}?/g, ctx.abs(javaRoot))
    .replace(/\$\{?APPDIR\}?/g, ctx.abs('app'))
    .replace(/\$\{?ROOTDIR\}?/g, ctx.contents);

  // ---- class path -------------------------------------------------------
  let cpRaw = [];
  if (Array.isArray(plist.JVMClassPath)) cpRaw = asArray(plist.JVMClassPath);
  else if (typeof plist.JVMClassPath === 'string') cpRaw = plist.JVMClassPath.split(':');
  else if (optsDict && optsDict.ClassPath) cpRaw = String(optsDict.ClassPath).split(':');
  else if (J.ClassPath) cpRaw = Array.isArray(J.ClassPath) ? asArray(J.ClassPath) : String(J.ClassPath).split(':');
  else if (cfg.section['app.classpath']) cpRaw = cfg.section['app.classpath'].split(':');

  const bundleRoot = ctx.appPath + path.sep;
  const cpEntries = []; // absolute paths inside the bundle
  for (const raw of cpRaw.filter(Boolean)) {
    let p = expand(raw);
    if (!path.isAbsolute(p)) p = path.join(ctx.abs(javaRoot), p);
    if (p.endsWith(`${path.sep}*`) || p.endsWith('/*')) {
      const dir = p.slice(0, -2);
      try {
        for (const f of fs.readdirSync(dir)) if (/\.jar$/i.test(f)) cpEntries.push(path.join(dir, f));
      } catch { /* missing dir */ }
      continue;
    }
    if (!(p + path.sep).startsWith(bundleRoot) && !p.startsWith(bundleRoot)) {
      notes.push(`class path entry outside the bundle was ignored: ${raw}`);
      continue;
    }
    if (fs.existsSync(p)) cpEntries.push(p);
    else notes.push(`class path entry not found in bundle: ${raw}`);
  }

  let classpath = [...new Set(cpEntries)];
  if (classpath.length === 0) classpath = foundJars.filter((j) => j.standard || foundJars.every((x) => !x.standard)).map((j) => ctx.abs(j.rel));

  // Main jar first (jpackage)
  const mainJarName = cfg.section['app.mainjar'];
  if (mainJarName) {
    const i = classpath.findIndex((p) => path.basename(p) === path.basename(mainJarName));
    if (i > 0) classpath.unshift(...classpath.splice(i, 1));
  }

  const jarFiles = classpath.filter((p) => /\.jar$/i.test(p));
  if (jarFiles.length === 0) {
    problems.push({ text: 'no .jar files were found in the bundle, so there is nothing to wrap', macSpecific: false });
  }

  // ---- main class -------------------------------------------------------
  let mainClass = plist.JVMMainClassName || (optsDict && optsDict.MainClass) || J.MainClass || cfg.section['app.mainclass'] || null;
  let mainClassSource = mainClass ? 'Info.plist / launcher config' : null;
  if (!mainClass) {
    for (const j of jarFiles) {
      const mc = manifestMainClass(j);
      if (mc) { mainClass = mc; mainClassSource = `Main-Class in ${path.basename(j)}`; break; }
    }
  }
  if (!mainClass && jarFiles.length) {
    problems.push({ text: 'could not determine the main class (no JVMMainClassName/MainClass in Info.plist and no Main-Class in any jar manifest)', macSpecific: false });
  }

  // ---- macOS-specific pieces -------------------------------------------
  const platformJars = jarFiles.filter((j) => PLATFORM_JAR_RE.test(path.basename(j).replace(/\.jar$/i, '')));
  if (platformJars.length) {
    problems.push({
      text: `uses macOS-specific libraries (${platformJars.slice(0, 3).map((p) => path.basename(p)).join(', ')}${platformJars.length > 3 ? ', ...' : ''}); the Windows equivalents are different jars toexe cannot supply`,
      macSpecific: true,
    });
  }
  const natives = ctx.find('', (n, r, isD) => (!isD && /\.(dylib|jnilib)$/i.test(n) && !HARMLESS_NATIVE.has(n)) || (isD && /\.framework$/i.test(n)), {
    maxDepth: 6, skipDir: (n) => skipRuntime(n) || /\.framework$/i.test(n), limit: 400,
  });
  if (natives.length) {
    problems.push({
      text: `bundles ${natives.length} macOS native librar${natives.length === 1 ? 'y' : 'ies'} (e.g. ${natives.slice(0, 3).map((p) => path.basename(p)).join(', ')}) that cannot run on Windows`,
      macSpecific: true,
    });
  }

  // ---- JVM options ------------------------------------------------------
  let rawOpts = [];
  if (Array.isArray(jvmOptsRaw)) rawOpts = asArray(jvmOptsRaw);
  else if (optsDict && optsDict.VMOptions) rawOpts = String(optsDict.VMOptions).split(/\s+/).filter(Boolean);
  if (J.VMOptions) rawOpts = rawOpts.concat(Array.isArray(J.VMOptions) ? asArray(J.VMOptions) : String(J.VMOptions).split(/\s+/).filter(Boolean));
  rawOpts = rawOpts.concat(cfg.javaOptions);
  const props = { ...(J.Properties || {}), ...((optsDict && optsDict.Properties) || {}) };
  for (const [k, v] of Object.entries(props)) rawOpts.push(`-D${k}=${v}`);

  const vmOptions = [];
  for (const o of rawOpts) {
    if (MAC_ONLY_OPTION_RE.test(o)) { notes.push(`dropped macOS-only JVM option: ${o}`); continue; }
    if (/\$/.test(o)) { notes.push(`dropped JVM option containing a macOS path variable: ${o}`); continue; }
    if (UNSAFE_BAT_CHARS.test(o)) { notes.push(`dropped JVM option with characters unsafe in a .bat file: ${o}`); continue; }
    vmOptions.push(o);
  }
  const args = [];
  for (const a of asArray(plist.JVMArguments).concat(asArray(J.Arguments))) {
    if (/\$/.test(a) || UNSAFE_BAT_CHARS.test(a)) notes.push(`dropped program argument: ${a}`);
    else args.push(a);
  }

  const plan = { jarFiles, classpath, mainClass, mainClassSource, vmOptions, args, javaVersion: jvmVersionHint(ctx), name: ctx.name };
  return {
    ok: problems.length === 0,
    problems: problems.map((p) => p.text),
    macSpecific: problems.some((p) => p.macSpecific),
    notes,
    plan,
  };
}

const safeName = (s) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'app';
const winEsc = (s) => String(s).replace(/%/g, '%%');

function buildBat(ctx, plan, relClasspath) {
  const cp = relClasspath.map((r) => `%APP_DIR%${r.split(path.sep).join('\\')}`).join(';');
  const opts = plan.vmOptions.map((o) => `"${winEsc(o)}"`).join(' ');
  const args = plan.args.map((a) => `"${winEsc(a)}"`).join(' ');
  const ver = plan.javaVersion ? ` (${plan.javaVersion})` : '';
  const lines = [
    '@echo off',
    `rem Generated by toexe from ${ctx.name}.app`,
    'rem This is a launcher script, NOT a native Windows executable. It needs Java.',
    'setlocal',
    'set "APP_DIR=%~dp0"',
    'where java >nul 2>nul',
    'if errorlevel 1 (',
    `  echo Java was not found on PATH. Install a Windows Java runtime${ver.replace(/[()]/g, '^$&')} and run this again.`,
    '  pause',
    '  exit /b 1',
    ')',
    `java ${opts} -cp "${cp}" ${plan.mainClass} ${args} %*`.replace(/ {2,}/g, ' '),
    'exit /b %errorlevel%',
    '',
  ];
  return lines.join('\r\n');
}

function buildReadme(ctx, plan, notes) {
  const lines = [
    `${ctx.name} - Windows wrapper generated by toexe`,
    '',
    'WHAT THIS IS',
    `  A launcher script (${safeName(ctx.name)}.bat) plus the .jar files from ${ctx.name}.app.`,
    '  It is NOT a native Windows .exe. It was NOT tested on Windows by toexe.',
    '',
    'REQUIREMENTS',
    `  A Java runtime for Windows must be installed and on PATH${plan.javaVersion ? ` (app hints: ${plan.javaVersion})` : ''}.`,
    '  The macOS runtime that shipped inside the .app cannot run on Windows and was not copied.',
    '',
    'HOW TO RUN',
    `  Double-click ${safeName(ctx.name)}.bat, or run it from a terminal.`,
    '',
    'KNOWN LIMITS',
    '  - Only jar files were copied. Other files the app reads from the .app bundle (Resources, etc.) were not.',
    '  - toexe cannot see inside jars: if a jar embeds only macOS native libraries, it will fail at runtime.',
    '  - Mac-specific behaviour (menu bar, dock icon, file associations) does not carry over.',
  ];
  if (notes.length) {
    lines.push('', 'ADJUSTMENTS MADE');
    for (const n of notes) lines.push(`  - ${n}`);
  }
  lines.push('');
  return lines.join('\r\n');
}

/**
 * Write the wrapper. Call analyzeJava first; this throws if analysis failed.
 * Returns { outputDir, files[], notes[] }.
 */
function writeJavaWrapper(ctx, analysis, outDir, { force = false } = {}) {
  if (!analysis.ok) throw new Error('cannot write wrapper: analysis reported problems');
  const { plan } = analysis;
  const dest = path.join(path.resolve(outDir), `${safeName(ctx.name)}-java-wrapper`);
  if (fs.existsSync(dest)) {
    if (!force) {
      const err = new Error(`${dest} already exists (use --force to replace it)`);
      err.code = 'EEXIST_OUT';
      throw err;
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });

  const relClasspath = [];
  const copied = [];
  for (const abs of plan.classpath) {
    const relToContents = path.relative(ctx.contents, abs);
    const target = path.join(dest, 'app', relToContents);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(abs, target, { recursive: true, dereference: true });
    relClasspath.push(path.join('app', relToContents));
    copied.push(path.relative(dest, target));
  }

  const batName = `${safeName(ctx.name)}.bat`;
  fs.writeFileSync(path.join(dest, batName), buildBat(ctx, plan, relClasspath));
  fs.writeFileSync(path.join(dest, 'README-WINDOWS.txt'), buildReadme(ctx, plan, analysis.notes));
  return { outputDir: dest, files: [batName, 'README-WINDOWS.txt', ...copied], notes: analysis.notes };
}

module.exports = { javaEvidence, analyzeJava, writeJavaWrapper, findJars };
