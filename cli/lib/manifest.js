'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { ScalvinError, invariant } = require('./errors');
const {
  assertInside,
  validateRelativePath,
  rejectSymlinkPath,
  sha256Buffer,
  sha256File,
  readBoundedRegularFile
} = require('./fs-safe');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PROTECTIONS = new Set(['framework', 'active', 'seed', 'protected']);

function portableCollisionKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function sanitizeRemoteLocator(locator) {
  try {
    const parsed = new URL(locator);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'https://invalid/';
  }
}

function safeFetchCauseCode(error) {
  const value = error?.code || error?.cause?.code;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? value : 'FETCH_FAILED';
}

function assertOnlyKeys(object, allowed, label) {
  invariant(object && typeof object === 'object' && !Array.isArray(object), `${label} must be an object.`, 'INVALID_MANIFEST');
  const extras = Object.keys(object).filter((key) => !allowed.includes(key));
  invariant(extras.length === 0, `${label} contains unsupported properties.`, 'INVALID_MANIFEST', { extras });
}

function validateManifest(manifest) {
  invariant(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Manifest must be an object.', 'INVALID_MANIFEST');
  assertOnlyKeys(manifest, ['$schema', 'schemaVersion', 'product', 'release', 'consentNoticeVersion', 'defaults', 'state', 'workspaceDirectories', 'protectedPaths', 'clientIntegrations', 'files'], 'Manifest');
  invariant(manifest.schemaVersion === 2, 'Unsupported manifest schema; expected schemaVersion 2.', 'UNSUPPORTED_MANIFEST_SCHEMA', { found: manifest.schemaVersion });
  invariant(manifest.$schema === './schemas/manifest-v2.schema.json', 'Manifest must use the tracked relative v2 schema.', 'INVALID_MANIFEST');
  invariant(manifest.product?.name === 'scalvin', 'Manifest product must be scalvin.', 'INVALID_MANIFEST');
  assertOnlyKeys(manifest.product, ['name', 'version', 'minimumNode', 'repository'], 'Manifest product');
  invariant(VERSION_PATTERN.test(manifest.product?.version || ''), 'Manifest product version is invalid.', 'INVALID_MANIFEST');
  invariant(typeof manifest.product?.minimumNode === 'string', 'Manifest minimumNode is required.', 'INVALID_MANIFEST');
  invariant(/^>=\d+\.\d+\.\d+$/.test(manifest.product.minimumNode), 'Manifest minimumNode range is invalid.', 'INVALID_MANIFEST');
  invariant(/^https:\/\//.test(manifest.product.repository || ''), 'Manifest repository must be an HTTPS URL.', 'INVALID_MANIFEST');
  invariant(['stable', 'prerelease', 'development'].includes(manifest.release?.channel), 'Manifest release channel is invalid.', 'INVALID_MANIFEST');
  invariant(manifest.release.version === manifest.product.version, 'Manifest release and product versions must match.', 'INVALID_MANIFEST');
  assertOnlyKeys(manifest.release, ['channel', 'version'], 'Manifest release');
  invariant(VERSION_PATTERN.test(manifest.consentNoticeVersion || ''), 'Manifest consent notice version is invalid.', 'INVALID_MANIFEST');
  assertOnlyKeys(manifest.defaults, ['workspace', 'companionName', 'language', 'persona', 'structure', 'modalities'], 'Manifest defaults');
  invariant(typeof manifest.defaults.workspace === 'string' && typeof manifest.defaults.companionName === 'string' && typeof manifest.defaults.language === 'string', 'Manifest defaults are incomplete.', 'INVALID_MANIFEST');
  invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.defaults.persona || '') && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.defaults.structure || ''), 'Manifest default selectors are invalid.', 'INVALID_MANIFEST');
  invariant(Array.isArray(manifest.defaults.modalities) && manifest.defaults.modalities.length > 0 && new Set(manifest.defaults.modalities).size === manifest.defaults.modalities.length, 'Manifest default modalities are invalid.', 'INVALID_MANIFEST');
  assertOnlyKeys(manifest.state, ['path', 'localPointer', 'legacyPaths'], 'Manifest state');
  invariant(manifest.defaults && typeof manifest.defaults === 'object', 'Manifest defaults are required.', 'INVALID_MANIFEST');
  invariant(Array.isArray(manifest.files) && manifest.files.length > 0, 'Manifest files must be a non-empty array.', 'INVALID_MANIFEST');
  invariant(Array.isArray(manifest.protectedPaths), 'Manifest protectedPaths must be an array.', 'INVALID_MANIFEST');
  invariant(Array.isArray(manifest.workspaceDirectories), 'Manifest workspaceDirectories must be an array.', 'INVALID_MANIFEST');

  const paths = new Set();
  const portablePaths = new Map();
  const targetKeys = new Set();
  const portableTargets = new Map();
  for (const file of manifest.files) {
    assertOnlyKeys(file, ['path', 'source', 'version', 'sha256', 'role', 'protection', 'targets'], 'Manifest file');
    file.path = validateRelativePath(file.path);
    invariant(!paths.has(file.path), 'Manifest contains a duplicate source path.', 'INVALID_MANIFEST', { path: file.path });
    const portablePath = portableCollisionKey(file.path);
    invariant(!portablePaths.has(portablePath), 'Manifest contains source paths that collide on a case-insensitive filesystem.', 'INVALID_MANIFEST', { path: file.path, conflictsWith: portablePaths.get(portablePath) });
    paths.add(file.path);
    portablePaths.set(portablePath, file.path);
    invariant(typeof file.source === 'string' && file.source.length > 0, 'Every file needs a source identifier.', 'INVALID_MANIFEST', { path: file.path });
    invariant(VERSION_PATTERN.test(file.version || ''), 'Every file needs a semantic version.', 'INVALID_MANIFEST', { path: file.path, version: file.version });
    invariant(HASH_PATTERN.test(file.sha256 || ''), 'Every file needs a SHA-256 hash.', 'INVALID_MANIFEST', { path: file.path });
    invariant(typeof file.role === 'string' && file.role.length > 0, 'Every file needs a role.', 'INVALID_MANIFEST', { path: file.path });
    invariant(PROTECTIONS.has(file.protection), 'Every file needs a valid protection class.', 'INVALID_MANIFEST', { path: file.path, protection: file.protection });
    const distributionOnly = file.role === 'distribution-code';
    invariant(
      Array.isArray(file.targets) && (distributionOnly ? file.targets.length === 0 : file.targets.length > 0),
      distributionOnly
        ? 'Distribution-code entries must not create workspace targets.'
        : 'Every workspace-managed file needs at least one target.',
      'INVALID_MANIFEST',
      { path: file.path }
    );
    if (distributionOnly) invariant(file.protection === 'framework', 'Distribution code must use framework protection.', 'INVALID_MANIFEST', { path: file.path });
    for (const target of file.targets) {
      assertOnlyKeys(target, ['path', 'protection', 'render', 'activation'], 'Manifest target');
      const targetPath = validateRelativePath(target.path);
      target.path = targetPath;
      const portableTarget = portableCollisionKey(targetPath);
      const existingPortableTarget = portableTargets.get(portableTarget);
      invariant(existingPortableTarget === undefined || existingPortableTarget === targetPath, 'Manifest contains target paths that collide on a case-insensitive filesystem.', 'INVALID_MANIFEST', { target: targetPath, conflictsWith: existingPortableTarget });
      portableTargets.set(portableTarget, targetPath);
      invariant(PROTECTIONS.has(target.protection), 'Target has an invalid protection class.', 'INVALID_MANIFEST', { path: file.path, target: target.path });
      invariant(!target.render || target.render === 'placeholders', 'Unsupported target renderer.', 'INVALID_MANIFEST', { target: target.path });
      if (target.activation) {
        assertOnlyKeys(target.activation, ['group', 'name'], 'Manifest activation');
        invariant(['persona', 'structure', 'modality'].includes(target.activation.group) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.activation.name || ''), 'Manifest activation is invalid.', 'INVALID_MANIFEST');
      }
      const selector = target.activation ? `${target.activation.group}:${target.activation.name}` : '-';
      const key = `${targetPath}:${selector}`;
      invariant(!targetKeys.has(key), 'Manifest has a duplicate target mapping.', 'INVALID_MANIFEST', { target: targetPath, selector });
      targetKeys.add(key);
    }
  }

  for (const protectedPath of manifest.protectedPaths) validateRelativePath(protectedPath.replace(/\/\*\*$/, '/placeholder'));
  for (const directory of manifest.workspaceDirectories) validateRelativePath(directory);
  if (manifest.clientIntegrations?.claude) {
    const integration = manifest.clientIntegrations.claude;
    assertOnlyKeys(integration, ['settingsPath', 'event', 'hooks'], 'Claude integration');
    validateRelativePath(integration.settingsPath);
    invariant(integration.event === 'UserPromptSubmit', 'Unsupported Claude hook event.', 'INVALID_MANIFEST');
    invariant(Array.isArray(integration.hooks), 'Claude integration hooks must be an array.', 'INVALID_MANIFEST');
    const knownTargets = new Set(manifest.files.flatMap((entry) => entry.targets.map((target) => target.path)));
    for (const hook of integration.hooks) {
      assertOnlyKeys(hook, ['target', 'command', 'timeoutSeconds'], 'Claude hook');
      validateRelativePath(hook.target);
      invariant(knownTargets.has(hook.target), 'Client integration references an unknown hook target.', 'INVALID_MANIFEST', { target: hook.target });
      invariant(hook.command === `node ${hook.target}`, 'Hook command must be derived from its registered target.', 'INVALID_MANIFEST', { target: hook.target });
      invariant(Number.isInteger(hook.timeoutSeconds) && hook.timeoutSeconds >= 1 && hook.timeoutSeconds <= 30, 'Hook timeout is invalid.', 'INVALID_MANIFEST');
    }
  }
  invariant(paths.has('schemas/manifest-v2.schema.json'), 'Manifest must register its tracked JSON schema.', 'INVALID_MANIFEST');
  return manifest;
}

