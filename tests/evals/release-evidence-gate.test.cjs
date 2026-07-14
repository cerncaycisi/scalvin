'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const {
  ARTIFACT_PATHS,
  REQUIRED_COMPONENTS
} = require('../../cli/verify-release-evidence');
const { stableJson } = require('../../cli/evaluate-captured-responses');
const { applyWindowsPrivateAcl } = require('../../cli/lib/fs-safe');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'cli', 'verify-release-evidence.js');
const SIGN_SCRIPT = path.join(ROOT, 'scripts', 'sign-clinical-review.mjs');
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build-release-evidence.mjs');
const ENCODE_SCRIPT = path.join(ROOT, 'scripts', 'encode-release-evidence-secret-chunks.mjs');
const REFERENCE_CAPTURE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'evals', 'fixtures', 'evaluator-pass-fixture.json'),
  'utf8'
));
const BEHAVIORAL_CORPUS = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'evals', 'behavioral-release-corpus.json'),
  'utf8'
));
const RELEASE_POLICY = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'evals', 'release-evidence-policy.json'),
  'utf8'
));
const COMMIT = 'a'.repeat(40);
const VERSION = '1.0.0';
const tempParent = process.env.SCALVIN_TEST_ROOT || path.join(ROOT, '.test-tmp');
fs.mkdirSync(tempParent, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'release-evidence-gate-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const publicDer = publicKey.export({ type: 'spki', format: 'der' });
const keyFingerprint = crypto.createHash('sha256').update(publicDer).digest('hex');

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function shaFile(relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, relative))).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildCapture(adapter = 'codex') {
  const capture = clone(REFERENCE_CAPTURE);
  capture.candidate = {
    releaseVersion: VERSION,
    commit: COMMIT,
    provider: 'reviewed-provider',
    model: 'reviewed-model',
    adapter,
    capturedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  };
  return capture;
}

function buildCaptures() {
  return RELEASE_POLICY.requiredClientAdapters.map((adapter) => buildCapture(adapter));
}

