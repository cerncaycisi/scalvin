'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  applyWindowsPrivateAcl,
  acquireMutationLock,
  activateDirectory,
  assertWorkspaceContentSnapshot,
  copyTree,
  inspectMutationLock,
  snapshotWorkspaceTree,
  hardenTree,
  verifyWindowsPrivateAcl
} = require('../../cli/lib/fs-safe');
const { sandbox } = require('./helpers');

const MANUAL_LOCK_GUIDANCE = 'Manual recovery only: inspect the lock, confirm no Scalvin mutation is running, then remove this exact lock path manually; never delete it based only on age or PID liveness.';

for (const failpoint of ['after-old-move', 'after-new-activate', 'after-fsync']) {
  test(`activation rollback restores old target at ${failpoint}`, async () => {
    const box = await sandbox(`activate-${failpoint}`);
    const target = path.join(box.base, 'target');
    const stage = path.join(box.base, 'stage');
    try {
      await fsp.mkdir(target);
      await fsp.mkdir(stage);
      await fsp.writeFile(path.join(target, 'value'), 'old');
      await fsp.writeFile(path.join(stage, 'value'), 'new');
      const expectedTargetSnapshot = await snapshotWorkspaceTree(target);
      process.env.SCALVIN_TEST_ACTIVATE_FAILPOINT = failpoint;
      await assert.rejects(activateDirectory(target, stage, { expectedTargetSnapshot }), { code: 'ACTIVATION_FAILED' });
      assert.equal(await fsp.readFile(path.join(target, 'value'), 'utf8'), 'old');
    } finally {
      delete process.env.SCALVIN_TEST_ACTIVATE_FAILPOINT;
      await box.cleanup();
    }
  });
}

