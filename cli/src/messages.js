'use strict';

// The one sentence toexe prints when it refuses an app. The wording is a
// product requirement: "<Framework> based apps cannot become exe".
function refusalMessage(frameworkName) {
  return `${frameworkName} based apps cannot become exe`;
}

module.exports = { refusalMessage };