function localePacks() {
  return fs.readdirSync(path.join(ROOT, 'hooks', 'safety-locales'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
}

function buildReview(captures) {
  const reviewedAt = new Date(Date.now() - 60 * 1000).toISOString();
  const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    schemaVersion: 1,
    artifactType: 'scalvin-independent-clinical-safety-review',
    candidate: { version: VERSION, commit: COMMIT },
    reviewedAt,
    validUntil,
    reviewer: {
      role: 'Independent clinical and safety reviewer',
      qualification: 'Synthetic qualification used only by the deterministic test fixture',
      independenceAttested: true,
      conflictsOfInterest: 'Synthetic test fixture; no real reviewer claim'
    },
    scope: {
      reviewedComponents: [...REQUIRED_COMPONENTS],
      localePackReviews: localePacks().map((locale) => ({
        locale,
        fluentReviewerAttested: true,
        decision: 'approve',
        limitations: ['Synthetic fixture only; this is not release evidence.']
      })),
      captureMatrix: captures.map((capture) => ({
        provider: capture.candidate.provider,
        model: capture.candidate.model,
        adapter: capture.candidate.adapter,
        evaluatedLocales: [...BEHAVIORAL_CORPUS.policy.coverageLocales].sort(),
        capturedAt: capture.candidate.capturedAt,
        captureCanonicalSha256: crypto.createHash('sha256')
          .update(Buffer.from(stableJson(capture), 'utf8')).digest('hex'),
        corpusSha256: shaFile('evals/behavioral-release-corpus.json'),
        candidateMetadataSha256: crypto.createHash('sha256')
          .update(Buffer.from(stableJson(capture.candidate), 'utf8')).digest('hex'),
        realModelCaptureAttested: true,
        captureMethod: 'client_export',
        provenanceSha256: crypto.createHash('sha256')
          .update(`synthetic-test-provenance:${capture.candidate.adapter}`).digest('hex'),
        decision: 'approve',
        limitations: ['Synthetic fixture only; this is not release evidence.']
      })),
      artifacts: Object.fromEntries(Object.entries(ARTIFACT_PATHS).map(([key, relative]) => [key, shaFile(relative)]))
    },
    decision: 'approve',
    limitations: ['Synthetic fixture only; this is not release evidence.'],
    requiredChanges: [],
    unresolvedDisagreements: [],
    reReviewTriggers: ['Any material safety, consent, retention, modality, model, or locale-pack change.'],
    statement: 'I independently reviewed the listed candidate and evidence and approve only the stated scope and limitations.'
  };
}

function sign(review) {
  return crypto.sign(null, Buffer.from(stableJson(review), 'utf8'), privateKey).toString('base64');
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeEnvelope(name, mutate = () => {}) {
  const captures = buildCaptures();
  const review = buildReview(captures);
  const envelope = {
    schemaVersion: 1,
    artifactType: 'scalvin-stable-release-evidence',
    review,
    reviewSignature: '',
    reviewerPublicKey: publicPem,
    captures
  };
  mutate(envelope);
  if (!envelope.reviewSignature) envelope.reviewSignature = sign(envelope.review);
  const target = path.join(tempRoot, name);
  fs.writeFileSync(target, zlib.gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8')), { mode: 0o600 });
  return target;
}

function run(input, extra = []) {
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--input', input,
    '--expected-commit', COMMIT,
    '--expected-version', VERSION,
    '--reviewer-key-sha256', keyFingerprint,
    ...extra
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  return { code: result.status, body: JSON.parse(result.stdout), raw: result.stdout };
}

test('signed exact-candidate review and complete capture matrix pass', () => {
  const result = run(writeEnvelope('good.json.gz'));
  assert.equal(result.code, 0);
  assert.equal(result.body.status, 'pass');
  assert.deepEqual(result.body.candidate, { version: VERSION, commit: COMMIT });
  assert.equal(result.body.review.reviewerKeySha256, keyFingerprint);
  assert.equal(result.body.review.localePackCount, localePacks().length);
  assert.equal(result.body.review.captureTupleCount, RELEASE_POLICY.requiredClientAdapters.length);
  assert.deepEqual(result.body.review.requiredClientAdapters, RELEASE_POLICY.requiredClientAdapters);
  assert.deepEqual(result.body.captures[0].provider, 'reviewed-provider');
  assert.deepEqual(result.body.captures[0].evaluatedLocales, [...BEHAVIORAL_CORPUS.policy.coverageLocales]);
  assert.doesNotMatch(result.raw, /Synthetic fixture only|absolute|response/i);
});

test('default macOS os.tmpdir alias is canonicalized before private capture staging', {
  skip: process.platform !== 'darwin'
}, () => {
  const input = writeEnvelope('default-macos-tmp.json.gz');
  const env = { ...process.env };
  delete env.RUNNER_TEMP;
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--input', input,
    '--expected-commit', COMMIT,
    '--expected-version', VERSION,
    '--reviewer-key-sha256', keyFingerprint
  ], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).status, 'pass');
  assert.doesNotMatch(result.stdout, /Tell me I was right|Synthetic fixture only|response/i);
});

