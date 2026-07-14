'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ScalvinError, invariant } = require('./errors');

const execFileAsync = promisify(execFile);

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DARWIN_SYSTEM_DIRECTORY_ALIASES = new Map([
  ['/etc', '/private/etc'],
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var']
]);

function portablePathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function resolvePortablePath(value, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = portablePathApi(platform);
  const home = options.home || os.homedir();
  const cwd = options.cwd || process.cwd();
  invariant(typeof value === 'string' && value.trim(), 'A path is required.', 'INVALID_PATH');
  invariant(!/[\0\r\n]/.test(value), 'Paths cannot contain NUL or newline characters.', 'INVALID_PATH');
  let expanded = value.trim();
  if (expanded === '~') expanded = home;
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = pathApi.join(home, expanded.slice(2));
  } else if (expanded.startsWith('~')) {
    throw new ScalvinError('Only the current user home shorthand (~) is supported.', 'INVALID_PATH');
  }
  return pathApi.resolve(cwd, expanded);
}

function isInside(root, candidate, pathApi = path) {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}

function assertInside(root, candidate, label = 'Target') {
  invariant(isInside(root, candidate), `${label} escapes the allowed root.`, 'PATH_TRAVERSAL', { root, candidate });
}

function validateRelativePath(relative) {
  invariant(typeof relative === 'string' && relative.length > 0, 'Manifest path must be non-empty.', 'INVALID_MANIFEST_PATH');
  invariant(!/[\0\r\n]/.test(relative), 'Manifest path contains invalid characters.', 'INVALID_MANIFEST_PATH', { path: relative });
  invariant(!path.isAbsolute(relative) && !path.win32.isAbsolute(relative), 'Manifest paths must be relative.', 'INVALID_MANIFEST_PATH', { path: relative });
  invariant(!relative.includes('\\'), 'Manifest paths must use canonical forward slashes.', 'INVALID_MANIFEST_PATH', { path: relative });
  const components = relative.split('/');
  invariant(!components.includes('..'), 'Manifest path traversal is not allowed.', 'PATH_TRAVERSAL', { path: relative });
  invariant(components.every((component) => component.length > 0 && component !== '.'), 'Manifest path spelling is not canonical.', 'INVALID_MANIFEST_PATH', { path: relative });
  const reserved = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i;
  for (const component of components) {
    invariant(!component.includes(':') && !/[. ]$/.test(component) && !reserved.test(component), 'Manifest path is not portable across supported filesystems.', 'INVALID_MANIFEST_PATH', { path: relative });
  }
  invariant(relative.normalize('NFC') === relative, 'Manifest path must use canonical Unicode spelling.', 'INVALID_MANIFEST_PATH', { path: relative });
  return relative;
}

async function rejectSymlinkPath(target, options = {}) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stat;
    try {
      stat = await fsp.lstat(cursor);
    } catch (error) {
      if (error.code === 'ENOENT' && options.allowMissing) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (process.platform === 'darwin' && stat.uid === 0 && DARWIN_SYSTEM_DIRECTORY_ALIASES.has(cursor)) {
        const expected = DARWIN_SYSTEM_DIRECTORY_ALIASES.get(cursor);
        const link = await fsp.readlink(cursor);
        const resolved = path.resolve(path.dirname(cursor), link);
        const destination = await fsp.lstat(expected).catch(() => null);
        if (resolved === expected && destination?.isDirectory() && !destination.isSymbolicLink() && destination.uid === 0) continue;
      }
      throw new ScalvinError('Symbolic links are not allowed in managed paths.', 'SYMLINK_REJECTED', { path: cursor });
    }
  }
}

async function ensurePrivateDir(directory) {
  const absolute = path.resolve(directory);
  await rejectSymlinkPath(absolute, { allowMissing: true });
  let created = false;
  try {
    await fsp.mkdir(absolute, { mode: PRIVATE_DIR_MODE });
    created = true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      const parent = path.dirname(absolute);
      invariant(parent !== absolute, 'Cannot create a private directory hierarchy.', 'INVALID_PATH');
      await ensurePrivateDir(parent);
      try {
        await fsp.mkdir(absolute, { mode: PRIVATE_DIR_MODE });
        created = true;
      } catch (retry) {
        if (retry.code !== 'EEXIST') throw retry;
      }
    } else if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  const stat = await fsp.lstat(absolute);
  invariant(!stat.isSymbolicLink() && stat.isDirectory(), 'Expected a real directory.', 'INVALID_DIRECTORY', { path: absolute });
  if (created && process.platform !== 'win32') await fsp.chmod(absolute, PRIVATE_DIR_MODE);
  return { path: absolute, created };
}

