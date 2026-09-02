# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: multi-context.** Memry is a pnpm workspace with genuinely separate contexts (`apps/*`, `packages/*`), so the glossary is split per context rather than kept in one root file.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — points at one `CONTEXT.md` per context. Read each one relevant to the topic you're working in.
- **`<context>/CONTEXT.md`** — the glossary for that app or package (e.g. `packages/domain-tasks/CONTEXT.md`).
- **`docs/adr/`** at the repo root — system-wide decisions (sync protocol, E2E encryption, IPC contracts, dual-database pattern).
- **`<context>/docs/adr/`** — decisions scoped to a single app or package.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT-MAP.md
├── docs/adr/                             ← system-wide decisions
│   ├── 0001-crdt-ownership-in-main.md
│   └── 0002-dual-database-data-index.md
├── apps/
│   ├── desktop/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/
│   ├── sync-server/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/
│   └── landing/
│       └── CONTEXT.md
└── packages/
    ├── domain-notes/CONTEXT.md
    ├── domain-tasks/CONTEXT.md
    ├── domain-inbox/CONTEXT.md
    ├── sync-core/
    │   ├── CONTEXT.md
    │   └── docs/adr/
    ├── storage-vault/CONTEXT.md
    └── contracts/CONTEXT.md
```

Only contexts that have actually needed a glossary or a decision record will have these files. That's expected — the map lists what exists.

## Existing docs that are not ADRs

Memry already carries long-form architecture and design docs. They are context, not decision records — read them, don't convert them:

- `docs/ARCHITECTURE.md` — system overview
- `CLAUDE.md` (root, `AGENTS.md` is a symlink to it) — build/verify commands, hard rules, known gotchas
- `PRODUCT.md` + `DESIGN.md` — product brief and global product design authority; desktop is the current reference implementation
- `docs/DESIGN_TOKENS.md` — desktop implementation token catalog
- `docs/superpowers/specs/` — feature specs (e.g. Agent Chat design)

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