test('activation CAS preserves a live write made after the stage snapshot', async () => {
  const box = await sandbox('activate-stale-live-write');
  const target = path.join(box.base, 'target');
  const stage = path.join(box.base, 'stage');
  try {
    await fsp.mkdir(target);
    await fsp.mkdir(stage);
    await fsp.writeFile(path.join(target, 'value'), 'old');
    await fsp.writeFile(path.join(stage, 'value'), 'new');
    const expectedTargetSnapshot = await snapshotWorkspaceTree(target);
    await fsp.writeFile(path.join(target, 'concurrent-note'), 'must survive');
    await assert.rejects(activateDirectory(target, stage, { expectedTargetSnapshot }), { code: 'STALE_WORKSPACE' });
    assert.equal(await fsp.readFile(path.join(target, 'value'), 'utf8'), 'old');
    assert.equal(await fsp.readFile(path.join(target, 'concurrent-note'), 'utf8'), 'must survive');
    await assert.rejects(fsp.access(stage), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('activation CAS does not replace a target created after an absent snapshot', async () => {
  const box = await sandbox('activate-stale-created-target');
  const target = path.join(box.base, 'target');
  const stage = path.join(box.base, 'stage');
  try {
    const expectedTargetSnapshot = await snapshotWorkspaceTree(target);
    await fsp.mkdir(stage);
    await fsp.writeFile(path.join(stage, 'value'), 'new');
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(target, 'concurrent-note'), 'must survive');
    await assert.rejects(activateDirectory(target, stage, { expectedTargetSnapshot }), { code: 'STALE_WORKSPACE' });
    assert.equal(await fsp.readFile(path.join(target, 'concurrent-note'), 'utf8'), 'must survive');
    await assert.rejects(fsp.access(stage), { code: 'ENOENT' });
  } finally {
    await box.cleanup();
  }
});

test('snapshot-bound stage copies reject ABA bytes while allowing private mode normalization', async () => {
  const box = await sandbox('snapshot-bound-copy');
  const source = path.join(box.base, 'source');
  const cleanStage = path.join(box.base, 'clean-stage');
  const transientStage = path.join(box.base, 'transient-stage');
  try {
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, 'personal.txt'), 'FINAL_A');
    if (process.platform !== 'win32') await fsp.chmod(path.join(source, 'personal.txt'), 0o644);
    const expected = await snapshotWorkspaceTree(source);

    await copyTree(source, cleanStage, { expectedSourceSnapshot: expected });
    assert.equal(await fsp.readFile(path.join(cleanStage, 'personal.txt'), 'utf8'), 'FINAL_A');
    if (process.platform !== 'win32') assert.equal((await fsp.stat(path.join(cleanStage, 'personal.txt'))).mode & 0o777, 0o600);

    await fsp.writeFile(path.join(source, 'personal.txt'), 'TRANSIENT_B');
    await copyTree(source, transientStage);
    await fsp.writeFile(path.join(source, 'personal.txt'), 'FINAL_A');
    await assert.rejects(assertWorkspaceContentSnapshot(transientStage, expected), { code: 'STALE_WORKSPACE' });
    assert.equal(await fsp.readFile(path.join(source, 'personal.txt'), 'utf8'), 'FINAL_A');
    assert.equal(await fsp.readFile(path.join(transientStage, 'personal.txt'), 'utf8'), 'TRANSIENT_B');
  } finally {
    await box.cleanup();
  }
});

test('cooperative mutation lock conflicts atomically and never writes inside the target', async () => {
  const box = await sandbox('mutation-lock-conflict');
  const target = path.join(box.base, 'target');
  let releaseFirst;
  let releaseSecond;
  try {
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(target, 'value'), 'old');
    releaseFirst = await acquireMutationLock(target);
    assert.equal(typeof releaseFirst, 'function');
    const inspected = await inspectMutationLock(target);
    assert.equal(inspected.status, 'present');
    assert.equal(inspected.lockKind, 'regular-file');
    assert.equal(inspected.ownerPid, process.pid);
    assert.equal(new Date(inspected.acquiredAt).toISOString(), inspected.acquiredAt);
    assert.doesNotMatch(JSON.stringify(inspected), /ownerToken|targetSha256/);
    await assert.rejects(
      acquireMutationLock(path.join(box.base, '.', 'target')),
      (error) => {
        assert.equal(error.code, 'MUTATION_LOCKED');
        assert.equal(error.details.recovery, 'manual-only');
        assert.equal(error.details.guidance, MANUAL_LOCK_GUIDANCE);
        assert.equal(error.details.lockPath, path.join(box.base, '.target.scalvin-mutation.lock'));
        assert.equal(error.message, `A mutation lock already exists at ${error.details.lockPath}. ${MANUAL_LOCK_GUIDANCE}`);
        assert.doesNotMatch(JSON.stringify(error.details), /ownerToken|ownerPid|acquiredAt/);
        return true;
      }
    );
    assert.deepEqual(await fsp.readdir(target), ['value']);

    const alternateTmp = path.join(box.base, 'alternate-tmp');
    await fsp.mkdir(alternateTmp);
    const childScript = `
const { acquireMutationLock } = require(${JSON.stringify(require.resolve('../../cli/lib/fs-safe'))});
(async () => {
  try {
    const release = await acquireMutationLock(process.argv[1]);
    await release();
    process.stdout.write(JSON.stringify({ status: 'acquired' }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ code: error.code, message: error.message, details: error.details }));
    process.exitCode = error.code === 'MUTATION_LOCKED' ? 23 : 24;
  }
})();
`;
    const child = spawnSync(process.execPath, ['-e', childScript, target], {
      cwd: box.base,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: alternateTmp, TMP: alternateTmp, TEMP: alternateTmp }
    });
    assert.equal(child.status, 23, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.stderr, '');
    const childError = JSON.parse(child.stdout);
    assert.equal(childError.code, 'MUTATION_LOCKED');
    assert.equal(childError.details.lockPath, path.join(box.base, '.target.scalvin-mutation.lock'));
    assert.equal(childError.details.guidance, MANUAL_LOCK_GUIDANCE);
    assert.doesNotMatch(JSON.stringify(childError), /ownerToken|ownerPid|acquiredAt/);

    await releaseFirst();
    await releaseFirst();
    releaseFirst = null;
    releaseSecond = await acquireMutationLock(target);
    await releaseSecond();
    releaseSecond = null;
  } finally {
    await releaseFirst?.().catch(() => {});
    await releaseSecond?.().catch(() => {});
    await box.cleanup();
  }
});