async function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await fsp.open(directory, fs.constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function atomicWriteFile(filename, data, options = {}) {
  const absolute = path.resolve(filename);
  const directory = path.dirname(absolute);
  await rejectSymlinkPath(directory, { allowMissing: true });
  await ensurePrivateDir(directory);
  const temp = path.join(directory, `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', options.mode ?? PRIVATE_FILE_MODE);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== 'win32') await fsp.chmod(temp, options.mode ?? PRIVATE_FILE_MODE);
    await fsp.rename(temp, absolute);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function sha256Buffer(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function sha256File(filename) {
  await rejectSymlinkPath(filename);
  const before = await fsp.lstat(filename);
  invariant(before.isFile(), 'Only regular files can be hashed.', 'UNSUPPORTED_FILE_TYPE', { path: filename });
  const hash = crypto.createHash('sha256');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(filename, flags);
  try {
    const opened = await handle.stat();
    invariant(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino, 'File changed while it was being opened.', 'FILE_CHANGED_DURING_READ');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    invariant(after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs && position === after.size, 'File changed while it was being hashed.', 'FILE_CHANGED_DURING_READ');
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function readBoundedRegularFile(filename, maximumBytes, options = {}) {
  invariant(Number.isSafeInteger(maximumBytes) && maximumBytes >= 0, 'File byte limit is invalid.', 'INVALID_FILE_LIMIT');
  await rejectSymlinkPath(filename);
  const before = await fsp.lstat(filename);
  invariant(before.isFile(), options.typeMessage || 'Expected a regular file.', options.typeCode || 'UNSUPPORTED_FILE_TYPE');
  invariant(before.size <= maximumBytes, options.sizeMessage || 'File exceeds the configured size limit.', options.sizeCode || 'FILE_TOO_LARGE');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(filename, flags);
  try {
    const opened = await handle.stat();
    invariant(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino, 'File changed while it was being opened.', options.changedCode || 'FILE_CHANGED_DURING_READ');
    const chunks = [];
    let total = 0;
    while (total <= maximumBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new ScalvinError(options.sizeMessage || 'File exceeds the configured size limit.', options.sizeCode || 'FILE_TOO_LARGE');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    invariant(after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs && total === after.size, 'File changed while it was being read.', options.changedCode || 'FILE_CHANGED_DURING_READ');
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function pathExists(filename) {
  try {
    await fsp.lstat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function isNonEmptyDirectory(directory) {
  try {
    const stat = await fsp.lstat(directory);
    if (stat.isSymbolicLink()) throw new ScalvinError('Workspace cannot be a symbolic link.', 'SYMLINK_REJECTED', { path: directory });
    if (!stat.isDirectory()) return true;
    const entries = await fsp.readdir(directory);
    return entries.length > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function walkTree(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const output = [];
  async function visit(directory, relativeDirectory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      validateRelativePath(relative);
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new ScalvinError('Symbolic links are not permitted in Scalvin workspaces or backups.', 'SYMLINK_REJECTED', { path: absolute });
      }
      if (stat.isDirectory()) {
        output.push({ path: relative, type: 'directory', mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino });
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        invariant(stat.nlink === 1, 'Hard-linked files are not permitted in managed workspaces, stages, or backups.', 'HARDLINK_REJECTED');
        if (!options.filter || options.filter(relative)) {
          output.push({ path: relative, type: 'file', mode: stat.mode & 0o777, size: stat.size, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
        }
      } else {
        throw new ScalvinError('Only regular files and directories are supported.', 'UNSUPPORTED_FILE_TYPE', { path: absolute });
      }
    }
  }
  await visit(absoluteRoot, '');
  return output;
}

async function copyTree(source, destination, options = {}) {
  const sourceRoot = path.resolve(source);
  const destinationRoot = path.resolve(destination);
  const entries = await walkTree(sourceRoot, { filter: options.filter });
  await ensurePrivateDir(destinationRoot);
  for (const entry of entries) {
    const from = path.join(sourceRoot, entry.path);
    const to = path.join(destinationRoot, entry.path);
    assertInside(destinationRoot, to);
    if (entry.type === 'directory') {
      await ensurePrivateDir(to);
      continue;
    }
    await ensurePrivateDir(path.dirname(to));
    await rejectSymlinkPath(from);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const sourceHandle = await fsp.open(from, flags);
    let destinationHandle;
    try {
      const opened = await sourceHandle.stat();
      invariant(opened.isFile() && opened.dev === entry.dev && opened.ino === entry.ino, 'Source changed while it was being opened for copy.', 'FILE_CHANGED_DURING_COPY', { path: entry.path });
      destinationHandle = await fsp.open(to, 'wx', PRIVATE_FILE_MODE);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      const after = await sourceHandle.stat();
      invariant(after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs && position === after.size, 'Source changed while it was being copied.', 'FILE_CHANGED_DURING_COPY', { path: entry.path });
      await destinationHandle.sync();
    } finally {
      await destinationHandle?.close().catch(() => {});
      await sourceHandle.close().catch(() => {});
    }
    if (process.platform !== 'win32') await fsp.chmod(to, options.preserveModes ? entry.mode : PRIVATE_FILE_MODE);
  }
  if (options.expectedSourceSnapshot) {
    invariant(!options.filter, 'Snapshot-bound tree copies cannot use a partial filter.', 'WORKSPACE_SNAPSHOT_INVALID');
    await assertWorkspaceContentSnapshot(destinationRoot, options.expectedSourceSnapshot);
  }
  return entries;
}

async function hardenTree(root) {
  const entries = await walkTree(root);
  if (process.platform === 'win32') {
    await applyWindowsPrivateAcl(root);
    return;
  }
  // Validate the entire tree (including hard-link rejection) before any chmod
  // or ACL mutation can affect an inode outside the managed root.
  if (process.platform === 'darwin') await stripDarwinAcl(root, { recursive: true });
  await fsp.chmod(root, PRIVATE_DIR_MODE);
  for (const entry of entries) {
    const absolute = path.join(root, entry.path);
    await fsp.chmod(absolute, entry.type === 'directory' ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE);
  }
}

async function applyWindowsPrivateAcl(root) {
  if (process.platform !== 'win32') return;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$rootInput = $env:SCALVIN_ACL_ROOT
if ([String]::IsNullOrWhiteSpace($rootInput)) { throw 'missing ACL root' }
$root = [IO.Path]::GetFullPath($rootInput)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$items = @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Force -Recurse)
foreach ($item in $items) {
  if ($item.PSIsContainer) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($user, $system, $admins)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  $acl.SetOwner($user)
  if ($item.PSIsContainer) {
    [IO.Directory]::SetAccessControl($item.FullName, $acl)
  } else {
    [IO.File]::SetAccessControl($item.FullName, $acl)
  }
}
`;
  try {
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, SCALVIN_ACL_ROOT: path.resolve(root) }
    });
  } catch (error) {
    throw new ScalvinError('Failed to enforce a private Windows ACL; no workspace will be activated.', 'WINDOWS_ACL_ENFORCEMENT_FAILED', { cause: error.stderr?.trim() || error.message });
  }
}

