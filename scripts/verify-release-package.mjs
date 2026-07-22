#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://github.com/cerncaycisi/scalvin';

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {};
  const keys = new Map([
    ['--archive', 'archive'],
    ['--checksum-file', 'checksumFile'],
    ['--sbom', 'sbom'],
    ['--metadata', 'metadata'],
    ['--release-set-checksum', 'releaseSetChecksum'],
    ['--expected-version', 'expectedVersion'],
    ['--expected-commit', 'expectedCommit']
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || index + 1 >= argv.length) {
      fail('Usage: verify-release-package.mjs --archive FILE --checksum-file FILE --sbom FILE --metadata FILE --release-set-checksum FILE --expected-version VERSION --expected-commit COMMIT');
    }
    options[key] = argv[index + 1];
  }
  for (const key of keys.values()) if (!options[key]) fail(`Missing required release verification option: ${key}.`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.expectedVersion)) {
    fail('Expected version must be a canonical semantic version.');
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.expectedCommit)) {
    fail('Expected commit must be a full lowercase Git object ID.');
  }
  return options;
}

function boundedRegularFile(filename, maximumBytes) {
  const absolute = path.resolve(filename);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    fail('A required release verification input is missing or unreadable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    fail('Release verification input is not a bounded regular file.');
  }
  return absolute;
}

function sha256File(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function hashFile(filename, algorithm) {
  return createHash(algorithm).update(readFileSync(filename)).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains missing or unknown fields.`);
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseCanonicalJson(filename, label) {
  const bytes = readFileSync(filename);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON.`);
  }
  if (text !== canonicalJson(value)) fail(`${label} is not canonical JSON.`);
  return value;
}

