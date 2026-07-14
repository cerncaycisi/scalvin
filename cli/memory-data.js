'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScalvinError, invariant } = require('./lib/errors');
const {
  PRIVATE_FILE_MODE,
  resolvePortablePath,
  isInside,
  assertInside,
  validateRelativePath,
  rejectSymlinkPath,
  ensurePrivateDir,
  atomicWriteFile,
  pathExists,
  walkTree,
  copyTree,
  sha256File,
  sha256Buffer,
  hardenTree,
  createPrivateStage,
  snapshotWorkspaceTree,
  assertWorkspaceSnapshot,
  fsyncDirectory,
  readBoundedRegularFile
} = require('./lib/fs-safe');

const MEMORY_ID = /^(?:mem|theme|focus)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^s-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_MEMORY_PATHS = Object.freeze([
  'profile.md',
  'ACTIVE-THEMES.md',
  'CURRENT-FOCUS.md',
  'NEXT-PRIMER.md',
  'sources/client-told-memories.md'
]);
const CATEGORY_PATHS = Object.freeze({
  profile: ['profile.md'],
  themes: ['ACTIVE-THEMES.md'],
  focus: ['CURRENT-FOCUS.md'],
  primer: ['NEXT-PRIMER.md'],
  'client-scenes': ['sources/client-told-memories.md'],
  'all-active': ACTIVE_MEMORY_PATHS
});

const PATH_CATEGORY = Object.freeze({
  'profile.md': 'profile',
  'ACTIVE-THEMES.md': 'themes',
  'CURRENT-FOCUS.md': 'focus',
  'NEXT-PRIMER.md': 'primer',
  'sources/client-told-memories.md': 'client-scenes'
});

async function readOptional(root, relative) {
  const normalized = validateRelativePath(relative);
  const filename = path.resolve(root, normalized);
  assertInside(root, filename, 'Memory data path');
  await rejectSymlinkPath(filename, { allowMissing: true });
  try {
    return (await readBoundedRegularFile(filename, 8 * 1024 * 1024, {
      typeCode: 'UNSUPPORTED_FILE_TYPE',
      sizeCode: 'MEMORY_FILE_TOO_LARGE',
      changedCode: 'MEMORY_FILE_CHANGED'
    })).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function memoryBlocks(markdown) {
  const headings = [];
  const expression = /^(#{1,6})\s+([^\r\n]+)$/gm;
  let match;
  while ((match = expression.exec(markdown)) !== null) headings.push({ start: match.index, end: expression.lastIndex, depth: match[1].length, title: match[2] });
  const blocks = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const idMatch = heading.title.match(/^((?:mem|theme|focus)-[0-9a-f-]{36})(?:\s+—|\b)/i);
    if (!idMatch || !MEMORY_ID.test(idMatch[1])) continue;
    let end = markdown.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].depth <= heading.depth) {
        end = headings[next].start;
        break;
      }
    }
    const body = markdown.slice(heading.start, end);
    const field = (name) => body.match(new RegExp(`^- ${name}:\\s*(.*)$`, 'mi'))?.[1].trim() || null;
    blocks.push({
      id: idMatch[1].toLowerCase(),
      start: heading.start,
      end,
      body,
      title: heading.title.slice(idMatch[1].length).replace(/^\s+—\s*/, '').trim() || null,
      statement: field('Statement'),
      kind: field('Kind'),
      status: field('Status'),
      confidence: field('Confidence'),
      lastLiveConfirmed: field('Last live confirmed'),
      reviewState: field('Review state'),
      currentRevision: field('Current revision')
    });
  }
  return blocks;
}

async function listMemoryItems(root, options = {}) {
  const items = [];
  for (const relative of ACTIVE_MEMORY_PATHS) {
    if (options.categories && !options.categories.includes(PATH_CATEGORY[relative])) continue;
    const markdown = await readOptional(root, relative);
    if (markdown === null) continue;
    for (const block of memoryBlocks(markdown)) {
      if (options.id && block.id !== options.id.toLowerCase()) continue;
      items.push({
        id: block.id,
        category: relative === 'profile.md' ? 'profile' : relative === 'ACTIVE-THEMES.md' ? 'themes' : relative === 'CURRENT-FOCUS.md' ? 'focus' : relative === 'NEXT-PRIMER.md' ? 'primer' : 'client-scenes',
        title: block.title,
        statement: block.statement,
        kind: block.kind,
        status: block.status,
        confidence: block.confidence,
        lastLiveConfirmed: block.lastLiveConfirmed,
        reviewState: block.reviewState,
        currentRevision: block.currentRevision
      });
    }
  }
  items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return items;
}

