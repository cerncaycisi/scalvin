#!/usr/bin/env node
'use strict';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
  process.stderr.write(`error [NODE_VERSION_UNSUPPORTED]: Scalvin requires Node 20 or newer; found ${process.versions.node}.\n`);
  process.exitCode = 1;
} else {
  (async () => {
    try {
      const { main } = require('../cli/index.js');
      await main(process.argv.slice(2));
    } catch {
      // Module-load failures must not expose absolute installation paths or a
      // stack trace. Normal command errors are rendered inside cli/index.js.
      process.stderr.write('error [CLI_START_FAILED]: Scalvin could not start.\n');
      process.exitCode = 1;
    }
  })();
}
