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
- Follow-up: this exact invalid run recurred once during CodeQL hardening. The
  fail-closed `DISTRIBUTION_INTEGRITY_FAILED` results were discarded, the
  manifest was refreshed, and no conclusion was taken from that run.

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

### Cross-platform path assertions

- Finding: the first hardened CI run passed Linux and macOS but failed Windows
  because two tests treated host-native path rendering as the persisted data
  contract. A rendered TOML JSON string doubled Windows backslashes, while a
  session assertion expected `path.relative()` backslashes even though Scalvin
  intentionally stores manifest paths with `/` separators.
- Result: product behavior was correct. Broker-entry assertions now accept one
  or more serialized path separators, and the lifecycle test compares the
  persisted path with its original canonical value.
- Reuse rule: distinguish filesystem paths from serialized manifest paths and
  escaped configuration strings. Assert canonical `/` paths in stored state;
  make display/config assertions tolerate platform-specific escaping.

### CodeQL alert closure

- Finding: the first Advanced Security review reported nine alerts: two
  polynomial-regex parsers, four check-then-use file patterns, and three
  environment- or shell-controlled release commands.
- Result: linear parsing, descriptor-bound reads, and a deterministic
  shell-free npm CLI path closed eight alerts in the first fix pass. The
  remaining test-only alert came from an `access()` absence check before a
  later open and was removed by asserting the read failure directly.
- Reuse rule: require both the workflow's CodeQL analysis job and the separate
  pull-request Advanced Security check to pass. A successful SARIF upload is
  not proof that the uploaded analysis contains zero blocking alerts.

### Repository history cleanup

- Attempt: a native `git filter-branch` rehearsal removed the target path, but
  the final procedure used GitHub's recommended `git-filter-repo` sensitive-
  data workflow in a fresh mirror clone.
- Result: the approved obsolete archive went from one reachable Git object to
  zero across every branch and tag ref, and the rewritten mirror passed a full
  `git fsck`. Five historical pull-request refs were reported separately.
- Reuse rule: merge or close open pull requests first; create and verify a
  complete bundle; rewrite a fresh mirror; require zero reachable target
  objects and a clean object check; then force-push only reviewed branch/tag
  refs. GitHub pull-request refs are read-only and cached historical views must
  never be described as purged by an ordinary force-push.
- Failed command: a ref-specific `force-with-lease` push initially stopped with
  `fatal: --mirror can't be combined with refspecs` because a mirror clone sets
  `remote.origin.mirror=true`. Disable that local mirror-push setting before
  the reviewed ref push; do not replace the lease with an unrestricted mirror
  push.

### Default-branch CodeQL baseline audit

- Finding: a successful pull-request CodeQL check and a zero-result pull-
  request merge-ref analysis do not prove that the default branch has no open
  alerts. The repository API still reported 17 inherited alerts after an
  earlier pull request whose merge-ref analysis had zero results.
- Result: the baseline hardening replaced check-then-open reads with
  descriptor-first no-follow reads plus device/inode and post-read checks,
  replaced polynomial-risk regex parsing with linear scans, and removed
  test-only dynamic JavaScript construction. Pull request 6 passed all nine
  CI jobs plus the separate CodeQL check; its merge-ref analysis evaluated 103
  rules with zero results. Final acceptance still requires a later
  default-branch analysis with zero results and an empty open-alert API result.
- Evidence: local validation completed 618 tests with zero failures, `npm run
  check`, and an npm package dry run. Pull-request CI run `30083802393` passed
  Linux Node 20/22/24, macOS Node 20/24, Windows Node 20/24, Python 3.12,
  security-extended CodeQL, and Required CI.
- Reuse rule: query the code-scanning analyses and open-alert endpoints after
  the exact commit reaches the default branch. Never treat PR-only
  `results_count: 0`, a successful SARIF upload, or a green "new alerts" check
  as baseline closure.
- Failed command: `node --test tests/safety` stopped with
  `MODULE_NOT_FOUND` because Node did not expand the directory into this
  repository's test set. Use `npm run test:safety`.
- Failed command: a regular-expression `rg` scan containing an incorrectly
  escaped newline stopped with `rg: the literal "\n" is not allowed in a
  regex`. Use fixed-string `rg -F` expressions for literal source-pattern
  inventory.
