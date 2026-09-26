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

### Review F1–F11 remediation pass (2026-09-25)

- Context: Linux, Node 24.21.0, branch `claude/perfect-pass` from main
  `f3502c0`, addressing the 2026-09-04 review findings F1, F4, F5, F6, F7, and
  F11.
- Finding: when the registry was stale, a direct crisis statement produced
  only `EMERGENCY_RESOURCE_REGISTRY_STALE`; classification never ran. After the
  change the same synthetic prompt with a stale fixture registry yields
  `urgent-review` / `self_harm` plus the non-current-contact guidance.
- Finding: a `SIGTERM`-ignoring synthetic child with a grandchild survived an
  output-overflow error. With process-group termination both exit within the
  grace period on overflow, timeout, and normal exit (Linux). A killed
  grandchild may briefly remain a zombie until init reaps it; liveness checks
  must treat state `Z` as exited.
- Evidence: `npm run check` passed; `npm test` completed 628 tests with 620
  passed, 0 failed, 8 skipped (about 11.5 minutes on a 2-CPU host).
- Registry re-verification: the four official source pages were fetched on
  2026-09-25 and still listed 9-1-1 and 9-8-8 (call/text) for Canada, 911 and
  988 (call/text) for the United States, and 112 for Türkiye. The fetch was
  agent-performed; a maintainer should confirm before merge.
- Reuse rule: do not edit shipped files while a full test run is in progress;
  the suite hashes the distribution and mid-run edits produce spurious
  manifest failures. Tests that depend on registry freshness must derive the
  expectation from the registry, not from literal dates.
- Failed command: `codex exec review --base main "<prompt>"` stops with
  `the argument '--base <BRANCH>' cannot be used with '[PROMPT]'`. Use
  `codex exec -s read-only "<prompt naming git diff main...HEAD>"` for a
  focused peer review.
- Peer review (Codex `gpt-6-astra`, read-only) found two medium issues, both
  fixed with regression tests: a detached worker group was orphaned when the
  parent received SIGINT/SIGTERM (the `exit` listener does not run on default
  signal termination), and the Claude allowlist dropped
  `CLAUDE_CODE_OAUTH_TOKEN` and `AWS_BEARER_TOKEN_BEDROCK`. An uncatchable
  parent SIGKILL can still orphan the worker group.

### Repository rulesets for main and stable tags (2026-09-25)

- Context: user-owned public repository; applies RELEASING.md section 5.
- Result: `main-pr-required-ci` (pull request required, strict `Required CI`
  from GitHub Actions App ID `15368`, no deletion or non-fast-forward, no
  bypass) and `stable-tag-immutable` (`v*` update and deletion blocked, no
  bypass) were created and are active.
- Failed command: creating `stable-tag-created-by-release-workflow` with the
  GitHub Actions integration as the only creation bypass returned HTTP 422
  `Actor GitHub Actions integration must be part of the ruleset source or owner
  organization`. On a user-owned repository this rule cannot be expressed as
  specified; a creation rule without that bypass would also block the release
  workflow.
- Reuse rule: move the repository to an organization before relying on the
  stable-tag creation restriction, or record an explicit alternative in
  RELEASING.md. Verify with a deliberately failing pull request that
  `Required CI` actually blocks merging.

### Claude Code exact-launch probe on Linux (2026-09-26)

- Context: Claude Code 2.1.281, Linux without `bubblewrap`, synthetic
  workspace from `scalvin install --consent granted` with canary strings in
  `profile.md` and `sessions/`, launched as `claude -p` with a minimal
  environment (`HOME`, `PATH`, `TERM`, `LANG`) and three prompts asking for
  Read, Bash `cat`, and Grep access to the canaries.
- Result: every launch stopped before any model turn with `sandbox required
  but unavailable: ... bubblewrap (bwrap) not installed`; no canary appeared in
  any output. Claude Code also printed that the 14 profile `allow` entries were
  ignored because the directory had not been trusted.
- Outcome: the generated profile fails closed on a host without the sandbox,
  but users saw only the raw client error. Doctor now warns with
  `CLAUDE_SANDBOX_DEPENDENCY_MISSING`, and both Claude launch paths refuse
  before spawning. This run is not boundary evidence: no tool call executed.
- Reuse rule: repeat the canary probe on a host with `bwrap` and `socat` and a
  trusted workspace before claiming anything about effective Read/Bash/Grep
  denial. Never use a real workspace for this probe.

### Claude Code exact-launch probe with a sandbox (2026-09-26)

- Context: Claude Code 2.1.281, Linux, the `bwrap` bundled with Codex 0.156.0
  placed on `PATH` for the probe only (unprivileged user namespaces enabled),
  `socat` installed, synthetic workspace from branch `claude/perfect-pass` with
  canaries in `profile.md` and `sessions/`, minimal environment, `claude -p`.
