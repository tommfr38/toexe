'use strict';

// Parse the answer to "Which app(s) to convert?".
// Accepts: a single number ("2"), a comma/space separated list ("1,3" / "1 3"),
// ranges ("2-4"), "all" (or "a", "*"), and "q"/"quit"/"exit"/"cancel" to abort.
//
// Returns one of:
//   { ok: true,  indices: [0-based, ascending, unique] }
//   { ok: false, cancel: true }
//   { ok: false, error: 'message' }
function parseSelection(input, count) {
  const text = String(input == null ? '' : input).trim().toLowerCase();
  if (text === '') return { ok: false, error: 'Please enter a number, a list like 1,3, or "all".' };
  if (['q', 'quit', 'exit', 'cancel'].includes(text)) return { ok: false, cancel: true };

  const tokens = text.split(/[\s,]+/).filter(Boolean);
  if (tokens.some((t) => t === 'all' || t === 'a' || t === '*')) {
    return { ok: true, indices: Array.from({ length: count }, (_, i) => i) };
  }

  const picked = new Set();
  for (const t of tokens) {
    let m = /^(\d+)$/.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n < 1 || n > count) return { ok: false, error: `${t} is out of range (choose 1-${count}).` };
      picked.add(n - 1);
      continue;
    }
    m = /^(\d+)-(\d+)$/.exec(t);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a > b) return { ok: false, error: `"${t}" is not a valid range.` };
      if (a < 1 || b > count) return { ok: false, error: `"${t}" is out of range (choose 1-${count}).` };
      for (let n = a; n <= b; n++) picked.add(n - 1);
      continue;
    }
    return { ok: false, error: `"${t}" is not a number. Use e.g. 2, 1,3 or all.` };
  }
  return { ok: true, indices: [...picked].sort((x, y) => x - y) };
}

module.exports = { parseSelection };
