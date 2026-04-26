# M5 - Notes CRUD + BlockNote + CRDT / Phase Prompts

Fresh-session prompts for M5. Run one phase per clean session. Do not start the
next phase until the previous phase is committed and verified.

## Worktree

M5 should run after M4 is merged to `main`.

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
git fetch origin
git worktree add ../spike-tauri-m5 -b m5/notes-crud-blocknote-crdt main
cd ../spike-tauri-m5
```

If the branch name is random, rename it before pushing:

```bash
git branch -m m5/notes-crud-blocknote-crdt
```

All prompts assume this root:

```text
/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
```

## Execution Order

| Phase | Prompt | Task | Plan Tasks | Status |
|-------|--------|------|------------|--------|
| A | `m5-phase-a-crdt-foundation.md` | Rust yrs CRDT core, DocStore, apply/snapshot/state-vector/compaction/wire | 1-9 | TODO |
| B | `m5-phase-b-db-schema-notes.md` | CRDT migrations plus notes/folders/tags DB primitives | 10-19 | TODO |
| C | `m5-phase-c-db-properties-crdt-persistence.md` | Property definitions plus CRDT update/snapshot persistence | 20-22 | TODO |
| D | `m5-phase-d-notes-core-commands.md` | Notes command skeleton, create/get/update/delete/list | 23-28 | TODO |
| E | `m5-phase-e-notes-advanced-commands.md` | Rename/move/exists/local-only/tags/links/aggregate tests | 29-32 | TODO |
| F | `m5-phase-f-folder-commands.md` | Folder CRUD, configs, templates, positions | 33-35 | TODO |
| G | `m5-phase-g-property-commands.md` | Property definition and option command surface | 36-37 | TODO |
| H | `m5-phase-h-deferred-stubs-parity.md` | File metadata/open/reveal plus deferred M6/M8 mock ledger | 38-39 | TODO |
| I | `m5-phase-i-crdt-commands.md` | CRDT Tauri command surface, chunks, capabilities, tests | 40-46 | TODO |
| J | `m5-phase-j-renderer-provider-blocknote.md` | Renderer origin tags, Yjs provider, BlockNote binding, mock swap | 47-50 | TODO |
| K | `m5-phase-k-md-to-yjs-seed.md` | Markdown to BlockNote blocks and idempotent Y.Doc seed | 51-52 | TODO |
| L | `m5-phase-l-registration-devtools-bindings.md` | Devtools, registrations, capabilities, bindings, event parity | 53-56 | TODO |
| M | `m5-phase-m-renderer-legacy-contract-cleanup.md` | Replace legacy sync_crdt path, rehome contracts, IPC cleanup | 57-60 | TODO |
| N | `m5-phase-n-runtime-e2e.md` | Real Tauri runtime e2e lane | 65-71 | TODO |
| O | `m5-phase-o-final-verification-ledger.md` | Full verification, manual dogfood, carry-forward ledger | 72-74 | TODO |

The source plan has 13 chunks. These prompts split the largest DB and notes-command
chunks into smaller sessions to reduce integration churn.

## Global Rules

1. Worktree root: `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
2. Branch: `m5/notes-crud-blocknote-crdt`
3. Source of truth: `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
4. Parent spec: `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
5. Predecessor: M4 must be merged before M5 starts.
6. New work goes only to `apps/desktop-tauri/` unless a phase explicitly says otherwise.
7. `apps/desktop/**` is read-only reference material. Do not change Electron during M5.
8. Tauri command names are snake_case. Tauri events use kebab-case unless the plan
   explicitly preserves a compatibility alias.
9. CRDT fragment name is exactly `prosemirror`.
10. Inline CRDT IPC update cap is 8 KB; larger updates use chunk commands.
11. Commit format: `m5(<scope>): <description>`.
12. No branding in branch names, commit bodies, PR descriptions, or generated docs.

## Required Method

Each implementation phase starts by invoking:

- `superpowers:using-superpowers`
- `superpowers:test-driven-development` for phases that write code
- `superpowers:systematic-debugging` for failures with non-obvious cause
- `superpowers:verification-before-completion` before reporting complete

Use RED-GREEN for every task with a test file in the plan. Confirm the RED failure
before implementation, then confirm GREEN before committing.

## Phase Handoff

At the end of every phase, run the smallest full-phase gate listed in that prompt,
then report:

```text
Phase <X> complete.
Tasks covered: <task numbers>
Commits: <count> (<first hash>..<last hash>)
Verification: <commands and result>
Next: Phase <Y> - <prompt filename>
Blockers: <none | list>
```

## Emergency Stop

Stop and report if:

- M4 is not merged or baseline checks are red.
- `yrs` APIs differ from the plan enough to change the CRDT design.
- renderer contracts conflict with generated Specta bindings.
- any production build would still rely on an unledgered mock route.
- `devtools_*` commands leak into production capabilities or generated production
  command lists.
- runtime e2e requires fake JS-only CRDT convergence instead of real `crdt_*` commands.

Do not guess. Identify root cause, state the smallest fix, and wait if the fix changes
scope.
