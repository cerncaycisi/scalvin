import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(root, ".test-tmp");

function runIsolatedPublicCheck(content) {
  mkdirSync(testRoot, { recursive: true });
  const fixtureRoot = mkdtempSync(path.join(testRoot, "public-check-"));
  try {
    mkdirSync(path.join(fixtureRoot, "scripts"));
    copyFileSync(
      path.join(root, "scripts", "check-public-repo.mjs"),
      path.join(fixtureRoot, "scripts", "check-public-repo.mjs"),
    );
    writeFileSync(path.join(fixtureRoot, "candidate.bin"), content);
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    return spawnSync(process.execPath, ["scripts/check-public-repo.mjs"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test("public repository candidates contain no private workspace data or secrets", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-public-repo.mjs"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test("security policy has concrete private-report response targets and retains safe harbor", () => {
  const policy = readFileSync(path.join(root, "SECURITY.md"), "utf8");
  assert.match(policy, /private vulnerability reporting/i);
  assert.match(policy, /acknowledgement within 3 business days/i);
  assert.match(policy, /initial triage within 10 business days/i);
  assert.match(policy, /authorized security research/i);
  assert.match(policy, /will not initiate legal action/i);
});

test("canonical client configuration formats keep deterministic LF line endings", () => {
  const attributes = readFileSync(path.join(root, ".gitattributes"), "utf8");
  assert.match(attributes, /^\*\.toml text eol=lf$/m);
  assert.match(attributes, /^\*\.json text eol=lf$/m);
  const codexTemplate = readFileSync(
    path.join(root, "adapters", "workspace", "codex.config.template.toml"),
    "utf8",
  );
  assert.doesNotMatch(codexTemplate, /\r/);
});

test("stable-release workflow stages tag creation after required CI and signed-evidence verification", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.doesNotMatch(workflow, /^\s+tags:\s*$/m, "a pushed tag must not be the release trigger");
  assert.match(workflow, /^\s+required-ci:\s*$/m);
  assert.match(workflow, /^\s+name: Required CI\s*$/m);
  assert.match(workflow, /MATRIX_RESULT: \$\{\{ needs\.test\.result \}\}/);
  assert.match(workflow, /PYTHON_RESULT: \$\{\{ needs\.compatibility-python\.result \}\}/);
  assert.match(workflow, /^\s+release-preflight:\s*$/m);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.stable_version != ''/);
  assert.match(workflow, /^\s+stable-release:\s*$/m);
  assert.match(workflow, /^\s+environment: stable-release\s*$/m);

  const preflightIndex = workflow.indexOf("  release-preflight:");
  const stableIndex = workflow.indexOf("  stable-release:");
  assert.ok(preflightIndex >= 0 && stableIndex > preflightIndex);
  const preflight = workflow.slice(preflightIndex, stableIndex);
  const stable = workflow.slice(stableIndex);
  assert.match(preflight, /needs:\s*\n\s+- required-ci/);
  assert.match(preflight, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(preflight, /test "\$release_channel" = "stable"/);
  assert.match(stable, /needs:\s*\n\s+- release-preflight/);
  assert.equal((workflow.match(/^\s+contents: write\s*$/gm) || []).length, 1);
  assert.equal((workflow.match(/^\s+id-token: write\s*$/gm) || []).length, 1);
  assert.equal((workflow.match(/^\s+attestations: write\s*$/gm) || []).length, 1);

  const verifyIndex = workflow.indexOf("node cli/verify-release-evidence.js");
  const artifactIndex = workflow.indexOf('node scripts/build-release-artifacts.mjs');
  const cleanInstallIndex = workflow.indexOf('node scripts/verify-release-package.mjs');
  const attestAction = 'uses: actions/attest@a1948c3f048ba23858d222213b7c278aabede763';
  const provenanceIndex = workflow.indexOf('id: attest-release-provenance');
  const sbomAttestationIndex = workflow.indexOf('id: attest-release-sbom');
  const preserveIndex = workflow.indexOf('name: Preserve attestation bundles with the release candidates');
  const uploadIndex = workflow.indexOf('uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
  const tagIndex = workflow.indexOf('git tag -a "$tag" "$GITHUB_SHA"');
  const pushIndex = workflow.indexOf('git push origin "refs/tags/${tag}"');
  assert.ok(verifyIndex >= 0, "signed release evidence must be verified");
  assert.ok(artifactIndex > verifyIndex, "release artifacts must follow signed-evidence verification");
  assert.ok(cleanInstallIndex > artifactIndex, "the packed candidate must be clean-install verified");
  assert.equal(workflow.split(attestAction).length - 1, 2);
  assert.ok(provenanceIndex > cleanInstallIndex, "only a verified archive may receive build provenance");
  assert.ok(sbomAttestationIndex > provenanceIndex, "the same archive must receive a separate SBOM attestation");
  assert.ok(preserveIndex > sbomAttestationIndex, "both attestation bundles must be preserved");
  assert.ok(uploadIndex > preserveIndex, "only a fully attested candidate set may be uploaded");
  assert.ok(tagIndex > uploadIndex, "the stable tag must be created after evidence and artifact verification");
  assert.ok(pushIndex > tagIndex, "the stable tag must be pushed only after local creation");
  assert.equal(workflow.split('git push origin "refs/tags/${tag}"').length - 1, 1);
  assert.match(stable, /scalvin-\$\{VERSION\}\.tgz\.sha256/);
  assert.match(stable, /scalvin-\$\{VERSION\}\.spdx\.json/);
  assert.match(stable, /scalvin-\$\{VERSION\}\.provenance\.intoto\.jsonl/);
  assert.match(stable, /scalvin-\$\{VERSION\}\.sbom\.intoto\.jsonl/);
});

test("public scan detects a common dash-token marker even after a NUL byte", () => {
  const syntheticMarker = ["sk", "-", "A".repeat(24)].join("");
  const result = runIsolatedPublicCheck(
    Buffer.concat([Buffer.from([0]), Buffer.from(syntheticMarker)]),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /candidate\.bin: contains credential-like token/);
  assert.doesNotMatch(result.stderr, new RegExp(syntheticMarker));
});

test("public scan fails closed when a candidate exceeds its scan bound", () => {
  const result = runIsolatedPublicCheck(Buffer.alloc(8_000_001, 0x61));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /candidate\.bin: exceeds the bounded public-content scan limit/);
});

test("public scan rejects local Unix and alternate Windows profile paths", () => {
  const unixPath = ["", "home", "private-user", "project"].join("/");
  const windowsPath = ["C:", "Accounts", "PrivateUser", "project"].join("\\");
  const result = runIsolatedPublicCheck(`${unixPath}\n${windowsPath}\\\n`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains absolute local Unix user or volume path/);
  assert.match(result.stderr, /contains absolute Windows profile path/);
  assert.doesNotMatch(result.stderr, /private-user|PrivateUser/);
});
