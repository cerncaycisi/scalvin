#!/usr/bin/env node
'use strict';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
  process.stderr.write('error [NODE_VERSION_UNSUPPORTED]: Capability broker requires Node 20 or newer.\n');
  process.exitCode = 1;
} else {
  let ScalvinErrorClass = null;
  (async () => {
    try {
      const supervisorEndpoint = process.env.SCALVIN_SUPERVISOR_ENDPOINT;
      const supervisorToken = process.env.SCALVIN_SUPERVISOR_TOKEN;
      const supervisor = typeof supervisorEndpoint === 'string' && supervisorEndpoint.length > 0 && supervisorEndpoint.length <= 1000
        && /^supervisor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supervisorToken || '')
        ? { endpoint: supervisorEndpoint, token: supervisorToken.toLowerCase() }
        : null;
      // The broker never accepts environment-based behavior overrides. In
      // particular, test failpoints, alternate local-state roots, and
      // repository target bypasses must not cross the privilege boundary.
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('SCALVIN_')) delete process.env[key];
      }
      ({ ScalvinError: ScalvinErrorClass } = require('../cli/lib/errors'));
      const { main } = require('../cli/mcp-server');
      await main(process.argv.slice(2), { supervisor });
    } catch (error) {
      const known = ScalvinErrorClass && error instanceof ScalvinErrorClass;
      const code = known && /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'BROKER_START_FAILED';
      process.stderr.write(`error [${code}]: Capability broker could not start.\n`);
      process.exitCode = known ? error.exitCode : 1;
    }
  })();
}
