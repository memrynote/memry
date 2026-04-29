# Phase B Implementation Prompts

Dispatch packets for executing the i18n Phase B implementation, one task per prompt.

## References

- **Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- **Plan:** `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- **Phase A prompts (predecessor):** `prompts/phaseA/`

## Phase B in one breath

Add ~42 universal strings to `common.json` (en), translate to TR + AR, exercise ICU pluralization for the first time, then migrate ~12 renderer files so live language switching shows visible non-English UI beyond the Phase A settings picker seed.

## How to use

Execute prompts in order. Each prompt assumes prior prompts are committed.

Two execution patterns:

1. **Sequential (single agent):** feed each prompt to one agent in order. Reset context between prompts so each agent starts fresh.
2. **Subagent-driven (recommended):** dispatch a fresh subagent per prompt. Tasks 05–13 are mostly independent and can run in parallel after Tasks 01–04 land.

## Prompts

| Order | File | What it does |
|---|---|---|
| 0 | `00-worktree-setup.md` | Create worktree off main; smoke-test Phase A still works |
| 1 | `01-expand-common-en.md` | Add ~42 universal strings to `en/common.json` |
| 2 | `02-translate-tr.md` | Translate to Turkish |
| 3 | `03-translate-ar.md` | Translate to Arabic |
| 4 | `04-icu-plural-test.md` | TDD unit test for ICU plurals across en/tr/ar |
| 5 | `05-unsaved-changes-dialog.md` | Migrate Save / Discard / Cancel buttons |
| 6 | `06-bulk-delete-confirmation.md` | Migrate Cancel + ICU `count.itemDelete` |
| 7 | `07-note-tree-cancel.md` | Migrate Cancel button only |
| 8 | `08-task-delete-cancel.md` | Migrate Cancel button only |
| 9 | `09-calendar-delete-cancel.md` | Migrate Cancel button only |
| 10 | `10-loading-folder-view.md` | Migrate "Loading…" in folder-view tables |
| 11 | `11-loading-settings.md` | Migrate "Loading…" in settings panels |
| 12 | `12-aria-search.md` | Migrate `aria-label="Search"` |
| 13 | `13-column-selector-plural.md` | Migrate ICU "N notes" plural |
| 14 | `14-e2e-extension.md` | Extend `i18n.spec.ts` with visible-flip assertion |
| 15 | `15-final-verification.md` | Lint, typecheck, test, e2e, open PR |

## Parallel execution opportunities

```
00 → 01 → 02 → 03 → 04
                      ↓
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
       05             06             07–13 (fan-out, independent)
       ↓              ↓              ↓
       └──────────────┴──────────────┘
                      ↓
                      14 (needs at least one migration done)
                      ↓
                      15
```

Tasks 05–13 touch different files with no overlap, so a coordinator can dispatch them concurrently. Tasks 01–03 are sequential (same files, different locales). Task 04 depends on 01–03.

## Conventions

- Each prompt is **self-contained** — file paths, exact code, verification commands, commit message all included.
- The plan file is the **single source of truth** — if a prompt drifts from the plan, the plan wins.
- Subagents executing in `isolation: "worktree"` cannot run `pnpm` or `gh` mutations — coordinator handles those (see MEMORY.md `feedback_subagent_permissions.md`).
- Commit messages follow Phase A's convention: `feat(i18n): ...` or `test(i18n): ...`.

## Exit signal

After Task 15 reports back, the coordinator opens the PR with `gh pr create` and links it back. Phase B is done when the PR is approved and merged.
