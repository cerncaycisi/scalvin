'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  reviewDue,
  parseIsoDate,
  startOfWeek,
  isCompletedArtifact,
  readFrontmatterOnly
} = require('../../cli/review-due');
const { acquireMutationLock } = require('../../cli/lib/fs-safe');
const { sandbox } = require('./helpers');

function reviewState(overrides = {}) {
  const consentOverrides = overrides.consent || {};
  return {
    schemaVersion: 2,
    workspaceId: '123e4567-e89b-42d3-a456-426614174999',
    consent: {
      continuityMemory: 'on',
      memoryPause: { state: 'none', startedAt: null },
      retention: {
        session_notes: 'until_deleted',
        reviews_and_summaries: 'until_deleted'
      },
      timezone: {
        value: 'Europe/Istanbul',
        status: 'confirmed',
        confirmedAt: '2026-07-01T00:00:00.000Z'
      },
      ...consentOverrides,
      retention: {
        session_notes: 'until_deleted',
        reviews_and_summaries: 'until_deleted',
        ...(consentOverrides.retention || {})
      }
    }
  };
}

function runReviewDue(options = {}) {
  return reviewDue({ canonicalState: reviewState(), ...options });
}

async function fixture(box) {
  await fsp.mkdir(path.join(box.workspace, 'sessions'), { recursive: true });
  await fsp.mkdir(path.join(box.workspace, 'archive', 'reviews'), { recursive: true });
}

test('review-due works on any weekday when a prior-week session exists', async () => {
  const box = await sandbox('review-due');
  try {
    await fixture(box);
    await fsp.writeFile(path.join(box.workspace, 'sessions', '2026-07-05-120000--123e4567-e89b-42d3-a456-426614174000--session.md'), '---\ncompletion: complete\n---\nfixture');
    const result = await runReviewDue({ workspace: box.workspace, date: '2026-07-15', timezone: 'Europe/Istanbul' });
    assert.equal(result.status, 'DUE');
    assert.equal(result.reviewWeekStart, '2026-07-13');
  } finally {
    await box.cleanup();
  }
});

test('review-due returns BUSY without multi-file claims while a workspace mutation is locked', async () => {
  const box = await sandbox('review-due-busy');
  let release = null;
  try {
    await fixture(box);
    release = await acquireMutationLock(box.workspace);
    const result = await runReviewDue({ workspace: box.workspace, date: '2026-07-15' });
    assert.equal(result.status, 'BUSY');
    assert.equal(result.errors, 1);
    assert.equal(result.sessionFilesRead, false);
    assert.equal(result.reviewFilesRead, false);
    assert.deepEqual(result.matches, []);
    assert.equal(result.nextAction, 'confirm-no-writer-then-remove-exact-lock-manually');
  } finally {
    await release?.().catch(() => {});
    await box.cleanup();
  }
});

test('new artifacts require one complete frontmatter marker; legacy requires nonempty truth', () => {
  assert.equal(isCompletedArtifact('---\ncompletion: complete\n---\nbody', 'new'), true);
  assert.equal(isCompletedArtifact('---\ncompletion: interrupted_partial\n---\nbody', 'new'), false);
  assert.equal(isCompletedArtifact('---\ncompletion: complete\ncompletion: complete\n---\nbody', 'new'), false);
  assert.equal(isCompletedArtifact('', 'legacy'), false);
  assert.equal(isCompletedArtifact('legacy body', 'legacy'), true);
  assert.equal(isCompletedArtifact('completion: incomplete\nlegacy body', 'legacy'), false);
});

test('incomplete, empty, and future artifacts do not affect due truth', async () => {
  const box = await sandbox('review-incomplete');
  try {
    await fixture(box);
    await fsp.writeFile(path.join(box.workspace, 'sessions', '2026-07-05-120000--123e4567-e89b-42d3-a456-426614174001--session.md'), '---\ncompletion: interrupted_partial\n---\n');
    await fsp.writeFile(path.join(box.workspace, 'sessions', '2026-07-04-1200.md'), '');
    let result = await runReviewDue({ workspace: box.workspace, date: '2026-07-15' });
    assert.equal(result.status, 'NOT_DUE');
    await fsp.writeFile(path.join(box.workspace, 'sessions', '2026-07-05-1200.md'), 'legacy complete');
    await fsp.writeFile(path.join(box.workspace, 'archive', 'reviews', '2026-07-20-120000--123e4567-e89b-42d3-a456-426614174002--weekly-review.md'), '---\ncompletion: complete\n---\nfuture');
    result = await runReviewDue({ workspace: box.workspace, date: '2026-07-15' });
    assert.equal(result.status, 'DUE');
  } finally {
    await box.cleanup();
  }
});

test('unconfirmed system timezone cannot produce DUE', async () => {
  const box = await sandbox('review-timezone');
  try {
    await fixture(box);
    await fsp.writeFile(path.join(box.workspace, 'sessions', '2020-01-01-1200.md'), 'legacy complete');
    const result = await reviewDue({
      workspace: box.workspace,
      canonicalState: reviewState({ consent: { timezone: { value: 'unconfirmed', status: 'unconfirmed', confirmedAt: null } } })
    });
    assert.equal(result.status, 'NOT_DUE');
    assert.equal(result.nextAction, 'confirm-timezone');
  } finally {
    await box.cleanup();
  }
});

