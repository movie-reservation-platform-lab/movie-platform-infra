---
name: programming-kb
description: Use when a question or engineering task can benefit from the local programming knowledge base at /home/patex1987/Documents/programming_kb, especially reusable architecture, backend, system design, TypeScript, testing, AWS, and implementation patterns. Prefer this local KB before broad internet search unless the user asks to validate, refresh, or research externally.
---

# Programming KB

Use this skill to retrieve reusable programming and architecture knowledge from the local Obsidian vault:

`/home/patex1987/Documents/programming_kb`

The goal is targeted local retrieval: infer likely tags from the user's question, inspect only the smallest useful set of notes, cite the notes used, and avoid loading the whole vault.

## Default behavior

- Read `/home/patex1987/Documents/programming_kb/index.md` first.
- Use `rg` or `scripts/kb-query.sh` to find candidate notes by tag, title, alias, and exact terms.
- Prefer notes with `status: stable`; use `draft` only when stable notes are missing or incomplete.
- Prefer generated notes in `concepts/`, `patterns/`, `decisions/`, and `sources/` over `raw/`.
- Do not edit files under `raw/`.
- Cite the KB pages used in the answer with file paths or Obsidian note names.
- If the KB lacks a useful note, say that and answer from repository context or general knowledge as appropriate.

## Tag-first retrieval

1. Convert the user's question into 2-6 likely kebab-case tags and search terms.
   - "How should I publish domain events reliably?" -> `domain-events`, `transactional-outbox`, `events`, `reliability`
   - "Should reservations use event sourcing?" -> `reservation-systems`, `event-sourcing`, `cqrs`, `postgres`
   - "How do I make a projector safe to rerun?" -> `projections`, `read-models`, `idempotency`, `events`
2. List available tags when unsure:
   - `bash .ai/skills/programming-kb/scripts/kb-query.sh tags`
3. Search by inferred tag:
   - `bash .ai/skills/programming-kb/scripts/kb-query.sh tag transactional-outbox`
4. Search by exact terms if tags miss:
   - `bash .ai/skills/programming-kb/scripts/kb-query.sh search "event outbox"`
5. Open only the top relevant notes, usually 1-4 files.

If the helper script is unavailable, use `rg` directly:

```bash
KB=/home/patex1987/Documents/programming_kb
rg -n --glob '*.md' --glob '!raw/**' '^- transactional-outbox$|title: .*Transactional Outbox|aliases:|transactional outbox' "$KB"
```

## Answer workflow

1. State that you are checking the local Programming KB when it materially affects the answer.
2. Search tags and terms before reading broad content.
3. Read the selected notes and their directly related notes only when needed.
4. Synthesize the answer in the user's task context; do not dump note content.
5. Include a short "Used KB notes" line when the answer depends on the KB.

## External validation

Use internet or external sources when:

- the user explicitly asks to validate, refresh, browse, research, or compare with current sources
- the topic is time-sensitive, version-sensitive, legal, security-sensitive, pricing-related, or likely to have changed
- local KB notes are marked `needs-review` or `deprecated`
- local notes disagree with each other or with repository evidence

When validating externally:

- Search primary or official sources first.
- Separate "KB says" from "current source says".
- If external sources supersede the KB, notify the user that the KB is stale and identify the note(s) that should be updated.

## Staleness and gaps

Treat a note as suspect when:

- `status: needs-review` or `status: deprecated`
- `updated:` is old for a version-sensitive topic
- the note references a tool, library, API, cloud service, or standard whose behavior may have changed
- repository evidence contradicts the note
- an external validation pass finds newer guidance

When you find stale or missing KB knowledge, tell the user in plain language:

```text
KB freshness note: <note> appears stale or incomplete because <reason>. It should be updated with <source/evidence>.
```

If the user asks to update the KB, follow `/home/patex1987/Documents/programming_kb/AGENTS.md`: preserve raw sources, update generated pages surgically, refresh `index.md`, and append to `log.md`.

