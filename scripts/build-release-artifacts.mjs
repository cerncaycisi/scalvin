#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://github.com/cerncaycisi/scalvin';

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = { requireClean: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--require-clean') {
      options.requireClean = true;
      continue;
    }
    const key = new Map([
      ['--output-directory', 'outputDirectory'],
      ['--expected-version', 'expectedVersion'],
      ['--expected-commit', 'expectedCommit'],
      ['--created-at', 'createdAt']
    ]).get(argument);
    if (!key || index + 1 >= argv.length) {
      fail('Usage: build-release-artifacts.mjs --output-directory DIR [--expected-version VERSION] [--expected-commit COMMIT] [--created-at RFC3339] [--require-clean]');
    }
    options[key] = argv[index + 1];
    index += 1;
  }
  if (!options.outputDirectory) fail('--output-directory is required.');
  return options;
}

function sha(buffer, algorithm = 'sha256') {
  return createHash(algorithm).update(buffer).digest('hex');
}

function readStableRegularFile(filename, maximumBytes = 32 * 1024 * 1024) {
  const descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(descriptor);
    const linked = lstatSync(filename);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || !linked.isFile()
      || linked.isSymbolicLink()
      || linked.nlink !== 1
      || linked.dev !== opened.dev
      || linked.ino !== opened.ino
      || opened.size < 0
      || opened.size > maximumBytes
    ) {
      fail('Release input is not a bounded single-link regular file.');
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      fail('Release input changed while it was being read.');
    }
    return { bytes, stat: opened };
  } finally {
    closeSync(descriptor);
  }
}

function shaFile(filename, algorithm = 'sha256') {
  return sha(readStableRegularFile(filename).bytes, algorithm);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateVersion(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    fail(`${label} must be a canonical semantic version.`);
  }
  return value;
}

function validateCommit(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    fail('Expected commit must be a full lowercase Git object ID.');
  }
  return value;
}

function validateTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail('Creation time must be RFC3339 UTC with milliseconds.');
  }
  if (new Date(value).toISOString() !== value) fail('Creation time is not a real RFC3339 instant.');
  return value;
}

