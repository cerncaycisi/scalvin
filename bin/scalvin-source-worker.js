#!/usr/bin/env node
'use strict';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
  process.stderr.write('error [NODE_VERSION_UNSUPPORTED]: Scalvin source worker requires Node 20 or newer.\n');
  process.exitCode = 1;
} else {
  (async () => {
    try {
      const { main } = require('../cli/source-worker.js');
      await main(process.argv.slice(2));
    } catch (error) {
      const code = /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'SOURCE_WORKER_START_FAILED';
      process.stderr.write(`error [${code}]: Scalvin isolated source worker could not start.\n`);
      process.exitCode = 1;
    }
  })();
}
