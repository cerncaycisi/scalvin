#!/usr/bin/env node

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);

function parseNow(arguments_) {
  if (arguments_.length === 0) return undefined;
  if (arguments_.length === 2 && arguments_[0] === '--now') return arguments_[1];
  throw new Error('usage');
}

try {
  const now = parseNow(process.argv.slice(2));
  const { loadRegistry, assessRegistry } = require('../hooks/emergency-resources.cjs');
  const registry = loadRegistry();
  const assessment = assessRegistry(registry, now);
  if (assessment.state !== 'current') {
    process.stderr.write(
      `Emergency resource registry check failed: ${assessment.reasonCode} (${assessment.affectedJurisdictions.join(',')}).\n`
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Emergency resource registry current: ${registry.jurisdictions.length} jurisdictions; earliest expiry ${assessment.earliestExpiresAt}.\n`
    );
  }
} catch (_) {
  process.stderr.write('Emergency resource registry check failed: EMERGENCY_RESOURCE_REGISTRY_LOAD_FAILED.\n');
  process.exitCode = 1;
}
