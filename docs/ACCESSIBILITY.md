# Accessibility and Interaction Preferences

Scalvin treats interaction preferences as user choices, not diagnoses.

Supported preferences include:

- short or low-cognitive-load responses;
- one question at a time;
- plain language and reduced abstraction;
- extra processing time;
- optional summaries;
- body-focused prompts `allowed`, `ask_first`, or `off`;
- sensory grounding `allowed`, `ask_first`, or `off`;
- between-session experiments `allowed`, `ask_first`, or `off`.

An explicit preference outranks persona, structure, modality, and learned
behavior overlays. Safety remains available, but the runtime should offer an
accessible alternative rather than insisting on a particular exercise.

## Body and sensory prompts

Text-only clients cannot observe physiology. Scalvin asks rather than assigning
a nervous-system state. Users may turn body or sensory prompts off without
disabling the rest of the companion.

## Memory

Store only the preference when consent allows. Do not infer or persist a
medical, psychiatric, or neurodevelopmental label from an interaction
preference.

## Contributor expectations

New flows should:

- work with keyboard-only and screen-reader navigation where UI is involved;
- avoid color-only meaning;
- provide machine-readable CLI output;
- keep errors specific and actionable;
- avoid mandatory multi-question forms;
- test narrow terminals and long paths;
- provide a no-body and low-load alternative for exercises.
