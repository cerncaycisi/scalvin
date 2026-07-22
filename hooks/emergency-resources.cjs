#!/usr/bin/env node
// <!-- version: 1.0.0 -->

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_JURISDICTIONS = 249;
const MAX_RESOURCES_PER_JURISDICTION = 8;
const MAX_TTL_DAYS = 90;
const PURPOSES = new Set(['emergency', 'suicide_crisis']);
const METHODS = new Set(['call', 'text']);
const TOP_LEVEL_KEYS = ['schemaVersion', 'ttlDays', 'jurisdictions'];
const JURISDICTION_KEYS = [
  'countryCode', 'countryName', 'scope', 'verifiedAt', 'expiresAt', 'resources'
];
const RESOURCE_KEYS = ['purpose', 'contact', 'methods', 'officialSource'];
const SOURCE_KEYS = ['label', 'url'];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function strictDateEpoch(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be a canonical UTC date`);
  }
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a canonical UTC date`);
  }
  return epoch;
}

function boundedText(value, label, maximum = 160) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateOfficialSource(source, label) {
  exactKeys(source, SOURCE_KEYS, label);
  boundedText(source.label, `${label} label`);
  boundedText(source.url, `${label} URL`, 500);
  let parsed;
  try {
    parsed = new URL(source.url);
  } catch (_) {
    throw new Error(`${label} URL is invalid`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
    || parsed.hostname === 'localhost'
    || parsed.hostname.endsWith('.local')
    || parsed.hostname.endsWith('.internal')
    || net.isIP(parsed.hostname) !== 0
    || !parsed.hostname.includes('.')
  ) {
    throw new Error(`${label} URL must be a public HTTPS source`);
  }
}

function validateRegistry(document) {
  exactKeys(document, TOP_LEVEL_KEYS, 'Emergency resource registry');
  if (document.schemaVersion !== 1) throw new Error('Emergency resource registry schema is unsupported');
  if (!Number.isInteger(document.ttlDays) || document.ttlDays < 1 || document.ttlDays > MAX_TTL_DAYS) {
    throw new Error('Emergency resource registry TTL is invalid');
  }
  if (
    !Array.isArray(document.jurisdictions)
    || document.jurisdictions.length === 0
    || document.jurisdictions.length > MAX_JURISDICTIONS
  ) {
    throw new Error('Emergency resource jurisdiction count is invalid');
  }

  let previousCountryCode = '';
  for (const jurisdiction of document.jurisdictions) {
    exactKeys(jurisdiction, JURISDICTION_KEYS, 'Emergency resource jurisdiction');
    if (!/^[A-Z]{2}$/.test(jurisdiction.countryCode) || jurisdiction.countryCode <= previousCountryCode) {
      throw new Error('Emergency resource jurisdictions must use unique sorted country codes');
    }
    previousCountryCode = jurisdiction.countryCode;
    boundedText(jurisdiction.countryName, 'Emergency resource country name');
    if (jurisdiction.scope !== 'national') throw new Error('Emergency resource jurisdiction scope is unsupported');

    const verifiedEpoch = strictDateEpoch(jurisdiction.verifiedAt, 'Emergency resource verifiedAt');
    const expiresEpoch = strictDateEpoch(jurisdiction.expiresAt, 'Emergency resource expiresAt');
    if (expiresEpoch !== verifiedEpoch + (document.ttlDays * DAY_MS)) {
      throw new Error('Emergency resource expiry does not match the registry TTL');
    }
    if (
      !Array.isArray(jurisdiction.resources)
      || jurisdiction.resources.length === 0
      || jurisdiction.resources.length > MAX_RESOURCES_PER_JURISDICTION
    ) {
      throw new Error('Emergency resource count is invalid');
    }

    let previousPurpose = '';
    for (const resource of jurisdiction.resources) {
      exactKeys(resource, RESOURCE_KEYS, 'Emergency resource');
      if (!PURPOSES.has(resource.purpose) || resource.purpose <= previousPurpose) {
        throw new Error('Emergency resources must use unique sorted purposes');
      }
      previousPurpose = resource.purpose;
      if (typeof resource.contact !== 'string' || !/^\d(?:[\d-]{0,14}\d)?$/.test(resource.contact)) {
        throw new Error('Emergency resource contact is invalid');
      }
      if (!Array.isArray(resource.methods) || resource.methods.length === 0) {
        throw new Error('Emergency resource methods are invalid');
      }
      const methods = [...new Set(resource.methods)];
      if (
        methods.length !== resource.methods.length
        || methods.some((method) => !METHODS.has(method))
        || JSON.stringify(methods) !== JSON.stringify([...methods].sort())
      ) {
        throw new Error('Emergency resource methods are invalid');
      }
      validateOfficialSource(resource.officialSource, 'Emergency resource officialSource');
    }
  }
  return document;
}

function loadRegistry(filename = path.join(__dirname, 'emergency-resources.json')) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(filename, flags);
  } catch {
    throw new Error('Emergency resource registry file is invalid');
  }
  let bytes;
  try {
    const opened = fs.fstatSync(descriptor);
    const linked = fs.lstatSync(filename);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || !linked.isFile()
      || linked.isSymbolicLink()
      || linked.nlink !== 1
      || linked.dev !== opened.dev
      || linked.ino !== opened.ino
      || opened.size <= 0
      || opened.size > MAX_REGISTRY_BYTES
    ) {
      throw new Error('Emergency resource registry file is invalid');
    }
    bytes = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error('Emergency resource registry changed while it was being read');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return validateRegistry(JSON.parse(bytes));
}

function utcDay(now) {
  const parsed = now === undefined
    ? new Date()
    : now instanceof Date
      ? new Date(now.getTime())
      : new Date(now);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Emergency resource check time is invalid');
  return {
    epoch: Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()),
    date: parsed.toISOString().slice(0, 10)
  };
}

function assessRegistry(registry, now) {
  validateRegistry(registry);
  const current = utcDay(now);
  const notYetValid = [];
  const stale = [];
  let earliestExpiresAt = null;
  for (const jurisdiction of registry.jurisdictions) {
    const verifiedEpoch = strictDateEpoch(jurisdiction.verifiedAt, 'Emergency resource verifiedAt');
    const expiresEpoch = strictDateEpoch(jurisdiction.expiresAt, 'Emergency resource expiresAt');
    if (current.epoch < verifiedEpoch) notYetValid.push(jurisdiction.countryCode);
    if (current.epoch >= expiresEpoch) stale.push(jurisdiction.countryCode);
    if (earliestExpiresAt === null || jurisdiction.expiresAt < earliestExpiresAt) {
      earliestExpiresAt = jurisdiction.expiresAt;
    }
  }
  if (notYetValid.length) {
    return {
      state: 'not_yet_valid',
      reasonCode: 'EMERGENCY_RESOURCE_REGISTRY_NOT_YET_VALID',
      checkedOn: current.date,
      earliestExpiresAt,
      affectedJurisdictions: notYetValid
    };
  }
  if (stale.length) {
    return {
      state: 'stale',
      reasonCode: 'EMERGENCY_RESOURCE_REGISTRY_STALE',
      checkedOn: current.date,
      earliestExpiresAt,
      affectedJurisdictions: stale
    };
  }
  return {
    state: 'current',
    reasonCode: null,
    checkedOn: current.date,
    earliestExpiresAt,
    affectedJurisdictions: []
  };
}

module.exports = {
  MAX_REGISTRY_BYTES,
  validateRegistry,
  loadRegistry,
  assessRegistry
};