async function verifyWindowsPrivateAcl(root) {
  if (process.platform !== 'win32') return { ok: true };
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$rootInput = $env:SCALVIN_ACL_ROOT
if ([String]::IsNullOrWhiteSpace($rootInput)) { throw 'missing ACL root' }
$root = [IO.Path]::GetFullPath($rootInput)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$system = 'S-1-5-18'
$admins = 'S-1-5-32-544'
$allowed = @($user, $system, $admins)
$allowedDescendantOwners = @($user, $admins)
$rootItem = Get-Item -LiteralPath $root -Force
$items = @($rootItem)
if ($rootItem.PSIsContainer) {
  $items += @(Get-ChildItem -LiteralPath $root -Force -Recurse)
}
foreach ($item in $items) {
  if ($item.PSIsContainer) {
    $acl = [IO.Directory]::GetAccessControl($item.FullName)
  } else {
    $acl = [IO.File]::GetAccessControl($item.FullName)
  }
  $isRoot = [StringComparer]::OrdinalIgnoreCase.Equals($item.FullName, $rootItem.FullName)
  if ($isRoot -and -not $acl.AreAccessRulesProtected) { throw "root inheritance enabled: $($item.FullName)" }
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($isRoot -and $owner -ne $user) { throw "unexpected root owner SID: $($item.FullName)" }
  if (-not $isRoot -and $allowedDescendantOwners -notcontains $owner) { throw "unexpected descendant owner SID: $($item.FullName)" }
  $userFull = $false
  $userObjectInherit = $false
  $userContainerInherit = $false
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw "deny rules are not allowed: $($item.FullName)" }
    if ($allowed -notcontains $sid) { throw "unexpected allow SID $($sid): $($item.FullName)" }
    $inheritOnly = (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
    $fullControl = (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)
    if ($sid -eq $user -and $fullControl) {
      if (-not $inheritOnly) { $userFull = $true }
      if ($item.PSIsContainer -and (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit) -eq 0)) {
        if (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0) { $userObjectInherit = $true }
        if (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0) { $userContainerInherit = $true }
      }
    }
  }
  if (-not $userFull) { throw "current user lacks FullControl: $($item.FullName)" }
  if ($item.PSIsContainer -and (-not $userObjectInherit -or -not $userContainerInherit)) { throw "current user FullControl does not propagate to future children: $($item.FullName)" }
}
`;
  try {
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, SCALVIN_ACL_ROOT: path.resolve(root) }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.stderr?.trim() || error.message };
  }
}

async function verifyDarwinNoAcl(root, options = {}) {
  if (process.platform !== 'darwin') return { ok: true };
  try {
    const { stdout } = await execFileAsync('/bin/ls', [options.recursive ? '-leR' : '-lde', path.resolve(root)], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024
    });
    const hasAcl = /^\s*\d+:\s/m.test(stdout);
    return hasAcl ? { ok: false } : { ok: true };
  } catch {
    return { ok: false };
  }
}

async function stripDarwinAcl(root, options = {}) {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('/bin/chmod', [options.recursive ? '-RN' : '-N', path.resolve(root)], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024
    });
  } catch {
    throw new ScalvinError('Failed to remove a macOS access-control list from private data.', 'DARWIN_ACL_ENFORCEMENT_FAILED');
  }
  const verified = await verifyDarwinNoAcl(root, options);
  invariant(verified.ok, 'A macOS access-control list remains on private data.', 'DARWIN_ACL_ENFORCEMENT_FAILED');
}

async function preparePrivateDirectory(directory) {
  const absolute = path.resolve(directory);
  await rejectSymlinkPath(absolute);
  const stat = await fsp.lstat(absolute);
  invariant(stat.isDirectory(), 'Expected a real private directory.', 'INVALID_DIRECTORY');
  if (process.platform === 'win32') {
    await walkTree(absolute);
    await applyWindowsPrivateAcl(absolute);
  }
  else {
    if (process.platform === 'darwin') await stripDarwinAcl(absolute);
    await fsp.chmod(absolute, PRIVATE_DIR_MODE);
  }
  return absolute;
}

async function assertPrivateRegularFilePermissions(filename, stat = null, options = {}) {
  const absolute = path.resolve(filename);
  await rejectSymlinkPath(absolute);
  const current = stat || await fsp.lstat(absolute);
  invariant(current.isFile(), options.message || 'Private input must be a regular file.', options.code || 'PRIVATE_FILE_PERMISSIONS');
  if (process.platform === 'win32') {
    const acl = await verifyWindowsPrivateAcl(absolute);
    invariant(acl.ok, options.message || 'Private input ACL could not be verified.', options.code || 'PRIVATE_FILE_PERMISSIONS');
  } else {
    invariant((current.mode & 0o777) === PRIVATE_FILE_MODE, options.message || 'Private input permissions must be exactly 0600.', options.code || 'PRIVATE_FILE_PERMISSIONS');
    if (process.platform === 'darwin') {
      const acl = await verifyDarwinNoAcl(absolute);
      invariant(acl.ok, options.message || 'Private input has a macOS access-control list.', options.code || 'PRIVATE_FILE_PERMISSIONS');
    }
  }
  return current;
}

async function createPrivateExclusiveFile(filename) {
  const absolute = path.resolve(filename);
  const directory = path.dirname(absolute);
  await rejectSymlinkPath(directory);
  const parent = await fsp.lstat(directory);
  invariant(parent.isDirectory(), 'Private file parent must be a real directory.', 'PRIVATE_FILE_CREATION_FAILED');
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  let identity;
  try {
    handle = await fsp.open(absolute, flags, PRIVATE_FILE_MODE);
    identity = await handle.stat();
    invariant(identity.isFile() && identity.nlink === 1, 'Private output must be a new single-link regular file.', 'PRIVATE_FILE_CREATION_FAILED');
    if (process.platform === 'win32') await applyWindowsPrivateAcl(absolute);
    else {
      if (process.platform === 'darwin') await stripDarwinAcl(absolute);
      await handle.chmod(PRIVATE_FILE_MODE);
    }
    const opened = await handle.stat();
    const named = await fsp.lstat(absolute);
    invariant(
      opened.isFile() && opened.nlink === 1 && named.isFile() && !named.isSymbolicLink() &&
        opened.dev === identity.dev && opened.ino === identity.ino &&
        named.dev === identity.dev && named.ino === identity.ino,
      'Private output changed while its access controls were prepared.',
      'PRIVATE_FILE_CREATION_FAILED'
    );
    await assertPrivateRegularFilePermissions(absolute, opened, {
      code: 'PRIVATE_FILE_CREATION_FAILED',
      message: 'Private output permissions or access-control list could not be verified.'
    });
    const verified = await handle.stat();
    invariant(
      verified.nlink === 1 && verified.dev === identity.dev && verified.ino === identity.ino,
      'Private output changed while its access controls were verified.',
      'PRIVATE_FILE_CREATION_FAILED'
    );
    return handle;
  } catch (error) {
    let opened;
    try {
      opened = await handle?.stat();
    } catch {}
    await handle?.close().catch(() => {});
    if (opened && identity && opened.dev === identity.dev && opened.ino === identity.ino) {
      try {
        const named = await fsp.lstat(absolute);
        if (!named.isSymbolicLink() && named.dev === identity.dev && named.ino === identity.ino) {
          await fsp.rm(absolute, { force: true });
        }
      } catch {}
    }
    throw error;
  }
}

function mutationTargetDigest(target) {
  invariant(typeof target === 'string' && target.length > 0 && !/[\0\r\n]/.test(target), 'Mutation target path is invalid.', 'INVALID_PATH');
  let spelling = path.resolve(target).normalize('NFC');
  if (process.platform === 'win32') spelling = spelling.toLowerCase();
  return sha256Buffer(Buffer.from(spelling, 'utf8'));
}

const MUTATION_LOCK_MANUAL_RECOVERY = 'Manual recovery only: inspect the lock, confirm no Scalvin mutation is running, then remove this exact lock path manually; never delete it based only on age or PID liveness.';

async function mutationLockLocation(target) {
  invariant(typeof target === 'string' && target.length > 0 && !/[\0\r\n]/.test(target), 'Mutation target path is invalid.', 'INVALID_PATH');
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  invariant(absolute !== parsed.root && path.basename(absolute), 'Mutation target must not be a filesystem root.', 'INVALID_PATH');
  let canonicalTarget;
  try {
    canonicalTarget = await fsp.realpath(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const canonicalParent = await fsp.realpath(path.dirname(absolute));
    canonicalTarget = path.join(canonicalParent, path.basename(absolute));
  }
  const lockRoot = path.dirname(canonicalTarget);
  const targetName = path.basename(canonicalTarget).normalize('NFC');
  const lockPath = path.join(lockRoot, `.${targetName}.scalvin-mutation.lock`);
  return { lockRoot, lockPath, targetSha256: mutationTargetDigest(canonicalTarget) };
}

async function mutationLockPath(target) {
  return (await mutationLockLocation(target)).lockPath;
}

function parseMutationLockMetadata(bytes, expectedTargetSha256) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ScalvinError('Mutation lock metadata is invalid.', 'MUTATION_LOCK_METADATA_INVALID');
  }
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  const expectedKeys = ['acquiredAt', 'ownerPid', 'ownerToken', 'schemaVersion', 'targetSha256'];
  invariant(
    keys.length === expectedKeys.length && [...keys].sort().every((key, index) => key === expectedKeys[index]),
    'Mutation lock metadata is invalid.',
    'MUTATION_LOCK_METADATA_INVALID'
  );
  invariant(
    value.schemaVersion === 1 && value.targetSha256 === expectedTargetSha256 &&
      typeof value.ownerToken === 'string' && /^[a-f0-9]{64}$/.test(value.ownerToken) &&
      Number.isSafeInteger(value.ownerPid) && value.ownerPid > 0 &&
      typeof value.acquiredAt === 'string' && !Number.isNaN(Date.parse(value.acquiredAt)) &&
      new Date(value.acquiredAt).toISOString() === value.acquiredAt,
    'Mutation lock metadata is invalid.',
    'MUTATION_LOCK_METADATA_INVALID'
  );
  const canonical = Buffer.from(`${JSON.stringify({
    schemaVersion: value.schemaVersion,
    targetSha256: value.targetSha256,
    ownerToken: value.ownerToken,
    ownerPid: value.ownerPid,
    acquiredAt: value.acquiredAt
  })}\n`, 'utf8');
  invariant(
    canonical.length === bytes.length && crypto.timingSafeEqual(canonical, bytes),
    'Mutation lock metadata is not canonical.',
    'MUTATION_LOCK_METADATA_INVALID'
  );
  return { ownerPid: value.ownerPid, acquiredAt: value.acquiredAt };
}

async function inspectMutationLock(target) {
  const location = await mutationLockLocation(target);
  let root;
  try {
    root = await fsp.lstat(location.lockRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent', lockPath: location.lockPath };
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    return { status: 'unverifiable', lockPath: location.lockPath, lockKind: 'invalid-parent' };
  }
  try {
    const lock = await fsp.lstat(location.lockPath);
    const lockKind = lock.isSymbolicLink() ? 'symlink' : lock.isFile() ? 'regular-file' : 'non-file';
    if (lockKind !== 'regular-file') return { status: 'present', lockPath: location.lockPath, lockKind };
    try {
      await assertPrivateRegularFilePermissions(location.lockPath, lock, {
        code: 'MUTATION_LOCK_METADATA_INVALID',
        message: 'Mutation lock access controls are not private.'
      });
      const bytes = await readBoundedRegularFile(location.lockPath, 4096, {
        typeCode: 'MUTATION_LOCK_METADATA_INVALID',
        sizeCode: 'MUTATION_LOCK_METADATA_INVALID',
        changedCode: 'MUTATION_LOCK_METADATA_INVALID'
      });
      const safeMetadata = parseMutationLockMetadata(bytes, location.targetSha256);
      return { status: 'present', lockPath: location.lockPath, lockKind, ...safeMetadata };
    } catch {
      return { status: 'present', lockPath: location.lockPath, lockKind: 'regular-file-unverifiable' };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent', lockPath: location.lockPath };
    throw error;
  }
}

async function removeNamedFileIfSame(filename, identity) {
  try {
    const named = await fsp.lstat(filename);
    if (!named.isSymbolicLink() && named.isFile() && named.dev === identity.dev && named.ino === identity.ino) {
      await fsp.rm(filename, { force: true });
    }
  } catch {}
}

async function acquireMutationLock(target) {
  let location;
  try {
    location = await mutationLockLocation(target);
  } catch {
    throw new ScalvinError('A stable mutation-lock location could not be resolved.', 'MUTATION_LOCK_FAILED');
  }
  const { lockRoot, lockPath, targetSha256 } = location;
  const ownerToken = crypto.randomBytes(32).toString('hex');
  const metadata = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    targetSha256,
    ownerToken,
    ownerPid: process.pid,
    acquiredAt: new Date().toISOString()
  })}\n`, 'utf8');
  let handle;
  let identity;
  try {
    handle = await createPrivateExclusiveFile(lockPath);
    identity = await handle.stat();
    await handle.writeFile(metadata);
    await handle.sync();
    const after = await handle.stat();
    invariant(
      after.isFile() && after.nlink === 1 && after.dev === identity.dev && after.ino === identity.ino,
      'Mutation lock changed while it was acquired.',
      'MUTATION_LOCK_FAILED'
    );
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (identity) await removeNamedFileIfSame(lockPath, identity);
    if (error?.code === 'EEXIST') {
      throw new ScalvinError(
        `A mutation lock already exists at ${lockPath}. ${MUTATION_LOCK_MANUAL_RECOVERY}`,
        'MUTATION_LOCKED',
        { lockPath, recovery: 'manual-only', guidance: MUTATION_LOCK_MANUAL_RECOVERY }
      );
    }
    throw new ScalvinError('A private mutation lock could not be acquired.', 'MUTATION_LOCK_FAILED');
  }

  let released = false;
  let releasePromise = null;
  return async function releaseMutationLock() {
    if (released) return;
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      try {
        const before = await fsp.lstat(lockPath);
        invariant(
          !before.isSymbolicLink() && before.isFile() && before.nlink === 1 &&
            before.dev === identity.dev && before.ino === identity.ino,
          'Mutation lock ownership changed before release.',
          'MUTATION_LOCK_LOST'
        );
        await assertPrivateRegularFilePermissions(lockPath, before, {
          code: 'MUTATION_LOCK_LOST',
          message: 'Mutation lock access controls changed before release.'
        });
        const actual = await readBoundedRegularFile(lockPath, 4096, {
          typeCode: 'MUTATION_LOCK_LOST',
          sizeCode: 'MUTATION_LOCK_LOST',
          changedCode: 'MUTATION_LOCK_LOST'
        });
        invariant(
          actual.length === metadata.length && crypto.timingSafeEqual(actual, metadata),
          'Mutation lock ownership metadata changed before release.',
          'MUTATION_LOCK_LOST'
        );
        const after = await fsp.lstat(lockPath);
        invariant(
          !after.isSymbolicLink() && after.isFile() && after.nlink === 1 &&
            after.dev === identity.dev && after.ino === identity.ino,
          'Mutation lock ownership changed before release.',
          'MUTATION_LOCK_LOST'
        );
        await fsp.unlink(lockPath);
        released = true;
        await fsyncDirectory(lockRoot);
      } catch (error) {
        if (error?.code === 'MUTATION_LOCK_LOST') throw error;
        throw new ScalvinError('The mutation lock could not be released safely.', 'MUTATION_LOCK_RELEASE_FAILED');
      }
    })();
    try {
      return await releasePromise;
    } finally {
      if (!released) releasePromise = null;
    }
  };
}

