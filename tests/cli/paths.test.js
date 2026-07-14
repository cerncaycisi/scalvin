'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  resolvePortablePath,
  isInside,
  validateRelativePath,
  rejectSymlinkPath
} = require('../../cli/lib/fs-safe');
const { sandbox } = require('./helpers');

test('tilde resolves before absolute path normalization on POSIX', () => {
  const home = ['', 'home', 'alice'].join('/');
  assert.equal(
    resolvePortablePath('~/private', { platform: 'linux', home, cwd: '/tmp' }),
    `${home}/private`
  );
});

test('Windows tilde and drive paths use win32 semantics', () => {
  const home = ['C:', 'Accounts', 'Alice'].join('\\');
  assert.equal(
    resolvePortablePath('~\\private', { platform: 'win32', home, cwd: 'D:\\work' }),
    `${home}\\private`
  );
  assert.equal(resolvePortablePath('D:\\Data\\Scalvin', { platform: 'win32', home, cwd: 'C:\\' }), 'D:\\Data\\Scalvin');
});

test('relative target validation rejects traversal and absolute paths', () => {
  assert.throws(() => validateRelativePath('../outside'), { code: 'PATH_TRAVERSAL' });
  assert.throws(() => validateRelativePath('/outside'), { code: 'INVALID_MANIFEST_PATH' });
  assert.throws(() => validateRelativePath('C:\\outside'), { code: 'INVALID_MANIFEST_PATH' });
  for (const alias of ['a/./b', 'a//b', './a/b', 'a/b/', 'a\\b']) {
    assert.throws(() => validateRelativePath(alias), { code: 'INVALID_MANIFEST_PATH' });
  }
  for (const nonPortable of ['CON', 'aux.txt', 'folder/COM1.log', 'name:stream', 'trailing.', 'trailing ']) {
    assert.throws(() => validateRelativePath(nonPortable), { code: 'INVALID_MANIFEST_PATH' });
  }
  assert.equal(validateRelativePath('a/b-c_1.txt'), 'a/b-c_1.txt');
  assert.equal(isInside('/safe', '/safe/child'), true);
  assert.equal(isInside('/safe', '/unsafe'), false);
});

test('managed paths reject symlink components', async () => {
  const box = await sandbox('symlink');
  try {
    await fsp.mkdir(path.join(box.base, 'real'));
    await fsp.symlink(path.join(box.base, 'real'), path.join(box.base, 'link'));
    await assert.rejects(rejectSymlinkPath(path.join(box.base, 'link', 'file'), { allowMissing: true }), { code: 'SYMLINK_REJECTED' });
  } finally {
    await box.cleanup();
  }
});

test('verified macOS system directory aliases do not reject normal temporary paths', { skip: process.platform !== 'darwin' }, async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'scalvin-system-alias-'));
  try {
    await rejectSymlinkPath(path.join(temporary, 'missing-child'), { allowMissing: true });
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});