function canonicalTimestamp(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function expectedReleaseSet({ archive, checksum, sbom, metadata }) {
  return [archive, checksum, sbom, metadata]
    .map((filename) => `${sha256File(filename)}  ${path.basename(filename)}\n`)
    .join('');
}

function spdxFileId(relative) {
  return `SPDXRef-File-${createHash('sha256').update(relative).digest('hex').slice(0, 20)}`;
}

function verifySbom(sbom, metadata, options, archiveSha256) {
  exactKeys(sbom, [
    'spdxVersion', 'dataLicense', 'SPDXID', 'name', 'documentNamespace',
    'creationInfo', 'packages', 'files', 'relationships'
  ], 'Release SBOM');
  if (sbom.spdxVersion !== 'SPDX-2.3' || sbom.dataLicense !== 'CC0-1.0' ||
      sbom.SPDXID !== 'SPDXRef-DOCUMENT' || sbom.name !== `scalvin-${options.expectedVersion}` ||
      sbom.documentNamespace !== `${REPOSITORY}/sbom/${options.expectedCommit}/scalvin-${options.expectedVersion}-${archiveSha256}`) {
    fail('Release SBOM document identity does not match the exact candidate.');
  }
  exactKeys(sbom.creationInfo, ['created', 'creators'], 'Release SBOM creation info');
  if (sbom.creationInfo.created !== metadata.createdAt ||
      JSON.stringify(sbom.creationInfo.creators) !== JSON.stringify(['Tool: scalvin/scripts/build-release-artifacts.mjs'])) {
    fail('Release SBOM creation information does not match the candidate metadata.');
  }

  if (!Array.isArray(sbom.packages) || sbom.packages.length !== 1) fail('Release SBOM package scope is invalid.');
  const sbomPackage = sbom.packages[0];
  exactKeys(sbomPackage, [
    'name', 'SPDXID', 'versionInfo', 'downloadLocation', 'filesAnalyzed',
    'packageVerificationCode', 'checksums', 'homepage', 'licenseConcluded',
    'licenseDeclared', 'copyrightText', 'externalRefs'
  ], 'Release SBOM package');
  exactKeys(sbomPackage.packageVerificationCode, ['packageVerificationCodeValue'], 'Release SBOM package verification code');
  if (sbomPackage.name !== 'scalvin' || sbomPackage.SPDXID !== 'SPDXRef-Package-scalvin' ||
      sbomPackage.versionInfo !== options.expectedVersion || sbomPackage.filesAnalyzed !== true ||
      sbomPackage.homepage !== REPOSITORY || sbomPackage.licenseConcluded !== 'MIT' ||
      sbomPackage.licenseDeclared !== 'MIT' || !Array.isArray(sbomPackage.checksums) ||
      sbomPackage.checksums.length !== 1 || sbomPackage.checksums[0].algorithm !== 'SHA256' ||
      sbomPackage.checksums[0].checksumValue !== archiveSha256 ||
      !Array.isArray(sbomPackage.externalRefs) || sbomPackage.externalRefs.length !== 1 ||
      sbomPackage.externalRefs[0].referenceLocator !== `pkg:npm/scalvin@${options.expectedVersion}`) {
    fail('Release SBOM package does not bind the exact archive and version.');
  }

  const inventoryPath = boundedRegularFile(path.join(ROOT, 'package-inventory.json'), 16 * 1024 * 1024);
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const expectedFiles = inventory.files;
  if (!Array.isArray(expectedFiles) || expectedFiles.length === 0 ||
      new Set(expectedFiles).size !== expectedFiles.length ||
      [...expectedFiles].sort().some((name, index) => name !== expectedFiles[index])) {
    fail('The canonical package inventory is invalid.');
  }
  if (!Array.isArray(sbom.files) || sbom.files.length !== expectedFiles.length) {
    fail('Release SBOM file coverage does not match package-inventory.json.');
  }
  const sbomFiles = new Map();
  const sha1Values = [];
  for (const entry of sbom.files) {
    exactKeys(entry, [
      'fileName', 'SPDXID', 'checksums', 'licenseConcluded', 'licenseInfoInFiles',
      'copyrightText', 'fileTypes'
    ], 'Release SBOM file');
    if (typeof entry.fileName !== 'string' || !entry.fileName.startsWith('./')) {
      fail('Release SBOM contains an invalid package path.');
    }
    const relative = entry.fileName.slice(2);
    if (!expectedFiles.includes(relative) || sbomFiles.has(relative) || entry.SPDXID !== spdxFileId(relative) ||
        !Array.isArray(entry.checksums) || entry.checksums.length !== 2) {
      fail('Release SBOM contains an unexpected, duplicate, or malformed package file.');
    }
    const source = path.resolve(ROOT, relative);
    if (!source.startsWith(`${ROOT}${path.sep}`)) fail('The canonical package inventory contains an unsafe path.');
    boundedRegularFile(source, 32 * 1024 * 1024);
    const expectedSha1 = hashFile(source, 'sha1');
    const expectedSha256 = sha256File(source);
    const checksumMap = new Map(entry.checksums.map((checksum) => [checksum.algorithm, checksum.checksumValue]));
    if (checksumMap.size !== 2 || checksumMap.get('SHA1') !== expectedSha1 || checksumMap.get('SHA256') !== expectedSha256) {
      fail('Release SBOM file hashes do not match the exact candidate checkout.');
    }
    sha1Values.push(expectedSha1);
    sbomFiles.set(relative, expectedSha256);
  }
  if (expectedFiles.some((relative) => !sbomFiles.has(relative))) {
    fail('Release SBOM omits a canonical package-inventory entry.');
  }
  const verificationCode = createHash('sha1').update(sha1Values.sort().join('')).digest('hex');
  if (sbomPackage.packageVerificationCode.packageVerificationCodeValue !== verificationCode) {
    fail('Release SBOM package verification code is invalid.');
  }

  if (!Array.isArray(sbom.relationships) || sbom.relationships.length !== expectedFiles.length + 1) {
    fail('Release SBOM relationships do not cover the complete package inventory.');
  }
  const relationshipKeys = new Set();
  for (const relationship of sbom.relationships) {
    exactKeys(relationship, ['spdxElementId', 'relationshipType', 'relatedSpdxElement'], 'Release SBOM relationship');
    relationshipKeys.add(`${relationship.spdxElementId}\0${relationship.relationshipType}\0${relationship.relatedSpdxElement}`);
  }
  const describes = 'SPDXRef-DOCUMENT\0DESCRIBES\0SPDXRef-Package-scalvin';
  if (!relationshipKeys.has(describes) || expectedFiles.some((relative) => (
    !relationshipKeys.has(`SPDXRef-Package-scalvin\0CONTAINS\0${spdxFileId(relative)}`)
  ))) {
    fail('Release SBOM relationships do not bind every package file.');
  }
  return sbomFiles;
}

function installedFileInventory(root) {
  const files = [];
  function walk(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('Installed release package contains a symbolic link.');
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) files.push(relative);
      else fail('Installed release package contains a special filesystem entry.');
    }
  }
  walk(root, '');
  return files.sort();
}

