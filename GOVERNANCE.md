# Project Governance

Scalvin is currently maintainer-led. The maintainer owns release decisions,
security response, compatibility policy, and the final merge decision.

## Decision priorities

When goals conflict, decisions follow this order:

1. prevent material safety or privacy harm;
2. preserve user control and truthful product boundaries;
3. protect data and update integrity;
4. preserve backward compatibility or provide migration;
5. improve conversation quality and features;
6. reduce maintenance cost.

## Safety-sensitive changes

Changes to crisis behavior, durable memory, consent, source processing,
high-risk modalities, update trust, backup, or restore require:

- an explicit threat/failure analysis;
- deterministic tests or eval cases;
- documentation and migration impact;
- review by someone other than the author when the project has multiple active
  maintainers;
- a release note.

## External work

Adapted work must satisfy its license and attribution requirements and be
evaluated against Scalvin's architecture, safety invariants, and multi-client
model. External changes are never merged only because they exist elsewhere.

## Releases

A stable release is authorized only through the `main` workflow after required
CI passes, version and manifest checks agree, migration notes are complete, a
clean install/update/restore smoke test succeeds, and the protected environment
verifies independent stable-release evidence. Repository admins must keep the
documented branch, tag, and environment rules live and verify them before a
release; workflow source alone does not prevent direct server-side tag writes.