function removeBlocks(markdown, blocks) {
  let output = markdown;
  for (const block of [...blocks].sort((a, b) => b.start - a.start)) output = `${output.slice(0, block.start)}${output.slice(block.end)}`;
  return output.replace(/\n{3,}/g, '\n\n');
}

async function derivedReferencePaths(root) {
  const paths = new Set(['NEXT-PRIMER.md', '.therapy/state/SOURCE-LEDGER.md', '.therapy/state/CHANGE-LOG.md']);
  for (const subtree of ['context', 'archive/checkpoints', 'archive/reviews']) {
    const subtreeRoot = path.join(root, subtree);
    if (!(await pathExists(subtreeRoot))) continue;
    for (const entry of await walkTree(subtreeRoot)) if (entry.type === 'file' && entry.path.toLowerCase().endsWith('.md')) paths.add(`${subtree}/${entry.path}`);
  }
  const archiveRoot = path.join(root, 'archive');
  if (await pathExists(archiveRoot)) {
    for (const entry of await walkTree(archiveRoot)) {
      if (entry.type === 'file' && /(?:deep-dive|summary).*\.md$/i.test(entry.path)) paths.add(`archive/${entry.path}`);
    }
  }
  return [...paths].sort();
}

function stripIdReferences(markdown, ids) {
  const lowered = ids.map((id) => id.toLowerCase());
  return markdown.split(/(?<=\n)/).filter((line) => !lowered.some((id) => line.toLowerCase().includes(id))).join('');
}

async function knownBackupCount(root) {
  const ledger = await readOptional(root, '.therapy/state/BACKUP-LEDGER.md');
  if (!ledger) return 0;
  return ledger.split(/\r?\n/).filter((line) => /^\|\s*backup-[0-9a-f-]{36}\s*\|/i.test(line)).length;
}

function confirmationToken(workspaceId, operation, selector) {
  const digest = crypto.createHash('sha256').update(`${workspaceId}\0${operation}\0${selector}`).digest('hex').slice(0, 16);
  return `${operation}:${selector}:${digest}`;
}

async function planForget(root, selection) {
  const hasId = selection.id !== undefined;
  const hasScope = selection.scope !== undefined;
  invariant(hasId !== hasScope, 'Memory forget requires exactly one --id or --scope.', 'INVALID_ARGUMENT');
  if (hasId) invariant(MEMORY_ID.test(selection.id), 'Memory ID is invalid.', 'INVALID_MEMORY_ID');
  if (hasScope) invariant(CATEGORY_PATHS[selection.scope], 'Unknown memory scope.', 'INVALID_MEMORY_SCOPE', { available: Object.keys(CATEGORY_PATHS) });
  const selectedPaths = hasId ? ACTIVE_MEMORY_PATHS : CATEGORY_PATHS[selection.scope];
  const writes = new Map();
  const ids = new Set();
  for (const relative of selectedPaths) {
    const markdown = await readOptional(root, relative);
    if (markdown === null) continue;
    const blocks = memoryBlocks(markdown).filter((block) => !hasId || block.id === selection.id.toLowerCase());
    if (!blocks.length) continue;
    blocks.forEach((block) => ids.add(block.id));
    writes.set(relative, removeBlocks(markdown, blocks));
  }
  invariant(ids.size > 0, 'No matching active memory item was found.', 'MEMORY_NOT_FOUND');
  for (const relative of await derivedReferencePaths(root)) {
    const markdown = writes.has(relative) ? writes.get(relative) : await readOptional(root, relative);
    if (markdown === null) continue;
    const stripped = stripIdReferences(markdown, [...ids]);
    if (stripped !== markdown) writes.set(relative, stripped);
  }
  return {
    selector: hasId ? selection.id.toLowerCase() : selection.scope,
    ids: [...ids].sort(),
    writes,
    deletes: [],
    affectedPaths: [...writes.keys()].sort(),
    knownBackupRecords: await knownBackupCount(root)
  };
}

