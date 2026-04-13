# Scalvin

A local-first AI companion system for long-form therapeutic continuity.

Built from the MIT-licensed [Inner Dialogue](https://github.com/ataglianetti/inner-dialogue) project, redesigned around a self-evolving runtime that grows with the user.

## What It Does

You open the folder, say hi, and start talking. The companion:

- introduces itself and begins the first session immediately -- no setup wizard
- learns about you over the first few sessions and builds your profile automatically
- writes session notes, tracks active themes, and maintains a working therapeutic focus
- evolves its own operational files as it learns your patterns, defenses, and preferences
- integrates source documents (journals, old notes, clinical records) and indexes them for selective reopening
- runs weekly self-reviews to catch drift, update formulations, and audit its own behavior
- detects model-specific tendencies (GPT over-mirroring, Claude over-formulating) and corrects for them
- supports backup and export of the entire workspace

Everything stays on your machine in plain markdown files. You own your data.

## How It Works

Scalvin creates a separate living workspace that holds:

- `profile.md` -- lean core memory, grows over time
- `ACTIVE-THEMES.md` -- medium-term therapeutic threads
- `CURRENT-FOCUS.md` -- short-term working direction
- `NEXT-PRIMER.md` -- 5-line handoff between sessions
- `sessions/` -- session notes
- `sources/` -- imported documents the companion can reopen selectively
- `archive/` -- richer historical material and review outputs

Behind the scenes, a set of operational layers guide the companion's behavior:

- how to open and close sessions
- when to update memory and when to leave it alone
- how to detect and interrupt defensive patterns
- when to reopen source material and when to stay with live content
- how to run weekly reviews and interim reviews
- how to evolve its own persona, disambiguation logic, and intervention style

These layers are living files the companion can update as the work progresses.

## Setup

1. Install [Codex](https://github.com/openai/codex) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
2. Open this folder.
3. Type "start" or "başla" or just say hi.
4. That's it.

No templates to fill. No configuration. The companion handles everything through conversation.

Detailed walkthrough: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)

## Key Features

**Conversational bootstrap** -- first session starts immediately, no setup wizard. Defaults are chosen silently; change them later by asking.

**Self-evolving companion** -- the companion updates its own persona notes, intervention playbook, pattern disambiguation, and source indexing as it learns the user.

**Source integration** -- import journals, old AI conversations, clinical records, or personal writing. The companion reads them, indexes triggers for reopening, and integrates relevant material into the therapeutic record.

**Model awareness** -- detects common drift patterns in GPT and Claude models and corrects for them. Notes which patterns actually appear with each user.

**Weekly reviews** -- automatic Monday reviews that catch drift, update formulations, check for over-interpretation, and audit the companion's own evolved files.

**Session primer** -- a 5-line rolling handoff file written at every session close, giving the next session instant context without reading 15 files.

**Between-session experiments** -- selective, observational carry-forward tasks with follow-up tracking and non-completion treated as meaningful data.

**Backup and export** -- ask the companion to save a copy of the workspace at any time. Gentle reminder after 10+ sessions without a backup.

**Local-first** -- all files stay on your machine. Your continuity doesn't depend on any vendor's chat history.

## Persona Library

Nine communication styles included: Susan (default), Warm & Supportive, Direct & Challenging, Coach, Grounded & Real, Contemplative, Philosophical, Creative, and Warm 4o-Style.

The companion adds client-specific adjustments on top of whichever base persona is active.

## Therapeutic Modalities

Twelve modalities available: ACT, IFS, CFT (defaults), CBT, DBT Skills, Psychodynamic, Narrative, Somatic Experiencing, Polyvagal, Lifespan Integration, Motivational Interviewing, and SFBT.

Mix and match at any time by asking the companion.

## Safety

Scalvin is for emotional support and self-reflection. It is not a substitute for licensed mental health care.

If you are in crisis:

- US/Canada: `988`
- International: [findahelpline.com](https://findahelpline.com)
- Immediate danger: contact local emergency services

## Attribution

Scalvin is a derivative work built from the MIT-licensed Inner Dialogue project by Anthony Taglianetti. The original copyright notice and license are preserved in [LICENSE](LICENSE).