test('Windows ACL verifier accepts safe protected-root inheritance and rejects broad or ineffective access', {
  skip: process.platform !== 'win32'
}, async () => {
  const box = await sandbox('windows-acl-verifier');
  const target = path.join(box.base, 'private-path');
  try {
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(target, 'value'), 'private');
    await applyWindowsPrivateAcl(target);
    const verified = await verifyWindowsPrivateAcl(target);
    assert.deepEqual(verified, { ok: true });
    const inherited = path.join(target, 'inherited-value');
    await fsp.writeFile(inherited, 'private through protected-root inheritance');
    // An elevated Windows token may assign newly created descendants to the
    // built-in Administrators owner group. That owner is safe only inside a
    // current-user-owned protected root whose effective ACEs stay allowlisted.
    assert.deepEqual(await verifyWindowsPrivateAcl(target), { ok: true });
    const inspectOwners = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$root = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $child = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_CHILD); $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rootOwner = [IO.Directory]::GetAccessControl($root).GetOwner([Security.Principal.SecurityIdentifier]).Value; $childOwner = [IO.File]::GetAccessControl($child).GetOwner([Security.Principal.SecurityIdentifier]).Value; [Console]::Write("$user`n$rootOwner`n$childOwner")'
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SCALVIN_TEST_ACL_PATH: target, SCALVIN_TEST_ACL_CHILD: inherited }
    });
    assert.equal(inspectOwners.status, 0, inspectOwners.stderr);
    const [currentUserSid, rootOwnerSid, childOwnerSid] = inspectOwners.stdout.trim().split(/\r?\n/);
    assert.equal(rootOwnerSid, currentUserSid);
    assert.ok(
      [currentUserSid, 'S-1-5-32-544'].includes(childOwnerSid),
      `unexpected protected-tree descendant owner ${childOwnerSid}`
    );
    const inheritedAsRoot = await verifyWindowsPrivateAcl(inherited);
    assert.equal(inheritedAsRoot.ok, false);
    assert.match(inheritedAsRoot.error, /root inheritance enabled/i);
    const addUnexpected = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$file = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $acl = [IO.File]::GetAccessControl($file); $users = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-545"); $rule = [Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow); [void]$acl.AddAccessRule($rule); [IO.File]::SetAccessControl($file, $acl)'
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SCALVIN_TEST_ACL_PATH: inherited }
    });
    assert.equal(addUnexpected.status, 0, addUnexpected.stderr);
    const unexpected = await verifyWindowsPrivateAcl(target);
    assert.equal(unexpected.ok, false);
    assert.match(unexpected.error, /unexpected allow SID/i);
    await applyWindowsPrivateAcl(target);
    const downgrade = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$root = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $acl = [IO.Directory]::GetAccessControl($root); $user = [Security.Principal.WindowsIdentity]::GetCurrent().User; $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit", [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow); $acl.SetAccessRule($rule); [IO.Directory]::SetAccessControl($root, $acl)'
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SCALVIN_TEST_ACL_PATH: target }
    });
    assert.equal(downgrade.status, 0, downgrade.stderr);
    const rejected = await verifyWindowsPrivateAcl(target);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /lacks FullControl/i);
    const addInheritOnlyFull = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$root = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $acl = [IO.Directory]::GetAccessControl($root); $user = [Security.Principal.WindowsIdentity]::GetCurrent().User; $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit", [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Allow); [void]$acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($root, $acl)'
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SCALVIN_TEST_ACL_PATH: target }
    });
    assert.equal(addInheritOnlyFull.status, 0, addInheritOnlyFull.stderr);
    const inheritOnly = await verifyWindowsPrivateAcl(target);
    assert.equal(inheritOnly.ok, false);
    assert.match(inheritOnly.error, /lacks FullControl/i);
    await applyWindowsPrivateAcl(target);
    const removePropagation = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$root = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $acl = [IO.Directory]::GetAccessControl($root); $user = [Security.Principal.WindowsIdentity]::GetCurrent().User; $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow); $acl.SetAccessRule($rule); [IO.Directory]::SetAccessControl($root, $acl)'
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SCALVIN_TEST_ACL_PATH: target }
    });
    assert.equal(removePropagation.status, 0, removePropagation.stderr);
    const nonPropagating = await verifyWindowsPrivateAcl(target);
    assert.equal(nonPropagating.ok, false);
    assert.match(nonPropagating.error, /does not propagate to future children/i);
    await applyWindowsPrivateAcl(target);
    const noPropagate = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$root = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $acl = [IO.Directory]::GetAccessControl($root); $user = [Security.Principal.WindowsIdentity]::GetCurrent().User; $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit", [Security.AccessControl.PropagationFlags]::NoPropagateInherit, [Security.AccessControl.AccessControlType]::Allow); $acl.SetAccessRule($rule); [IO.Directory]::SetAccessControl($root, $acl)'
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SCALVIN_TEST_ACL_PATH: target }
    });
    assert.equal(noPropagate.status, 0, noPropagate.stderr);
    const boundedPropagation = await verifyWindowsPrivateAcl(target);
    assert.equal(boundedPropagation.ok, false);
    assert.match(boundedPropagation.error, /does not propagate to future children/i);
    await applyWindowsPrivateAcl(target);
    try {
      const addDeny = spawnSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Deny a real filesystem capability without denying directory reads:
        // the verifier must be able to traverse the tree to inspect the ACE.
        '$root = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $acl = [IO.Directory]::GetAccessControl($root); $user = [Security.Principal.WindowsIdentity]::GetCurrent().User; $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::WriteData, [Security.AccessControl.AccessControlType]::Deny); [void]$acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($root, $acl)'
      ], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, SCALVIN_TEST_ACL_PATH: target }
      });
      assert.equal(addDeny.status, 0, addDeny.stderr);
      const denied = await verifyWindowsPrivateAcl(target);
      assert.equal(denied.ok, false);
      assert.match(denied.error, /deny rules are not allowed/i);
    } finally {
      await applyWindowsPrivateAcl(target);
    }
    assert.deepEqual(await verifyWindowsPrivateAcl(target), { ok: true });
    if (process.env.GITHUB_ACTIONS === 'true') {
      const setAdministratorOwner = spawnSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$root = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $acl = [IO.Directory]::GetAccessControl($root); $admins = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"); $acl.SetOwner($admins); [IO.Directory]::SetAccessControl($root, $acl)'
      ], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, SCALVIN_TEST_ACL_PATH: target }
      });
      assert.equal(setAdministratorOwner.status, 0, setAdministratorOwner.stderr);
      const wrongRootOwner = await verifyWindowsPrivateAcl(target);
      assert.equal(wrongRootOwner.ok, false);
      assert.match(wrongRootOwner.error, /unexpected root owner SID/i);
      await applyWindowsPrivateAcl(target);
    }
    const enableRootInheritance = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$root = [IO.Path]::GetFullPath($env:SCALVIN_TEST_ACL_PATH); $acl = [IO.Directory]::GetAccessControl($root); $acl.SetAccessRuleProtection($false, $true); [IO.Directory]::SetAccessControl($root, $acl)'
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SCALVIN_TEST_ACL_PATH: target }
    });
    try {
      assert.equal(enableRootInheritance.status, 0, enableRootInheritance.stderr);
      const inheritedRoot = await verifyWindowsPrivateAcl(target);
      assert.equal(inheritedRoot.ok, false);
      assert.match(inheritedRoot.error, /root inheritance enabled/i);
    } finally {
      await applyWindowsPrivateAcl(target);
    }
    assert.deepEqual(await verifyWindowsPrivateAcl(target), { ok: true });
  } finally {
    await box.cleanup();
  }
});