async function planCorrection(root, id, statement, now = new Date().toISOString()) {
  invariant(MEMORY_ID.test(id || ''), 'Memory correction requires a valid --id.', 'INVALID_MEMORY_ID');
  invariant(typeof statement === 'string' && statement.trim() && statement.length <= 2_000 && !/[\0\r\n]/.test(statement), 'Memory correction requires a single-line --statement of at most 2000 characters.', 'INVALID_MEMORY_STATEMENT');
  const matches = [];
  for (const relative of ACTIVE_MEMORY_PATHS) {
    const markdown = await readOptional(root, relative);
    if (markdown === null) continue;
    for (const block of memoryBlocks(markdown)) if (block.id === id.toLowerCase()) matches.push({ relative, markdown, block });
  }
  invariant(matches.length === 1, matches.length ? 'Memory ID is duplicated; refusing an ambiguous correction.' : 'Memory item was not found.', matches.length ? 'MEMORY_ID_DUPLICATED' : 'MEMORY_NOT_FOUND');
  const { relative, markdown, block } = matches[0];
  invariant(/^- Statement:/mi.test(block.body), 'This memory record has no deterministic Statement field to correct.', 'MEMORY_FORMAT_UNSUPPORTED');
  const revision = Number(block.currentRevision || '1');
  invariant(Number.isSafeInteger(revision) && revision >= 1, 'Memory revision is invalid.', 'MEMORY_FORMAT_UNSUPPORTED');
  let body = block.body.replace(/^- Statement:.*$/mi, `- Statement: ${statement.trim()}`);
  body = body.replace(/^- Status:.*$/mi, '- Status: user_confirmed');
  if (/^- Current revision:/mi.test(body)) body = body.replace(/^- Current revision:.*$/mi, `- Current revision: ${revision + 1}`);
  else body += `\n- Current revision: ${revision + 1}\n`;
  const revisionLine = `- r${revision + 1} — ${now} — user correction; prior wording retired`;
  if (/^#### Revision history\s*$/mi.test(body)) body = body.replace(/^(#### Revision history\s*)$/mi, `$1\n\n${revisionLine}`);
  else body += `\n#### Revision history\n\n${revisionLine}\n`;
  return { id: id.toLowerCase(), writes: new Map([[relative, `${markdown.slice(0, block.start)}${body}${markdown.slice(block.end)}`]]), deletes: [], affectedPaths: [relative] };
}

async function resetFromTemplate(root, templateRelative) {
  return readOptional(root, `.therapy/templates/${templateRelative}`);
}

async function planDeleteAll(root) {
  const entries = await walkTree(root);
  const deletes = [];
  const writes = new Map();
  for (const relative of ['profile.md', 'ACTIVE-THEMES.md', 'CURRENT-FOCUS.md', 'NEXT-PRIMER.md']) if (await pathExists(path.join(root, relative))) writes.set(relative, '');
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const relative = entry.path;
    if (relative.startsWith('sessions/')) deletes.push(relative);
    else if (relative.startsWith('sources/') && relative !== 'sources/README.md') deletes.push(relative);
    else if (relative.startsWith('context/') && relative !== 'context/README.md') deletes.push(relative);
    else if (relative.startsWith('archive/') && !['archive/README.md', 'archive/reviews/REVIEW-INDEX.md'].includes(relative)) deletes.push(relative);
    else if (relative.startsWith('.therapy/change-control/pending/') || relative.startsWith('.therapy/change-control/history/')) deletes.push(relative);
    else if (relative.startsWith('.therapy/user-overrides/') && relative !== '.therapy/user-overrides/README.md') deletes.push(relative);
  }
  const resets = [
    ['.therapy/state/SOURCE-LEDGER.md', 'state/SOURCE-LEDGER.template.md'],
    ['.therapy/state/CHANGE-LOG.md', 'state/CHANGE-LOG.template.md'],
    ['archive/reviews/REVIEW-INDEX.md', 'archive/reviews/REVIEW-INDEX.template.md']
  ];
  for (const [target, template] of resets) {
    const content = await resetFromTemplate(root, template);
    if (content !== null) writes.set(target, content);
  }
  const knownBackupRecords = await knownBackupCount(root);
  return {
    selector: 'all',
    ids: [],
    writes,
    deletes: [...new Set(deletes)].sort(),
    affectedPaths: [...new Set([...writes.keys(), ...deletes])].sort(),
    knownBackupRecords,
    deletedCategories: [
      'profile_memory', 'themes_and_focus', 'session_notes', 'primers_and_checkpoints',
      'reviews_and_summaries', 'client_scene_memories', 'context_graph', 'raw_transcripts',
      'imported_sources', 'external_care_records', 'behavior_customization'
    ],
    retainedOperationalCategories: ['usage_ledgers'],
    retainedSeparateCopies: knownBackupRecords > 0 ? ['known_backups_outside_live_workspace'] : []
  };
}

