#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.md"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const failures = [];
const inlineLink = /!?\[[^\]]*]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

for (const file of files) {
  const absolute = path.join(root, file);
  const text = readFileSync(absolute, "utf8");
  let match;
  while ((match = inlineLink.exec(text)) !== null) {
    let target = match[1];
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target) ||
      target.includes("{{")
    ) {
      continue;
    }

    const pathname = target.split("#", 1)[0].split("?", 1)[0];
    if (!pathname) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      failures.push(`${file}: invalid URL encoding in ${target}`);
      continue;
    }

    const resolved = decoded.startsWith("/")
      ? path.join(root, decoded.slice(1))
      : path.resolve(path.dirname(absolute), decoded);
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line}: missing relative link target ${target}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write("Markdown link check failed:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Markdown link check passed (${files.length} files).\n`);
