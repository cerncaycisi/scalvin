'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { install, memory } = require('../../cli/operations');
const { privacySummary, renderPrivacySummary } = require('../../cli/privacy-summary');
const { sandbox } = require('./helpers');

const MEMORY_ID = 'mem-a23e4567-e89b-42d3-a456-426614174000';

function memoryBlock(statement) {
  return `\n### ${MEMORY_ID} — Preference\n\n- Statement: ${statement}\n- Kind: preference\n- Status: user_confirmed\n- Last live confirmed: 2026-09-01T10:00:00Z\n- Confidence: confirmed\n- Review state: current\n- Current revision: 1\n`;
}

test('privacy summary reports counts and controls without any memory content', async (t) => {
  const box = await sandbox('privacy-summary');
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  await fsp.appendFile(path.join(box.workspace, 'profile.md'), memoryBlock('PRIVATE_PRIVACY_SUMMARY_CANARY'));

  const summary = await privacySummary({ target: box.workspace });
  assert.equal(summary.contentIncluded, false);
  assert.equal(summary.memorySaving, 'none');
  assert.equal(summary.countsAvailable, true);
  const profile = summary.stored.find((item) => item.dataClass === 'profile_memory');
  assert.equal(profile.count, 1);
  assert.equal(profile.policy, 'until_deleted');
  assert.equal(summary.stored.find((item) => item.dataClass === 'raw_transcripts').policy, 'do_not_store');

  const text = renderPrivacySummary(summary);
  assert.match(text, /Profile memory\s+1 item, kept until you delete them/);
  assert.match(text, /Raw conversation transcripts\s+off \(not stored\)/);
  assert.match(text, /What leaves this computer/);
  assert.match(text, /--action pause/);
  assert.match(text, /--action delete-all/);
  for (const output of [text, JSON.stringify(summary)]) {
    assert.equal(output.includes('PRIVATE_PRIVACY_SUMMARY_CANARY'), false);
    assert.equal(output.includes(MEMORY_ID), false);
  }
});

test('privacy summary stays content-free and count-free during sealed pause', async (t) => {
  const box = await sandbox('privacy-summary-sealed');
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  await fsp.appendFile(path.join(box.workspace, 'profile.md'), memoryBlock('PRIVATE_SEALED_CANARY'));
  await memory({ target: box.workspace, action: 'seal' });

  const summary = await privacySummary({ target: box.workspace });
  assert.equal(summary.memorySaving, 'sealed_pause');
  assert.equal(summary.countsAvailable, false);
  assert.equal(summary.stored.find((item) => item.dataClass === 'profile_memory').count, null);
  const text = renderPrivacySummary(summary);
  assert.match(text, /sealed: nothing is read or saved/);
  assert.match(text, /Profile memory\s+on \(count unavailable while sealed\)/);
  assert.equal(text.includes('PRIVATE_SEALED_CANARY'), false);
});

test('privacy summary reports retained data after persistence is switched off', async (t) => {
  const { consent } = require('../../cli/operations');
  const box = await sandbox('privacy-summary-off');
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  await fsp.appendFile(path.join(box.workspace, 'profile.md'), memoryBlock('PRIVATE_OFF_CANARY'));
  await consent({ target: box.workspace, category: 'continuity_memory', value: 'off', retention: 'do_not_store' });
  const summary = await privacySummary({ target: box.workspace });
  const profile = summary.stored.find((item) => item.dataClass === 'profile_memory');
  const text = renderPrivacySummary(summary);
  assert.equal(profile.policy, 'do_not_store');
  assert.equal(profile.count, 1);
  assert.match(text, /Profile memory\s+off for new data; 1 item saved earlier still kept/);
  assert.match(text, /Memory: saving is off \(continuity memory is off\)/);
  assert.doesNotMatch(text, /Profile memory\s+off \(not stored\)/);
  assert.equal(text.includes('PRIVATE_OFF_CANARY'), false);
});

test('privacy summary omits identifiers and sanitizes failures', { skip: process.platform === 'win32' }, async (t) => {
  const box = await sandbox('privacy-summary-errors');
  t.after(box.cleanup);
  await install({ target: box.workspace, consent: 'granted' });
  const summary = await privacySummary({ target: box.workspace });
  assert.equal('workspaceId' in summary, false);

  await fsp.symlink(path.join(box.workspace, 'profile.md'), path.join(box.workspace, 'sessions', 'PRIVATE_FILENAME_CANARY.md'));
  await assert.rejects(privacySummary({ target: box.workspace }), (error) => {
    assert.equal(error.code, 'PRIVACY_SUMMARY_UNAVAILABLE');
    assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes('PRIVATE_FILENAME_CANARY'), false);
    assert.match(error.details.causeCode, /^[A-Z0-9_]+$/);
    return true;
  });
});

test('suggested commands quote the workspace path for a shell', () => {
  const { shellQuote } = require('../../cli/privacy-summary');
  assert.equal(shellQuote("/tmp/a b/$HOME/it's", 'linux'), "'/tmp/a b/$HOME/it'\\''s'");
  assert.equal(shellQuote('/x/`id`', 'darwin'), "'/x/`id`'");
  assert.equal(shellQuote('C:\\Users\\a "b"', 'win32'), '"C:\\Users\\a ""b"""');
});
