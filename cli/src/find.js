'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash', 'Library']);

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// A directory counts as an app bundle when it ends in .app and has Contents/.
function isAppBundle(p) {
  return /\.app$/i.test(p) && isDir(p) && isDir(path.join(p, 'Contents'));
}

/**
 * Find .app bundles under `dir`. Direct children are checked first; only if
 * there are none does it look one level deeper (up to maxDepth). It never
 * descends into a .app. If `dir` is itself an app, returns just that.
 * Returns absolute paths sorted by name.
 */
function findApps(dir, { maxDepth = 2 } = {}) {
  const root = path.resolve(dir);
  if (isAppBundle(root)) return [root];

  const scan = (d, level, target, out) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (!(e.isDirectory() || (e.isSymbolicLink() && isDir(p)))) continue;
      const looksApp = /\.app$/i.test(e.name);
      if (level === target) {
        if (looksApp && isAppBundle(p)) out.push(p);
      } else if (!looksApp) {
        scan(p, level + 1, target, out);
      }
    }
  };

  for (let depth = 1; depth <= maxDepth; depth++) {
    const out = [];
    scan(root, 1, depth, out);
    if (out.length) return out.sort((a, b) => a.localeCompare(b));
  }
  return [];
}

module.exports = { findApps, isAppBundle };
