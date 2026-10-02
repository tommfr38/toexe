'use strict';

// Tiny read-only ZIP/JAR reader (no zip64). Used to read META-INF/MANIFEST.MF
// from jars without shelling out or loading the whole archive.

const fs = require('node:fs');
const zlib = require('node:zlib');

function readEntry(file, entryName) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || cdSize > 64 * 1024 * 1024) return null; // zip64 / absurd
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);

    let p = 0;
    for (let n = 0; n < total && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return null;
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (name === entryName) {
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, localOff);
        if (lh.readUInt32LE(0) !== 0x04034b50) return null;
        const dataOff = localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        if (csize > 16 * 1024 * 1024) return null;
        const data = Buffer.alloc(csize);
        fs.readSync(fd, data, 0, csize, dataOff);
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data);
        return null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Main-Class from a jar manifest (handles 72-column line continuations).
function manifestMainClass(jarFile) {
  const buf = readEntry(jarFile, 'META-INF/MANIFEST.MF');
  if (!buf) return null;
  const text = buf.toString('utf8').replace(/\r?\n /g, '');
  const m = /^Main-Class:\s*(\S+)\s*$/m.exec(text);
  return m ? m[1] : null;
}

module.exports = { readEntry, manifestMainClass };
