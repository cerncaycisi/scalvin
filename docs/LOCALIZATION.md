# Language And Localization

Scalvin is language-neutral at runtime. No conversation language is primary,
secondary, or privileged. The repository documentation is maintained in
English for contributor consistency; that is not a runtime default or a claim
that English behavior is more complete.

## Runtime contract

- The stored preference is `auto` or a canonical
  [BCP 47](https://www.rfc-editor.org/info/bcp47) language tag such as
  `es-419`, `zh-Hant`, or `ar`.
- `auto` follows the user's current language and mixed-language register. An
  explicit current-turn request outranks the stored preference.
- Do not force language purity. Preserve code-switching, names, quoted text,
  idiom, and user-defined terms when they carry meaning.
- Translate conversational function, safety meaning, and tone rather than
  replacing words literally or importing source-language therapeutic jargon.
- Ask when slang, an idiom, pronoun, register, or culturally specific expression
  is ambiguous.
- If the model cannot communicate reliably in the requested language, say so
  plainly and let the user choose a fallback. Do not silently switch languages.
- Do not persist a language preference unless the applicable persistence
  consent permits it. Returning to `auto` is always available.

Language, location, timezone, and culture are separate signals. Never infer a
country, emergency number, timezone, ethnicity, religion, gender, values, or
preferred formality from a language tag.

## Stable data contract

Code, paths, manifest fields, consent states, ledger status values, and stable
IDs remain language-neutral. User-authored text is stored as Unicode without
translating or transliterating it for persistence. A display translation must
never overwrite the original record.

UI and adapter implementations must support Unicode text, bidirectional
scripts, combining marks, and mixed scripts without treating visual order as a
security boundary. Exact IDs and confirmation tokens use the language-neutral
machine value shown by the CLI.

## Mechanical safety packs

The prose safety protocol and contextual response rules apply in every
language. The optional mechanical hook is narrower: it scans every installed,
validated locale pack under `hooks/safety-locales/` and never selects a pack by
guessing the user's language.

Locale packs are bounded data files named with their canonical BCP 47 tag. The
core matcher contains no preferred-language branch. Adding or removing a pack
does not change consent, safety authority, crisis routing, or any other product
policy.

Coverage truth matters:

- a locale pack detects only its tested patterns and can miss paraphrases;
- passing a corpus is not a clinical assessment or proof of safety;
- hook silence never establishes that a message is safe;
- documentation translation alone does not create detector coverage;
- the currently bundled `en` and `tr` packs are two finite, independently
  tested detector packs, not the set of languages Scalvin can converse in.

Every bundled pack needs first-person must-fire cases; quoted, third-person,
historical, media, professional, grief, venting, and ordinary-language
boundaries; common idioms; measured over-fire cases; and documented known
failures. CI derives the required pack inventory from the pack files rather
than hard-coding a favored language pair.

## Emergency resources

Emergency and crisis resources depend on verified location, not conversation
language. Ask for country or region only when it is needed, verify current
official information, and do not promise availability, confidentiality, cost,
or operating hours without evidence. A translated resource sentence does not
prove that the service applies to that user.

## Personas and modalities

Persona and modality files specify intent, boundaries, and conversational
shape. They do not require a sentence in any particular natural language.
Runtime phrasing should be generated in the user's current language and tested
for meaning, consent, safety, and naturalness by fluent reviewers. An example
written in the repository's documentation language is illustrative source text,
not a fixed script.

## Contributing a locale pack or translation

A contribution must include:

1. a canonical BCP 47 scope and a description of dialect/register limits;
2. review by a fluent speaker, with reviewer consent to public attribution or
   an auditable private maintainer record;
3. safety boundary and false-positive corpus cases where a detector pack is
   involved;
4. culturally and legally cautious resource wording, separated from language
   detection;
5. automated Unicode, mixed-language, and malformed-input tests;
6. known limitations and a non-certification statement.

Do not claim full language support from machine translation, a small prompt
sample, or a passing keyword corpus. Release notes must state exactly what was
reviewed and what remains unverified.
