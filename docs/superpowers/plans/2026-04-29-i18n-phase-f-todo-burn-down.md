# i18n Phase F TODO Burn-Down Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Phase E `TODO(i18n): wrap in t()` baseline by converting each real user-facing renderer string to a typed `t()` call and then ratchet `pnpm i18n:check` to reject any remaining TODOs.

**Architecture:** Phase F is the follow-up to Phase E's conservative codemod. It does not add Turkish or Arabic translation content; it adds English keys to the existing namespace JSON files and relies on the existing fallback chain for `tr` / `ar`. Every TODO is either converted to `t()` or proven to be a scanner false positive with a focused scanner/ESLint test.

**Tech Stack:** React 19, `@memry/i18n` `useT(namespace)`, i18next ICU strings, TypeScript, ESLint 9 flat config, Phase E `pnpm i18n:check`, Vitest/Node test gates.

---

## Source Context

Read these before editing:

- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-e-codemod-and-lint.md`
- `apps/desktop/scripts/i18n/check.mjs`
- `apps/desktop/scripts/i18n/scan-source.mjs`
- `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.mjs`
- `packages/i18n/src/renderer/use-t.ts`
- `packages/i18n/src/locales/en/common.json`
- `packages/i18n/src/locales/en/notes.json`
- `packages/i18n/src/locales/en/inbox.json`
- `packages/i18n/src/locales/en/tasks.json`
- `packages/i18n/src/locales/en/settings.json`
- `packages/i18n/src/locales/en/calendar.json`
- `packages/i18n/src/locales/en/journal.json`
- `packages/i18n/src/locales/en/graph.json`
- `packages/i18n/src/locales/tr/*.json`
- `packages/i18n/src/locales/ar/*.json`

Current Phase E baseline:

```bash
pnpm --filter @memry/desktop i18n:check --format json
```

Expected before Phase F implementation:

- exit `0`
- `warnings.todoCount` is currently `922`
- `failures.missingEnglishKeys` is empty
- `failures.untranslated` is empty because TODO comments annotate the baseline

## Scope

In scope:

- Remove every `TODO(i18n): wrap ... in t()` marker from production renderer code.
- Add English source strings to existing namespace JSON files.
- Use ICU interpolation/plural syntax for strings with counts, names, dates, search queries, or user-visible dynamic values.
- Preserve user-authored content as dynamic values passed into translation strings.
- Tighten `i18n:check` to `--max-todo 0` after the TODO count reaches zero.
- Add scanner/ESLint tests for any proven false positives.

Out of scope:

- Adding Turkish or Arabic feature translations. Keep Phase C/D/E/F namespace files in `tr` and `ar` as `{}` unless they already have content from Phase B.
- Translation pipeline work.
- Broad RTL Tailwind codemod.
- Product behavior changes.
- Rewriting strings that are not part of the Phase E TODO baseline unless a test proves the checker missed them.
- Main-process menu/errors work; Phase D owns that.

## Rules For Each TODO

For every TODO, make one of these decisions:

1. **Real user-facing copy:** Replace the literal with `t('key')`, add the English key to the owning namespace, remove the TODO.
2. **User-facing copy with variables:** Replace the full phrase with one `t()` call and pass variables, for example `t('folder.noMatch', { query: searchQuery })`.
3. **Count/plural copy:** Use ICU plural syntax, for example `{count, plural, one {# task} other {# tasks}}`.
4. **User-authored content:** Do not translate the user content itself; interpolate it into translated UI copy.
5. **Technical/non-user copy:** Add a focused allowlist test to `scan-source.test.mjs` and, when applicable, the ESLint RuleTester file, then remove the TODO without adding a translation key.

Do not keep any TODO as a final state.

## Namespace Heuristic

Use existing namespaces:

- `apps/desktop/src/renderer/src/components/inbox/**` -> `inbox`
- `apps/desktop/src/renderer/src/components/filing/**` -> usually `inbox` if used by capture/file flows, otherwise `notes`
- `apps/desktop/src/renderer/src/components/note/**` -> `notes`
- `apps/desktop/src/renderer/src/components/folder-view/**` -> `notes`
- `apps/desktop/src/renderer/src/pages/file.tsx` -> `notes`
- `apps/desktop/src/renderer/src/pages/folder-view.tsx` -> `notes`
- `apps/desktop/src/renderer/src/components/tasks/**` -> `tasks`
- `apps/desktop/src/renderer/src/pages/settings/**` -> `settings`
- `apps/desktop/src/renderer/src/components/settings/**` -> `settings`
- `apps/desktop/src/renderer/src/components/calendar/**` -> `calendar`
- `apps/desktop/src/renderer/src/components/journal/**` -> `journal`
- `apps/desktop/src/renderer/src/components/graph/**` -> `graph`
- shared app shell, tabs, generic UI controls -> `common` unless the copy is feature-specific

If a file mixes domains, use multiple hooks:

```tsx
const { t } = useT('notes')
const { t: tCommon } = useT('common')
```

Keep key names stable and domain-oriented. Avoid keys named after current component structure when the copy belongs to a reusable concept.

## File Structure

Likely modified:

- `packages/i18n/src/locales/en/common.json`
- `packages/i18n/src/locales/en/notes.json`
- `packages/i18n/src/locales/en/inbox.json`
- `packages/i18n/src/locales/en/tasks.json`
- `packages/i18n/src/locales/en/settings.json`
- `packages/i18n/src/locales/en/calendar.json`
- `packages/i18n/src/locales/en/journal.json`
- `packages/i18n/src/locales/en/graph.json`
- `apps/desktop/src/renderer/src/**/*.tsx` files containing `TODO(i18n): wrap`
- `apps/desktop/scripts/i18n/scan-source.test.mjs` only for false-positive coverage
- `apps/desktop/scripts/i18n/scan-source.mjs` only for test-proven false-positive fixes
- `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.test.mjs` only for false-positive coverage
- `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.mjs` only for test-proven false-positive fixes
- `package.json`
- `apps/desktop/package.json`

Do not modify unless explicitly needed:

- `packages/i18n/src/locales/tr/*.json`
- `packages/i18n/src/locales/ar/*.json`
- `packages/i18n/src/locales/index.ts`
- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`

## Chunk 1: Inventory And False-Positive Policy

### Task 1: Snapshot the canonical TODO baseline

**Files:**
- Read: `apps/desktop/scripts/i18n/check.mjs`
- Read: `apps/desktop/scripts/i18n/scan-source.mjs`
- Read: `docs/superpowers/plans/2026-04-29-i18n-phase-e-codemod-and-lint.md`

- [ ] **Step 1: Capture the checker baseline**

```bash
pnpm --filter @memry/desktop i18n:check --format json > /tmp/memry-i18n-phase-f-baseline.json
```

Expected: command exits `0`.

- [ ] **Step 2: Confirm the baseline shape**

```bash
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('/tmp/memry-i18n-phase-f-baseline.json','utf8')); console.log({todoCount:r.warnings.todoCount, missingEnglish:r.failures.missingEnglishKeys.length, untranslated:r.failures.untranslated.length})"
```

Expected before migration:

```text
{ todoCount: 922, missingEnglish: 0, untranslated: 0 }
```

- [ ] **Step 3: Capture the file list**

```bash
rg -l "TODO\\(i18n\\): wrap" apps/desktop/src/renderer/src | sort > /tmp/memry-i18n-phase-f-files.txt
wc -l /tmp/memry-i18n-phase-f-files.txt
```

Expected before migration: `190` files.

- [ ] **Step 4: Capture the directory distribution**

```bash
sed 's#apps/desktop/src/renderer/src/##; s#/[^/]*$##' /tmp/memry-i18n-phase-f-files.txt | sort | uniq -c | sort -nr
```

Expected: tasks, app shell, folder-view, tabs, sidebar, inbox, settings, and shared UI directories are the largest buckets.

### Task 2: Prove the final ratchet is currently red

**Files:**
- Read: `apps/desktop/scripts/i18n/check.mjs`

- [ ] **Step 1: Run the future final check**

```bash
pnpm --filter @memry/desktop i18n:check --max-todo 0
```

Expected: exits non-zero because the current TODO count is above zero.

- [ ] **Step 2: Record the first actionable failure**

Expected failure text includes the TODO count and mentions the `--max-todo 0` limit.

Do not change scripts yet. The ratchet belongs at the end after all TODOs are gone.

### Task 3: Add false-positive test coverage before weakening detection

**Files:**
- Modify if needed: `apps/desktop/scripts/i18n/scan-source.test.mjs`
- Modify if needed: `apps/desktop/scripts/i18n/scan-source.mjs`
- Modify if needed: `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.test.mjs`
- Modify if needed: `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.mjs`

- [ ] **Step 1: Inspect likely false-positive categories**

Search for TODOs around keyboard shortcuts and code-like examples:

```bash
rg -n "TODO\\(i18n\\): wrap.*(shortcut|title|placeholder)|ContextMenuShortcut|dateDiff|A . Z|Z . A|⌘|⇧" apps/desktop/src/renderer/src
```

Expected: shortcut labels, formula DSL examples, and non-sentence command hints may appear.

- [ ] **Step 2: Write a scanner test for each real false-positive category**

Examples that should be allowed if confirmed by source inspection:

```tsx
<ContextMenuShortcut>⇧⌘M</ContextMenuShortcut>
<kbd>N</kbd>
<Input placeholder={'dateDiff(due_date, today(), "days")'} />
```

Expected: tests fail before scanner allowlist changes.

- [ ] **Step 3: Implement minimal allowlist changes**

Only allow specific technical containers or props after reading the real source:

- keyboard shortcut display components such as `ContextMenuShortcut`
- `kbd`, `code`, `pre`, and similar technical containers
- code-example placeholders only where the prop is explicitly a formula/code editor example

Do not globally ignore `placeholder`, `title`, or one-letter text in normal UI.

- [ ] **Step 4: Run tooling tests**

```bash
pnpm --filter @memry/desktop test:i18n-tools
```

Expected: all i18n tooling tests pass.

- [ ] **Step 5: Commit scanner-only false-positive fixes**

```bash
git add apps/desktop/scripts/i18n/scan-source.mjs apps/desktop/scripts/i18n/scan-source.test.mjs apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.mjs apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.test.mjs
git commit -m "fix(i18n): ignore technical text in TODO burn-down"
```

Only create this commit if scanner or ESLint rule files changed.

## Chunk 2: App Shell, Shared UI, Tabs, And Search

### Task 4: Convert app shell and generic navigation copy

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/nav-main.tsx`
- Modify: `apps/desktop/src/renderer/src/components/nav-projects.tsx`
- Modify: `apps/desktop/src/renderer/src/components/nav-user.tsx`
- Modify: `apps/desktop/src/renderer/src/components/team-switcher.tsx`
- Modify: `apps/desktop/src/renderer/src/components/window-controls.tsx`
- Modify: `apps/desktop/src/renderer/src/components/traffic-lights.tsx`
- Modify: `packages/i18n/src/locales/en/common.json`
- Modify as needed: `packages/i18n/src/locales/en/notes.json`
- Modify as needed: `packages/i18n/src/locales/en/tasks.json`

- [ ] **Step 1: Read the files before editing**

```bash
sed -n '1,460p' apps/desktop/src/renderer/src/components/app-sidebar.tsx
sed -n '1,260p' apps/desktop/src/renderer/src/components/nav-main.tsx
sed -n '1,260p' apps/desktop/src/renderer/src/components/nav-projects.tsx
sed -n '1,220p' apps/desktop/src/renderer/src/components/nav-user.tsx
```

- [ ] **Step 2: Choose namespaces**

Use:

- `common` for shell labels like close, sync disabled, generic search, window actions.
- `notes` for note tree/sidebar labels.
- `tasks` for project/task-specific labels.

- [ ] **Step 3: Convert literals to `t()`**

Example pattern:

```tsx
const { t } = useT('notes')
const { t: tCommon } = useT('common')

<SidebarSection label={t('tree.sections.collections')} />
<button aria-label={t('tree.actions.newNote')} />
<TooltipContent>{t('tree.actions.newNote')}</TooltipContent>
```

- [ ] **Step 4: Add English keys**

Add keys near related existing groups. Prefer reusing existing keys before adding new ones.

- [ ] **Step 5: Run checks for this slice**

```bash
pnpm --filter @memry/desktop i18n:check --format json > /tmp/memry-i18n-phase-f-after-shell.json
pnpm lint
```

Expected:

- `i18n:check` exits `0`
- `failures.missingEnglishKeys` is empty
- `failures.untranslated` is empty
- `warnings.todoCount` is lower than the baseline
- `pnpm lint` exits `0` errors

### Task 5: Convert tabs, split-view, command/search, and shared UI copy

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/tabs/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/split-view/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/search/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/find-bar/find-bar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/keyboard-shortcuts-modal.tsx`
- Modify: `apps/desktop/src/renderer/src/components/keyboard/keyboard-shortcuts-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/keyboard/chord-indicator.tsx`
- Modify: `apps/desktop/src/renderer/src/components/ui/autocomplete-dropdown.tsx`
- Modify: `apps/desktop/src/renderer/src/components/ui/breadcrumb.tsx`
- Modify: `apps/desktop/src/renderer/src/components/ui/dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/ui/sheet.tsx`
- Modify: `apps/desktop/src/renderer/src/components/ui/sidebar.tsx`
- Modify: `packages/i18n/src/locales/en/common.json`
- Modify as needed: `packages/i18n/src/locales/en/settings.json`

- [ ] **Step 1: List TODOs in the slice**

```bash
rg -n "TODO\\(i18n\\): wrap" apps/desktop/src/renderer/src/components/tabs apps/desktop/src/renderer/src/components/split-view apps/desktop/src/renderer/src/components/search apps/desktop/src/renderer/src/components/find-bar apps/desktop/src/renderer/src/components/keyboard apps/desktop/src/renderer/src/components/ui
```

- [ ] **Step 2: Convert copy**

Use `common` for generic shell/search/UI labels. Use `settings` for shortcut-management copy.

- [ ] **Step 3: Preserve technical shortcut strings**

Do not translate key glyphs such as `⌘`, `⇧`, `M`, `N`, or raw chord display text. If the checker flagged them, cover the component in Task 3 false-positive tests.

- [ ] **Step 4: Run checks**

```bash
pnpm --filter @memry/desktop i18n:check --format json > /tmp/memry-i18n-phase-f-after-shared-ui.json
pnpm lint
```

Expected: no failures, no lint errors, TODO count lower than after Task 4.

- [ ] **Step 5: Commit the shell/shared slice**

```bash
git add apps/desktop/src/renderer/src/components/app-sidebar.tsx apps/desktop/src/renderer/src/components/nav-main.tsx apps/desktop/src/renderer/src/components/nav-projects.tsx apps/desktop/src/renderer/src/components/nav-user.tsx apps/desktop/src/renderer/src/components/team-switcher.tsx apps/desktop/src/renderer/src/components/window-controls.tsx apps/desktop/src/renderer/src/components/traffic-lights.tsx apps/desktop/src/renderer/src/components/tabs apps/desktop/src/renderer/src/components/split-view apps/desktop/src/renderer/src/components/search apps/desktop/src/renderer/src/components/find-bar apps/desktop/src/renderer/src/components/keyboard apps/desktop/src/renderer/src/components/ui packages/i18n/src/locales/en/common.json packages/i18n/src/locales/en/notes.json packages/i18n/src/locales/en/tasks.json packages/i18n/src/locales/en/settings.json
git commit -m "feat(i18n): burn down shell and shared UI TODOs"
```

## Chunk 3: Notes, Folder View, Filing, And Viewers

### Task 6: Convert folder-view copy

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/folder-view/column-header.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/column-selector.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/filter-builder.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/filter-row.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/folder-view-toolbar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/formula-editor-modal.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/group-by-selector.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/grouped-table.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/move-to-folder-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/row-context-menu.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/sortable-column-header.tsx`
- Modify: `apps/desktop/src/renderer/src/components/folder-view/view-switcher.tsx`
- Modify: `packages/i18n/src/locales/en/notes.json`
- Modify as needed: `packages/i18n/src/locales/en/common.json`

- [ ] **Step 1: Read current folder-view TODOs**

```bash
rg -n "TODO\\(i18n\\): wrap" apps/desktop/src/renderer/src/components/folder-view
```

- [ ] **Step 2: Add `notes.folderView` key groups**

Suggested groups:

```json
{
  "folderView": {
    "table": {},
    "toolbar": {},
    "filters": {},
    "columns": {},
    "formulas": {},
    "grouping": {},
    "views": {},
    "moveDialog": {},
    "contextMenu": {}
  }
}
```

Use existing `notes` groups if they already match.

- [ ] **Step 3: Convert interpolated phrases as whole strings**

Examples:

```tsx
t('folderView.contextMenu.moveNotesToFolder', { count: selectedCount })
t('folderView.moveDialog.noMatch', { query: searchQuery })
t('folderView.groupedTable.moreGroups', { count: remainingCount })
```

Do not split quotes or punctuation around user data into separate JSX text nodes.

- [ ] **Step 4: Handle technical formula copy carefully**

Translate explanatory labels such as `Expression`, `Preview`, and `Available`. Keep formula function names and code samples stable unless product copy says otherwise.

- [ ] **Step 5: Run checks**

```bash
pnpm --filter @memry/desktop i18n:check --format json > /tmp/memry-i18n-phase-f-after-folder-view.json
pnpm --filter @memry/desktop test:renderer -- folder-view
pnpm lint
```

Expected:

- i18n check exits `0`
- renderer folder-view tests pass if the script forwards the filter; if it runs broader tests, failures must be investigated before continuing
- lint exits `0` errors

### Task 7: Convert note, template, viewer, and filing-adjacent copy

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/note/**/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/filing/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sidebar/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/shared/document-info-tab.tsx`
- Modify: `apps/desktop/src/renderer/src/components/viewers/*.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/file.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/folder-view.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/template-editor.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/templates.tsx`
- Modify: `packages/i18n/src/locales/en/notes.json`
- Modify as needed: `packages/i18n/src/locales/en/inbox.json`
- Modify as needed: `packages/i18n/src/locales/en/common.json`

- [ ] **Step 1: List TODOs in the slice**

```bash
rg -n "TODO\\(i18n\\): wrap" apps/desktop/src/renderer/src/components/note apps/desktop/src/renderer/src/components/filing apps/desktop/src/renderer/src/components/sidebar apps/desktop/src/renderer/src/components/shared apps/desktop/src/renderer/src/components/viewers apps/desktop/src/renderer/src/pages/file.tsx apps/desktop/src/renderer/src/pages/folder-view.tsx apps/desktop/src/renderer/src/pages/template-editor.tsx apps/desktop/src/renderer/src/pages/templates.tsx
```

- [ ] **Step 2: Convert copy**

Use `notes` for note, folder, template, sidebar, viewer, and folder-view page copy. Use `inbox` only for filing UI that belongs to inbox capture/file flows.

- [ ] **Step 3: Preserve user content**

Do not translate:

- note titles
- folder names
- tag names
- filenames
- URLs
- template body content

Translate surrounding UI copy and interpolate user content into the phrase.

- [ ] **Step 4: Run focused checks**

```bash
pnpm --filter @memry/desktop i18n:check --format json > /tmp/memry-i18n-phase-f-after-notes.json
pnpm --filter @memry/desktop test:renderer -- notes
pnpm lint
```

Expected: no i18n failures, no lint errors, TODO count lower than after Task 6.

- [ ] **Step 5: Commit the notes/folder slice**

```bash
git add apps/desktop/src/renderer/src/components/folder-view apps/desktop/src/renderer/src/components/note apps/desktop/src/renderer/src/components/filing apps/desktop/src/renderer/src/components/sidebar apps/desktop/src/renderer/src/components/shared/document-info-tab.tsx apps/desktop/src/renderer/src/components/viewers apps/desktop/src/renderer/src/pages/file.tsx apps/desktop/src/renderer/src/pages/folder-view.tsx apps/desktop/src/renderer/src/pages/template-editor.tsx apps/desktop/src/renderer/src/pages/templates.tsx packages/i18n/src/locales/en/notes.json packages/i18n/src/locales/en/inbox.json packages/i18n/src/locales/en/common.json
git commit -m "feat(i18n): burn down notes and folder TODOs"
```

## Chunk 4: Tasks Workspace

### Task 8: Convert task filters, dialogs, and action copy

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/tasks/**/*.tsx`
- Modify: `packages/i18n/src/locales/en/tasks.json`
- Modify as needed: `packages/i18n/src/locales/en/common.json`

- [ ] **Step 1: List task TODOs**

```bash
rg -n "TODO\\(i18n\\): wrap" apps/desktop/src/renderer/src/components/tasks
```

- [ ] **Step 2: Group keys in `tasks.json`**

Suggested groups:

```json
{
  "filters": {},
  "dialogs": {},
  "bulk": {},
  "datePicker": {},
  "repeat": {},
  "dragDrop": {},
  "empty": {},
  "savedFilters": {},
  "quickAdd": {},
  "badges": {}
}
```

Reuse existing `task`, `project`, `status`, `priority`, `filters`, `quickAdd`, and `toasts` groups where they already fit.

- [ ] **Step 3: Convert count and status phrases with ICU**

Examples:

```json
"dragDrop": {
  "multiOverlay": "{count, plural, one {# task} other {# tasks}}"
}
```

```tsx
{t('dragDrop.multiOverlay', { count })}
```

- [ ] **Step 4: Keep task/project names dynamic**

Do not translate task titles, project names, saved filter names, or custom status names. Interpolate them into translated UI copy.

- [ ] **Step 5: Add focused renderer tests for risky copy**

If a changed component already has a test file, extend it. If not, add the smallest useful test near the component. Good candidates:

- `components/tasks/bulk-actions/bulk-delete-dialog.test.tsx`
- `components/tasks/filters/active-filters-bar.test.tsx`
- a new narrow test for count/plural copy if no existing test covers it

- [ ] **Step 6: Run checks**

```bash
pnpm --filter @memry/desktop i18n:check --format json > /tmp/memry-i18n-phase-f-after-tasks.json
pnpm --filter @memry/desktop test:renderer -- tasks
pnpm lint
```

Expected: no i18n failures, no lint errors, task-focused renderer tests pass.

- [ ] **Step 7: Commit the tasks slice**

```bash
git add apps/desktop/src/renderer/src/components/tasks packages/i18n/src/locales/en/tasks.json packages/i18n/src/locales/en/common.json
git commit -m "feat(i18n): burn down tasks TODOs"
```

## Chunk 5: Inbox, Capture, Reminder, Sync, And Misc Feature Copy

### Task 9: Convert inbox, capture, and reminder copy

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/bulk/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/capture-input.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox/**/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inline-quick-file.tsx`
- Modify: `apps/desktop/src/renderer/src/components/quick-capture*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/quick-file-dropdown.tsx`
- Modify: `apps/desktop/src/renderer/src/components/reminder/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/snooze/snooze-picker.tsx`
- Modify: `apps/desktop/src/renderer/src/components/social-card.tsx`
- Modify: `apps/desktop/src/renderer/src/components/voice-recorder.tsx`
- Modify: `packages/i18n/src/locales/en/inbox.json`
- Modify as needed: `packages/i18n/src/locales/en/common.json`