test('reviewer signing and maintainer assembly tools create a verified private envelope', async () => {
  const reviewPath = path.join(tempRoot, 'tool-review.json');
  const privatePath = path.join(tempRoot, 'tool-private.pem');
  const signingOutputDirectory = path.join(tempRoot, 'tool-signing-output');
  const evidenceOutputDirectory = path.join(tempRoot, 'tool-evidence-output');
  fs.mkdirSync(signingOutputDirectory, { mode: 0o777 });
  fs.chmodSync(signingOutputDirectory, 0o777);
  fs.mkdirSync(evidenceOutputDirectory, { mode: 0o777 });
  fs.chmodSync(evidenceOutputDirectory, 0o777);
  if (process.platform === 'darwin') {
    for (const directory of [signingOutputDirectory, evidenceOutputDirectory]) {
      const acl = spawnSync('/bin/chmod', [
        '+a',
        'everyone allow read,readattr,readextattr,readsecurity,file_inherit',
        directory
      ], { encoding: 'utf8' });
      assert.equal(acl.status, 0, acl.stderr);
    }
  }
  const signaturePath = path.join(signingOutputDirectory, 'tool-review.sig');
  const publicPath = path.join(signingOutputDirectory, 'tool-public.pem');
  const capturePath = path.join(tempRoot, 'tool-capture.json');
  const outputPath = path.join(evidenceOutputDirectory, 'tool-evidence.json.gz');
  const captures = buildCaptures();
  fs.writeFileSync(reviewPath, `${JSON.stringify(buildReview(captures))}\n`, { mode: 0o600 });
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  if (process.platform === 'win32') await applyWindowsPrivateAcl(privatePath);
  const capturePaths = captures.map((capture, index) => {
    const value = index === 0 ? capturePath : path.join(tempRoot, `tool-capture-${index}.json`);
    fs.writeFileSync(value, `${JSON.stringify(capture)}\n`, { mode: 0o600 });
    return value;
  });

  const signed = spawnSync(process.execPath, [
    SIGN_SCRIPT,
    '--review', reviewPath,
    '--private-key', privatePath,
    '--signature-output', signaturePath,
    '--public-key-output', publicPath
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(JSON.parse(signed.stdout).reviewerKeySha256, keyFingerprint);
  assert.doesNotMatch(signed.stdout, /PRIVATE KEY|Synthetic fixture/i);
  if (process.platform !== 'win32') {
    assert.equal(mode(signingOutputDirectory), 0o777);
    assert.equal(mode(signaturePath), 0o600);
  }
  if (process.platform === 'darwin') {
    const parentAcl = spawnSync('/bin/ls', ['-lde', signingOutputDirectory], { encoding: 'utf8' });
    const fileAcl = spawnSync('/bin/ls', ['-le', signaturePath], { encoding: 'utf8' });
    assert.match(parentAcl.stdout, /^\s*\d+:\s/m);
    assert.doesNotMatch(fileAcl.stdout, /^\s*\d+:\s/m);
  }

  const builtArguments = [
    BUILD_SCRIPT,
    '--review', reviewPath,
    '--signature', signaturePath,
    '--public-key', publicPath,
    ...capturePaths.flatMap((value) => ['--capture', value]),
    '--output', outputPath,
    '--expected-commit', COMMIT,
    '--expected-version', VERSION,
    '--reviewer-key-sha256', keyFingerprint
  ];
  const built = spawnSync(process.execPath, builtArguments, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(JSON.parse(built.stdout).status, 'built-and-verified');
  assert.equal(run(outputPath).body.status, 'pass');
  assert.doesNotMatch(built.stdout, /PRIVATE KEY|Synthetic fixture|Tell me I was right/i);
  if (process.platform !== 'win32') {
    assert.equal(mode(evidenceOutputDirectory), 0o777);
    assert.equal(mode(outputPath), 0o600);
  }
  if (process.platform === 'darwin') {
    const parentAcl = spawnSync('/bin/ls', ['-lde', evidenceOutputDirectory], { encoding: 'utf8' });
    const fileAcl = spawnSync('/bin/ls', ['-le', outputPath], { encoding: 'utf8' });
    assert.match(parentAcl.stdout, /^\s*\d+:\s/m);
    assert.doesNotMatch(fileAcl.stdout, /^\s*\d+:\s/m);
  }

  const unpinnedOutputPath = path.join(tempRoot, 'tool-evidence-unpinned.json.gz');
  const unpinnedArguments = [...builtArguments];
  unpinnedArguments[unpinnedArguments.indexOf('--output') + 1] = unpinnedOutputPath;
  unpinnedArguments[unpinnedArguments.length - 1] = 'b'.repeat(64);
  const unpinned = spawnSync(process.execPath, [
    ...unpinnedArguments
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(unpinned.status, 0);
  assert.equal(fs.existsSync(unpinnedOutputPath), false);

  const chunksPath = path.join(tempRoot, 'tool-secret-chunks');
  const encoded = spawnSync(process.execPath, [
    ENCODE_SCRIPT,
    '--input', outputPath,
    '--output-directory', chunksPath
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(encoded.status, 0, encoded.stderr);
  const encodedResult = JSON.parse(encoded.stdout);
  assert.ok(encodedResult.chunkCount >= 1);
  if (process.platform !== 'win32') {
    assert.equal(mode(chunksPath), 0o700);
    for (const name of fs.readdirSync(chunksPath)) assert.equal(mode(path.join(chunksPath, name)), 0o600);
  }
  const reconstructed = Buffer.from(fs.readdirSync(chunksPath).sort()
    .map((name) => fs.readFileSync(path.join(chunksPath, name), 'utf8')).join(''), 'base64');
  assert.deepEqual(reconstructed, fs.readFileSync(outputPath));
});

test('exclusive release outputs never overwrite or delete caller-owned files', async () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'existing-output-'));
  const captures = buildCaptures();
  const review = buildReview(captures);
  const reviewPath = path.join(directory, 'review.json');
  const privatePath = path.join(directory, 'reviewer-private.pem');
  const existingSignaturePath = path.join(directory, 'existing-review.sig');
  const absentPublicPath = path.join(directory, 'must-remain-absent.pem');
  const signatureCanary = 'PREEXISTING-SIGNATURE-CANARY\n';
  fs.writeFileSync(reviewPath, `${JSON.stringify(review)}\n`, { mode: 0o600 });
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  if (process.platform === 'win32') await applyWindowsPrivateAcl(privatePath);
  fs.writeFileSync(existingSignaturePath, signatureCanary, { mode: 0o600 });

  const signed = spawnSync(process.execPath, [
    SIGN_SCRIPT,
    '--review', reviewPath,
    '--private-key', privatePath,
    '--signature-output', existingSignaturePath,
    '--public-key-output', absentPublicPath
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.notEqual(signed.status, 0);
  assert.equal(signed.stdout, '');
  assert.equal(fs.readFileSync(existingSignaturePath, 'utf8'), signatureCanary);
  assert.equal(fs.existsSync(absentPublicPath), false);
  assert.doesNotMatch(signed.stderr, /PREEXISTING-SIGNATURE-CANARY|BEGIN PRIVATE KEY|Synthetic fixture only/i);

  const signaturePath = path.join(directory, 'review.sig');
  const publicPath = path.join(directory, 'reviewer-public.pem');
  const existingEvidencePath = path.join(directory, 'existing-evidence.json.gz');
  const evidenceCanary = 'PREEXISTING-EVIDENCE-CANARY\n';
  fs.writeFileSync(signaturePath, `${sign(review)}\n`, { mode: 0o600 });
  fs.writeFileSync(publicPath, publicPem, { mode: 0o600 });
  fs.writeFileSync(existingEvidencePath, evidenceCanary, { mode: 0o600 });
  const capturePaths = captures.map((capture, index) => {
    const capturePath = path.join(directory, `capture-${index}.json`);
    fs.writeFileSync(capturePath, `${JSON.stringify(capture)}\n`, { mode: 0o600 });
    return capturePath;
  });
  const built = spawnSync(process.execPath, [
    BUILD_SCRIPT,
    '--review', reviewPath,
    '--signature', signaturePath,
    '--public-key', publicPath,
    ...capturePaths.flatMap((capturePath) => ['--capture', capturePath]),
    '--output', existingEvidencePath,
    '--expected-commit', COMMIT,
    '--expected-version', VERSION,
    '--reviewer-key-sha256', keyFingerprint
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.notEqual(built.status, 0);
  assert.equal(built.stdout, '');
  assert.equal(fs.readFileSync(existingEvidencePath, 'utf8'), evidenceCanary);
  assert.doesNotMatch(built.stderr, /PREEXISTING-EVIDENCE-CANARY|Tell me I was right|Synthetic fixture only/i);
});

test('reviewer signing rejects a non-private key without exposing key material or paths', {
  skip: process.platform === 'win32'
}, () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'broad-key-'));
  const reviewPath = path.join(directory, 'review.json');
  const privatePath = path.join(directory, 'reviewer-private.pem');
  const signaturePath = path.join(directory, 'review.sig');
  const publicPath = path.join(directory, 'reviewer-public.pem');
  const keyBytes = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(reviewPath, `${JSON.stringify(buildReview(buildCaptures()))}\n`, { mode: 0o600 });
  fs.writeFileSync(privatePath, keyBytes, { mode: 0o600 });
  fs.chmodSync(privatePath, 0o640);

  const result = spawnSync(process.execPath, [
    SIGN_SCRIPT,
    '--review', reviewPath,
    '--private-key', privatePath,
    '--signature-output', signaturePath,
    '--public-key-output', publicPath
  ], { cwd: ROOT, encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'The reviewer private key permissions or access-control list are not private.');
  assert.equal(fs.existsSync(signaturePath), false);
  assert.equal(fs.existsSync(publicPath), false);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(escaped(privatePath)));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /BEGIN PRIVATE KEY|Synthetic fixture only/i);
});

test('macOS inherited ACL cannot bypass the exact 0600 reviewer-key gate', {
  skip: process.platform !== 'darwin'
}, () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'inherited-key-acl-'));
  const acl = spawnSync('/bin/chmod', [
    '+a',
    'everyone allow read,readattr,readextattr,readsecurity,file_inherit',
    directory
  ], { encoding: 'utf8' });
  assert.equal(acl.status, 0, acl.stderr);

  const reviewPath = path.join(directory, 'review.json');
  const privatePath = path.join(directory, 'reviewer-private.pem');
  const signaturePath = path.join(directory, 'review.sig');
  const publicPath = path.join(directory, 'reviewer-public.pem');
  fs.writeFileSync(reviewPath, `${JSON.stringify(buildReview(buildCaptures()))}\n`, { mode: 0o600 });
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.chmodSync(privatePath, 0o600);
  assert.equal(mode(privatePath), 0o600);
  const listed = spawnSync('/bin/ls', ['-le', privatePath], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^\s*\d+:\s/m);

  const result = spawnSync(process.execPath, [
    SIGN_SCRIPT,
    '--review', reviewPath,
    '--private-key', privatePath,
    '--signature-output', signaturePath,
    '--public-key-output', publicPath
  ], { cwd: ROOT, encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'The reviewer private key permissions or access-control list are not private.');
  assert.equal(fs.existsSync(signaturePath), false);
  assert.equal(fs.existsSync(publicPath), false);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(escaped(privatePath)));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /BEGIN PRIVATE KEY|Synthetic fixture only/i);
});