test('mutation lock follows case-insensitive macOS filesystem identity', {
  skip: process.platform !== 'darwin'
}, async (t) => {
  const box = await sandbox('mutation-lock-case-alias');
  const target = path.join(box.base, 'CaseTarget');
  const alias = path.join(box.base, 'casetarget');
  let release;
  try {
    await fsp.mkdir(target);
    const actual = await fsp.lstat(target);
    let aliased;
    try {
      aliased = await fsp.lstat(alias);
    } catch (error) {
      if (error.code === 'ENOENT') {
        t.skip('The test volume is case-sensitive.');
        return;
      }
      throw error;
    }
    if (actual.dev !== aliased.dev || actual.ino !== aliased.ino) {
      t.skip('The test volume is case-sensitive.');
      return;
    }
    release = await acquireMutationLock(target);
    await assert.rejects(acquireMutationLock(alias), { code: 'MUTATION_LOCKED' });
  } finally {
    await release?.().catch(() => {});
    await box.cleanup();
  }
});

test('privacy hardening rejects hardlinks without changing the external inode', { skip: process.platform === 'win32' }, async () => {
  const box = await sandbox('harden-hardlink-boundary');
  const outside = path.join(box.base, 'outside.txt');
  const target = path.join(box.base, 'target');
  try {
    await fsp.writeFile(outside, 'outside content', { mode: 0o644 });
    await fsp.chmod(outside, 0o644);
    await fsp.mkdir(target);
    await fsp.link(outside, path.join(target, 'linked.txt'));
    await assert.rejects(hardenTree(target), { code: 'HARDLINK_REJECTED' });
    assert.equal(await fsp.readFile(outside, 'utf8'), 'outside content');
    assert.equal((await fsp.stat(outside)).mode & 0o777, 0o644);
  } finally {
    await box.cleanup();
  }
});

