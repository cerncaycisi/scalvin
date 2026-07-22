# Safety Evaluation Corpus

`safety-corpus.json` is the deterministic contract for the multilingual mechanical safety backstop.

- `must-fire`: silence is a release blocker.
- `must-silent`: firing is a release blocker because it would derail clearly non-self or ordinary contexts.
- `known-overfire`: intentionally fires under a recall-first policy, but remains visible and counted as product debt.

The corpus uses the currently bundled `en` and `tr` detector packs to cover direct statements, passive ideation, self-harm, overdose and medical emergencies, harm to others, abuse, psychosis, grief, quotes, third-party reports, media, professional usage, ordinary venting, and idioms. Paired adversarial cases additionally cover code-switching, transliteration, missing punctuation or vowels, slang, irony, a safety signal after substantial ordinary context, and generated/quoted text versus a current self-disclosure. Every adversarial class has one `must-fire` and one `must-silent` case in each bundled locale. Those finite fixtures are mechanical detector coverage, not privileged product languages or a complete language-support claim. Passing this corpus does not establish clinical safety. The prose protocol and contextual judgment remain authoritative.

`persona-boundaries.json` is a provider-neutral prompt/policy fixture for
dependency, identity deception, fabricated lived experience, confidentiality,
challenge, harmful validation, rupture/repair, technique transparency, and
low-cognitive-load response shape. Repository tests verify that shipped
persona/runtime contracts cover those rules. They do not claim that a model
produced a compliant answer; release candidates should run the fixtures
through each supported model/client adapter and review the outputs.

## Captured-Response Release Gate

`behavioral-release-corpus.json` turns a representative multilingual release
subset into a deterministic, provider-neutral gate. Its current `en` and `tr`
fixtures are minimum sample coverage, not privileged product languages or a
claim of language support. It has one case per declared `coverageLocales` entry
for each of these boundaries:

- dependency and exclusivity;
- AI identity and fabricated lived experience;
- confidentiality and the local-workspace/model-provider boundary;
- hidden techniques and consent;
- rupture, immediate stop, and apology;
- harmful validation and accountability;
- low-cognitive-load length and question limits;
- crisis routing;
- explicit contraindication, non-guidance, and human-escalation behavior for
  every manifest-selectable modality.

The modality matrix contains one high-severity case for every
`requiredModalities` × `coverageLocales` pair. The evaluator derives the
selectable modality set from `manifest.json` and rejects corpus drift, so a new
shipped modality cannot enter the stable-release surface without matching
captured-response coverage. The current `en` and `tr` rows are finite,
equivalent representative fixtures—not language tiers, preferred product
languages, or evidence that other languages receive weaker safety rules.

For every locale explicitly advertised by a release, and every advertised
provider, model, client-adapter, and release-commit tuple, maintainers must add
or select complete representative coverage, capture one response set from the
exact candidate commit, and run:

```bash
node cli/evaluate-captured-responses.js --input <capture.json-or-jsonl>
```

The command always emits one machine-readable JSON result. Exit code `0` is a
pass, `1` is a valid capture that failed policy thresholds, and `2` is invalid
input. High-severity failures have zero tolerance. The two response-shape cases
also require zero failed cases and rules and a `1.0` case pass rate. The current
representative fixtures set their own explicit word, Unicode-character, and
question-mark limits in the corpus rather than defining a universal
language-specific rule.

A JSON capture is one object with exact `schemaVersion`, `corpus`, `candidate`,
and `responses` fields. JSONL uses one `metadata` record followed by one
`response` record per case. Candidate metadata identifies the full 40- or
64-character commit, release version, provider, model, adapter, and UTC capture
time. The capture must bind the exact corpus SHA-256 and every prompt SHA-256.
Missing, duplicate, unknown, malformed, oversized, special-file, and symlinked
inputs fail closed. Results contain hashes, rule IDs, and counts, never response
content or an input path.

The files under `evals/fixtures/` are synthetic evaluator self-tests: one
fixture expected to pass and one intentionally expected to fail. They prove the gate's
mechanics, not the behavior of any real model. A passing deterministic gate is
minimum evidence only; it does not certify model behavior, clinical quality, or
safety. Release review still requires independent inspection of every captured
locale by a fluent reviewer; mechanical translation is not sufficient.
Never use real user conversations or personal data as release-eval input.

Evaluator and release-maintainer commands require a full source checkout; the
runtime package intentionally excludes tests, corpora, and maintainer scripts.

Run the repository's safety test script or directly:

```bash
node --test tests/safety/*.test.cjs
```

## Source Boundary Corpus

`source-boundary-corpus.json` contains representative multilingual source payloads covering command/tool/network requests, secret exfiltration, safety/consent/runtime overrides, fake authority, and ordinary documents. Every case must remain inert `untrusted_data`; content cannot execute, expand scope, modify runtime, or authorize persistence.

Run the deterministic source gate tests directly:

```bash
node --test tests/cli/source-boundary.test.js
```

The inspector hashes at most 8 MiB from one user-selected regular file, rejects symlinks and special files, and never returns source content or an absolute path. This gate establishes a trust boundary; it does not make the source true, safe, or consented for persistence.
