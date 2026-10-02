'use strict';

// Minimal Mach-O reader: just enough to list linked libraries, target
// platform(s) and CPU architectures. Handles thin and fat (universal) files.
// Only the header and load commands are read; the rest of the file is not.

const fs = require('node:fs');

const MH_MAGIC_64_LE = 0xfeedfacf;
const MH_MAGIC_32_LE = 0xfeedface;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

const LC_LOAD_DYLIB = 0x0c;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_LOAD_UPWARD_DYLIB = 0x80000023;
const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_MACOSX = 0x24;

const DYLIB_CMDS = new Set([
  LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LAZY_LOAD_DYLIB, LC_LOAD_UPWARD_DYLIB,
]);

const CPU = {
  7: 'i386',
  0x01000007: 'x86_64',
  12: 'arm',
  0x0100000c: 'arm64',
  0x0200000c: 'arm64_32',
};

const PLATFORM_NAMES = {
  1: 'macos', 2: 'ios', 3: 'tvos', 4: 'watchos', 5: 'bridgeos', 6: 'maccatalyst',
  7: 'ios-simulator', 8: 'tvos-simulator', 9: 'watchos-simulator', 10: 'driverkit', 11: 'visionos',
};

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  return n === length ? buf : buf.subarray(0, n);
}

function parseThin(fd, offset) {
  const head = readAt(fd, offset, 32);
  if (head.length < 28) return null;
  const magic = head.readUInt32LE(0);
  let headerSize;
  if (magic === MH_MAGIC_64_LE) headerSize = 32;
  else if (magic === MH_MAGIC_32_LE) headerSize = 28;
  else return null; // big-endian (PowerPC) images are not macOS apps we care about

  const cputype = head.readUInt32LE(4);
  const filetype = head.readUInt32LE(12);
  const ncmds = head.readUInt32LE(16);
  const sizeofcmds = Math.min(head.readUInt32LE(20), 8 * 1024 * 1024);
  const cmds = readAt(fd, offset + headerSize, sizeofcmds);

  const libs = [];
  const platforms = new Set();
  let pos = 0;
  for (let i = 0; i < ncmds && pos + 8 <= cmds.length; i++) {
    const cmd = cmds.readUInt32LE(pos);
    const cmdsize = cmds.readUInt32LE(pos + 4);
    if (cmdsize < 8 || pos + cmdsize > cmds.length) break;
    if (DYLIB_CMDS.has(cmd)) {
      const nameOff = cmds.readUInt32LE(pos + 8);
      if (nameOff < cmdsize) {
        const end = cmds.indexOf(0, pos + nameOff);
        libs.push(cmds.toString('utf8', pos + nameOff, end === -1 || end > pos + cmdsize ? pos + cmdsize : end));
      }
    } else if (cmd === LC_BUILD_VERSION) {
      platforms.add(PLATFORM_NAMES[cmds.readUInt32LE(pos + 8)] || `platform-${cmds.readUInt32LE(pos + 8)}`);
    } else if (cmd === LC_VERSION_MIN_MACOSX) {
      platforms.add('macos');
    }
    pos += cmdsize;
  }
  return { arch: CPU[cputype] || `cpu-${cputype}`, filetype, libs, platforms, loadCommands: cmds };
}

/**
 * Inspect a file. Returns:
 *   { isMachO: false, shebang?: string }
 *   { isMachO: true, archs: string[], libs: string[], platforms: string[],
 *     loadCommandsInclude(str): boolean }
 */
function readMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    return { isMachO: false, error: e.code || e.message };
  }
  try {
    const head = readAt(fd, 0, 64);
    if (head.length < 4) return { isMachO: false };
    if (head[0] === 0x23 && head[1] === 0x21) { // "#!"
      const line = head.toString('utf8', 2).split('\n')[0].trim();
      return { isMachO: false, shebang: line };
    }

    const be = head.readUInt32BE(0);
    const slices = [];
    if ((be === FAT_MAGIC || be === FAT_MAGIC_64) && head.length >= 8) {
      const n = head.readUInt32BE(4);
      if (n > 0 && n <= 20) { // Java class files share the 0xCAFEBABE magic; they have a huge "count"
        const entry = be === FAT_MAGIC_64 ? 32 : 20;
        const table = readAt(fd, 8, n * entry);
        for (let i = 0; i < n; i++) {
          const o = i * entry;
          if (o + entry > table.length) break;
          const off = be === FAT_MAGIC_64
            ? Number(table.readBigUInt64BE(o + 8))
            : table.readUInt32BE(o + 8);
          const s = parseThin(fd, off);
          if (s) slices.push(s);
        }
      }
    } else {
      const s = parseThin(fd, 0);
      if (s) slices.push(s);
    }
    if (slices.length === 0) return { isMachO: false };

    const libs = [...new Set(slices.flatMap((s) => s.libs))];
    const platforms = [...new Set(slices.flatMap((s) => [...s.platforms]))];
    return {
      isMachO: true,
      archs: slices.map((s) => s.arch),
      libs,
      platforms,
      loadCommandsInclude: (str) => slices.some((s) => s.loadCommands.includes(str)),
    };
  } catch (e) {
    return { isMachO: false, error: e.message };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readMachO };
