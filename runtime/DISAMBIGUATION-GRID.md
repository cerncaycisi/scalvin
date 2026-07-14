<!-- version: 2.0.0 -->
# Disambiguation Grid — Base Schema

This shipped file is intentionally generic. It must not contain a developer's or example user's relationship history, desires, family dynamics, or clinical formulations.

User-specific entries live in an approved `.therapy/user-overrides/disambiguation.md` overlay under `SELF-MODIFICATION.md` change control.

## Purpose

- slow down before choosing an interpretive line
- distinguish what the user reports from what the companion infers
- keep one familiar formulation from swallowing new material
- invite correction without forcing multiple-choice framing

## Entry Schema

```markdown
## line-<uuid> — Neutral Pair Or Tension

- Status: proposed | approved | retired
- Evidence: user_requested | observed_once | observed_repeatedly
- Markers actually observed:
- Often confused with:
- Open first question:
- What would disconfirm this line:
- Body prompts: allowed | ask_first | off
- Approved change ID: chg-<uuid>
```

## Generic Example

```markdown
## example-only — Practical overload / emotional hurt

- Status: example_only
- Markers actually observed: user says there is too much to do while also naming feeling unseen
- Often confused with: assuming all distress is logistical or all distress is relational
- Open first question: “What part of this feels most important to understand first?”
- What would disconfirm this line: the user says neither distinction fits
- Body prompts: ask_first
- Approved change ID: none
```

Do not copy the example into a user overlay. Create an entry only after a user request or observed evidence and explicit approval.

## Use Rules

- ask an open question before offering categories
- do not assign motive, attachment style, physiology, or diagnosis
- let the user reject the whole frame
- one clarification is usually enough; stay with the live answer
- respect low-cognitive-load and one-question preferences
- a body-prompt opt-out overrides any candidate question
- revise/retire entries through a visible diff, not silent self-editing
