# Engineering Experiment Log

This public-safe log records material implementation experiments so future
contributors do not repeat known failures or mistake a partial check for proof.
It is not a changelog and must never contain personal content, credentials,
private workspace paths, or machine-specific secret values.

For each material experiment, record:

- date and tested client/runtime version when relevant;
- the exact hypothesis or configuration;
- measured outcome and evidence;
- the rule future work should reuse;
- unresolved limitations separately from confirmed behavior.

Small unit-test iterations do not need individual entries. Consolidate them
when they establish a reusable engineering rule.

## 2026-07-22 hardening experiments

### Interactive broker approval

- Attempt: combine Claude Code `dontAsk` with mutating Scalvin MCP tools in the
  `permissions.ask` list.
- Result: rejected design. Claude Code documents that `dontAsk` auto-denies
  calls which would otherwise prompt, including explicit `ask` rules.
- Reuse rule: run the main Claude companion in `default` permission mode;
  pre-approve only bounded read-only broker tools and keep every mutator in
  `ask`.
- Evidence: canonical client-policy tests and the current
  [Claude Code permission-mode documentation](https://code.claude.com/docs/en/permission-modes).

- Attempt: combine Codex `-a never` with `default_tools_approval_mode =
  "prompt"` for mutating broker tools.
- Result: rejected design. A no-prompt launch cannot provide the intended
  interactive MCP authorization.
- Reuse rule: the supervised main Codex launch relies on the project granular
  approval policy, with only bounded read-only broker tools set to `auto`.
  Source workers remain non-interactive because their separate surface exposes
  exactly three isolated tools and no main-broker authority.
- Evidence: canonical client-policy tests plus the current
  [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

### Codex effective configuration

- Attempt: load a generated project profile with an installed Codex CLI and
  treat a successful config parse as hard-boundary attestation.
- Result: partial success only. The profile parsed, but installation/PATH and
  non-interactive terminal diagnostics were unrelated failures; parsing did
  not prove effective runtime enforcement.
- Reuse rule: use `--ignore-user-config` and `--ignore-rules` for the supervised
  main launch, but continue reporting `hardBoundaryAttested: false` until an
  exact-candidate effective-runtime probe exists.

### Source-worker tool isolation

- Finding: disabling visible apps and browser features did not disable Codex
  shell facilities because `shell_tool` and `unified_exec` have independent
  feature switches.
- Result: fixed. Both switches are explicitly disabled in the generated main
  profile and isolated worker launch; worker tests assert the flags.
- Reuse rule: when adding a new client version, inventory every enabled-by-
  default tool feature instead of inferring tool isolation from a short list of
  disabled features.

### Client executable resolution

- Attempt: reject every symlink found through `PATH` when locating Codex or
  Claude.
- Result: rejected design. Normal client installations commonly expose a
  symlink, so the strict check made a valid installation unusable.
- Reuse rule: resolve the candidate with `realpath`, reject unsafe path
  traversal, and execute only the verified regular-file target.
- Evidence: a regression test covers a symlinked `PATH` entry and exact target
  resolution.

### Manifest-bound test runs

- Attempt: run installation-dependent tests while managed files were still
  being edited.
- Result: invalid test run. Expected `DISTRIBUTION_INTEGRITY_FAILED` errors were
  caused by stale manifest hashes rather than product behavior.
- Reuse rule: finish edits, run `npm run inventory:refresh` and `npm run
  manifest:refresh`, freeze the worktree, then run `npm run check` and the full
  test suite. Do not edit managed files during that suite.

### Local workspace pointer during smoke installs

- Finding: a smoke install from a source checkout can update the gitignored
  local workspace pointer.
- Result: the temporary pointer was removed after verifying it did not identify
  a live user workspace.
- Reuse rule: isolate smoke runs with a temporary local-state directory when
  possible, or set the supported pointer-disable switch for tests that do not
  need pointer behavior. Never overwrite or delete an existing pointer without
  first validating the referenced workspace.

### Runtime contract tests after boundary changes

- Finding: after weekly review and context-graph access became terminal-only,
  one safety contract test still required the removed direct-read/runtime
  wording.
- Result: product behavior was correct; the stale assertion was replaced with
  checks for typed session startup, direct-private-access denial, and explicit
  terminal-only review handling.
- Reuse rule: when a capability moves behind the broker or becomes
  terminal-only, update both positive and negative contract assertions. Do not
  restore obsolete runtime authority merely to satisfy an old string test.

### Safety-hook timing under the complete test workload

- Attempt: give the normal hook CLI contract test a 250 ms internal worker
  deadline while Node's complete test runner executes many files concurrently.
- Result: rejected test configuration. The same test passed in isolation and
  in the prior complete run but once degraded under full-run contention,
  exercising the hook's intentional timeout path instead of its fire/silent
  contract.
- Reuse rule: normal CLI contract tests use the production 1500 ms hook
  deadline and a separate process-start allowance. The repository test runner
  caps file-level concurrency at two, and CI reserves enough wall time for the
  complete security-heavy suite. Timeout/fail-open behavior keeps its own
  explicit short-deadline tests; do not conflate host scheduling delay with
  functional classification assertions.
