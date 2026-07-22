import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = process.env.SCALVIN_TEST_ROOT || path.join(ROOT, '.test-tmp');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function sha256File(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function runScript(script, args, environment) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment
  });
}

function releaseSetContent(files) {
  return files.map((filename) => `${sha256File(filename)}  ${path.basename(filename)}\n`).join('');
}

test('release builder emits checksum-bound SPDX artifacts and the packed clean install passes doctor', () => {
  const fixture = mkdtempSync(path.join(TEST_ROOT, 'release-artifacts-'));
  const output = path.join(fixture, 'output');
  const cache = path.join(fixture, 'npm-cache');
  const environment = { ...process.env, npm_config_cache: cache };
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const createdAt = '2026-07-15T00:00:00.000Z';

  try {
    const built = JSON.parse(runScript('build-release-artifacts.mjs', [
      '--output-directory', output,
      '--expected-version', VERSION,
      '--expected-commit', commit,
      '--created-at', createdAt
    ], environment));
    assert.equal(built.status, 'built');
    assert.equal(built.version, VERSION);
    assert.equal(built.commit, commit);
    assert.deepEqual(readdirSync(output).sort(), [
      built.archive,
      built.checksum,
      built.metadata,
      built.releaseSetChecksum,
      built.sbom
    ].sort());

    const archive = path.join(output, built.archive);
    const checksum = path.join(output, built.checksum);
    const sbomPath = path.join(output, built.sbom);
    const metadataPath = path.join(output, built.metadata);
    const releaseSetChecksumPath = path.join(output, built.releaseSetChecksum);
    assert.equal(built.archiveSha256, sha256File(archive));
    assert.equal(readFileSync(checksum, 'utf8'), `${built.archiveSha256}  ${built.archive}\n`);

    const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
    const inventory = JSON.parse(readFileSync(path.join(ROOT, 'package-inventory.json'), 'utf8'));
    assert.equal(sbom.spdxVersion, 'SPDX-2.3');
    assert.equal(sbom.creationInfo.created, createdAt);
    assert.equal(sbom.files.length, inventory.files.length);
    assert.equal(sbom.packages[0].versionInfo, VERSION);
    assert.ok(sbom.packages[0].checksums.some((entry) => (
      entry.algorithm === 'SHA256' && entry.checksumValue === built.archiveSha256
    )));

    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    assert.deepEqual(metadata.candidate, { version: VERSION, commit });
    assert.deepEqual(metadata.attestationSubject, {
      name: built.archive,
      digest: { sha256: built.archiveSha256 }
    });
    assert.equal(metadata.artifacts.sbom.sha256, sha256File(sbomPath));
    assert.equal(metadata.artifacts.checksum.sha256, sha256File(checksum));
    assert.equal(readFileSync(releaseSetChecksumPath, 'utf8'), releaseSetContent([
      archive,
      checksum,
      sbomPath,
      metadataPath
    ]));

    const verified = JSON.parse(runScript('verify-release-package.mjs', [
      '--archive', archive,
      '--checksum-file', checksum,
      '--sbom', sbomPath,
      '--metadata', metadataPath,
      '--release-set-checksum', releaseSetChecksumPath,
      '--expected-version', VERSION,
      '--expected-commit', commit
    ], environment));
    assert.deepEqual(verified, {
      status: 'verified',
      version: VERSION,
      archiveSha256: built.archiveSha256,
      metadataSha256: sha256File(metadataPath),
      doctorStatus: 'healthy'
    });

    const missingMetadata = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'verify-release-package.mjs'),
      '--archive', archive,
      '--checksum-file', checksum,
      '--sbom', sbomPath,
      '--release-set-checksum', releaseSetChecksumPath,
      '--expected-version', VERSION,
      '--expected-commit', commit
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment
    });
    assert.equal(missingMetadata.status, 1);
    assert.match(missingMetadata.stderr, /Missing required release verification option: metadata/);

    metadata.candidate.commit = commit === '0'.repeat(commit.length) ? '1'.repeat(commit.length) : '0'.repeat(commit.length);
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    writeFileSync(releaseSetChecksumPath, releaseSetContent([archive, checksum, sbomPath, metadataPath]));
    const tamperedMetadata = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'verify-release-package.mjs'),
      '--archive', archive,
      '--checksum-file', checksum,
      '--sbom', sbomPath,
      '--metadata', metadataPath,
      '--release-set-checksum', releaseSetChecksumPath,
      '--expected-version', VERSION,
      '--expected-commit', commit
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment
    });
    assert.equal(tamperedMetadata.status, 1);
    assert.match(tamperedMetadata.stderr, /Release metadata candidate does not match/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
