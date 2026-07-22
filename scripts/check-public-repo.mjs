#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deleted = new Set(
  execFileSync("git", ["ls-files", "-z", "--deleted"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean),
);
const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter((file) => file && !deleted.has(file));

const errors = [];
const maximumScannableBytes = 8_000_000;
const mutableMainTrustRoot =
  ["raw.githubusercontent.com", "cerncaycisi", "scalvin", "main"].join("/") +
  "/";

const forbiddenTrackedPaths = [
  /^profile\.md$/,
  /^ACTIVE-THEMES\.md$/,
  /^CURRENT-FOCUS\.md$/,
  /^NEXT-PRIMER\.md$/,
  /^sessions\//,
  /^sources\//,
  /^archive\//,
  /^\.therapy\//,
  /^\.scalvin\//,
  /^\.audit\//,
  /(?:^|\/)\.env(?:\.|$)/,
];

const contentChecks = [
  {
    name: "absolute local Unix user or volume path",
    pattern:
      /\/(?:Users|home|Volumes)\/[A-Za-z0-9._-]+\/|\/root\/|\/mnt\/[a-z]\/Users\/[A-Za-z0-9._-]+\//i,
  },
  {
    name: "absolute Windows profile path",
    pattern:
      /[A-Za-z]:\\(?:Users|Accounts|Profiles|Documents and Settings)\\[^\\\r\n]+\\/i,
  },
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: "credential-like token",
    pattern:
      /\b(?:sk[-_][A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
  {
    name: "assigned secret-like value",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/i,
  },
];

for (const file of tracked) {
  if (
    file !== ".env.example" &&
    forbiddenTrackedPaths.some((pattern) => pattern.test(file))
  ) {
    errors.push(`${file}: sensitive/generated path must not be tracked`);
    continue;
  }

  const absolute = path.join(root, file);
  let buffer;
  try {
    buffer = readFileSync(absolute);
  } catch (error) {
    errors.push(`${file}: cannot read tracked file (${error.message})`);
    continue;
  }

  if (buffer.length > maximumScannableBytes) {
    errors.push(
      `${file}: exceeds the bounded public-content scan limit (${maximumScannableBytes} bytes)`,
    );
    continue;
  }

  // Decode every bounded candidate, including files containing NUL bytes.
  // Credential and private-key markers are ASCII and remain detectable in
  // UTF-8-decoded binary content; an embedded NUL must never bypass scanning.
  const text = buffer.toString("utf8");
  for (const check of contentChecks) {
    if (check.pattern.test(text)) {
      errors.push(`${file}: contains ${check.name}`);
    }
  }

  if (
    file !== "CHANGELOG.md" &&
    text.includes(mutableMainTrustRoot)
  ) {
    errors.push(`${file}: mutable raw main URL is not an update trust root`);
  }
}

if (errors.length > 0) {
  process.stderr.write("Public-repository safety check failed:\n");
  for (const error of errors) {
    process.stderr.write(`- ${error}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `Public-repository safety check passed (${tracked.length} candidate files).\n`,
);
