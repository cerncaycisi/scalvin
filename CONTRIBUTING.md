# Contributing To Scalvin

Thanks for helping improve the project.

## What This Repo Is

Scalvin is a local-first therapeutic companion system.

It is not:

- a cloud note product
- a generic chatbot prompt pack
- a place for real user case material

It is:

- a repo for the reusable system
- a repo for persona, modality, structure, and runtime logic
- a repo for safer long-form continuity around AI-supported reflection

## High-Value Contribution Areas

- bootstrap flow clarity
- client-adapter improvements that keep the core system generic
- clinically grounded modality additions or refinements
- safer source/archive/review behavior
- memory hygiene improvements
- documentation that helps people use the system without leaking private data

## Do Not Contribute

- real private journals, session notes, profiles, or user archives
- changes that assume one vendor or tool is the only supported client
- "smart" shortcuts that weaken safety, archive discipline, or source discipline
- changes that require uploading user notes to remote services

## Design Rules

- preserve the local-first model
- keep the generated workspace self-contained
- keep adapters thin and the runtime central
- prefer reliability over cleverness in core flows
- preserve user-specific living files as editable files, not hidden magic

## Safety-Sensitive Areas

These require extra care in PRs:

- `safety-protocol.md`
- runtime files that affect crisis handling, review cadence, or source reopening
- import logic
- any change that alters what becomes durable memory

When touching these, explain:

- what changed
- why it changed
- what risk it reduces
- what new risk it might introduce

## Pull Requests

1. Describe the problem being solved.
2. Say whether the change affects bootstrap behavior, runtime behavior, privacy, or safety.
3. Note whether you tested the conversational bootstrap or returning-session flow.
4. If something could not be tested, say that explicitly.

## Style

- be specific
- be kind
- be evidence-aware
- avoid inflated product language
