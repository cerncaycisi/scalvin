'use strict';

// Plain-language, content-free privacy summary. It answers three questions
// for a non-technical user: what is stored, what leaves this computer, and
// how to pause, correct, export, or delete it. It only reads the existing
// content-free `memory status` and `memory retention-status` operations and
// never opens memory, session, source, or transcript content.

const operations = require('./operations');

const CLASS_LABELS = Object.freeze([
  ['profile_memory', 'Profile memory', 'item'],
  ['themes_and_focus', 'Themes and current focus', 'item'],
  ['session_notes', 'Session notes', 'note'],
  ['primers_and_checkpoints', 'Next-session primers and checkpoints', 'file'],
  ['reviews_and_summaries', 'Reviews and summaries', 'file'],
  ['client_scene_memories', 'Scenes you told the companion', 'item'],
  ['context_graph', 'People, places, and events (context graph)', 'entry'],
  ['raw_transcripts', 'Raw conversation transcripts', 'file'],
  ['imported_sources', 'Imported documents', 'file'],
  ['external_care_records', 'Notes from outside care', 'file'],
  ['behavior_customization', 'Approved behavior adjustments', 'change']
]);

const PAUSE_TEXT = Object.freeze({
  none: 'saving normally',
  write_pause: 'paused: nothing new is saved until you resume',
  sealed_pause: 'sealed: nothing is read or saved until you resume from the terminal'
});

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

async function privacySummary(options = {}) {
  const status = await operations.memory({ target: options.target, action: 'status' });
  const retention = await operations.memory({ target: options.target, action: 'retention-status' });
  const controls = status.consentControls || {};
  const policies = controls.retention || {};
  const byClass = new Map((retention.classes || []).map((item) => [item.dataClass, item]));
  const stored = CLASS_LABELS.map(([dataClass, label, noun]) => {
    const policy = policies[dataClass] || byClass.get(dataClass)?.basePolicy || 'unknown';
    const inspected = byClass.get(dataClass);
    const count = retention.inventoryAvailable && Number.isSafeInteger(inspected?.objectCount) ? inspected.objectCount : null;
    return { dataClass, label, noun, policy, count };
  });
  return {
    status: 'inspected',
    workspacePath: status.workspacePath,
    workspaceId: status.workspaceId,
    contentIncluded: false,
    memorySaving: status.memoryPause || 'unknown',
    continuityMemory: status.continuityMemory || 'unknown',
    countsAvailable: retention.inventoryAvailable === true,
    stored,
    knownBackups: Number.isSafeInteger(retention.knownBackupRecords) ? retention.knownBackupRecords : null,
    nextAction: 'none'
  };
}

function renderPrivacySummary(summary) {
  const workspace = JSON.stringify(summary.workspacePath);
  const lines = [
    'Scalvin privacy summary',
    '',
    `Workspace: ${summary.workspacePath}`,
    `Memory: ${PAUSE_TEXT[summary.memorySaving] || summary.memorySaving}; continuity memory is ${summary.continuityMemory}.`,
    '',
    'What is stored on this computer (counts only; no content is shown):'
  ];
  const width = Math.max(...summary.stored.map((item) => item.label.length));
  for (const item of summary.stored) {
    let value;
    if (item.policy === 'do_not_store') value = 'off (not stored)';
    else if (item.count === null) value = 'on (count unavailable while sealed)';
    else value = `${plural(item.count, item.noun)}, kept until you delete them`;
    lines.push(`  ${item.label.padEnd(width)}  ${value}`);
  }
  lines.push('');
  if (summary.knownBackups === null) lines.push('Backups: unknown.');
  else if (summary.knownBackups === 0) lines.push('Backups: none recorded.');
  else lines.push(`Backups: ${plural(summary.knownBackups, 'backup')} recorded. Backups are separate copies; deleting live data does not delete them.`);
  lines.push(
    '',
    'What leaves this computer:',
    '  Your AI client sends each message, and the context it loads, to its model',
    '  provider unless you use a local model. The client may also keep its own',
    '  conversation history; Scalvin settings do not control that.',
    '',
    'What you can do (from this checkout):',
    `  See what is remembered   node bin/scalvin.js memory --workspace ${workspace} --action view`,
    `  Correct an item          node bin/scalvin.js memory --workspace ${workspace} --action correct --id ID --statement "..."`,
    `  Pause saving             node bin/scalvin.js memory --workspace ${workspace} --action pause`,
    `  Resume saving            node bin/scalvin.js memory --workspace ${workspace} --action resume`,
    `  Forget one item          node bin/scalvin.js memory --workspace ${workspace} --action forget --id ID`,
    `  Export a readable copy   node bin/scalvin.js memory --workspace ${workspace} --action export --output DIR --allow-plaintext-export`,
    `  Delete everything        node bin/scalvin.js memory --workspace ${workspace} --action delete-all`,
    '  Forget and delete show a preview first and need the exact confirmation token.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

module.exports = { privacySummary, renderPrivacySummary };
