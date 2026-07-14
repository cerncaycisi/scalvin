import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = path.join(root, ".test-tmp", "cleanup-script");

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: fixture,
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function run(command, args, options = {}) {
  const result = execute(command, args, options);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function installCleanupScript(targetRoot) {
  const scripts = path.join(targetRoot, "scripts");
  mkdirSync(scripts, { recursive: true });
  const script = path.join(scripts, "clean-for-distribution.sh");
  copyFileSync(path.join(root, "scripts", "clean-for-distribution.sh"), script);
  chmodSync(script, 0o755);
  return script;
}

function assertRefused(result, message) {
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, new RegExp(`refusing cleanup: ${message}`));
}

test(
  "distribution cleanup removes only untracked metadata",
  { skip: process.platform === "win32" },
  () => {
    rmSync(fixture, { recursive: true, force: true });
    mkdirSync(path.join(fixture, "__MACOSX"), { recursive: true });

    const script = installCleanupScript(fixture);

    writeFileSync(path.join(fixture, "._tracked"), "must remain\n");
    writeFileSync(
      path.join(fixture, "__MACOSX", "tracked.txt"),
      "must remain\n",
    );

    run("git", ["init", "-q"]);
    run("git", ["add", "._tracked", "__MACOSX/tracked.txt"]);

    writeFileSync(path.join(fixture, "._untracked"), "remove\n");
    writeFileSync(path.join(fixture, ".DS_Store"), "remove\n");
    mkdirSync(path.join(fixture, "nested", "__MACOSX"), { recursive: true });
    writeFileSync(
      path.join(fixture, "nested", "__MACOSX", "noise.txt"),
      "remove\n",
    );

    run("bash", [script]);

    assert.equal(existsSync(path.join(fixture, "._tracked")), true);
    assert.equal(
      existsSync(path.join(fixture, "__MACOSX", "tracked.txt")),
      true,
    );
    assert.equal(existsSync(path.join(fixture, "._untracked")), false);
    assert.equal(existsSync(path.join(fixture, ".DS_Store")), false);
    assert.equal(
      existsSync(path.join(fixture, "nested", "__MACOSX")),
      false,
    );

    rmSync(fixture, { recursive: true, force: true });
  },
);

test(
  "distribution cleanup refuses a non-Git root without deleting metadata",
  { skip: process.platform === "win32" },
  () => {
    rmSync(fixture, { recursive: true, force: true });
    mkdirSync(fixture, { recursive: true });
    const script = installCleanupScript(fixture);
    const metadata = path.join(fixture, ".DS_Store");
    writeFileSync(metadata, "must remain\n");

    const result = execute("bash", [script], {
      env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
    });

    assertRefused(result, "no Git repository was found at the script root");
    assert.equal(existsSync(metadata), true);
    rmSync(fixture, { recursive: true, force: true });
  },
);

test(
  "distribution cleanup refuses a script below the Git root",
  { skip: process.platform === "win32" },
  () => {
    rmSync(fixture, { recursive: true, force: true });
    mkdirSync(fixture, { recursive: true });
    run("git", ["init", "-q"]);
    const nestedRoot = path.join(fixture, "nested");
    const script = installCleanupScript(nestedRoot);
    const metadata = path.join(nestedRoot, ".DS_Store");
    writeFileSync(metadata, "must remain\n");

    const result = execute("bash", [script]);

    assertRefused(result, "the script root is not the Git repository root");
    assert.equal(existsSync(metadata), true);
    rmSync(fixture, { recursive: true, force: true });
  },
);

test(
  "distribution cleanup refuses a symlinked script root",
  { skip: process.platform === "win32" },
  () => {
    rmSync(fixture, { recursive: true, force: true });
    const realRoot = path.join(fixture, "real");
    mkdirSync(realRoot, { recursive: true });
    installCleanupScript(realRoot);
    run("git", ["init", "-q"], { cwd: realRoot });
    const metadata = path.join(realRoot, ".DS_Store");
    writeFileSync(metadata, "must remain\n");
    const linkedRoot = path.join(fixture, "linked");
    symlinkSync(realRoot, linkedRoot, "dir");

    const result = execute(
      "bash",
      [path.join(linkedRoot, "scripts", "clean-for-distribution.sh")],
      { cwd: fixture },
    );

    assertRefused(
      result,
      "the cleanup script path contains a symbolic link",
    );
    assert.equal(existsSync(metadata), true);
    rmSync(fixture, { recursive: true, force: true });
  },
);