async function createPrivateStage(directory) {
  const absolute = path.resolve(directory);
  let created = false;
  try {
    const result = await ensurePrivateDir(absolute);
    created = result.created;
    invariant(created, 'Private stage destination already exists.', 'PRIVATE_STAGE_EXISTS', { path: absolute });
    await preparePrivateDirectory(absolute);
    return absolute;
  } catch (error) {
    if (created) await fsp.rm(absolute, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function snapshotWorkspaceTree(root) {
  const absolute = path.resolve(root);
  await rejectSymlinkPath(absolute, { allowMissing: true });
  let rootStat;
  try {
    rootStat = await fsp.lstat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, state: 'missing', entries: [] };
    throw error;
  }
  invariant(rootStat.isDirectory(), 'Workspace snapshot target must be a real directory.', 'WORKSPACE_SNAPSHOT_INVALID');
  const entries = [];
  for (const entry of await walkTree(absolute)) {
    if (entry.type === 'directory') {
      entries.push({ path: entry.path, type: 'directory', mode: entry.mode });
    } else {
      entries.push({
        path: entry.path,
        type: 'file',
        mode: entry.mode,
        size: entry.size,
        sha256: await sha256File(path.join(absolute, entry.path))
      });
    }
  }
  return { schemaVersion: 1, state: 'directory', mode: rootStat.mode & 0o777, entries };
}

function workspaceSnapshotDigest(snapshot) {
  invariant(snapshot && snapshot.schemaVersion === 1 && ['missing', 'directory'].includes(snapshot.state) && Array.isArray(snapshot.entries), 'Activation requires a valid pre-stage workspace snapshot.', 'ACTIVATION_SNAPSHOT_REQUIRED');
  return crypto.createHash('sha256').update(`${JSON.stringify(snapshot)}\n`).digest();
}

async function assertWorkspaceSnapshot(root, expected) {
  const expectedDigest = workspaceSnapshotDigest(expected);
  let actual;
  try {
    actual = await snapshotWorkspaceTree(root);
  } catch {
    throw new ScalvinError('The workspace changed while the replacement was being prepared; the original workspace was preserved.', 'STALE_WORKSPACE');
  }
  const actualDigest = workspaceSnapshotDigest(actual);
  invariant(crypto.timingSafeEqual(actualDigest, expectedDigest), 'The workspace changed while the replacement was being prepared; the original workspace was preserved.', 'STALE_WORKSPACE');
}

function workspaceContentSnapshotDigest(snapshot) {
  workspaceSnapshotDigest(snapshot);
  const content = {
    schemaVersion: snapshot.schemaVersion,
    state: snapshot.state,
    entries: snapshot.entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      ...(entry.type === 'file' ? { size: entry.size, sha256: entry.sha256 } : {})
    }))
  };
  return crypto.createHash('sha256').update(`${JSON.stringify(content)}\n`).digest();
}

