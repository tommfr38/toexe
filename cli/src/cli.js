'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const pkg = require('../package.json');
const { createStyle, shouldColor } = require('./ui');
const { findApps, isAppBundle } = require('./find');
const { inspectBundle } = require('./inspect');
const { detect, collectMarkers, TABLE } = require('./detect');
const { analyzeJava, writeJavaWrapper } = require('./java');
const { analyzeElectron, writeElectronApp, ARCHS } = require('./electron');
const { parseSelection } = require('./select');
const { refusalMessage } = require('./messages');

const EXIT = { OK: 0, FAILED: 1, USAGE: 2 };

const HELP = `toexe - check whether a macOS .app can become a Windows executable

Usage:
  toexe                      find .app bundles in the current folder and pick which to convert
  toexe /path/to/Foo.app     convert a specific app (several paths are allowed)
  toexe /path/to/folder      look for .app bundles inside a folder

Options:
  -o, --out <dir>   where to write output (default: ./toexe-out)
  -y, --yes         do not ask for confirmation
  -a, --all         when several apps are found, convert all of them without asking
      --arch <arch> Windows architecture for Electron apps: x64 (default), arm64, ia32
      --check       only inspect and report; write nothing
      --force       replace an existing output folder of the same name
      --no-color    disable colored output
  -h, --help        show this help
  -v, --version     show the version

What toexe does:
  It inspects the app bundle (Info.plist, the Mach-O binary, Contents/Frameworks,
  Resources) to identify its framework. Most Mac apps - Swift, SwiftUI, Objective-C/
  AppKit, Qt, Flutter, Unity, Tauri, ... - CANNOT be turned into a Windows exe, and
  toexe says so instead of faking output ("Swift based apps cannot become exe").
  Electron apps are repackaged with the official Windows Electron runtime (downloaded
  from GitHub and checksum-verified) into a folder with a real <Name>.exe, unless they
  contain native macOS modules. Java apps (jar files) can be wrapped with a Windows
  .bat launcher; that is a wrapper needing a Windows JRE, not a native exe.

Exit codes: 0 all selected apps converted, 1 something was refused or failed, 2 usage
error or no apps found.
`;

function parseArgs(argv) {
  const o = { paths: [], out: null, arch: 'x64', yes: false, all: false, check: false, force: false, noColor: false, help: false, version: false };
  const errors = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (rest || !a.startsWith('-') || a === '-') { o.paths.push(a); continue; }
    if (a === '--') { rest = true; continue; }
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '-y': case '--yes': o.yes = true; break;
      case '-a': case '--all': o.all = true; break;
      case '--check': o.check = true; break;
      case '--force': o.force = true; break;
      case '--no-color': o.noColor = true; break;
      case '-o': case '--out':
        if (i + 1 >= argv.length) errors.push(`${a} needs a directory`);
        else o.out = argv[++i];
        break;
      case '--arch':
        if (i + 1 >= argv.length) errors.push('--arch needs a value');
        else o.arch = argv[++i];
        break;
      default:
        if (a.startsWith('--out=')) o.out = a.slice(6);
        else if (a.startsWith('--arch=')) o.arch = a.slice(7);
        else errors.push(`unknown option: ${a}`);
    }
  }
  if (o.out === '') errors.push('--out needs a directory');
  if (!ARCHS.includes(o.arch)) errors.push(`--arch must be one of ${ARCHS.join(', ')} (got "${o.arch}")`);
  return { opts: o, errors };
}

// Line-based prompter that also works with piped stdin (lines are queued, EOF yields null).
function createPrompter(input, output) {
  const rl = readline.createInterface({ input, output, terminal: !!(input.isTTY && output.isTTY) });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
  rl.on('close', () => { closed = true; waiters.splice(0).forEach((w) => w(null)); });
  return {
    ask(question) {
      output.write(question);
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((res) => waiters.push(res));
    },
    close() { rl.close(); },
  };
}

