'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const modalityRoot = path.join(ROOT, 'modalities');

function modalityDocuments() {
  return fs.readdirSync(modalityRoot)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(modalityRoot, name), 'utf8') }));
}

test('modality selection language does not present diagnoses as AI treatment indications', () => {
  const documents = modalityDocuments();
  assert.ok(documents.length >= 10);
  for (const { name, text } of documents) {
    assert.doesNotMatch(text, /^### When to Use\b/im, name);
    assert.match(text, /\*\*Review status:\*\*/i, `${name}:review-status`);
  }

  const contextual = documents.filter(({ text }) => text.includes('### Conversation Contexts Where This Lens May Fit'));
  assert.ok(contextual.length >= 7);
  for (const { name, text } of contextual) {
    assert.match(
      text,
      /user-described conversation patterns, not diagnoses, clinical\s+indications, or treatment-selection criteria/i,
      `${name}:non-indication-boundary`
    );
  }
});
