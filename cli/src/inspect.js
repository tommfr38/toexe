'use strict';

// Builds a lazily-evaluated, read-only "view" of a .app bundle that the
// detection matchers query. Nothing here ever writes to the bundle.

const fs = require('node:fs');
const path = require('node:path');
const { readMachO } = require('./macho');
const { readPlist } = require('./plist');

const SCAN_CHUNK = 32 * 1024 * 1024;

function lazy(fn) {
  let done = false;
  let value;
  return () => {
    if (!done) { value = fn(); done = true; }
    return value;
  };
}

// Scan a file once for a set of byte-string markers (chunked, with overlap so
// markers spanning chunk borders are still found). Returns Set of found markers.
function scanFileForMarkers(file, markers) {
  const found = new Set();
  const needles = [...new Set(markers)].map((m) => [m, Buffer.from(m, 'latin1')]);
  if (needles.length === 0) return found;
  const overlap = Math.max(...needles.map(([, b]) => b.length)) - 1;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return found;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(SCAN_CHUNK + overlap);
    let pos = 0;
    let carry = 0;
    while (pos < size) {
      const n = fs.readSync(fd, buf, carry, SCAN_CHUNK, pos);
      if (n <= 0) break;
      const view = buf.subarray(0, carry + n);
      for (const [m, b] of needles) {
        if (!found.has(m) && view.indexOf(b) !== -1) found.add(m);
      }
      pos += n;
      carry = Math.min(overlap, view.length);
      view.copy(buf, 0, view.length - carry);
    }
  } finally {
    fs.closeSync(fd);
  }
  return found;
}

/**
 * @param {string} appPath path to a .app directory
 * @param {{markers?: string[]}} [opts] binary string markers to scan for in one pass
 */
function inspectBundle(appPath, opts = {}) {
  const root = path.resolve(appPath);
  const contents = path.join(root, 'Contents');
  const rel = (r) => path.join(contents, r);

  const safeStat = (p) => { try { return fs.statSync(p); } catch { return null; } };
  const exists = (r) => fs.existsSync(rel(r));
  const isDir = (r) => { const s = safeStat(rel(r)); return !!(s && s.isDirectory()); };
  const list = (r) => { try { return fs.readdirSync(rel(r)); } catch { return []; } };

  const plistResult = lazy(() => readPlist(path.join(contents, 'Info.plist')));

  const exePath = lazy(() => {
    const plist = plistResult().value;
    const macosDir = rel('MacOS');
    if (plist && typeof plist.CFBundleExecutable === 'string') {
      const p = path.join(macosDir, plist.CFBundleExecutable);
      if (fs.existsSync(p)) return p;
    }
    const files = list('MacOS').filter((f) => { const s = safeStat(path.join(macosDir, f)); return s && s.isFile(); });
    return files.length ? path.join(macosDir, files[0]) : null;
  });

  const macho = lazy(() => (exePath() ? readMachO(exePath()) : { isMachO: false }));

  const markerResults = lazy(() => (exePath() ? scanFileForMarkers(exePath(), opts.markers || []) : new Set()));
  const extraMarkerCache = new Map();

  const ctx = {
    appPath: root,
    name: path.basename(root).replace(/\.app$/i, ''),
    contents,
    exists,
    isDir,
    list,
    abs: rel,
    get plist() { return plistResult().value; },
    get plistError() { return plistResult().error; },
    get exePath() { return exePath(); },
    get exeName() { return exePath() ? path.basename(exePath()) : null; },
    get macho() { return macho(); },
    get frameworks() { return list('Frameworks'); },
    get isMAS() { return exists('_MASReceipt/receipt') || exists('_MASReceipt'); },

    // First linked library (install name) matching the regex, or null.
    linked(re) {
      const m = ctx.macho;
      return (m.isMachO && m.libs.find((l) => re.test(l))) || null;
    },

    // Does the main executable contain this byte string?
    binaryHas(marker) {
      if ((opts.markers || []).includes(marker)) return markerResults().has(marker);
      if (!extraMarkerCache.has(marker)) {
        extraMarkerCache.set(marker, exePath() ? scanFileForMarkers(exePath(), [marker]).has(marker) : false);
      }
      return extraMarkerCache.get(marker);
    },

    // Recursive file search under Contents (relative start dir), bounded.
    // `skipDir(name, relPath)` may prune directories. Returns relative paths.
    find(startRel, predicate, { maxDepth = 4, skipDir = () => false, limit = 5000 } = {}) {
      const out = [];
      const walk = (relDir, depth) => {
        if (out.length >= limit) return;
        let entries;
        try {
          entries = fs.readdirSync(rel(relDir), { withFileTypes: true });
        } catch { return; }
        for (const e of entries) {
          const r = path.join(relDir, e.name);
          let isD = e.isDirectory();
          if (e.isSymbolicLink()) { const s = safeStat(rel(r)); isD = !!(s && s.isDirectory()); }
          if (predicate(e.name, r, isD)) out.push(r);
          if (isD && depth < maxDepth && !skipDir(e.name, r)) walk(r, depth + 1);
          if (out.length >= limit) return;
        }
      };
      walk(startRel, 0);
      return out;
    },
  };
  return ctx;
}

module.exports = { inspectBundle, scanFileForMarkers };
