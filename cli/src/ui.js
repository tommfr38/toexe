'use strict';

// Tiny ANSI styling helper. No dependencies, no emoji.
const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
};

function createStyle(enabled) {
  const style = { enabled: !!enabled };
  for (const [name, [open, close]] of Object.entries(CODES)) {
    style[name] = (s) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
  }
  return style;
}

// Decide whether to colorize a given stream, honouring NO_COLOR / FORCE_COLOR.
function shouldColor(stream, env = process.env, flagNoColor = false) {
  if (flagNoColor) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return !!(stream && stream.isTTY);
}

module.exports = { createStyle, shouldColor };