test('current-week review or absence of prior sessions returns NOT_DUE', async () => {
  const box = await sandbox('review-not-due');
  try {
    await fixture(box);
    let result = await runReviewDue({ workspace: box.workspace, date: '2026-07-15' });
    assert.equal(result.status, 'NOT_DUE');
    await fsp.writeFile(path.join(box.workspace, 'sessions', '2026-07-05-1200.md'), 'fixture');
    await fsp.writeFile(path.join(box.workspace, 'archive', 'reviews', '2026-07-14-1200-weekly-review.md'), 'fixture');
    result = await runReviewDue({ workspace: box.workspace, date: '2026-07-15' });
    assert.equal(result.status, 'NOT_DUE');
    assert.match(result.reason, /already exists/);
  } finally {
    await box.cleanup();
  }
});

test('review-due rejects bad dates, timezone, non-directory, and symlinks', async () => {
  const box = await sandbox('review-errors');
  try {
    await fixture(box);
    assert.throws(() => parseIsoDate('2026-02-30'), { code: 'INVALID_DATE' });
    assert.equal(startOfWeek(parseIsoDate('2026-07-19')).toISOString().slice(0, 10), '2026-07-13');
    await assert.rejects(runReviewDue({ workspace: box.workspace, timezone: 'Not/AZone' }), { code: 'INVALID_TIMEZONE' });
    await fsp.rm(path.join(box.workspace, 'sessions'), { recursive: true });
    await fsp.writeFile(path.join(box.workspace, 'sessions'), 'not a dir');
    await assert.rejects(runReviewDue({ workspace: box.workspace, date: '2026-07-15' }), { code: 'NOT_A_DIRECTORY' });
    await fsp.rm(path.join(box.workspace, 'sessions'));
    await fsp.mkdir(path.join(box.base, 'real-sessions'));
    await fsp.symlink(path.join(box.base, 'real-sessions'), path.join(box.workspace, 'sessions'));
    await assert.rejects(runReviewDue({ workspace: box.workspace, date: '2026-07-15' }), { code: 'SYMLINK_REJECTED' });
  } finally {
    await box.cleanup();
  }
});

test('review-due reads only new artifact frontmatter, never the private body', async () => {
  const box = await sandbox('review-frontmatter-only');
  try {
    await fixture(box);
    const filename = path.join(box.workspace, 'sessions', '2026-07-05-120000--123e4567-e89b-42d3-a456-426614174020--session.md');
    await fsp.writeFile(filename, '---\ncompletion: complete\n---\nPRIVATE_SENTINEL\ncompletion: incomplete\n');
    const metadata = await readFrontmatterOnly(filename);
    assert.equal(metadata, 'completion: complete');
    assert.doesNotMatch(metadata, /PRIVATE_SENTINEL|incomplete/);
    const result = await runReviewDue({ workspace: box.workspace, date: '2026-07-15' });
    assert.equal(result.status, 'DUE');
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  } finally {
    await box.cleanup();
  }
});

test('review-due gates return before any session or review file access', async () => {
  const box = await sandbox('review-gates');
  try {
    await fsp.mkdir(path.join(box.workspace, 'archive'), { recursive: true });
    await fsp.symlink(path.join(box.base, 'missing-private-sessions'), path.join(box.workspace, 'sessions'));
    await fsp.symlink(path.join(box.base, 'missing-private-reviews'), path.join(box.workspace, 'archive', 'reviews'));
    const states = [
      reviewState({ consent: { continuityMemory: 'off' } }),
      reviewState({ consent: { memoryPause: { state: 'sealed_pause', startedAt: '2026-07-14T00:00:00.000Z' } } }),
      reviewState({ consent: { retention: { session_notes: 'do_not_store' } } }),
      reviewState({ consent: { retention: { reviews_and_summaries: 'do_not_store' } } })
    ];
    for (const canonicalState of states) {
      const result = await reviewDue({ workspace: box.workspace, canonicalState, date: '2026-07-15' });
      assert.equal(result.status, 'NOT_DUE');
      assert.equal(result.availability, 'disabled');
      assert.equal(result.sessionFilesRead, false);
      assert.equal(result.reviewFilesRead, false);
    }
  } finally {
    await box.cleanup();
  }
});

test('frontmatter reader rejects symlink, oversized, and changed artifacts', async () => {
  const box = await sandbox('review-hostile-files');
  try {
    const target = path.join(box.base, 'target.md');
    const link = path.join(box.base, 'link.md');
    await fsp.writeFile(target, '---\ncompletion: complete\n---\nprivate');
    await fsp.symlink(target, link);
    await assert.rejects(readFrontmatterOnly(link), { code: 'SYMLINK_REJECTED' });

    const oversized = path.join(box.base, 'oversized.md');
    await fsp.writeFile(oversized, '---\ncompletion: complete\n---\n');
    await fsp.truncate(oversized, (8 * 1024 * 1024) + 1);
    await assert.rejects(readFrontmatterOnly(oversized), { code: 'REVIEW_ARTIFACT_TOO_LARGE' });

    const changed = path.join(box.base, 'changed.md');
    await fsp.writeFile(changed, '---\ncompletion: complete\n---\nprivate');
    await assert.rejects(
      readFrontmatterOnly(changed, { afterOpen: () => fsp.appendFile(changed, '!') }),
      { code: 'REVIEW_ARTIFACT_CHANGED' }
    );
  } finally {
    await box.cleanup();
  }
});
