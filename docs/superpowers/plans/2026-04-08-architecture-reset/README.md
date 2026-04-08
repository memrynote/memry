# Memry Architecture Reset Roadmap

This folder breaks the architecture-reset program into independent implementation plans so the work can land step by step instead of as one oversized refactor.

## Why This Exists

The original architecture plan is too large to execute safely as a single stream of work. This roadmap turns it into a sequence of reviewable phases with explicit dependencies, exit criteria, and verification commands.

## Execution Rules

- Land one phase per branch/PR unless a phase is intentionally split further.
- Do not start a later phase until the current phase's exit criteria are green.
- Preserve existing user-facing behavior unless the phase explicitly calls for a change.
- Prefer strangler migrations over in-place rewrites.
- When a phase produces reusable primitives, migrate one vertical slice first before broad adoption.

## Phase Order

| Phase | Plan | Purpose | Depends On |
|------|------|---------|------------|
| 00 | `00-foundations-and-guardrails.md` | Add architectural guardrails and DB-boundary safety | None |
| 01 | `01-rpc-and-type-unification.md` | Create generated RPC surface and canonical transport/domain types | 00 |
| 02 | `02-tasks-vertical-slice.md` | Migrate tasks/projects/statuses/reminders to the new architecture | 00, 01 |
| 03 | `03-inbox-vertical-slice.md` | Convert inbox into command/query/job pipeline | 00, 01 |
| 04 | `04-notes-journal-vault.md` | Build unified notes/journal/vault domain boundary | 00, 01 |
| 05 | `05-sync-core-simplification.md` | Replace feature-owned sync calls with sync adapters | 02, 03, 04 |
| 06 | `06-projection-pipeline.md` | Move FTS/graph/embeddings/stats into projection workers | 04, 05 |
| 07 | `07-sync-server-alignment.md` | Align server contracts and transport with the new client sync model | 05, 06 |

## Milestones

### Milestone A: Guardrails And Contracts
- Phases 00-01
- Outcome: compiler and CI begin enforcing the intended architecture before major migrations start

### Milestone B: First Domain Migrations
- Phases 02-04
- Outcome: tasks, inbox, and notes each have domain-owned command/query surfaces instead of handler/provider-driven orchestration

### Milestone C: Platform Simplification
- Phases 05-07
- Outcome: sync and projections become reusable platform subsystems instead of feature-specific plumbing

## Suggested Branching

- `arch/phase-00-guardrails`
- `arch/phase-01-rpc`
- `arch/phase-02-tasks`
- `arch/phase-03-inbox`
- `arch/phase-04-notes`
- `arch/phase-05-sync-core`
- `arch/phase-06-projections`
- `arch/phase-07-server-alignment`

## Global Verification Bar

Run these at the end of every phase unless the phase doc narrows the command first:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check
```

If a phase touches renderer/main contracts, also run:

```bash
pnpm ipc:generate
```

## Success Criteria For The Full Program

- Renderer stops owning durable domain orchestration.
- IPC handlers become thin transport adapters.
- `data.db` and `index.db` have compile-time separation.
- Sync logic becomes adapter-driven instead of feature-driven.
- Search, graph, embeddings, and stats are maintained by projection workers.
- Notes and journal share a single domain model with vault-backed content and projection-backed derived state.

