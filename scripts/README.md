# Scripts

Maintenance scripts for the Scalvin repo. Not required to use Scalvin -- only useful for contributors and maintainers.

## clean-for-distribution.sh

Removes macOS resource fork files (`._*`), Finder metadata (`.DS_Store`), and `__MACOSX/` directories from the working tree. Run before creating a release zip or committing work done on macOS.

    ./scripts/clean-for-distribution.sh

Safe to run repeatedly. Does not touch git-tracked files or the `.git/` directory.