test('Windows reviewer-key ACL is verified before signing', {
  skip: process.platform !== 'win32'
}, () => {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'broad-key-acl-'));
  const reviewPath = path.join(directory, 'review.json');
  const privatePath = path.join(directory, 'reviewer-private.pem');
  const signaturePath = path.join(directory, 'review.sig');
  const publicPath = path.join(directory, 'reviewer-public.pem');
  fs.writeFileSync(reviewPath, `${JSON.stringify(buildReview(buildCaptures()))}\n`);
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const acl = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$root = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $acl = [IO.File]::GetAccessControl($root); $sid = [Security.Principal.SecurityIdentifier]::new("S-1-1-0"); $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow); $acl.SetAccessRuleProtection($false, $true); [void]$acl.AddAccessRule($rule); [IO.File]::SetAccessControl($root, $acl)'
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, SCALVIN_TEST_ACL_PATH: privatePath }
  });
  assert.equal(acl.status, 0, acl.stderr);

  const result = spawnSync(process.execPath, [
    SIGN_SCRIPT,
    '--review', reviewPath,
    '--private-key', privatePath,
    '--signature-output', signaturePath,
    '--public-key-output', publicPath
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'The reviewer private key permissions or access-control list are not private.');
  assert.equal(fs.existsSync(signaturePath), false);
  assert.equal(fs.existsSync(publicPath), false);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(escaped(privatePath), 'i'));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /BEGIN PRIVATE KEY|Synthetic fixture only/i);
});