function npmCliPath() {
  const executableDirectory = path.dirname(process.execPath);
  return process.platform === 'win32'
    ? path.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.resolve(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function runNpm(args, options = {}) {
  return execFileSync(process.execPath, [npmCliPath(), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function currentCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function assertCleanCheckout() {
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (status !== '') fail('Release artifacts require a clean source checkout.');
}

function spdxFileId(relative) {
  return `SPDXRef-File-${sha(Buffer.from(relative), 'sha256').slice(0, 20)}`;
}

function buildSpdx({ version, commit, createdAt, archiveHash, packageReport }) {
  const files = packageReport.files.map((entry) => {
    const absolute = path.join(ROOT, entry.path);
    const { bytes } = readStableRegularFile(absolute);
    return {
      fileName: `./${entry.path}`,
      SPDXID: spdxFileId(entry.path),
      checksums: [
        { algorithm: 'SHA1', checksumValue: sha(bytes, 'sha1') },
        { algorithm: 'SHA256', checksumValue: sha(bytes, 'sha256') }
      ],
      licenseConcluded: 'NOASSERTION',
      licenseInfoInFiles: ['NOASSERTION'],
      copyrightText: 'NOASSERTION',
      fileTypes: ['SOURCE']
    };
  });
  const verificationCode = sha(
    Buffer.from(files.map((entry) => entry.checksums[0].checksumValue).sort().join('')),
    'sha1'
  );
  const packageId = 'SPDXRef-Package-scalvin';
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `scalvin-${version}`,
    documentNamespace: `${REPOSITORY}/sbom/${commit}/scalvin-${version}-${archiveHash}`,
    creationInfo: {
      created: createdAt,
      creators: ['Tool: scalvin/scripts/build-release-artifacts.mjs']
    },
    packages: [{
      name: 'scalvin',
      SPDXID: packageId,
      versionInfo: version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: true,
      packageVerificationCode: { packageVerificationCodeValue: verificationCode },
      checksums: [{ algorithm: 'SHA256', checksumValue: archiveHash }],
      homepage: REPOSITORY,
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT',
      copyrightText: 'Copyright (c) 2026 Scalvin contributors',
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:npm/scalvin@${version}`
      }]
    }],
    files,
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: packageId },
      ...files.map((entry) => ({
        spdxElementId: packageId,
        relationshipType: 'CONTAINS',
        relatedSpdxElement: entry.SPDXID
      }))
    ]
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const inventory = JSON.parse(readFileSync(path.join(ROOT, 'package-inventory.json'), 'utf8'));
  const version = validateVersion(packageJson.version, 'Package version');
  if (options.expectedVersion && validateVersion(options.expectedVersion, 'Expected version') !== version) {
    fail('Expected version does not match package.json.');
  }
  if (manifest.product?.version !== version || manifest.release?.version !== version) {
    fail('Package and manifest versions do not agree.');
  }
  const commit = validateCommit(options.expectedCommit || currentCommit());
  if (commit !== validateCommit(currentCommit())) fail('Expected commit does not match the checkout.');
  const createdAt = validateTimestamp(options.createdAt || new Date().toISOString());
  if (options.requireClean) assertCleanCheckout();

  const output = path.resolve(options.outputDirectory);
  if (existsSync(output)) fail('Output directory already exists.');
  const parent = path.dirname(output);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(path.join(parent, '.scalvin-release-stage-'));

  try {
    const rawReport = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', stage]);
    const reports = JSON.parse(rawReport);
    if (!Array.isArray(reports) || reports.length !== 1) fail('npm pack returned an unexpected report.');
    const report = reports[0];
    if (report.name !== 'scalvin' || report.version !== version || !Array.isArray(report.files)) {
      fail('npm pack report does not match the release candidate.');
    }
    const packagedPaths = report.files.map((entry) => entry.path).sort();
    const expectedPaths = [...inventory.files].sort();
    if (JSON.stringify(packagedPaths) !== JSON.stringify(expectedPaths)) {
      fail('npm package contents do not match package-inventory.json.');
    }

    const archiveName = report.filename;
    const archivePath = path.join(stage, archiveName);
    if (!existsSync(archivePath) || !lstatSync(archivePath).isFile()) fail('npm pack did not create the expected archive.');
    const archiveHash = shaFile(archivePath);
    const checksumName = `${archiveName}.sha256`;
    writeFileSync(path.join(stage, checksumName), `${archiveHash}  ${archiveName}\n`, { flag: 'wx', mode: 0o644 });

    const sbomName = `scalvin-${version}.spdx.json`;
    const sbom = buildSpdx({ version, commit, createdAt, archiveHash, packageReport: report });
    writeFileSync(path.join(stage, sbomName), canonicalJson(sbom), { flag: 'wx', mode: 0o644 });
    const sbomHash = shaFile(path.join(stage, sbomName));

    const metadataName = `scalvin-${version}.release-metadata.json`;
    const metadata = {
      schemaVersion: 1,
      artifactType: 'scalvin-stable-release-artifact-set',
      repository: REPOSITORY,
      candidate: { version, commit },
      createdAt,
      attestationSubject: { name: archiveName, digest: { sha256: archiveHash } },
      artifacts: {
        packageArchive: { name: archiveName, bytes: lstatSync(archivePath).size, sha256: archiveHash },
        checksum: { name: checksumName, algorithm: 'SHA256', sha256: shaFile(path.join(stage, checksumName)) },
        sbom: { name: sbomName, format: 'SPDX-2.3', sha256: sbomHash }
      },
      sourceContracts: {
        manifestSha256: shaFile(path.join(ROOT, 'manifest.json')),
        packageInventorySha256: shaFile(path.join(ROOT, 'package-inventory.json'))
      }
    };
    const metadataPath = path.join(stage, metadataName);
    writeFileSync(metadataPath, canonicalJson(metadata), { flag: 'wx', mode: 0o644 });
    const metadataHash = shaFile(metadataPath);

    // This checksum list is deliberately created after the metadata. The
    // metadata binds every source and release artifact except itself; this
    // non-circular list then binds the exact metadata bytes as an attestation
    // subject alongside the archive, archive checksum, and SBOM.
    const releaseSetChecksumName = `scalvin-${version}.release-set.sha256`;
    const releaseSetChecksums = [
      [archiveHash, archiveName],
      [shaFile(path.join(stage, checksumName)), checksumName],
      [sbomHash, sbomName],
      [metadataHash, metadataName]
    ].map(([digest, name]) => `${digest}  ${name}\n`).join('');
    writeFileSync(path.join(stage, releaseSetChecksumName), releaseSetChecksums, { flag: 'wx', mode: 0o644 });

    for (const name of [archiveName, checksumName, sbomName, metadataName, releaseSetChecksumName]) {
      chmodSync(path.join(stage, name), 0o644);
    }
    renameSync(stage, output);
    process.stdout.write(`${JSON.stringify({
      status: 'built',
      version,
      commit,
      archive: archiveName,
      archiveSha256: archiveHash,
      checksum: checksumName,
      sbom: sbomName,
      metadata: metadataName,
      releaseSetChecksum: releaseSetChecksumName
    })}\n`);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