function parseNodeMajor(range) {
  const match = String(range).match(/(\d+)/);
  return match ? Number(match[1]) : 20;
}

function assertNodeVersion(manifest) {
  const current = Number(process.versions.node.split('.')[0]);
  const required = parseNodeMajor(manifest.product.minimumNode);
  invariant(current >= required, `Scalvin requires Node ${required} or newer; found ${process.versions.node}.`, 'NODE_VERSION_UNSUPPORTED', { required, current: process.versions.node });
}

async function readJsonFile(filename) {
  let raw;
  try {
    raw = (await readBoundedRegularFile(filename, 2 * 1024 * 1024, {
      typeCode: 'MANIFEST_NOT_REGULAR', sizeCode: 'MANIFEST_TOO_LARGE', changedCode: 'MANIFEST_CHANGED_DURING_READ'
    })).toString('utf8');
  } catch (error) {
    if (error instanceof ScalvinError) throw error;
    throw new ScalvinError('Unable to read manifest.', 'MANIFEST_READ_FAILED', { path: filename, cause: error.message });
  }
  try {
    return { manifest: JSON.parse(raw), raw: Buffer.from(raw), locator: path.resolve(filename), sourceRoot: path.dirname(path.resolve(filename)), remote: false };
  } catch (error) {
    throw new ScalvinError('Manifest is not valid JSON.', 'INVALID_MANIFEST_JSON', { path: filename, cause: error.message });
  }
}

