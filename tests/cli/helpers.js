'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..', '..');

async function sandbox(label) {
  const base = path.join(ROOT, '.test-tmp', `cli-${label}-${process.pid}-${crypto.randomUUID()}`);
  await fsp.mkdir(base, { recursive: true });
  process.env.SCALVIN_ALLOW_REPO_TARGET = '1';
  process.env.SCALVIN_LOCAL_STATE_DIR = path.join(base, 'local-state');
  delete process.env.SCALVIN_DISABLE_LOCAL_POINTER;
  delete process.env.SCALVIN_TEST_FAILPOINT;
  return {
    base,
    workspace: path.join(base, 'workspace'),
    cleanup: async () => {
      delete process.env.SCALVIN_TEST_FAILPOINT;
      await fsp.rm(base, { recursive: true, force: true });
    }
  };
}

async function incomingDistribution(base, version = '1.0.1', mutate = async () => {}) {
  const manifest = JSON.parse(await fsp.readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
  const source = path.join(base, `incoming-${version}`);
  await fsp.mkdir(source, { recursive: true });
  for (const entry of manifest.files) {
    const destination = path.join(source, entry.path);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(path.join(ROOT, entry.path), destination);
  }
  await mutate({ source, manifest });
  manifest.product.version = version;
  manifest.release.version = version;
  manifest.release.channel = 'stable';
  for (const entry of manifest.files) {
    const data = await fsp.readFile(path.join(source, entry.path));
    entry.sha256 = crypto.createHash('sha256').update(data).digest('hex');
  }
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await fsp.writeFile(path.join(source, 'manifest.json'), manifestBytes);
  return {
    source, manifest, manifestPath: path.join(source, 'manifest.json'),
    manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex')
  };
}

async function readJson(filename) {
  return JSON.parse(await fsp.readFile(filename, 'utf8'));
}

module.exports = { ROOT, sandbox, incomingDistribution, readJson };
