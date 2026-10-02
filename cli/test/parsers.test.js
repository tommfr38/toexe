'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, rmrf, plistXml, machoThin, machoFat, writeJar, LIB, CPU_X86_64, CPU_ARM64 } = require('../testlib/fixtures');
const { parseXmlPlist } = require('../src/plist');
const { readMachO } = require('../src/macho');
const { manifestMainClass } = require('../src/zip');
const { scanFileForMarkers } = require('../src/inspect');

let dir;
test.before(() => { dir = tmpDir(); });
test.after(() => rmrf(dir));

test('plist: round-trips nested dict/array/bool/int/entities', () => {
  const obj = { a: 'x & <y>', n: 3, t: true, f: false, arr: ['1', { k: 'v' }], d: { e: {} }, empty: '' };
  assert.deepEqual(parseXmlPlist(plistXml(obj)), { ...obj, d: { e: {} } });
});

test('plist: handles comments, doctype, self-closing values', () => {
  const xml = '<?xml version="1.0"?><!DOCTYPE plist><!-- hi --><plist><dict><key>A</key><true/><key>B</key><string/><key>C</key><array/></dict></plist>';
  assert.deepEqual(parseXmlPlist(xml), { A: true, B: '', C: [] });
});

test('macho: thin binary exposes libs, arch and platform', () => {
  const f = path.join(dir, 'thin');
  fs.writeFileSync(f, machoThin({ libs: [LIB.system, LIB.swiftCore], platform: 1 }));
  const m = readMachO(f);
  assert.equal(m.isMachO, true);
  assert.deepEqual(m.archs, ['arm64']);
  assert.deepEqual(m.libs, [LIB.system, LIB.swiftCore]);
  assert.deepEqual(m.platforms, ['macos']);
});

test('macho: fat binary merges slices', () => {
  const f = path.join(dir, 'fat');
  fs.writeFileSync(f, machoFat([machoThin({ libs: [LIB.system], cputype: CPU_X86_64 }), machoThin({ libs: [LIB.appkit], cputype: CPU_ARM64 })]));
  const m = readMachO(f);
  assert.deepEqual(m.archs, ['x86_64', 'arm64']);
  assert.deepEqual([...m.libs].sort(), [LIB.appkit, LIB.system].sort());
});

test('macho: scripts and Java class files are not Mach-O', () => {
  const s = path.join(dir, 'script');
  fs.writeFileSync(s, '#!/bin/bash\necho\n');
  assert.deepEqual(readMachO(s), { isMachO: false, shebang: '/bin/bash' });
  const c = path.join(dir, 'Foo.class');
  fs.writeFileSync(c, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34, 0, 0, 0, 0]));
  assert.equal(readMachO(c).isMachO, false);
  assert.equal(readMachO(path.join(dir, 'missing')).isMachO, false);
});

test('zip: reads Main-Class from a jar manifest', () => {
  const jar = path.join(dir, 'a.jar');
  writeJar(jar, { mainClass: 'org.example.Main' });
  assert.equal(manifestMainClass(jar), 'org.example.Main');
  const none = path.join(dir, 'b.jar');
  writeJar(none);
  assert.equal(manifestMainClass(none), null);
  assert.equal(manifestMainClass(path.join(dir, 'nope.jar')), null);
});

test('scanFileForMarkers finds markers across chunk boundaries', () => {
  const f = path.join(dir, 'big.bin');
  const chunk = 32 * 1024 * 1024;
  const buf = Buffer.alloc(chunk + 64, 0x41);
  Buffer.from('NEEDLE-ACROSS').copy(buf, chunk - 5); // straddles the 32 MiB boundary
  fs.writeFileSync(f, buf);
  const found = scanFileForMarkers(f, ['NEEDLE-ACROSS', 'NOT-THERE']);
  assert.deepEqual([...found], ['NEEDLE-ACROSS']);
});