test('macOS inherited ACL is removed from verifier temporary storage before capture evaluation', {
  skip: process.platform !== 'darwin'
}, () => {
  const runnerTemp = fs.mkdtempSync(path.join(tempRoot, 'runner-temp-acl-'));
  const acl = spawnSync('/bin/chmod', [
    '+a',
    'everyone allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit',
    runnerTemp
  ], { encoding: 'utf8' });
  assert.equal(acl.status, 0, acl.stderr);

  const inheritedProbe = fs.mkdtempSync(path.join(runnerTemp, 'probe-'));
  const listed = spawnSync('/bin/ls', ['-lde', inheritedProbe], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^\s*\d+:\s/m);
  fs.rmSync(inheritedProbe, { recursive: true, force: true });

  const input = writeEnvelope('runner-temp-private.json.gz');
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--input', input,
    '--expected-commit', COMMIT,
    '--expected-version', VERSION,
    '--reviewer-key-sha256', keyFingerprint
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: runnerTemp }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).status, 'pass');
  assert.deepEqual(fs.readdirSync(runnerTemp), []);
  assert.doesNotMatch(result.stdout, /Tell me I was right|Synthetic fixture only|response/i);
});

test('tampered signed review fails closed', () => {
  const input = writeEnvelope('tampered-review.json.gz', (envelope) => {
    envelope.reviewSignature = sign(envelope.review);
    envelope.review.limitations.push('Unsigned mutation');
  });
  const result = run(input);
  assert.equal(result.code, 2);
  assert.equal(result.body.error.code, 'REVIEW_SIGNATURE_INVALID');
});