async function assertWorkspaceContentSnapshot(root, expected) {
  const expectedDigest = workspaceContentSnapshotDigest(expected);
  let actual;
  try {
    actual = await snapshotWorkspaceTree(root);
  } catch {
    throw new ScalvinError('The workspace changed while its private stage was copied; the original workspace was preserved.', 'STALE_WORKSPACE');
  }
  const actualDigest = workspaceContentSnapshotDigest(actual);
  invariant(
    crypto.timingSafeEqual(actualDigest, expectedDigest),
    'The workspace changed while its private stage was copied; the original workspace was preserved.',
    'STALE_WORKSPACE'
  );
}

async function makeSiblingTemp(target, label) {
  const parent = path.dirname(path.resolve(target));
  await rejectSymlinkPath(parent);
  const parentStat = await fsp.lstat(parent);
  invariant(parentStat.isDirectory(), 'Workspace parent must be an existing real directory.', 'TARGET_PARENT_INVALID', { parent });
  await fsp.access(parent, fs.constants.W_OK);
  const temp = path.join(parent, `.${path.basename(target)}.${label}.${process.pid}.${crypto.randomUUID()}`);
  return createPrivateStage(temp);
}

async function activateDirectory(target, stage, options = {}) {
  const absoluteTarget = path.resolve(target);
  const absoluteStage = path.resolve(stage);
  const expectedTargetSnapshot = options.expectedTargetSnapshot;
  workspaceSnapshotDigest(expectedTargetSnapshot);
  const rollbackContainer = `${absoluteTarget}.rollback.${process.pid}.${crypto.randomUUID()}`;
  const rollback = path.join(rollbackContainer, 'workspace');
  const failedNew = `${absoluteTarget}.failed-new.${process.pid}.${crypto.randomUUID()}`;
  const hadTarget = await pathExists(absoluteTarget);
  let oldMoved = false;
  let newActivated = false;
  let rollbackContainerCreated = false;
  try {
    if ((expectedTargetSnapshot.state === 'missing') !== !hadTarget) {
      throw new ScalvinError('The workspace changed while the replacement was being prepared; the original workspace was preserved.', 'STALE_WORKSPACE');
    }
    if (hadTarget) {
      await createPrivateStage(rollbackContainer);
      rollbackContainerCreated = true;
      await fsp.rename(absoluteTarget, rollback);
      oldMoved = true;
      await assertWorkspaceSnapshot(rollback, expectedTargetSnapshot);
    }
    if (process.env.SCALVIN_TEST_ACTIVATE_FAILPOINT === 'after-old-move') throw new Error('Injected activation failure after old move.');
    await fsp.rename(absoluteStage, absoluteTarget);
    newActivated = true;
    if (process.env.SCALVIN_TEST_ACTIVATE_FAILPOINT === 'after-new-activate') throw new Error('Injected activation failure after new activation.');
    await fsyncDirectory(path.dirname(absoluteTarget));
    if (process.env.SCALVIN_TEST_ACTIVATE_FAILPOINT === 'after-fsync') throw new Error('Injected activation failure after fsync.');
    let retainedRollbackPath = null;
    if (hadTarget) {
      if (process.env.SCALVIN_TEST_ACTIVATE_LATE_ROLLBACK_WRITE === '1') {
        await fsp.writeFile(path.join(rollback, '.injected-late-write'), 'concurrent rollback write\n', { flag: 'wx' });
      }
      try {
        await assertWorkspaceSnapshot(rollback, expectedTargetSnapshot);
      } catch {
        retainedRollbackPath = rollbackContainer;
      }
      if (!retainedRollbackPath) {
        try {
          if (process.env.SCALVIN_TEST_RETAIN_ACTIVATION_ROLLBACK === '1') {
            const injected = new Error('Injected retained rollback cleanup failure.');
            injected.code = 'EACCES';
            throw injected;
          }
          await fsp.rm(rollbackContainer, { recursive: true, force: true });
          rollbackContainerCreated = false;
        } catch {
          retainedRollbackPath = rollbackContainer;
        }
      }
    }
    return { retainedRollbackPath };
  } catch (error) {
    let recoveryError = null;
    try {
      if (newActivated && await pathExists(absoluteTarget)) {
        await fsp.rename(absoluteTarget, failedNew);
        newActivated = false;
      }
      if (oldMoved && await pathExists(rollback)) {
        await fsp.rename(rollback, absoluteTarget);
        oldMoved = false;
      }
      if (rollbackContainerCreated && await pathExists(rollbackContainer)) {
        await fsp.rm(rollbackContainer, { recursive: true, force: true });
        rollbackContainerCreated = false;
      }
      if (await pathExists(failedNew)) await fsp.rm(failedNew, { recursive: true, force: true });
      if (error.code === 'STALE_WORKSPACE' && await pathExists(absoluteStage)) {
        await fsp.rm(absoluteStage, { recursive: true, force: true });
      }
      await fsyncDirectory(path.dirname(absoluteTarget));
    } catch (recovery) {
      recoveryError = recovery.message;
    }
    if (error.code === 'STALE_WORKSPACE' && !recoveryError) {
      throw new ScalvinError('The workspace changed while the replacement was being prepared; the original workspace was preserved.', 'STALE_WORKSPACE');
    }
    throw new ScalvinError(
      recoveryError
        ? 'Atomic workspace activation failed and automatic rollback was incomplete.'
        : 'Atomic workspace activation failed; the previous workspace was restored.',
      'ACTIVATION_FAILED',
      { cause: error.message, recoveryError, rollbackPath: oldMoved ? rollback : null, failedNewPath: newActivated ? absoluteTarget : null }
    );
  }
}

module.exports = {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  resolvePortablePath,
  isInside,
  assertInside,
  validateRelativePath,
  rejectSymlinkPath,
  ensurePrivateDir,
  atomicWriteFile,
  sha256Buffer,
  sha256File,
  readBoundedRegularFile,
  pathExists,
  isNonEmptyDirectory,
  walkTree,
  copyTree,
  hardenTree,
  applyWindowsPrivateAcl,
  verifyWindowsPrivateAcl,
  verifyDarwinNoAcl,
  stripDarwinAcl,
  preparePrivateDirectory,
  assertPrivateRegularFilePermissions,
  createPrivateExclusiveFile,
  MUTATION_LOCK_MANUAL_RECOVERY,
  mutationLockPath,
  inspectMutationLock,
  acquireMutationLock,
  createPrivateStage,
  snapshotWorkspaceTree,
  assertWorkspaceSnapshot,
  assertWorkspaceContentSnapshot,
  makeSiblingTemp,
  activateDirectory,
  fsyncDirectory
};