function verifyMetadata(options, files, hashes) {
  const metadata = parseCanonicalJson(files.metadata, 'Release metadata');
  exactKeys(metadata, [
    'schemaVersion', 'artifactType', 'repository', 'candidate', 'createdAt',
    'attestationSubject', 'artifacts', 'sourceContracts'
  ], 'Release metadata');
  if (metadata.schemaVersion !== 1 || metadata.artifactType !== 'scalvin-stable-release-artifact-set' ||
      metadata.repository !== REPOSITORY || !canonicalTimestamp(metadata.createdAt)) {
    fail('Release metadata identity or creation time is invalid.');
  }

  exactKeys(metadata.candidate, ['version', 'commit'], 'Release metadata candidate');
  if (metadata.candidate.version !== options.expectedVersion || metadata.candidate.commit !== options.expectedCommit) {
    fail('Release metadata candidate does not match the expected version and commit.');
  }

  exactKeys(metadata.attestationSubject, ['name', 'digest'], 'Release metadata attestation subject');
  exactKeys(metadata.attestationSubject.digest, ['sha256'], 'Release metadata attestation digest');
  if (metadata.attestationSubject.name !== path.basename(files.archive) ||
      metadata.attestationSubject.digest.sha256 !== hashes.archive) {
    fail('Release metadata does not bind the exact package archive.');
  }

  exactKeys(metadata.artifacts, ['packageArchive', 'checksum', 'sbom'], 'Release metadata artifacts');
  exactKeys(metadata.artifacts.packageArchive, ['name', 'bytes', 'sha256'], 'Release metadata package archive');
  exactKeys(metadata.artifacts.checksum, ['name', 'algorithm', 'sha256'], 'Release metadata archive checksum');
  exactKeys(metadata.artifacts.sbom, ['name', 'format', 'sha256'], 'Release metadata SBOM');
  const archiveStat = lstatSync(files.archive);
  if (metadata.artifacts.packageArchive.name !== path.basename(files.archive) ||
      metadata.artifacts.packageArchive.bytes !== archiveStat.size ||
      metadata.artifacts.packageArchive.sha256 !== hashes.archive ||
      metadata.artifacts.checksum.name !== path.basename(files.checksum) ||
      metadata.artifacts.checksum.algorithm !== 'SHA256' ||
      metadata.artifacts.checksum.sha256 !== hashes.checksum ||
      metadata.artifacts.sbom.name !== path.basename(files.sbom) ||
      metadata.artifacts.sbom.format !== 'SPDX-2.3' ||
      metadata.artifacts.sbom.sha256 !== hashes.sbom) {
    fail('Release metadata artifact bindings do not match the supplied files.');
  }

  const manifest = boundedRegularFile(path.join(ROOT, 'manifest.json'), 16 * 1024 * 1024);
  const inventory = boundedRegularFile(path.join(ROOT, 'package-inventory.json'), 16 * 1024 * 1024);
  exactKeys(metadata.sourceContracts, ['manifestSha256', 'packageInventorySha256'], 'Release metadata source contracts');
  if (metadata.sourceContracts.manifestSha256 !== sha256File(manifest) ||
      metadata.sourceContracts.packageInventorySha256 !== sha256File(inventory)) {
    fail('Release metadata source-contract hashes do not match this candidate checkout.');
  }
  const manifestValue = JSON.parse(readFileSync(manifest, 'utf8'));
  const inventoryValue = JSON.parse(readFileSync(inventory, 'utf8'));
  if (manifestValue.product?.version !== options.expectedVersion ||
      manifestValue.release?.version !== options.expectedVersion ||
      inventoryValue.schemaVersion !== 1 ||
      inventoryValue.purpose !== 'canonical-npm-package-file-inventory' ||
      !Array.isArray(inventoryValue.files) || inventoryValue.files.length === 0) {
    fail('Release metadata source contracts do not describe the expected candidate version and inventory.');
  }
  return metadata;
}

function npmCommand(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      arguments: [npmExecPath, ...args]
    };
  }
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      arguments: ['/d', '/s', '/c', 'npm.cmd', ...args]
    };
  }
  return { command: 'npm', arguments: args };
}