async function transcriptFiles(root) {
  const transcriptRoot = path.join(root, 'archive', 'transcripts');
  if (!(await pathExists(transcriptRoot))) return [];
  return (await walkTree(transcriptRoot))
    .filter((entry) => entry.type === 'file' && entry.path.toLowerCase().endsWith('.md') && entry.path !== 'README.md')
    .map((entry) => `archive/transcripts/${entry.path}`)
    .sort();
}

async function planTranscriptDelete(root, selection) {
  const all = selection.scope === 'all';
  invariant(all || SESSION_ID.test(selection.sessionId || ''), 'Transcript delete requires --session-id s-<uuid> or --scope all.', 'INVALID_ARGUMENT');
  invariant(!(all && selection.sessionId), 'Transcript delete accepts either --session-id or --scope all, not both.', 'INVALID_ARGUMENT');
  const candidates = await transcriptFiles(root);
  const selected = [];
  for (const relative of candidates) {
    if (all) selected.push(relative);
    else {
      const markdown = await readOptional(root, relative);
      const declared = markdown?.match(/^session_id:\s*(s-[0-9a-f-]{36})\s*$/mi)?.[1]?.toLowerCase();
      if (declared === selection.sessionId.toLowerCase() || relative.toLowerCase().includes(selection.sessionId.slice(2).toLowerCase())) selected.push(relative);
    }
  }
  invariant(selected.length > 0, 'No matching transcript was found.', 'TRANSCRIPT_NOT_FOUND');
  const writes = new Map();
  const referenceRoots = ['profile.md', 'ACTIVE-THEMES.md', 'CURRENT-FOCUS.md', 'NEXT-PRIMER.md'];
  for (const entry of await walkTree(root)) {
    if (entry.type !== 'file' || !entry.path.toLowerCase().endsWith('.md')) continue;
    if (entry.path.startsWith('sessions/') || entry.path.startsWith('context/')) referenceRoots.push(entry.path);
  }
  const needles = all ? [] : [selection.sessionId.toLowerCase(), ...selected.map((item) => item.toLowerCase())];
  for (const relative of [...new Set(referenceRoots)]) {
    const markdown = await readOptional(root, relative);
    if (markdown === null) continue;
    const lines = markdown.split(/(?<=\n)/).map((line) => {
      const lower = line.toLowerCase();
      const relevant = all || needles.some((needle) => lower.includes(needle));
      if (!relevant) return line;
      if (/^source_transcript:/i.test(line.trim())) return line.replace(/source_transcript:.*/i, 'source_transcript: none');
      if (lower.includes('archive/transcripts/') || (lower.includes('transcript') && needles.some((needle) => lower.includes(needle)))) return '';
      return line;
    }).join('');
    if (lines !== markdown) writes.set(relative, lines);
  }
  return {
    selector: all ? 'all' : selection.sessionId.toLowerCase(),
    ids: all ? selected.map((item) => path.basename(item)) : [selection.sessionId.toLowerCase()],
    writes,
    deletes: selected,
    affectedPaths: [...new Set([...writes.keys(), ...selected])].sort(),
    knownBackupRecords: await knownBackupCount(root)
  };
}