test('unpinned reviewer key fails closed', () => {
  const input = writeEnvelope('wrong-pin.json.gz');
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--input', input,
    '--expected-commit', COMMIT,
    '--expected-version', VERSION,
    '--reviewer-key-sha256', 'b'.repeat(64)
  ], { cwd: ROOT, encoding: 'utf8' });
  const body = JSON.parse(result.stdout);
  assert.equal(result.status, 2);
  assert.equal(body.error.code, 'REVIEW_KEY_MISMATCH');
});

test('review matrix must exactly match unique captured provider/model/adapter tuples', () => {
  const input = writeEnvelope('matrix-mismatch.json.gz', (envelope) => {
    envelope.review.scope.captureMatrix[0].model = 'different-model';
  });
  const result = run(input);
  assert.equal(result.code, 2);
  assert.equal(result.body.error.code, 'REVIEW_CAPTURE_SCOPE_MISMATCH');
});

test('the signed matrix must cover every shipped client adapter', () => {
  const input = writeEnvelope('adapter-missing.json.gz', (envelope) => {
    envelope.captures.pop();
    envelope.review.scope.captureMatrix.pop();
  });
  const result = run(input);
  assert.equal(result.code, 2);
  assert.equal(result.body.error.code, 'REVIEW_ADAPTER_SCOPE_INCOMPLETE');
});

test('every tuple requires signed real-model collection provenance', () => {
  const input = writeEnvelope('provenance-missing.json.gz', (envelope) => {
    envelope.review.scope.captureMatrix[0].realModelCaptureAttested = false;
  });
  const result = run(input);
  assert.equal(result.code, 2);
  assert.equal(result.body.error.code, 'REVIEW_CAPTURE_PROVENANCE_INVALID');
});

test('a passing same-tuple capture cannot be substituted after independent review', () => {
  const input = writeEnvelope('capture-substitution.json.gz', (envelope) => {
    envelope.captures[0].candidate.capturedAt = new Date(Date.now() - 9 * 60 * 1000).toISOString();
  });
  const result = run(input);
  assert.equal(result.code, 2);
  assert.equal(result.body.error.code, 'REVIEW_CAPTURE_EVIDENCE_MISMATCH');
});

test('every bundled locale pack requires an approving fluent review', () => {
  const input = writeEnvelope('locale-missing.json.gz', (envelope) => {
    envelope.review.scope.localePackReviews.pop();
  });
  const result = run(input);
  assert.equal(result.code, 2);
  assert.equal(result.body.error.code, 'REVIEW_LOCALE_SCOPE_INVALID');
});

test('expired reviews and non-approval decisions block stable release', () => {
  const expired = run(writeEnvelope('expired.json.gz', (envelope) => {
    envelope.review.reviewedAt = '2020-01-01T00:00:00.000Z';
    envelope.review.validUntil = '2020-02-01T00:00:00.000Z';
  }));
  assert.equal(expired.code, 2);
  assert.equal(expired.body.error.code, 'REVIEW_EXPIRED');

  const revise = run(writeEnvelope('revise.json.gz', (envelope) => {
    envelope.review.decision = 'revise';
  }));
  assert.equal(revise.code, 2);
  assert.equal(revise.body.error.code, 'REVIEW_NOT_APPROVED');
});

test('symlink input is rejected without disclosing its path or response text', { skip: process.platform === 'win32' }, () => {
  const target = writeEnvelope('regular.json.gz');
  const link = path.join(tempRoot, 'linked.json.gz');
  fs.symlinkSync(target, link);
  const result = run(link);
  assert.equal(result.code, 2);
  assert.equal(result.body.error.code, 'EVIDENCE_NOT_REGULAR');
  assert.doesNotMatch(result.raw, new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.raw, /Tell me I was right|Synthetic fixture only/i);
});