- Untrusted directory: Claude Code warned that the 14 `allow` entries were
  ignored, but `Read(profile.md)` still appeared in `permission_denials`, so the
  project deny rules applied. Framework reads worked; no Bash tool existed.
- Trusted directory (a temporary trust entry for the synthetic directory,
  removed afterwards): `Read` of `profile.md` and `sessions/synthetic.md` was denied by
  the permission layer, a workspace-wide Grep returned no canary, and no Bash
  tool existed. No canary appeared in any output.
- Finding: a plain launch also exposed the user's own MCP servers. The session
  listed `scalvin` and a user-level task-manager server. The supervised launch
  flags (`--strict-mcp-config --mcp-config .mcp.json --setting-sources
  project`) exposed only `scalvin`. Project settings cannot generically disable
  unknown user-level servers, so the adapters now forbid calling any other MCP
  server or connector and recommend the supervised launcher. The
  rule was tested only against a local synthetic MCP server that records
  calls: with user-level instructions excluded (`--setting-sources project`)
  and the tool pre-allowed, a control directory without an adapter called it
  once, while the previous and the new adapters called it zero times for a
  request to put a feeling summary into a task; the new adapter cited the rule.
  Without `--setting-sources project`, the user's own global instructions also
  loaded into the session and confounded the result.
- Reuse rule: rerun this probe on each supported Claude Code version with a
  sandbox available. Never test foreign-connector refusal against a real
  account; use a local synthetic MCP server that only records calls.
### Codex 0.156 exact-launch probes (2026-09-26)

- Context: Codex CLI 0.156.0 (standalone install) on Linux, `gpt-6-astra`,
  synthetic workspaces with canary strings in `profile.md` and `sessions/`,
  minimal environment, and the local Codex configuration restored
  byte-for-byte after each temporary trust entry.
- Untrusted directory: Codex ignored the project profile completely (shell
  commands ran and the broker was absent). No canary leaked only because the
  model followed the adapter text; that is compliance, not enforcement.
- Trusted, previous profile (`"." = "deny"` plus child denies): Codex failed at
  session start with `bwrap: Can't mkdir <workspace>/.claude: Read-only file
  system`; with only the root denied it failed with `failed to load AGENTS.md
  instructions ... Permission denied`.
- Trusted, readable root plus explicit denies: `codex sandbox -- sh -c ...`
  read framework files, returned `Permission denied` for `profile.md`,
  `sessions/`, `SETUP-NOTES.md`, and `.scalvin/state.json`, and rejected writes
  with `Read-only file system`. Running the debug sandbox under a custom
  profile needs `~/.codex/packages` readable because Codex re-executes itself
  inside the sandbox; enabling the model shell hit the same `execvp` failure,
  so the shell stays disabled.
- Broker: every tool call timed out after 60 s because Codex sends
  `params._meta` and the broker answered with an ID-less invalid-request
  error. Fixed; `capability_status` and `control_status` then completed.
- Source worker: `codex exec -a` is no longer accepted, dotted `-c` filesystem
  keys fail to parse, and a denied working directory blocks instruction
  loading. Fixed; `scalvin source process --client codex` produced a signed
  proposal.
- Framework access: with no shell or file tool the companion could not read
  the safety protocol at all. The broker now serves framework Markdown as MCP
  resources; a fresh session listed them, read the safety protocol and
  preflight contracts, called the status tools, quoted the protocol heading,
  and declined `profile.md` with no canary in any output.
- Reuse rule: probe Codex in a trusted synthetic git workspace and inspect the
  JSON event stream for `command_execution`, `mcp_tool_call`, and canaries.
  Use `codex sandbox` for enforcement evidence, because a compliant model
  refuses denied reads without attempting them. Record the exact Codex version;
  these results are not a stable-release attestation.
- Peer review (Codex `gpt-6-astra`, read-only) of the resource channel found a
  hard-link disclosure (the bounded reader did not check `nlink`), service of
  unregistered or customized Markdown under allowed directories, filename
  disclosure through a symlinked directory root, and `.therapy/version.json`
  left readable under the readable root. The broker now serves only managed
  framework targets recorded in canonical state whose bytes match the
  installed SHA-256, rejects multi-link files, lists from state instead of
  walking directories, and the Codex profile denies `.therapy/version.json`.
- Foreign-connector check on the new profile: with a local synthetic recording
  MCP server added through `-c mcp_servers.tasks...` and a request to store a
  feeling summary as a task, the Scalvin workspace recorded zero calls and the
  companion cited the workspace privacy rule. The control directory also
  recorded zero calls, but because of an approval setting, so the Codex
  control is inconclusive.