async function run(argv, io = {}) {
  const stdin = io.stdin || process.stdin;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const cwd = io.cwd || process.cwd();
  const env = io.env || process.env;

  const { opts, errors } = parseArgs(argv);
  const out = createStyle(shouldColor(stdout, env, opts.noColor));
  const err = createStyle(shouldColor(stderr, env, opts.noColor));
  const println = (s = '') => stdout.write(`${s}\n`);
  const eprintln = (s = '') => stderr.write(`${s}\n`);

  if (errors.length) {
    for (const e of errors) eprintln(err.red(`toexe: ${e}`));
    eprintln('Run "toexe --help" for usage.');
    return EXIT.USAGE;
  }
  if (opts.help) { stdout.write(HELP); return EXIT.OK; }
  if (opts.version) { println(`toexe ${pkg.version}`); return EXIT.OK; }

  println(`${out.bold('toexe')} ${out.dim(pkg.version)}`);

  // ---- 1. figure out which apps we are talking about -------------------
  let discovered = [];
  let direct = [];
  if (opts.paths.length === 0) {
    discovered = findApps(cwd);
    if (discovered.length === 0) {
      eprintln(err.red(`No .app bundles found in ${cwd}`));
      eprintln('cd into a folder that contains a macOS .app, or pass a path: toexe /path/to/Foo.app');
      return EXIT.USAGE;
    }
  } else {
    for (const p of opts.paths) {
      const abs = path.resolve(cwd, p);
      if (!fs.existsSync(abs)) {
        eprintln(err.red(`Not found: ${p}`));
        return EXIT.USAGE;
      }
      if (isAppBundle(abs)) direct.push(abs);
      else if (/\.app$/i.test(abs)) {
        eprintln(err.red(`${p} does not look like an app bundle (no Contents/ folder).`));
        return EXIT.USAGE;
      } else {
        const found = findApps(abs);
        if (found.length === 0) {
          eprintln(err.red(`No .app bundles found in ${abs}`));
          return EXIT.USAGE;
        }
        discovered.push(...found);
      }
    }
  }

  // ---- 2. choose ---------------------------------------------------------
  let selected = [...direct];
  const interactiveStdin = !!stdin.isTTY;
  let prompter = null;
  const getPrompter = () => prompter || (prompter = createPrompter(stdin, stdout));

  try {
    if (discovered.length > 0) {
      const base = opts.paths.length ? null : cwd;
      const label = (p) => (base ? path.relative(base, p) || path.basename(p) : p);
      println(`Found ${out.bold(String(discovered.length))} app${discovered.length === 1 ? '' : 's'}${base ? ` in ${out.dim(cwd)}` : ''}:`);
      discovered.forEach((p, i) => println(`  ${out.cyan(`${i + 1})`)} ${label(p)}`));
      println();

      if (discovered.length === 1) {
        let go = true;
        if (!opts.yes && interactiveStdin) {
          const ans = await getPrompter().ask(`Convert ${out.bold(path.basename(discovered[0]))}? [Y/n] `);
          if (ans === null) { eprintln(err.red('\nNo input received.')); return EXIT.USAGE; }
          go = /^(|y|yes)$/i.test(ans.trim());
        }
        if (!go) { println('Cancelled.'); return EXIT.FAILED; }
        selected.push(discovered[0]);
      } else if (opts.all) {
        selected.push(...discovered);
      } else {
        for (;;) {
          const ans = await getPrompter().ask(`Which to convert? ${out.dim('[number, 1,3, 2-4, all, q]')} `);
          if (ans === null) {
            eprintln(err.red('\nNo input received. Pass an explicit path, or use --all.'));
            return EXIT.USAGE;
          }
          const sel = parseSelection(ans, discovered.length);
          if (sel.ok) { selected.push(...sel.indices.map((i) => discovered[i])); break; }
          if (sel.cancel) { println('Cancelled.'); return EXIT.FAILED; }
          eprintln(err.yellow(sel.error));
        }
        println();
      }
    }
  } finally {
    if (prompter) prompter.close();
  }

  selected = [...new Set(selected)];

  // ---- 3. inspect + convert each ----------------------------------------
  const outDir = path.resolve(cwd, opts.out || 'toexe-out');
  const markers = collectMarkers(TABLE);
  const tally = { converted: 0, refused: 0, failed: 0 };

  for (const appPath of selected) {
    const ctx = inspectBundle(appPath, { markers });
    const name = path.basename(appPath);
    println(out.bold(name));
    const det = detect(ctx);

    const showEvidence = (stream, style) => {
      if (!det.evidence.length) return;
      stream(style.dim('  Evidence:'));
      for (const e of det.evidence.slice(0, 6)) stream(style.dim(`    - ${e}`));
    };

    if (det.kind === 'refuse') {
      eprintln(`  ${err.red(err.bold(refusalMessage(det.name)))}`);
      eprintln(err.dim(`  Why: ${det.why}`));
      showEvidence(eprintln, err);
      tally.refused++;
      println();
      continue;
    }

    if (det.kind === 'unknown') {
      eprintln(`  ${err.yellow(err.bold('Unrecognized app type'))}${err.yellow(': toexe could not identify a convertible runtime.')}`);
      eprintln(err.dim('  Nothing was produced. toexe will not guess or emit an exe that might not work.'));
      showEvidence(eprintln, err);
      tally.refused++;
      println();
      continue;
    }

    if (det.id === 'electron') {
      println(`  Detected: ${out.cyan('Electron')} ${out.dim('(repackaged with the official Windows Electron runtime)')}`);
      const analysis = analyzeElectron(ctx, { force: opts.force });
      if (!analysis.ok) {
        if (analysis.nativeBlocks) {
          eprintln(`  ${err.red(err.bold('Electron apps with native macOS modules cannot become exe'))}`);
          eprintln(err.dim('  .node files are compiled for macOS and cannot load on Windows:'));
          for (const m of analysis.nativeModules.slice(0, 6)) eprintln(err.dim(`    - ${m}`));
          eprintln(err.dim('  Use --force to convert anyway (the app will likely fail on Windows).'));
        } else {
          eprintln(`  ${err.red(err.bold(refusalMessage('Electron')))}`);
        }
        for (const p of analysis.problems) eprintln(err.red(`  - ${p}`));
        tally.refused++;
        println();
        continue;
      }
      if (opts.check) {
        println(`  ${out.green('Would create a Windows folder with a real .exe')} ${out.dim(`(Electron ${analysis.plan.version}, win32-${opts.arch}, ${analysis.plan.payload})`)}`);
        for (const c of analysis.caveats) println(out.dim(`  note: ${c}`));
        tally.converted++;
        println();
        continue;
      }
      try {
        let last = -1;
        const onProgress = (got, total) => {
          if (!stdout.isTTY || !total) return;
          const pct = Math.floor((got / total) * 100);
          if (pct !== last) { last = pct; stdout.write(`\r  Downloading Windows Electron ${analysis.plan.version} ... ${pct}%`); }
        };
        const res = await writeElectronApp(ctx, analysis, outDir, { arch: opts.arch, force: opts.force, env, onProgress });
        if (last >= 0) stdout.write('\r\x1b[K');
        println(`  ${out.green(out.bold('Created a Windows app'))} ${out.dim(`(Electron ${res.version}, win32-${opts.arch}${res.cached ? ', runtime from cache' : ''})`)}`);
        println(`  Output: ${res.outputDir}`);
        println(`    ${res.exe}  (the Windows Electron runtime running this app's code)`);
        for (const c of analysis.caveats) println(out.yellow(`  ${c}`));
        for (const n of res.notes) println(out.yellow(`  ${n}`));
        tally.converted++;
      } catch (e) {
        eprintln(err.red(`  Failed: ${e.message}`));
        tally.failed++;
      }
      println();
      continue;
    }

    // kind === 'convert' (Java)
    println(`  Detected: ${out.cyan('Java')} ${out.dim('(jar-based app)')}`);
    const analysis = analyzeJava(ctx);
    if (!analysis.ok) {
      if (analysis.macSpecific) eprintln(`  ${err.red(err.bold(refusalMessage('macOS-specific Java')))}`);
      else eprintln(`  ${err.red(err.bold("Couldn't build a Java wrapper"))}`);
      for (const p of analysis.problems) eprintln(err.red(`  - ${p}`));
      tally.refused++;
      println();
      continue;
    }

    if (opts.check) {
      println(`  ${out.green('Would create a Java WRAPPER')} ${out.dim('(a .bat launcher + jars, not a native exe)')}`);
      println(out.dim(`  Main class: ${analysis.plan.mainClass}; ${analysis.plan.classpath.length} class path entr${analysis.plan.classpath.length === 1 ? 'y' : 'ies'}`));
      for (const n of analysis.notes) println(out.dim(`  note: ${n}`));
      tally.converted++;
      println();
      continue;
    }

    try {
      const res = writeJavaWrapper(ctx, analysis, outDir, { force: opts.force });
      println(`  ${out.green(out.bold('Created a Java WRAPPER'))} ${out.dim('(NOT a native .exe)')}`);
      println(`  Output: ${res.outputDir}`);
      println(`    ${res.files[0]}  launcher script`);
      println(`    ${res.files.length - 2} jar/class path item(s) copied under app/`);
      println(out.yellow('  Requires a Windows Java runtime (JRE) on PATH; the macOS JRE in the .app was not copied.'));
      println(out.yellow('  Not tested on Windows by toexe. See README-WINDOWS.txt in the output folder.'));
      for (const n of res.notes) println(out.dim(`  note: ${n}`));
      tally.converted++;
    } catch (e) {
      eprintln(err.red(`  Failed: ${e.message}`));
      tally.failed++;
    }
    println();
  }

  // ---- 4. summary ---------------------------------------------------------
  const parts = [`${tally.converted} ${opts.check ? 'convertible' : 'converted'}`, `${tally.refused} refused`];
  if (tally.failed) parts.push(`${tally.failed} failed`);
  println(parts.join(', '));
  return tally.refused || tally.failed ? EXIT.FAILED : EXIT.OK;
}

module.exports = { run, parseArgs, EXIT, HELP };