async function applyPlan(root, plan) {
  for (const relative of plan.deletes) {
    const filename = path.resolve(root, validateRelativePath(relative));
    assertInside(root, filename, 'Deletion target');
    await rejectSymlinkPath(filename, { allowMissing: true });
    await fsp.rm(filename, { force: true });
  }
  for (const [relative, content] of plan.writes) {
    const filename = path.resolve(root, validateRelativePath(relative));
    assertInside(root, filename, 'Memory write target');
    await rejectSymlinkPath(filename, { allowMissing: true });
    await atomicWriteFile(filename, content);
  }
}

async function appendDeletionReceipt(root, receipt) {
  const relative = '.therapy/state/DELETION-LEDGER.md';
  const markdown = await readOptional(root, relative);
  if (markdown === null) return false;
  const header = '|---|---|---|---|---|---|---|---|---|';
  invariant(markdown.includes(header), 'Deletion ledger template is invalid.', 'DELETION_LEDGER_INVALID');
  const row = `| ${receipt.eventId} | ${receipt.at} | ${receipt.sessionId || 'none'} | ${receipt.dataClass} | ${receipt.objectIds.length ? receipt.objectIds.join(',') : 'all'} | ${receipt.scope} | ${receipt.derivedCount} | ${receipt.knownBackupRecords > 0 ? 'true' : 'false'} | active_workspace_completed |`;
  await atomicWriteFile(path.join(root, relative), markdown.replace(header, `${header}\n${row}`));
  return true;
}

function exportSelected(relative, scope) {
  const active = ACTIVE_MEMORY_PATHS.includes(relative);
  if (scope === 'active') return active;
  const continuity = active || relative.startsWith('sessions/') || (relative.startsWith('archive/') && !relative.startsWith('archive/transcripts/')) || relative.startsWith('context/');
  if (scope === 'continuity') return continuity;
  return continuity || relative.startsWith('sources/') || relative.startsWith('archive/transcripts/') || relative.startsWith('.therapy/user-overrides/') || relative.startsWith('.therapy/change-control/') || relative.startsWith('.therapy/state/') || relative === '.scalvin/state.json' || relative === 'SETUP-NOTES.md';
}

function retentionClassForPath(relative) {
  if (relative === 'profile.md') return 'profile_memory';
  if (relative === 'ACTIVE-THEMES.md' || relative === 'CURRENT-FOCUS.md') return 'themes_and_focus';
  if (relative === 'NEXT-PRIMER.md' || relative.startsWith('archive/checkpoints/')) return 'primers_and_checkpoints';
  if (relative === 'sources/client-told-memories.md') return 'client_scene_memories';
  if (relative.startsWith('sessions/') || (relative.startsWith('archive/') && !relative.startsWith('archive/reviews/') && !relative.startsWith('archive/transcripts/') && !relative.startsWith('archive/checkpoints/'))) return 'session_notes';
  if (relative.startsWith('archive/reviews/')) return 'reviews_and_summaries';
  if (relative.startsWith('archive/transcripts/')) return 'raw_transcripts';
  if (relative.startsWith('context/')) return 'context_graph';
  if (relative.startsWith('sources/')) return 'imported_sources';
  if (relative.startsWith('.therapy/change-control/') || relative.startsWith('.therapy/user-overrides/')) return 'behavior_customization';
  if (relative.startsWith('.therapy/state/')) return 'usage_ledgers';
  return null;
}

