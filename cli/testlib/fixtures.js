'use strict';

// Helpers that build fake .app bundles in a temp dir for tests.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDir(prefix = 'toexe-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// ---- plist ---------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plistValue(v, ind) {
  if (typeof v === 'boolean') return `${ind}<${v}/>`;
  if (typeof v === 'number') return `${ind}<integer>${v}</integer>`;
  if (Array.isArray(v)) return `${ind}<array>\n${v.map((x) => plistValue(x, `${ind}  `)).join('\n')}\n${ind}</array>`;
  if (v && typeof v === 'object') {
    const inner = Object.entries(v).map(([k, x]) => `${ind}  <key>${esc(k)}</key>\n${plistValue(x, `${ind}  `)}`).join('\n');
    return `${ind}<dict>\n${inner}\n${ind}</dict>`;
  }
  return `${ind}<string>${esc(v)}</string>`;
}
function plistXml(obj) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(obj, '')}\n</plist>\n`;
}

// ---- Mach-O --------------------------------------------------------------
const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

function pad8(n) { return (n + 7) & ~7; }

/** Build a thin 64-bit little-endian Mach-O with the given dylib links. */
function machoThin({ libs = [], platform = null, extraText = [], cputype = CPU_ARM64, payload = Buffer.alloc(0) } = {}) {
  const cmds = [];
  for (const lib of libs) {
    const nameBytes = Buffer.from(`${lib}\0`);
    const size = pad8(24 + nameBytes.length);
    const b = Buffer.alloc(size);
    b.writeUInt32LE(0x0c, 0);
    b.writeUInt32LE(size, 4);
    b.writeUInt32LE(24, 8);
    nameBytes.copy(b, 24);
    cmds.push(b);
  }
  if (platform) {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(0x32, 0);
    b.writeUInt32LE(24, 4);
    b.writeUInt32LE(platform, 8);
    cmds.push(b);
  }
  for (const t of extraText) { // opaque command carrying a section/segment name
    const text = Buffer.from(`${t}\0`);
    const size = pad8(8 + text.length);
    const b = Buffer.alloc(size);
    b.writeUInt32LE(0x19, 0);
    b.writeUInt32LE(size, 4);
    text.copy(b, 8);
    cmds.push(b);
  }
  const body = Buffer.concat(cmds);
  const head = Buffer.alloc(32);
  head.writeUInt32LE(0xfeedfacf, 0);
  head.writeUInt32LE(cputype, 4);
  head.writeUInt32LE(2, 12); // MH_EXECUTE
  head.writeUInt32LE(cmds.length, 16);
  head.writeUInt32LE(body.length, 20);
  return Buffer.concat([head, body, payload]);
}

/** Wrap small thin slices (< 4 KiB each) into a fat (universal) binary. */
function machoFat(slices) {
  const out = Buffer.alloc(4096 * (slices.length + 1));
  out.writeUInt32BE(0xcafebabe, 0);
  out.writeUInt32BE(slices.length, 4);
  slices.forEach((s, i) => {
    const o = 8 + 20 * i;
    const off = 4096 * (i + 1);
    out.writeUInt32BE(s.readUInt32LE(4), o); // cputype
    out.writeUInt32BE(off, o + 8);
    out.writeUInt32BE(s.length, o + 12);
    out.writeUInt32BE(12, o + 16);
    s.copy(out, off);
  });
  return out;
}

const LIB = {
  system: '/usr/lib/libSystem.B.dylib',
  foundation: '/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation',
  appkit: '/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit',
  swiftCore: '/usr/lib/swift/libswiftCore.dylib',
  swiftUI: '/System/Library/Frameworks/SwiftUI.framework/Versions/A/SwiftUI',
  uikit: '/System/Library/PrivateFrameworks/UIKitMacHelper.framework/Versions/A/UIKitMacHelper',
};

// ---- ZIP / JAR -----------------------------------------------------------
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Write a (stored, uncompressed) zip with the given { name: content } entries. */
function writeZip(file, entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameB = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameB, data);
    central.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([...locals, cd, eocd]));
}

function writeJar(file, { mainClass = null } = {}) {
  const entries = {};
  entries['META-INF/MANIFEST.MF'] = `Manifest-Version: 1.0\r\n${mainClass ? `Main-Class: ${mainClass}\r\n` : ''}\r\n`;
  entries['com/example/Placeholder.class'] = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
  writeZip(file, entries);
}

/** Write a minimal valid asar archive with { 'dir/file.js': content } entries. */
function writeAsar(file, entries) {
  const root = { files: {} };
  let offset = 0;
  const bodies = [];
  for (const [p, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const parts = p.split('/');
    let node = root;
    for (const d of parts.slice(0, -1)) node = node.files[d] = node.files[d] || { files: {} };
    node.files[parts[parts.length - 1]] = { size: data.length, offset: String(offset) };
    bodies.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(root));
  const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + jsonPadded.length, 4);
  head.writeUInt32LE(4 + jsonPadded.length, 8);
  head.writeUInt32LE(json.length, 12);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, jsonPadded, ...bodies]));
}

// ---- app bundles ---------------------------------------------------------
/**
 * Create <parent>/<name>.app.
 *  opts.plist   : object merged into Info.plist (CFBundleExecutable defaults to name)
 *  opts.exe     : Buffer|string content of Contents/MacOS/<exeName> (default: AppKit Mach-O)
 *  opts.exeName : executable file name (default: name)
 *  opts.files   : { 'Resources/app.asar': 'x', ... } paths relative to Contents
 *  opts.dirs    : empty directories relative to Contents
 */
function makeApp(parent, name, opts = {}) {
  const app = path.join(parent, `${name}.app`);
  const contents = path.join(app, 'Contents');
  const exeName = opts.exeName || name;
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  const plist = { CFBundleName: name, CFBundleExecutable: exeName, CFBundlePackageType: 'APPL', ...(opts.plist || {}) };
  fs.writeFileSync(path.join(contents, 'Info.plist'), plistXml(plist));
  const exe = opts.exe !== undefined ? opts.exe : machoThin({ libs: [LIB.system, LIB.foundation, LIB.appkit] });
  fs.writeFileSync(path.join(contents, 'MacOS', exeName), exe, { mode: 0o755 });
  for (const d of opts.dirs || []) fs.mkdirSync(path.join(contents, d), { recursive: true });
  for (const [rel, content] of Object.entries(opts.files || {})) {
    const p = path.join(contents, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return app;
}

module.exports = { tmpDir, rmrf, plistXml, machoThin, machoFat, writeZip, writeJar, writeAsar, makeApp, LIB, CPU_ARM64, CPU_X86_64 };
