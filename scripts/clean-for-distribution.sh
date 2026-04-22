#!/usr/bin/env bash
# Remove macOS filesystem noise before packaging or committing.
# Safe to run repeatedly. Does not touch git-tracked files.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "Cleaning macOS metadata from: $repo_root"

# Remove resource fork sidecars
find . -name '._*' -not -path './.git/*' -print -delete

# Remove Finder metadata
find . -name '.DS_Store' -not -path './.git/*' -print -delete

# Remove __MACOSX directories produced by some zip tools
find . -type d -name '__MACOSX' -not -path './.git/*' -print -exec rm -rf {} + 2>/dev/null || true

echo "Done."