function runNpm(args, options = {}) {
  const invocation = npmCommand(args);
  return execFileSync(invocation.command, invocation.arguments, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function runNode(args, options = {}) {
  return execFileSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const archive = boundedRegularFile(options.archive, 32 * 1024 * 1024);
  const checksumFile = boundedRegularFile(options.checksumFile, 4096);
  const sbomFile = boundedRegularFile(options.sbom, 16 * 1024 * 1024);
  const metadataFile = boundedRegularFile(options.metadata, 1024 * 1024);
  const releaseSetChecksumFile = boundedRegularFile(options.releaseSetChecksum, 16 * 1024);
  const archiveName = path.basename(archive);
  const expectedArchiveName = `scalvin-${options.expectedVersion}.tgz`;
  if (archiveName !== expectedArchiveName ||
      path.basename(checksumFile) !== `${expectedArchiveName}.sha256` ||
      path.basename(sbomFile) !== `scalvin-${options.expectedVersion}.spdx.json` ||
      path.basename(metadataFile) !== `scalvin-${options.expectedVersion}.release-metadata.json` ||
      path.basename(releaseSetChecksumFile) !== `scalvin-${options.expectedVersion}.release-set.sha256`) {
    fail('Release artifact filenames do not match the expected candidate version.');
  }
  const archiveSha256 = sha256File(archive);
  const checksum = readFileSync(checksumFile, 'utf8');
  if (checksum !== `${archiveSha256}  ${archiveName}\n`) fail('Release archive checksum does not match.');

  const sbom = parseCanonicalJson(sbomFile, 'Release SBOM');
  const sbomPackage = Array.isArray(sbom.packages) ? sbom.packages.find((entry) => entry.name === 'scalvin') : null;
  if (sbom.spdxVersion !== 'SPDX-2.3' || sbomPackage?.versionInfo !== options.expectedVersion) {
    fail('Release SBOM does not match the expected package version.');
  }
  if (!sbomPackage.checksums?.some((entry) => entry.algorithm === 'SHA256' && entry.checksumValue === archiveSha256)) {
    fail('Release SBOM does not bind the package archive SHA-256.');
  }

  const files = {
    archive,
    checksum: checksumFile,
    sbom: sbomFile,
    metadata: metadataFile
  };
  const hashes = {
    archive: archiveSha256,
    checksum: sha256File(checksumFile),
    sbom: sha256File(sbomFile)
  };
  const metadata = verifyMetadata(options, files, hashes);
  const releaseSet = readFileSync(releaseSetChecksumFile, 'utf8');
  if (releaseSet !== expectedReleaseSet(files)) {
    fail('Release-set checksum does not bind the exact archive, checksum, SBOM, and metadata files.');
  }
  const metadataSha256 = sha256File(metadataFile);
  const sbomFileHashes = verifySbom(sbom, metadata, options, archiveSha256);

  const temporary = mkdtempSync(path.join(os.tmpdir(), 'scalvin-release-smoke-'));
  try {
    const installRoot = path.join(temporary, 'install-root');
    runNpm([
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
      '--prefix', installRoot, archive
    ], { cwd: temporary });
    const installedPackage = path.join(installRoot, 'node_modules', 'scalvin');
    const installedFiles = installedFileInventory(installedPackage);
    const expectedInstalledFiles = [...sbomFileHashes.keys()].sort();
    if (JSON.stringify(installedFiles) !== JSON.stringify(expectedInstalledFiles)) {
      fail('Installed release package contents do not match package-inventory.json.');
    }
    for (const [relative, expectedHash] of sbomFileHashes) {
      if (sha256File(path.join(installedPackage, relative)) !== expectedHash) {
        fail('Installed release package bytes do not match the candidate SBOM.');
      }
    }
    const cli = path.join(installedPackage, 'bin', 'scalvin.js');
    if (!existsSync(cli) || !lstatSync(cli).isFile()) fail('Installed package is missing the Scalvin entrypoint.');

    const version = runNode([cli, '--version'], { cwd: installRoot }).trim();
    if (version !== options.expectedVersion) fail('Installed CLI version does not match the release candidate.');
    const help = runNode([cli, '--help'], { cwd: installRoot });
    if (!help.includes(`Scalvin ${options.expectedVersion}`) || !help.includes('scalvin doctor --workspace PATH')) {
      fail('Installed CLI help surface is incomplete.');
    }

    const workspace = path.join(temporary, 'workspace');
    const installed = JSON.parse(runNode([
      cli, 'install', '--workspace', workspace, '--consent', 'declined', '--non-interactive', '--json'
    ], { cwd: installRoot }));
    if (installed.version !== options.expectedVersion || installed.workspacePath !== workspace) {
      fail('Packed clean install returned inconsistent candidate metadata.');
    }
    const doctor = JSON.parse(runNode([cli, 'doctor', '--workspace', workspace, '--json'], { cwd: installRoot }));
    if (doctor.status !== 'healthy' || doctor.errors !== 0) fail('Packed clean install did not pass doctor.');

    process.stdout.write(`${JSON.stringify({
      status: 'verified',
      version,
      archiveSha256,
      metadataSha256,
      doctorStatus: doctor.status
    })}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
