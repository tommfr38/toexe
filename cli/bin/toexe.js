#!/usr/bin/env node
'use strict';

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`toexe needs Node.js 18 or newer (you have ${process.versions.node}).`);
  process.exit(2);
}

require('../src/cli')
  .run(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(`toexe: unexpected error: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
