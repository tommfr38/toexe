'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSelection } = require('../src/select');

test('single number', () => {
  assert.deepEqual(parseSelection('2', 3), { ok: true, indices: [1] });
  assert.deepEqual(parseSelection('  1  ', 3), { ok: true, indices: [0] });
});

test('comma-separated list (sorted, de-duplicated)', () => {
  assert.deepEqual(parseSelection('3,1', 3), { ok: true, indices: [0, 2] });
  assert.deepEqual(parseSelection('1, 3', 4), { ok: true, indices: [0, 2] });
  assert.deepEqual(parseSelection('2,2,2', 3), { ok: true, indices: [1] });
});

test('space-separated list and ranges', () => {
  assert.deepEqual(parseSelection('1 3', 3), { ok: true, indices: [0, 2] });
  assert.deepEqual(parseSelection('2-4', 5), { ok: true, indices: [1, 2, 3] });
  assert.deepEqual(parseSelection('1,3-4', 5), { ok: true, indices: [0, 2, 3] });
});

test('"all" in any case, plus a and *', () => {
  for (const s of ['all', 'ALL', ' All ', 'a', '*']) {
    assert.deepEqual(parseSelection(s, 3), { ok: true, indices: [0, 1, 2] });
  }
});

test('quit words cancel', () => {
  for (const s of ['q', 'quit', 'exit', 'Cancel']) assert.deepEqual(parseSelection(s, 3), { ok: false, cancel: true });
});

test('rejects empty, out of range, zero, junk and bad ranges', () => {
  for (const s of ['', '   ', '0', '4', '1,9', 'foo', '1,x', '3-2', '0-2', '2-9', '-1']) {
    const r = parseSelection(s, 3);
    assert.equal(r.ok, false, `"${s}" should be rejected`);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, `"${s}" should explain why`);
  }
});

test('null / undefined input is an error, not a crash', () => {
  assert.equal(parseSelection(null, 2).ok, false);
  assert.equal(parseSelection(undefined, 2).ok, false);
});