- [ ] **Step 1: List TODOs in inbox/capture/reminder files**

```bash
rg -n "TODO\\(i18n\\): wrap" apps/desktop/src/renderer/src/components/bulk apps/desktop/src/renderer/src/components/capture-input.tsx apps/desktop/src/renderer/src/components/inbox apps/desktop/src/renderer/src/components/inbox-detail apps/desktop/src/renderer/src/components/inline-quick-file.tsx apps/desktop/src/renderer/src/components/quick-capture*.tsx apps/desktop/src/renderer/src/components/quick-file-dropdown.tsx apps/desktop/src/renderer/src/components/reminder apps/desktop/src/renderer/src/components/snooze apps/desktop/src/renderer/src/components/social-card.tsx apps/desktop/src/renderer/src/components/voice-recorder.tsx
```

- [ ] **Step 2: Convert real copy to `inbox` keys**

Use existing groups such as `bulk`, `detail`, `empty`, `list`, `loading`, `quickActions`, `reminder`, `toast`, `triage`, and `view`. Add new nested groups only when copy does not fit.

- [ ] **Step 3: Preserve captured/user content**

Do not translate captured text, link titles, transcriptions, filenames, URLs, voice memo names, or note titles. Interpolate them when used in surrounding UI copy.

- [ ] **Step 4: Run checks**

