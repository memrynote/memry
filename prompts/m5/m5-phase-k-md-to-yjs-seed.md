# M5 Phase K - Markdown to Yjs Seed

Fresh session prompt. This phase converts markdown from the vault into the first
BlockNote-compatible CRDT document.

---

## PROMPT START

You are implementing **Phase K of Milestone M5**. This phase executes plan Tasks
51-52 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-j-renderer-provider-blocknote.md`

The renderer can talk to Rust CRDT commands. Phase K makes first-open seeding from
existing markdown useful and idempotent.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
test -f apps/desktop-tauri/src-tauri/src/commands/crdt.rs
test -f apps/desktop-tauri/src/lib/crdt/yjs-tauri-provider.ts
pnpm --filter @memry/desktop-tauri cargo:test -- --test commands_crdt_test
pnpm --filter @memry/desktop-tauri test -- src/lib/crdt
```

If this fails, STOP and finish Phases I/J.

### Your Scope

Execute Tasks 51-52 in order:

- **Task 51:** Add `pulldown-cmark`; create `crdt/md_to_yjs.rs` and tests for
  paragraphs, headings, lists, code blocks, empty input, and Turkish diacritics.
- **Task 52:** Create `crdt/seed.rs`; seed an empty Y.Doc under XmlFragment
  `prosemirror`; make seeding idempotent; wire modules into `crdt/mod.rs`.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 51-52 fully before editing.
3. Keep markdown conversion intentionally scoped: paragraph, heading, list item,
   code block. Do not build full markdown fidelity in M5.
4. If `yrs` XML APIs differ from the plan snippets, adapt the minimal code while
   preserving the contract: BlockNote can render seeded content.
5. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/src/crdt/md_to_yjs.rs
test -f apps/desktop-tauri/src-tauri/src/crdt/seed.rs
rg -n "prosemirror|seed_from_markdown|md_to_blocknote_blocks" apps/desktop-tauri/src-tauri/src/crdt

cd apps/desktop-tauri/src-tauri
cargo test --test crdt_md_to_yjs_test
cargo test --test crdt_seed_test

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'crdt_*'
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Manual smoke before reporting complete:

```bash
pnpm --filter @memry/desktop-tauri dev
```

Open a markdown-only note with paragraphs/headings/lists and confirm visible content in
BlockNote.

### When Done

Report:

```text
Phase K complete.
Tasks covered: 51, 52
Commits: <count> (<first hash>..<last hash>)
Verification: crdt_md_to_yjs_test + crdt_seed_test + crdt slice + manual open smoke
Next: Phase L - prompts/m5/m5-phase-l-registration-devtools-bindings.md
Blockers: <none | list>
```

## PROMPT END
