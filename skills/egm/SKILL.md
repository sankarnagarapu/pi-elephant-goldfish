---
name: egm
description: Elephant-Goldfish Model index: design with an elephant, review with a goldfish. Lists available EGM skills and how to use them.
---

# Elephant-Goldfish Model (EGM)

EGM is a design-before-code workflow. **Elephant** holds project context and drafts the specification. **Goldfish** reviewers examine the draft and referenced source material without the earlier conversation, exposing unstated assumptions and blind spots. **You** resolve trade-offs and approve the specification before implementing.

Use it when a feature needs design decisions before implementation. For a small, clear bug fix, use your normal coding workflow.

## Available skills

Invoke with `/skill:<name>`:

- `egm-brainstorm` — Test an idea and write a concept brief (`concepts_brief.md`).
- `egm-draft` — Turn a brief or existing notes into a design document (`design_draft.md`).
- `egm-resolve` — Work through review findings and agree on changes.
- `egm-bootstrap` — Create or update documentation for an existing codebase.
- `egm-review` — Review a design with fresh agents across five stages.
- `egm-review-loop` — Run a configured group of reviewers for a specific review task.
- `egm-drift-report` — Compare checked-in documents with the current source code.

## Reviewer agents and standards

Reviewer agent prompts live in `../../agents/`. Document standards live in `../../resources/document_standards/`. Execution instructions: `../../resources/execution_instructions.md`.

Goldfish reviews require fresh subagent contexts. Pi-Bolt provides subagents via `opensec-pi-subagents`; Pi core does not. If your host cannot spawn fresh subagents, run reviewers inline or via separate `pi` invocations, noting the loss of zero-context isolation.