async function createMemoryExport(root, options = {}) {
  const scope = options.scope || 'active';
  invariant(['active', 'continuity', 'all'].includes(scope), 'Export scope must be active, continuity, or all.', 'INVALID_EXPORT_SCOPE');
  invariant(options.output, 'Memory export requires --output.', 'INVALID_ARGUMENT');
  const outputRoot = resolvePortablePath(options.output);
  invariant(!isInside(root, outputRoot), 'Export output must be outside the workspace.', 'INVALID_EXPORT_LOCATION');
  await rejectSymlinkPath(outputRoot, { allowMissing: true });
  const sourceSnapshot = await snapshotWorkspaceTree(root);
  const entries = (await walkTree(root)).filter((entry) => entry.type === 'file'
    && exportSelected(entry.path, scope)
    && !options.excludedPaths?.has(entry.path));
  const name = `scalvin-export-${new Date().toISOString().replace(/[:.]/g, '-') }--${crypto.randomUUID()}`;
  const finalPath = path.join(outputRoot, name);
  invariant(!(await pathExists(finalPath)), 'Memory export destination already exists.', 'EXPORT_EXISTS');
  if (options.dryRun) return { status: 'dry-run', scope, exportPath: finalPath, files: entries.length };
  const stage = path.join(outputRoot, `.export-stage-${process.pid}-${crypto.randomUUID()}`);
  const payload = path.join(stage, 'payload');
  let activated = false;
  let finalIdentity = null;
  try {
    await createPrivateStage(stage);
    await ensurePrivateDir(payload);
    const manifestEntries = [];
    const selected = new Set(entries.map((entry) => entry.path));
    await copyTree(root, payload, { filter: (relative) => selected.has(relative) });
    for (const entry of entries) {
      const destination = path.join(payload, entry.path);
      assertInside(payload, destination, 'Export target');
      const copiedHash = await sha256File(destination);
      const sourceEntry = sourceSnapshot.entries.find((candidate) => candidate.path === entry.path && candidate.type === 'file');
      invariant(sourceEntry && sourceEntry.size === entry.size && sourceEntry.sha256 === copiedHash,
        'The workspace changed while its export payload was copied; no export was finalized.', 'STALE_WORKSPACE');
      manifestEntries.push({ path: entry.path, size: entry.size, sha256: copiedHash });
    }
    await assertWorkspaceSnapshot(root, sourceSnapshot);
    const integrity = { format: 'scalvin-memory-export', formatVersion: 1, createdAt: new Date().toISOString(), scope, entries: manifestEntries };
    const raw = `${JSON.stringify(integrity, null, 2)}\n`;
    await atomicWriteFile(path.join(stage, 'integrity.json'), raw);
    await atomicWriteFile(path.join(stage, 'CHECKSUM.sha256'), `${sha256Buffer(Buffer.from(raw))}  integrity.json\n`);
    await hardenTree(stage);
    for (const entry of manifestEntries) invariant(await sha256File(path.join(stage, 'payload', entry.path)) === entry.sha256, 'Export verification failed.', 'EXPORT_VERIFICATION_FAILED');
    invariant(!(await pathExists(finalPath)), 'Memory export destination already exists.', 'EXPORT_EXISTS');
    const stageIdentity = await fsp.lstat(stage);
    invariant(stageIdentity.isDirectory() && !stageIdentity.isSymbolicLink(), 'Memory export stage identity is invalid.', 'EXPORT_ACTIVATION_FAILED');
    finalIdentity = stageIdentity;
    await fsp.rename(stage, finalPath);
    activated = true;
    const activatedIdentity = await fsp.lstat(finalPath);
    invariant(activatedIdentity.isDirectory() && !activatedIdentity.isSymbolicLink() &&
      activatedIdentity.dev === finalIdentity.dev && activatedIdentity.ino === finalIdentity.ino,
    'Memory export activation identity changed.', 'EXPORT_ACTIVATION_FAILED');
    if (process.env.SCALVIN_TEST_MEMORY_EXPORT_FAILPOINT === 'after-rename') {
      throw new ScalvinError('Injected memory-export failure after rename.', 'TEST_FAILPOINT');
    }
    await fsyncDirectory(outputRoot);
    return { status: 'created', scope, exportPath: finalPath, files: entries.length, checksum: sha256Buffer(Buffer.from(raw)) };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (activated) {
      error.details = {
        ...(error.details || {}),
        status: 'partial',
        exportCreated: true,
        exportPath: finalPath,
        nextAction: 'secure-or-remove-memory-export'
      };
    }
    throw error;
  }
}

module.exports = {
  ACTIVE_MEMORY_PATHS,
  CATEGORY_PATHS,
  MEMORY_ID,
  SESSION_ID,
  memoryBlocks,
  listMemoryItems,
  knownBackupCount,
  confirmationToken,
  planForget,
  planCorrection,
  planDeleteAll,
  planTranscriptDelete,
  applyPlan,
  appendDeletionReceipt,
  createMemoryExport,
  retentionClassForPath
};
