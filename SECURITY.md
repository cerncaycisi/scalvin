# Privacy & Security Guide

Scalvin is designed around local files and user-controlled workspaces.

## Threat Model Basics

Scalvin protects the workspace better than a cloud note app, but it does not magically make hosted model providers disappear.

There are two separate privacy layers:

1. local workspace privacy
2. model-provider privacy

## Local Workspace Privacy

By default, generated files stay on your machine:

- `profile.md`
- `sessions/`
- `sources/`
- `archive/`
- runtime files

This is already much better than keeping sensitive material in a browser app with opaque storage.

## Model Provider Privacy

If you use Codex, Claude Code, ChatGPT, or another hosted model, your live messages still pass through that provider unless you run a local model.

Scalvin does not change that.

What it does change is this:

- the long-term memory stays in your files
- your continuity does not depend on one vendor's chat history
- you can move the workspace between tools

## Recommended Defaults

- use a password on your computer
- turn on full-disk encryption
- keep companion workspaces outside cloud-synced folders unless you understand the tradeoff
- back up important workspaces safely

## For Shared Computers

Prefer encrypted storage such as:

- encrypted disk images on macOS
- VeraCrypt containers on Windows

## For Maximum Privacy

If you need conversations to never leave your device:

- run a local model
- keep the workspace in encrypted local storage

Expect lower model quality than hosted frontier models.

## Security Reporting

If you publish this repo, add a private reporting path here.

Until then:

- treat safety and privacy issues as high-priority local fixes
- do not post real private workspace content in issues or PRs
