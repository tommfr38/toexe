'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Minimal parser for XML property lists (the common case, and what tests use).
function parseXmlPlist(xml) {
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z0-9]+)[^>]*?(\/?)>|([^<]+)/g;
  const stack = [];
  let root;
  let key = null;
  let leaf = null;
  let text = '';

  const put = (v) => {
    const top = stack[stack.length - 1];
    if (!top) root = v;
    else if (Array.isArray(top)) top.push(v);
    else {
      top[key] = v;
      key = null;
    }
  };

  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) { // CDATA
      if (leaf) text += m[1];
      continue;
    }
    if (m[5] !== undefined) { // text
      if (leaf) text += m[5];
      continue;
    }
    if (m[3] === undefined) continue; // comment, PI, doctype
    const closing = m[2] === '/';
    const name = m[3];
    const selfClosing = m[4] === '/';

    if (!closing) {
      switch (name) {
        case 'dict': { const o = {}; put(o); if (!selfClosing) stack.push(o); break; }
        case 'array': { const a = []; put(a); if (!selfClosing) stack.push(a); break; }
        case 'true': put(true); break;
        case 'false': put(false); break;
        case 'key': case 'string': case 'integer': case 'real': case 'date': case 'data':
          if (selfClosing) {
            if (name === 'key') key = '';
            else put('');
          } else { leaf = name; text = ''; }
          break;
        default: break; // plist wrapper
      }
    } else {
      switch (name) {
        case 'dict': case 'array': stack.pop(); break;
        case 'key': key = decodeEntities(text); leaf = null; break;
        case 'string': put(decodeEntities(text)); leaf = null; break;
        case 'integer': case 'real': put(Number(text.trim())); leaf = null; break;
        case 'date': case 'data': put(text.trim()); leaf = null; break;
        default: break;
      }
    }
  }
  return root;
}

// Read an Info.plist (XML or binary). Binary plists are converted with the
// macOS `plutil` tool; if that is unavailable we report an error instead of
// guessing.
function readPlist(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      head = Buffer.alloc(8);
      fs.readSync(fd, head, 0, 8, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { value: null, error: e.code === 'ENOENT' ? 'missing' : e.message };
  }
  try {
    if (head.toString('latin1', 0, 6) === 'bplist') {
      const out = execFileSync('plutil', ['-convert', 'json', '-o', '-', '--', file], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { value: JSON.parse(out), error: null };
    }
    const value = parseXmlPlist(fs.readFileSync(file, 'utf8'));
    if (value === undefined || value === null || typeof value !== 'object') {
      return { value: null, error: 'unparseable plist' };
    }
    return { value, error: null };
  } catch (e) {
    return { value: null, error: e.message };
  }
}

module.exports = { parseXmlPlist, readPlist };