```bash
pnpm --filter @memry/desktop i18n:check --format json > /tmp/memry-i18n-phase-f-after-inbox.json
pnpm --filter @memry/desktop test:renderer -- inbox
pnpm lint
```

Expected: no i18n failures, no lint errors, inbox-focused renderer tests pass.

### Task 10: Convert sync, calendar, journal, graph, onboarding, and settings leftovers

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-event-metadata.tsx`
- Modify: `apps/desktop/src/renderer/src/components/day-panel/global-day-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/first-run-onboarding.tsx`
- Modify: `apps/desktop/src/renderer/src/components/graph/**/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/hint-overlay/hint-indicator.tsx`
- Modify: `apps/desktop/src/renderer/src/components/icon-picker.tsx`
- Modify: `apps/desktop/src/renderer/src/components/journal/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/kibo-ui/tree/index.tsx`
- Modify: `apps/desktop/src/renderer/src/components/sync/*.tsx`
- Modify: `apps/desktop/src/renderer/src/components/vault-onboarding.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx`
- Modify: `packages/i18n/src/locales/en/calendar.json`
- Modify: `packages/i18n/src/locales/en/journal.json`
- Modify: `packages/i18n/src/locales/en/graph.json`
- Modify: `packages/i18n/src/locales/en/settings.json`
- Modify as needed: `packages/i18n/src/locales/en/common.json`

- [ ] **Step 1: List remaining TODOs outside completed slices**

```bash
rg -n "TODO\\(i18n\\): wrap" apps/desktop/src/renderer/src
```

Expected at this point: only files from this task and any false-positive leftovers appear.

- [ ] **Step 2: Convert each leftover by namespace**

Use the namespace heuristic. Do not create a new namespace for one-off leftover copy.

- [ ] **Step 3: Run focused existing i18n tests**

```bash
pnpm --filter @memry/desktop test:renderer -- i18n
pnpm --filter @memry/desktop test:main -- locale-handler
```

Expected: renderer i18n and locale handler tests pass. If the script runs broader suites, wait for the final exit code and report honestly.

- [ ] **Step 4: Run global checks**

```bash
pnpm --filter @memry/desktop i18n:check --format json > /tmp/memry-i18n-phase-f-after-all-copy.json
pnpm lint
```

Expected:

- i18n check exits `0`
- `warnings.todoCount` is `0`
- `failures.missingEnglishKeys` is empty
- `failures.untranslated` is empty
- lint exits `0` errors

- [ ] **Step 5: Commit the inbox/misc slice**

```bash
git add apps/desktop/src/renderer/src/components/bulk apps/desktop/src/renderer/src/components/capture-input.tsx apps/desktop/src/renderer/src/components/inbox apps/desktop/src/renderer/src/components/inbox-detail apps/desktop/src/renderer/src/components/inline-quick-file.tsx apps/desktop/src/renderer/src/components/quick-capture*.tsx apps/desktop/src/renderer/src/components/quick-file-dropdown.tsx apps/desktop/src/renderer/src/components/reminder apps/desktop/src/renderer/src/components/snooze apps/desktop/src/renderer/src/components/social-card.tsx apps/desktop/src/renderer/src/components/voice-recorder.tsx apps/desktop/src/renderer/src/components/calendar apps/desktop/src/renderer/src/components/day-panel apps/desktop/src/renderer/src/components/first-run-onboarding.tsx apps/desktop/src/renderer/src/components/graph apps/desktop/src/renderer/src/components/hint-overlay apps/desktop/src/renderer/src/components/icon-picker.tsx apps/desktop/src/renderer/src/components/journal apps/desktop/src/renderer/src/components/kibo-ui/tree/index.tsx apps/desktop/src/renderer/src/components/sync apps/desktop/src/renderer/src/components/vault-onboarding.tsx apps/desktop/src/renderer/src/pages/settings/ai-inline-section.tsx packages/i18n/src/locales/en/inbox.json packages/i18n/src/locales/en/calendar.json packages/i18n/src/locales/en/journal.json packages/i18n/src/locales/en/graph.json packages/i18n/src/locales/en/settings.json packages/i18n/src/locales/en/common.json
git commit -m "feat(i18n): burn down inbox and remaining renderer TODOs"
```

## Chunk 6: Ratchet To Zero

### Task 11: Tighten `i18n:check` scripts

**Files:**
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Modify if needed: `apps/desktop/scripts/i18n/check.test.mjs`

- [ ] **Step 1: Prove no TODOs remain**

```bash
rg -n "TODO\\(i18n\\): wrap" apps/desktop/src/renderer/src
```

Expected: exits `1` with no matches.

- [ ] **Step 2: Prove strict checker passes before changing scripts**

```bash
pnpm --filter @memry/desktop i18n:check --max-todo 0
```

Expected: exits `0`.

- [ ] **Step 3: Update package scripts to enforce the ratchet**

In `apps/desktop/package.json`, change:

```json
"i18n:check": "node scripts/i18n/check.mjs"
```

to:

```json
"i18n:check": "node scripts/i18n/check.mjs --max-todo 0"
```

Keep the root `package.json` script as:

```json
"i18n:check": "pnpm --filter @memry/desktop i18n:check"
```

- [ ] **Step 4: Run tooling tests**

```bash
pnpm --filter @memry/desktop test:i18n-tools
pnpm i18n:check
```

Expected:

- tooling tests pass
- root `pnpm i18n:check` exits `0`
- text output has no TODO warning

- [ ] **Step 5: Commit the ratchet**

```bash
git add package.json apps/desktop/package.json apps/desktop/scripts/i18n/check.test.mjs
git commit -m "chore(i18n): ratchet TODO baseline to zero"
```

## Final Verification Gate

Run from the worktree root:

- [ ] `pnpm --filter @memry/desktop test:i18n-tools`
  - Expected: all i18n tooling tests pass.
- [ ] `pnpm i18n:check`
  - Expected: exits `0`, no TODO warning, no missing English keys.
- [ ] `pnpm lint`
  - Expected: exits `0`; existing non-i18n warnings are acceptable.
- [ ] `pnpm typecheck`
  - Expected: exits `0`.
- [ ] `pnpm --filter @memry/i18n test`
  - Expected: package tests pass.
- [ ] `pnpm --filter @memry/desktop test:renderer -- i18n`
  - Expected: renderer i18n tests pass. If the filter runs the full renderer suite, the full suite must pass or failures must be triaged.
- [ ] `pnpm --filter @memry/desktop test:main -- locale-handler`
  - Expected: locale handler tests pass. If the filter runs the full main suite, the full suite must pass or failures must be triaged.
- [ ] `pnpm --filter @memry/desktop exec playwright test --config config/playwright.config.ts tests/e2e/i18n.e2e.ts`
  - Expected: live language switch, RTL direction, and native menu rebuild E2E pass. If Electron E2E cannot run locally, stop and report the exact environment blocker.

If any command fails:

- Stop.
- Record the exact command, exit code, and first actionable error.
- Fix only the Phase F slice that caused the failure.
- Do not add Turkish/Arabic translation content to fix a fallback warning.

## Final Review Checklist

- [ ] `rg -n "TODO\\(i18n\\): wrap" apps/desktop/src/renderer/src` returns no matches.
- [ ] `pnpm i18n:check` enforces `--max-todo 0`.
- [ ] Every remaining user-facing renderer string introduced by Phase E is behind `t()`.
- [ ] Every new English key is in the correct namespace.
- [ ] No `tr` / `ar` feature namespace files were populated as part of this phase.
- [ ] User-authored content remains untranslated and is only interpolated into UI strings.
- [ ] Count-dependent copy uses ICU plural syntax.
- [ ] Technical false positives have scanner/ESLint tests before allowlist changes.
- [ ] No broad RTL Tailwind codemod was included.
- [ ] No main-process Phase D strings were included.

## Commit Plan

Use atomic commits while implementing:

```bash
git commit -m "fix(i18n): ignore technical text in TODO burn-down"
git commit -m "feat(i18n): burn down shell and shared UI TODOs"
git commit -m "feat(i18n): burn down notes and folder TODOs"
git commit -m "feat(i18n): burn down tasks TODOs"
git commit -m "feat(i18n): burn down inbox and remaining renderer TODOs"
git commit -m "chore(i18n): ratchet TODO baseline to zero"
```

Omit the false-positive commit if no scanner or ESLint rule changes are needed.