async function readBoundedResponse(response, maximumBytes, code) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ScalvinError('Remote response exceeds the configured size limit.', code, { declared, maximumBytes });
  }
  invariant(response.body, 'Remote response has no body.', code);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ScalvinError('Remote response exceeds the configured size limit.', code, { received: total, maximumBytes });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readRemoteJson(url) {
  const publicUrl = sanitizeRemoteLocator(url);
  let response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new ScalvinError('Unable to fetch manifest.', 'MANIFEST_FETCH_FAILED', { url: publicUrl, causeCode: safeFetchCauseCode(error) });
  }
  invariant(response.ok, `Manifest request failed with HTTP ${response.status}.`, 'MANIFEST_FETCH_FAILED', { url: publicUrl, status: response.status });
  const raw = await readBoundedResponse(response, 2 * 1024 * 1024, 'MANIFEST_TOO_LARGE');
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new ScalvinError('Remote manifest is not valid JSON.', 'INVALID_MANIFEST_JSON', { url: publicUrl, causeCode: 'INVALID_JSON' });
  }
  const loaded = { manifest, raw, locator: publicUrl, remote: true };
  Object.defineProperty(loaded, 'sourceRoot', { value: new URL('.', url).href, enumerable: false });
  return loaded;
}

async function loadManifest(locator) {
  let loaded;
  if (/^https:\/\//i.test(locator)) loaded = await readRemoteJson(locator);
  else if (/^file:/i.test(locator)) loaded = await readJsonFile(fileURLToPath(locator));
  else loaded = await readJsonFile(locator);
  validateManifest(loaded.manifest);
  assertNodeVersion(loaded.manifest);
  loaded.sha256 = sha256Buffer(loaded.raw);
  return loaded;
}

async function readSourceFile(sourceContext, entry) {
  const relative = validateRelativePath(entry.path);
  let data;
  if (sourceContext.remote) {
    const url = new URL(relative.split('/').map(encodeURIComponent).join('/'), sourceContext.sourceRoot).href;
    let response;
    try {
      response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new ScalvinError('Unable to fetch a manifest file.', 'SOURCE_FETCH_FAILED', { path: relative, causeCode: safeFetchCauseCode(error) });
    }
    invariant(response.ok, `Source request failed with HTTP ${response.status}.`, 'SOURCE_FETCH_FAILED', { path: relative, status: response.status });
    data = await readBoundedResponse(response, 8 * 1024 * 1024, 'SOURCE_TOO_LARGE');
  } else {
    const absolute = path.resolve(sourceContext.sourceRoot, relative);
    assertInside(sourceContext.sourceRoot, absolute, 'Manifest source');
    data = await readBoundedRegularFile(absolute, 8 * 1024 * 1024, {
      typeCode: 'SOURCE_NOT_REGULAR_FILE', typeMessage: 'Managed sources must be regular files.',
      sizeCode: 'SOURCE_TOO_LARGE', sizeMessage: 'Managed files may not exceed 8 MiB.',
      changedCode: 'SOURCE_CHANGED_DURING_READ'
    });
  }
  invariant(data.length <= 8 * 1024 * 1024, 'Managed files may not exceed 8 MiB.', 'SOURCE_TOO_LARGE', { path: relative, size: data.length });
  const actual = sha256Buffer(data);
  invariant(actual === entry.sha256, 'Source file hash does not match the manifest.', 'SOURCE_HASH_MISMATCH', { path: relative, expected: entry.sha256, actual });
  return data;
}

async function verifyDistribution(manifest, sourceRoot) {
  const errors = [];
  for (const entry of manifest.files) {
    const absolute = path.resolve(sourceRoot, entry.path);
    try {
      assertInside(sourceRoot, absolute, 'Manifest source');
      await rejectSymlinkPath(absolute);
      const actual = await sha256File(absolute);
      if (actual !== entry.sha256) errors.push({ path: entry.path, expected: entry.sha256, actual, code: 'HASH_MISMATCH' });
    } catch (error) {
      errors.push({ path: entry.path, code: error.code || 'READ_FAILED', message: error.message });
    }
  }
  return errors;
}

module.exports = {
  validateManifest,
  assertNodeVersion,
  loadManifest,
  readSourceFile,
  verifyDistribution,
  HASH_PATTERN,
  VERSION_PATTERN,
  readBoundedResponse,
  sanitizeRemoteLocator
};
