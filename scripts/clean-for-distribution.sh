#!/usr/bin/env bash
# Remove macOS filesystem noise before packaging or committing.
# Safe to run repeatedly. Does not touch git-tracked files.

set -euo pipefail

refuse() {
  printf 'refusing cleanup: %s\n' "$1" >&2
  exit 64
}

script_source="${BASH_SOURCE[0]}"
if [[ "$script_source" != /* ]]; then
  script_source="$PWD/$script_source"
fi

if [[ -L "$script_source" ]]; then
  refuse "the cleanup script is a symbolic link"
fi

logical_script_dir="$(cd -- "$(dirname -- "$script_source")" && pwd -L)"
physical_script_dir="$(cd -P -- "$(dirname -- "$script_source")" && pwd -P)"
if [[ "$logical_script_dir" != "$physical_script_dir" ]]; then
  refuse "the cleanup script path contains a symbolic link"
fi

repo_root="$(cd -P -- "$physical_script_dir/.." && pwd -P)"
if [[ "$physical_script_dir/$(basename -- "$script_source")" != \
  "$repo_root/scripts/clean-for-distribution.sh" ]]; then
  refuse "the cleanup script is not in the expected repository location"
fi

if ! git_root="$(git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null)"; then
  refuse "no Git repository was found at the script root"
fi
if ! git_root="$(cd -P -- "$git_root" && pwd -P)"; then
  refuse "the Git repository root cannot be resolved"
fi
if [[ "$git_root" != "$repo_root" ]]; then
  refuse "the script root is not the Git repository root"
fi

cd -- "$repo_root"

echo "Cleaning untracked macOS metadata from: $repo_root"

removed=0
skipped=0

remove_untracked_file() {
  local path="$1"
  local git_path="${path#./}"

  if git ls-files --error-unmatch -- "$git_path" >/dev/null 2>&1; then
    printf 'skip tracked: %s\n' "$path"
    skipped=$((skipped + 1))
    return
  fi

  printf 'remove: %s\n' "$path"
  rm -f -- "$path"
  removed=$((removed + 1))
}

while IFS= read -r -d '' path; do
  remove_untracked_file "$path"
done < <(
  find . \
    -path './.git' -prune -o \
    -type f \( -name '._*' -o -name '.DS_Store' \) \
    -print0
)

while IFS= read -r -d '' path; do
  git_path="${path#./}"
  if [[ -n "$(git ls-files -- "$git_path")" ]]; then
    printf 'skip directory containing tracked files: %s\n' "$path"
    skipped=$((skipped + 1))
    continue
  fi

  printf 'remove directory: %s\n' "$path"
  rm -rf -- "$path"
  removed=$((removed + 1))
done < <(
  find . \
    -path './.git' -prune -o \
    -type d -name '__MACOSX' \
    -print0
)

printf 'Done. removed=%d skipped=%d\n' "$removed" "$skipped"
