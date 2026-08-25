#!/usr/bin/env node

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEAD_DAYS = 14;
const MAX_LEAD_DAYS = 90;

class UsageError extends Error {}

function parseLeadDays(raw) {
  if (!/^\d{1,3}$/.test(raw)) throw new UsageError('usage');
  const value = Number(raw);
  if (value > MAX_LEAD_DAYS) throw new UsageError('usage');
  return value;
}

function parseArguments(arguments_) {
  const options = { now: undefined, leadDays: DEFAULT_LEAD_DAYS, failExpiring: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === '--now') {
      if (options.now !== undefined || index + 1 >= arguments_.length) throw new UsageError('usage');
      index += 1;
      options.now = arguments_[index];
    } else if (flag === '--lead-days') {
      if (index + 1 >= arguments_.length) throw new UsageError('usage');
      index += 1;
      options.leadDays = parseLeadDays(arguments_[index]);
    } else if (flag === '--fail-expiring') {
      options.failExpiring = true;
    } else {
      throw new UsageError('usage');
    }
  }
  return options;
}

function daysUntil(expiresAt, checkedOn) {
  const expiry = Date.parse(`${expiresAt}T00:00:00.000Z`);
  const checked = Date.parse(`${checkedOn}T00:00:00.000Z`);
  if (!Number.isFinite(expiry) || !Number.isFinite(checked)) return null;
  return Math.round((expiry - checked) / DAY_MS);
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (_) {
  process.stderr.write(
    'usage: check-emergency-resources.mjs [--now <YYYY-MM-DD>] [--lead-days <0-90>] [--fail-expiring]\n'
  );
  process.exitCode = 1;
}

if (options !== undefined) {
  try {
    const { loadRegistry, assessRegistry } = require('../hooks/emergency-resources.cjs');
    const registry = loadRegistry();
    const assessment = assessRegistry(registry, options.now);
    if (assessment.state !== 'current') {
      process.stderr.write(
        `Emergency resource registry check failed: ${assessment.reasonCode} (${assessment.affectedJurisdictions.join(',')}).\n`
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `Emergency resource registry current: ${registry.jurisdictions.length} jurisdictions; earliest expiry ${assessment.earliestExpiresAt}.\n`
      );
      // Freshness is still `current` here. The lead-time notice exists so a
      // lapse is scheduled work rather than a surprise red build on the day
      // the TTL runs out. It never relaxes the stale check above, and it is
      // deliberately not a runtime capability state: the installed safety hook
      // keeps reporting exactly `current` or `stale`.
      const remaining = daysUntil(assessment.earliestExpiresAt, assessment.checkedOn);
      if (remaining !== null && remaining <= options.leadDays) {
        process.stderr.write(
          `Emergency resource registry expiring soon: EMERGENCY_RESOURCE_REGISTRY_EXPIRING_SOON`
          + ` (earliest expiry ${assessment.earliestExpiresAt}, ${remaining} day(s) left).`
          + ` Re-verify every officialSource against its live official page before advancing verifiedAt.\n`
        );
        if (options.failExpiring) process.exitCode = 1;
      }
    }
  } catch (_) {
    process.stderr.write('Emergency resource registry check failed: EMERGENCY_RESOURCE_REGISTRY_LOAD_FAILED.\n');
    process.exitCode = 1;
  }
}