test('activation reports a private retained rollback when cleanup fails', async () => {
  const box = await sandbox('activate-retained-rollback');
  const target = path.join(box.base, 'target');
  const stage = path.join(box.base, 'stage');
  try {
    await fsp.mkdir(target);
    await fsp.mkdir(stage);
    await fsp.writeFile(path.join(target, 'value'), 'old');
    await fsp.writeFile(path.join(stage, 'value'), 'new');
    const expectedTargetSnapshot = await snapshotWorkspaceTree(target);
    process.env.SCALVIN_TEST_RETAIN_ACTIVATION_ROLLBACK = '1';
    const result = await activateDirectory(target, stage, { expectedTargetSnapshot });
    assert.ok(result.retainedRollbackPath);
    assert.equal(await fsp.readFile(path.join(target, 'value'), 'utf8'), 'new');
    assert.equal(await fsp.readFile(path.join(result.retainedRollbackPath, 'workspace', 'value'), 'utf8'), 'old');
    if (process.platform !== 'win32') assert.equal((await fsp.stat(result.retainedRollbackPath)).mode & 0o777, 0o700);
  } finally {
    delete process.env.SCALVIN_TEST_RETAIN_ACTIVATION_ROLLBACK;
    await box.cleanup();
  }
});

test('activation retains and reports a rollback changed immediately before cleanup', async () => {
  const box = await sandbox('activate-late-rollback-write');
  const target = path.join(box.base, 'target');
  const stage = path.join(box.base, 'stage');
  try {
    await fsp.mkdir(target);
    await fsp.mkdir(stage);
    await fsp.writeFile(path.join(target, 'value'), 'old');
    await fsp.writeFile(path.join(stage, 'value'), 'new');
    const expectedTargetSnapshot = await snapshotWorkspaceTree(target);
    process.env.SCALVIN_TEST_ACTIVATE_LATE_ROLLBACK_WRITE = '1';
    const result = await activateDirectory(target, stage, { expectedTargetSnapshot });
    assert.ok(result.retainedRollbackPath);
    assert.equal(await fsp.readFile(path.join(target, 'value'), 'utf8'), 'new');
    assert.equal(await fsp.readFile(path.join(result.retainedRollbackPath, 'workspace', 'value'), 'utf8'), 'old');
    assert.equal(
      await fsp.readFile(path.join(result.retainedRollbackPath, 'workspace', '.injected-late-write'), 'utf8'),
      'concurrent rollback write\n'
    );
  } finally {
    delete process.env.SCALVIN_TEST_ACTIVATE_LATE_ROLLBACK_WRITE;
    await box.cleanup();
  }
});
