# I18n Phase C Journal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all journal feature user-facing strings into the Phase C `journal` namespace while preserving English behavior, keeping Turkish and Arabic journal namespace files as literal `{}`, and reusing Phase B `common` keys only where those keys already exist.

**Architecture:** Journal React components call `useT('journal')` for journal-specific UI copy and `useT('common')` only for already-supplied shared verbs/states. Pure journal date helpers stay hook-free by accepting translated label maps from components, with English fallback constants for existing callers/tests. Tiptap extension aria labels get translation callbacks through extension options so non-React extension code stays independent of React hooks.

**Tech Stack:** React 19, TypeScript, i18next/react-i18next, `@memry/i18n`, Vitest, Testing Library, Playwright Electron E2E, JSON locale resources.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Depends on:** Phase A i18n infrastructure and Phase B common namespace merged or present in the target worktree.

**Out of scope:** Phase D menu/error/global copy, Phase E lint/codemod work, Turkish/Arabic journal translations, and changes to journal save semantics, IPC contracts, sync, or editor content behavior.

---

## Spec

Source of truth:

- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`

Phase C journal scope:

- Namespace file: `packages/i18n/src/locales/en/journal.json`
- Translation hook: `useT('journal')`
- Feature folder: `apps/desktop/src/renderer/src/components/journal/**`
- Journal page and journal-specific supporting code:
  - `apps/desktop/src/renderer/src/pages/journal.tsx`
  - `apps/desktop/src/renderer/src/lib/journal-utils.ts`
  - `apps/desktop/src/renderer/src/hooks/use-journal-reminders.ts`

The plan covers:

- Journal titles and section labels
- Entry/editor chrome
- Empty/loading states
- Date, month, weekday, relative-day, greeting, and navigation labels
- Action labels, aria labels, tooltips, prompts, toasts, and journal-specific copy
- Journal-specific Tiptap extension labels under the journal feature folder

Locale policy:

- Populate English `journal.json`.
- Keep `packages/i18n/src/locales/tr/journal.json` exactly `{}`.
- Keep `packages/i18n/src/locales/ar/journal.json` exactly `{}`.
- Do not add non-English feature namespace strings unless a later translation plan explicitly says so.

## Depends On

- Phase A i18n infrastructure is present:
  - `packages/i18n/src/renderer/use-t.ts`
  - `packages/i18n/src/shared/config.ts`
  - `packages/i18n/src/shared/types.ts`
  - renderer i18n provider wiring
- Phase B common namespace is present:
  - `packages/i18n/src/locales/en/common.json`
  - `packages/i18n/src/locales/tr/common.json`
  - `packages/i18n/src/locales/ar/common.json`
- `journal` already exists in `I18N_NAMESPACES`.
- `journal.json` exists for `en`, `tr`, and `ar`.

## Out of Scope

- Phase D menu/error/global copy.
- Phase E lint rules, codemods, and i18n key coverage tooling.
- Populating Turkish or Arabic journal translations.
- Changing journal product behavior, save semantics, data loading, IPC contracts, schema, sync, or editor content model.
- Refactoring unrelated journal layout, styles, accessibility behavior, or tests beyond what the migration requires.
- Rewriting shared test utilities unless needed for a journal i18n wrapper.

## Files To Inspect

Read these before editing implementation code:

- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- `packages/i18n/src/renderer/use-t.ts`
- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/locales/en/common.json`
- `packages/i18n/src/locales/en/journal.json`
- `packages/i18n/src/locales/tr/journal.json`
- `packages/i18n/src/locales/ar/journal.json`
- `apps/desktop/src/renderer/src/pages/journal.tsx`
- `apps/desktop/src/renderer/src/lib/journal-utils.ts`
- `apps/desktop/src/renderer/src/hooks/use-journal-reminders.ts`
- `apps/desktop/src/renderer/src/components/journal/ai-connections-panel.tsx`
- `apps/desktop/src/renderer/src/components/journal/collapsible-section.tsx`
- `apps/desktop/src/renderer/src/components/journal/date-breadcrumb.tsx`
- `apps/desktop/src/renderer/src/components/journal/day-card.tsx`
- `apps/desktop/src/renderer/src/components/journal/day-context-sidebar.tsx`
- `apps/desktop/src/renderer/src/components/journal/default-template-indicator.tsx`
- `apps/desktop/src/renderer/src/components/journal/editor-toolbar.tsx`
- `apps/desktop/src/renderer/src/components/journal/floating-day-context.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-breadcrumb.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-date-display.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-day-panel.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-editor.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-entry-list-item.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-error-boundary.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-header-actions.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-month-view.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-navigation-row.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-reminder-button.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-stats-footer.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-year-view.tsx`
- `apps/desktop/src/renderer/src/components/journal/note-drawer.tsx`
- `apps/desktop/src/renderer/src/components/journal/todays-notes.tsx`
- `apps/desktop/src/renderer/src/components/journal/extensions/tag/tag-autocomplete.tsx`
- `apps/desktop/src/renderer/src/components/journal/extensions/tag/tag.ts`
- `apps/desktop/src/renderer/src/components/journal/extensions/wiki-link/wiki-link-autocomplete.tsx`
- `apps/desktop/src/renderer/src/components/journal/extensions/wiki-link/wiki-link.ts`
- `apps/desktop/src/renderer/src/components/journal/editor-toolbar.test.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-day-panel.test.tsx`
- `apps/desktop/src/renderer/src/lib/journal-utils.test.ts`
- `apps/desktop/tests/e2e/i18n.e2e.ts`
- `apps/desktop/tests/e2e/journal.e2e.ts`
- `apps/desktop/tests/utils/render.tsx`

Use `rg` for the first pass:

```bash
rg -n --glob '*.{ts,tsx,json}' \
  '"[^"]*[A-Za-z][^"]*"|'\''[^'\'']*[A-Za-z][^'\'']*'\''' \
  apps/desktop/src/renderer/src/components/journal \
  apps/desktop/src/renderer/src/pages/journal.tsx \
  apps/desktop/src/renderer/src/lib/journal-utils.ts \
  apps/desktop/src/renderer/src/hooks/use-journal-reminders.ts
```

Expected output:

- Lines containing candidate English user-facing strings.
- Some false positives from imports, test ids, class names, enum values, and internal constants; do not migrate those.

## Files To Modify

Implementation files:

- `packages/i18n/src/locales/en/journal.json`
- `apps/desktop/src/renderer/src/pages/journal.tsx`
- `apps/desktop/src/renderer/src/lib/journal-utils.ts`
- `apps/desktop/src/renderer/src/hooks/use-journal-reminders.ts`
- `apps/desktop/src/renderer/src/components/journal/ai-connections-panel.tsx`
- `apps/desktop/src/renderer/src/components/journal/collapsible-section.tsx`
- `apps/desktop/src/renderer/src/components/journal/date-breadcrumb.tsx`
- `apps/desktop/src/renderer/src/components/journal/day-card.tsx`
- `apps/desktop/src/renderer/src/components/journal/day-context-sidebar.tsx`
- `apps/desktop/src/renderer/src/components/journal/default-template-indicator.tsx`
- `apps/desktop/src/renderer/src/components/journal/editor-toolbar.tsx`
- `apps/desktop/src/renderer/src/components/journal/floating-day-context.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-breadcrumb.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-date-display.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-day-panel.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-editor.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-entry-list-item.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-error-boundary.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-header-actions.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-month-view.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-navigation-row.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-reminder-button.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-stats-footer.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-year-view.tsx`
- `apps/desktop/src/renderer/src/components/journal/note-drawer.tsx`
- `apps/desktop/src/renderer/src/components/journal/todays-notes.tsx`
- `apps/desktop/src/renderer/src/components/journal/extensions/tag/tag-autocomplete.tsx`
- `apps/desktop/src/renderer/src/components/journal/extensions/tag/tag.ts`
- `apps/desktop/src/renderer/src/components/journal/extensions/wiki-link/wiki-link-autocomplete.tsx`
- `apps/desktop/src/renderer/src/components/journal/extensions/wiki-link/wiki-link.ts`

Test files:

- `apps/desktop/src/renderer/src/components/journal/editor-toolbar.test.tsx`
- `apps/desktop/src/renderer/src/components/journal/journal-day-panel.test.tsx`
- `apps/desktop/src/renderer/src/lib/journal-utils.test.ts`

Files to create:

- `apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx`

Files that must remain unchanged except formatting caused by explicit implementation need:

- `packages/i18n/src/locales/tr/journal.json`
- `packages/i18n/src/locales/ar/journal.json`

## Key Design

### Namespace Shape

Use nested keys grouped by journal surface, not by component filename only. Keep names stable and readable:

```json
{
  "title": "Journal",
  "section": {
    "journal": "Journal",
    "aiConnections": "AI Connections",
    "todaysNotes": "Today's Notes",
    "schedule": "Schedule",
    "tasks": "Tasks"
  },
  "action": {
    "versionHistory": "Version History",
    "export": "Export",
    "fullWidth": "Full width",
    "journalSettings": "Journal Settings",
    "focusMode": "Focus Mode",
    "exitFocusMode": "Exit Focus Mode",
    "createNote": "Create Note",
    "createNewNote": "Create new note",
    "startBlank": "Start blank instead",
    "changeTemplate": "Change template"
  },
  "date": {
    "relative": {
      "today": "Today",
      "yesterday": "Yesterday",
      "tomorrow": "Tomorrow",
      "future": "Future"
    },
    "weekday": {
      "sunday": "Sunday"
    },
    "weekdayShort": {
      "sunday": "Sun"
    },
    "month": {
      "january": "January"
    },
    "monthShort": {
      "january": "Jan"
    }
  }
}
```

Add complete weekday/month key sets in implementation. The snippet above shows shape only.

### Common Namespace Use

Use `common` only for Phase B keys already present, for example:

- `common:button.retry`
- `common:button.close`
- `common:button.open`
- `common:button.delete`
- `common:button.edit`
- `common:state.loading`
- `common:state.error`

Keep these in `journal` because they are feature-specific phrases:

- `Create Note`
- `Version History`
- `Journal Settings`
- `Full Mode`
- `Compact Mode`
- `Start blank instead`
- `Refresh connections`
- `Go to Today`
- `Reload Journal`
- `Try Again` unless intentionally replaced with existing `common:button.retry`

### Interpolation

Follow existing i18n interpolation style in this repo:

```tsx
t('toast.noteNotFound', { target })
t('ai.connectionAria', { label, scorePercent })
t('stats.modified', { date })
```

Use ICU-style plural/select syntax only if the repo's current i18n setup supports it for JSON resources. If not confirmed, use simple count branches in TypeScript and separate singular/plural keys:

```tsx
count === 1 ? t('count.note') : t('count.notes')
```

### Journal Date Helpers

Do not call hooks from `journal-utils.ts`. Keep the module pure.

Add exported label types/constants:

```ts
export type JournalDateLabels = {
  weekdays: readonly string[]
  weekdaysShort: readonly string[]
  months: readonly string[]
  monthsShort: readonly string[]
  relative: {
    today: string
    yesterday: string
    tomorrow: string
    future: string
  }
  greetings: {
    morning: string
    afternoon: string
    evening: string
    night: string
  }
}

export const ENGLISH_JOURNAL_DATE_LABELS: JournalDateLabels = { ... }
```

Then update existing helpers to accept optional labels:

- `formatDayHeader(dateStr, labels = ENGLISH_JOURNAL_DATE_LABELS)`
- `formatDateParts(dateStr, labels = ENGLISH_JOURNAL_DATE_LABELS)`
- `getMonthName(monthIndex, labels = ENGLISH_JOURNAL_DATE_LABELS)`
- `getSpecialDayLabel(dateStr, labels = ENGLISH_JOURNAL_DATE_LABELS)`
- `getTimeBasedGreeting(labels = ENGLISH_JOURNAL_DATE_LABELS)`

In React components, build a labels object from `useT('journal')` and pass it to helpers.

### Tiptap Extension Labels

For non-React extension definitions:

- Extend `TagOptions` with `getAriaLabel?: (tag: string) => string`.
- Extend `WikiLinkOptions` with `getAriaLabel?: (title: string) => string`.
- Keep current English fallback values in extension defaults for non-React usage.
- Configure the extensions from `JournalEditor` using `useT('journal')`:

```tsx
const { t, i18n } = useT('journal')

Tag.configure({
  getAriaLabel: (tag) => t('tag.ariaLabel', { tag })
})
```

If the editor instance memoizes extensions, include translation dependencies without resetting document content. Prefer updating extension options on language change only where supported; otherwise keep fallback behavior documented in the test note and avoid remounting the editor if that would risk content loss.

### Error Boundary

`journal-error-boundary.tsx` is a class component. Do not call `useT` inside it.

Use one of these approaches:

- Wrap the fallback UI in `<Translation ns="journal">`.
- Extract the rendered fallback body into a small function component that uses `useT('journal')`, while the class boundary remains responsible for catching errors.

Do not replace the error boundary behavior as part of this migration.

## Implementation Steps

### 0. Preflight

- [ ] Confirm only Phase C journal files are in scope.

```bash
git status --short
```

Expected output:

- Either no output, or unrelated files owned by other agents.
- If unrelated files appear, do not edit, stage, revert, or format them.

- [ ] Confirm Phase A/B i18n base exists.

```bash
test -f packages/i18n/src/renderer/use-t.ts \
  && test -f packages/i18n/src/locales/en/common.json \
  && test -f packages/i18n/src/locales/en/journal.json \
  && echo "Phase A/B i18n base present"
```

Expected output:

```text
Phase A/B i18n base present
```

- [ ] Confirm TR/AR journal stubs start as literal `{}`.

```bash
node -e "const fs=require('fs'); for (const p of ['packages/i18n/src/locales/tr/journal.json','packages/i18n/src/locales/ar/journal.json']) { const s=fs.readFileSync(p,'utf8').trim(); if (s !== '{}') throw new Error(p+' must stay {}'); } console.log('journal stubs ok')"
```

Expected output:

```text
journal stubs ok
```

Atomic commit suggestion after this chunk:

```bash
git add docs/superpowers/plans/2026-04-29-i18n-phase-c-journal.md
git commit -m "docs: add journal i18n phase c plan"
```

Only commit the plan file if the task is plan-only. For implementation work, continue before committing.

### 1. Create English Journal Namespace

- [ ] Replace `packages/i18n/src/locales/en/journal.json` with the full English key tree.
- [ ] Include title/section keys:
  - `title`
  - `section.journal`
  - `section.aiConnections`
  - `section.todaysNotes`
  - `section.schedule`
  - `section.tasks`
  - `section.calendarEvents`
  - `section.overdueTasks`
  - `section.technicalDetails`
- [ ] Include action/menu keys:
  - `action.versionHistory`
  - `action.export`
  - `action.fullWidth`
  - `action.journalSettings`
  - `action.fullMode`
  - `action.compactMode`
  - `action.focusMode`
  - `action.exitFocusMode`
  - `action.createNote`
  - `action.createNewNote`
  - `action.showLess`
  - `action.showMoreNotes`
  - `action.showFewerNotes`
  - `action.startBlank`
  - `action.changeTemplate`
  - `action.dismissIndicator`
  - `action.refreshConnections`
  - `action.reloadJournal`
  - `action.goToToday`
  - `action.copyUnsavedContent`
  - `action.openNoteFullPage`
  - `action.closeNoteDrawer`
- [ ] Include editor keys:
  - `editor.placeholder.future`
  - `editor.placeholder.today`
  - `editor.placeholder.past`
  - `editor.placeholder.default`
  - `editor.toolbar.ariaLabel`
  - `editor.toolbar.bold`
  - `editor.toolbar.italic`
  - `editor.toolbar.underline`
  - `editor.toolbar.strikethrough`
  - `editor.toolbar.link`
  - `editor.toolbar.image`
  - `editor.toolbar.moreOptions`
  - `editor.toolbar.heading1`
  - `editor.toolbar.heading2`
  - `editor.toolbar.heading3`
  - `editor.toolbar.bulletList`
  - `editor.toolbar.numberedList`
  - `editor.toolbar.checklist`
  - `editor.toolbar.quote`
  - `editor.toolbar.divider`
  - `editor.toolbar.codeBlock`
  - `editor.prompt.enterUrl`
  - `editor.upload.noEntry`
  - `editor.upload.failed`
- [ ] Include date keys:
  - `date.relative.today`
  - `date.relative.yesterday`
  - `date.relative.tomorrow`
  - `date.relative.future`
  - `date.weekday.sunday` through `date.weekday.saturday`
  - `date.weekdayShort.sunday` through `date.weekdayShort.saturday`
  - `date.month.january` through `date.month.december`
  - `date.monthShort.january` through `date.monthShort.december`
  - `date.greeting.morning`
  - `date.greeting.afternoon`
  - `date.greeting.evening`
  - `date.greeting.night`
  - `date.allDay`
- [ ] Include navigation and aria keys:
  - `nav.previousDay`
  - `nav.nextDay`
  - `nav.previousMonth`
  - `nav.nextMonth`
  - `nav.previousYear`
  - `nav.nextYear`
  - `nav.journalBack`
  - `nav.dateNavigation`
  - `nav.goToYearView`
  - `nav.previousView`
  - `nav.nextView`
  - `aria.moreOptions`
  - `aria.documentStatistics`
  - `aria.dayContext`
  - `aria.scheduleEvents`
  - `aria.tasks`
- [ ] Include empty/loading/error keys:
  - `empty.noEntry`
  - `empty.noDaysInMonth`
  - `empty.noEventsScheduled`
  - `empty.noEventsScheduledToday`
  - `empty.noEventsWereScheduled`
  - `empty.noTasksDue`
  - `empty.noTasksDueToday`
  - `empty.noTasksWereDue`
  - `empty.noNotesToday`
  - `empty.startDocumenting`
  - `ai.loading`
  - `ai.empty.willAppear`
  - `ai.empty.noneYet`
  - `ai.empty.moreJournaling`
  - `ai.empty.keepWriting`
  - `ai.error.loadFailed`
- [ ] Include count/status keys:
  - `count.item`
  - `count.items`
  - `count.note`
  - `count.notes`
  - `count.day`
  - `count.days`
  - `count.event`
  - `count.events`
  - `count.meeting`
  - `count.meetings`
  - `count.task`
  - `count.tasks`
  - `count.todo`
  - `count.people`
  - `count.moreConnections`
  - `count.daysWithEntries`
  - `count.charactersWritten`
  - `count.words`
  - `count.characters`
  - `count.completed`
  - `count.overdue`
  - `stats.wordCount`
  - `stats.characterCount`
  - `stats.readingTime`
  - `stats.lastModified`
  - `stats.lessThanOneMinute`
  - `stats.minutes`
  - `stats.read`
  - `stats.modified`
- [ ] Include task/status/template/reminder/toast/extension keys:
  - `task.completed`
  - `task.notCompleted`
  - `task.priority`
  - `task.overdue`
  - `task.markComplete`
  - `task.markNotComplete`
  - `template.using`
  - `reminder.hasReminders`
  - `reminder.setToRevisit`
  - `reminder.tooltip`
  - `reminder.success.set`
  - `reminder.success.deleted`
  - `reminder.success.dismissed`
  - `reminder.success.snoozed`
  - `reminder.error.set`
  - `reminder.error.delete`
  - `reminder.error.dismiss`
  - `reminder.error.snooze`
  - `toast.unsavedRetry`
  - `toast.noteNotFound`
  - `toast.fileNotFound`
  - `toast.openLinkedItemFailed`
  - `toast.errorPrefix`
  - `export.noteTitle`
  - `note.generatedTitle`
  - `note.openAria`
  - `ai.connectionAria`
  - `tag.suggestionsAria`
  - `tag.empty.title`
  - `tag.empty.description`
  - `tag.groupTitle`
  - `tag.create`
  - `tag.ariaLabel`
  - `wiki.suggestionsAria`
  - `wiki.empty.title`
  - `wiki.groupRecent`
  - `wiki.groupAllPages`
  - `wiki.createNewPage`
  - `wiki.ariaLabel`

Validate JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/journal.json','utf8')); console.log('journal json ok')"
```

Expected output:

```text
journal json ok
```

Atomic commit suggestion:

```bash
git add packages/i18n/src/locales/en/journal.json
git commit -m "feat(i18n): add English journal namespace"
```

### 2. Update Pure Journal Date Utilities

- [ ] Add `JournalDateLabels` and `ENGLISH_JOURNAL_DATE_LABELS` to `apps/desktop/src/renderer/src/lib/journal-utils.ts`.
- [ ] Replace hard-coded weekday/month/greeting arrays with English fallback labels.
- [ ] Update exported date label helpers to accept optional translated labels.
- [ ] Preserve existing default English output for all existing callers.
- [ ] Add or update `journal-utils.test.ts` coverage:
  - default English month/day output still passes
  - custom labels are used for month names
  - custom labels are used for relative labels
  - custom labels are used for greetings if the helper is deterministic/testable

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- apps/desktop/src/renderer/src/lib/journal-utils.test.ts
```

Expected output:

- Vitest exits 0.
- `journal-utils.test.ts` passes.

Atomic commit suggestion:

```bash
git add apps/desktop/src/renderer/src/lib/journal-utils.ts apps/desktop/src/renderer/src/lib/journal-utils.test.ts
git commit -m "feat(i18n): make journal date labels translatable"
```

### 3. Migrate Journal Page And Toast Copy

- [ ] In `apps/desktop/src/renderer/src/pages/journal.tsx`, import and use `useT('journal')`.
- [ ] Use `useT('common')` only for Phase B shared verbs such as retry where the exact key exists.
- [ ] Migrate tab title `Journal`.
- [ ] Migrate unsaved retry toast copy and retry action label.
- [ ] Migrate wiki/note open toasts:
  - `Note "{target}" not found`
  - `File not found: {target}`
  - `Failed to open linked item`
  - `Error:`
- [ ] Migrate ContentArea placeholders:
  - future planning placeholder
  - today placeholder
  - past reflection placeholder
- [ ] Migrate export/version note title format.
- [ ] Pass translated date labels from the page into date helper calls where this page formats journal dates.

Add focused tests in `journal-i18n.test.tsx` or existing page-adjacent tests if a page test harness already exists:

- [ ] Render journal page or smallest practical child with an i18n provider.
- [ ] Assert English placeholder appears through the `journal` namespace.
- [ ] Assert changing the English resource value changes rendered output without code changes.

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
```

Expected output:

- Vitest exits 0.
- New i18n smoke test passes.

Atomic commit suggestion:

```bash
git add apps/desktop/src/renderer/src/pages/journal.tsx apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
git commit -m "feat(i18n): migrate journal page copy"
```

### 4. Migrate Journal Entry And Date Chrome

- [ ] Migrate date/navigation labels in:
  - `date-breadcrumb.tsx`
  - `journal-breadcrumb.tsx`
  - `journal-date-display.tsx`
  - `journal-entry-list-item.tsx`
  - `journal-month-view.tsx`
  - `journal-year-view.tsx`
  - `journal-navigation-row.tsx`
- [ ] Use translated date labels instead of English month/weekday constants.
- [ ] Replace `slice(0, 3)` month/weekday abbreviations with `date.weekdayShort.*` and `date.monthShort.*`.
- [ ] Migrate badges and labels:
  - `Today`
  - `Yesterday`
  - `Tomorrow`
  - `Future`
  - `No entry`
  - `No days in this month`
  - `days with entries`
  - `characters written`
- [ ] Migrate navigation aria/title text:
  - previous/next day
  - previous/next month
  - previous/next year
  - journal back
  - journal date navigation
  - go to year view
  - add/remove bookmark
  - more options
  - full/compact mode
  - version history/export
- [ ] Add tests for one translated month label and one translated navigation label in `journal-i18n.test.tsx`.

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx apps/desktop/src/renderer/src/lib/journal-utils.test.ts
```

Expected output:

- Vitest exits 0.
- Date helper and journal i18n tests pass.

Atomic commit suggestion:

```bash
git add \
  apps/desktop/src/renderer/src/components/journal/date-breadcrumb.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-breadcrumb.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-date-display.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-entry-list-item.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-month-view.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-year-view.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-navigation-row.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
git commit -m "feat(i18n): migrate journal date chrome"
```

### 5. Migrate Editor Chrome

- [ ] In `editor-toolbar.tsx`, migrate:
  - toolbar aria label
  - Bold, Italic, Underline, Strikethrough
  - Link, Image
  - Focus Mode, Exit Focus Mode
  - More options
  - Heading 1/2/3
  - Bullet List, Numbered List, Checklist, Quote, Divider, Code Block
  - `Enter URL:`
  - no-entry upload toast
  - upload failed fallback
- [ ] In `journal-editor.tsx`, migrate editor placeholders or pass translated placeholders down from the parent if that is the existing data flow.
- [ ] In `note-drawer.tsx`, migrate:
  - open full page aria
  - close drawer aria
  - editor placeholder
  - toolbar button labels/titles
- [ ] Update `editor-toolbar.test.tsx` to wrap with an i18n provider if needed.
- [ ] Keep existing assertions meaningful by asserting translated English labels.

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- apps/desktop/src/renderer/src/components/journal/editor-toolbar.test.tsx apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
```

Expected output:

- Vitest exits 0.
- Existing toolbar behavior tests still pass.
- i18n smoke coverage passes.

Atomic commit suggestion:

```bash
git add \
  apps/desktop/src/renderer/src/components/journal/editor-toolbar.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-editor.tsx \
  apps/desktop/src/renderer/src/components/journal/note-drawer.tsx \
  apps/desktop/src/renderer/src/components/journal/editor-toolbar.test.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
git commit -m "feat(i18n): migrate journal editor chrome"
```

### 6. Migrate Day Panel, Context, Stats, And Templates

- [ ] In `day-card.tsx`, migrate:
  - Calendar Events
  - meeting/task counts
  - Overdue Tasks
  - attendee count suffix
  - plan/start-writing placeholders
  - focus mode labels and aria text
- [ ] In `journal-day-panel.tsx`, migrate any remaining journal-specific labels.
- [ ] In `day-context-sidebar.tsx`, migrate:
  - empty schedule/task states
  - day context aria labels
  - Today/schedule/tasks titles
  - event/task/to-do counts
  - overdue badge
  - all-day label
  - task completed/not-completed/priority/overdue labels
  - mark complete/not-complete aria labels
- [ ] In `floating-day-context.tsx`, migrate:
  - Today/Schedule/Tasks tabs
  - empty event/task states
  - all-day label
  - overdue/completed counts
- [ ] In `default-template-indicator.tsx`, migrate:
  - `Using "{templateName}"`
  - Change template
  - Start blank instead
  - dismiss aria
- [ ] In `journal-stats-footer.tsx`, migrate:
  - Document statistics aria
  - Word count, Character count, Estimated reading time, Last modified
  - `< 1 min`
  - `{minutes} min`
  - `{count} words`
  - `{count} chars`
  - `{readingTime} read`
  - `Modified {date}`
- [ ] Replace hard-coded `en-US` date formatting with i18n-aware language where safe:
  - use `i18n.language` when formatting user-visible dates
  - keep data keys/storage values unchanged
- [ ] Update `journal-day-panel.test.tsx` with an i18n provider if needed.

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- apps/desktop/src/renderer/src/components/journal/journal-day-panel.test.tsx apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
```

Expected output:

- Vitest exits 0.
- Existing day panel behavior tests still pass.
- Translated labels render from `journal`.

Atomic commit suggestion:

```bash
git add \
  apps/desktop/src/renderer/src/components/journal/day-card.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-day-panel.tsx \
  apps/desktop/src/renderer/src/components/journal/day-context-sidebar.tsx \
  apps/desktop/src/renderer/src/components/journal/floating-day-context.tsx \
  apps/desktop/src/renderer/src/components/journal/default-template-indicator.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-stats-footer.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-day-panel.test.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
git commit -m "feat(i18n): migrate journal day context copy"
```

### 7. Migrate AI Connections And Today's Notes

- [ ] In `ai-connections-panel.tsx`, migrate:
  - AI Connections header
  - Show less
  - more connections count
  - refresh connections title
  - connection aria label
  - loading text
  - empty states
  - error fallback
  - retry action, using `common:button.retry` if the exact Phase B key is present
- [ ] In `todays-notes.tsx`, migrate:
  - Today's Notes header
  - generated note title
  - show fewer/more aria labels
  - Show less / more button content
  - create new note aria/title
  - notes-created-today aria
  - note open aria
  - empty title/body
  - Create Note action
- [ ] Add i18n smoke tests for at least one empty state and one action label.

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
```

Expected output:

- Vitest exits 0.
- AI/notes copy smoke tests pass.

Atomic commit suggestion:

```bash
git add \
  apps/desktop/src/renderer/src/components/journal/ai-connections-panel.tsx \
  apps/desktop/src/renderer/src/components/journal/todays-notes.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
git commit -m "feat(i18n): migrate journal side panels"
```

### 8. Migrate Reminders, Errors, And Feature Extension Copy

- [ ] In `use-journal-reminders.ts`, migrate toast success/error copy:
  - reminder set
  - delete success/error
  - dismiss success/error
  - snooze success/error
- [ ] Continue using `extractErrorMessage(result.error, fallback)` with translated fallback strings.
- [ ] In `journal-reminder-button.tsx`, migrate:
  - reminder tooltip
  - has reminders
  - set reminder to revisit
  - count overflow behavior stays unchanged
- [ ] In `journal-error-boundary.tsx`, migrate:
  - Journal Error
  - error description with `{date}`
  - unsaved content detected with `{length}`
  - copy unsaved content aria
  - Technical details
  - reload journal aria and label
  - go to today aria and label
- [ ] Keep the class error boundary behavior intact.
- [ ] In `tag-autocomplete.tsx`, migrate:
  - suggestions aria
  - No tags yet
  - Type to create a new tag
  - Tags
  - Create `#{query}`
- [ ] In `wiki-link-autocomplete.tsx`, migrate:
  - suggestions aria
  - No pages found
  - Recent
  - All Pages
  - Create new page
- [ ] In `tag.ts`, add translated aria label option with English fallback.
- [ ] In `wiki-link.ts`, add translated aria label option with English fallback.
- [ ] Configure translated extension label builders from `journal-editor.tsx`.

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
```

Expected output:

- Vitest exits 0.
- Error/reminder/extension smoke coverage passes where practical.

Atomic commit suggestion:

```bash
git add \
  apps/desktop/src/renderer/src/hooks/use-journal-reminders.ts \
  apps/desktop/src/renderer/src/components/journal/journal-reminder-button.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-error-boundary.tsx \
  apps/desktop/src/renderer/src/components/journal/extensions/tag/tag-autocomplete.tsx \
  apps/desktop/src/renderer/src/components/journal/extensions/tag/tag.ts \
  apps/desktop/src/renderer/src/components/journal/extensions/wiki-link/wiki-link-autocomplete.tsx \
  apps/desktop/src/renderer/src/components/journal/extensions/wiki-link/wiki-link.ts \
  apps/desktop/src/renderer/src/components/journal/journal-editor.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx
git commit -m "feat(i18n): migrate journal reminders and extension labels"
```

### 9. Sweep For Remaining Journal Strings

- [ ] Run a final journal-folder string sweep.

```bash
rg -n --glob '*.{ts,tsx}' \
  '"[^"]*[A-Za-z][^"]*"|'\''[^'\'']*[A-Za-z][^'\'']*'\''' \
  apps/desktop/src/renderer/src/components/journal \
  apps/desktop/src/renderer/src/pages/journal.tsx \
  apps/desktop/src/renderer/src/lib/journal-utils.ts \
  apps/desktop/src/renderer/src/hooks/use-journal-reminders.ts
```

Expected output:

- Remaining English string literals are only imports, class names, test ids, internal enum values, storage keys, log scopes, CSS tokens, route/path fragments, or deliberate English fallback constants in pure non-React code.
- Any remaining user-facing journal copy is either behind `t(...)`, `commonT(...)`, or explicitly documented as not user-facing.

- [ ] Confirm TR/AR journal stubs still literal `{}`.

```bash
node -e "const fs=require('fs'); for (const p of ['packages/i18n/src/locales/tr/journal.json','packages/i18n/src/locales/ar/journal.json']) { const s=fs.readFileSync(p,'utf8').trim(); if (s !== '{}') throw new Error(p+' must stay {}'); } console.log('journal stubs ok')"
```

Expected output:

```text
journal stubs ok
```

- [ ] Confirm English JSON still parses.

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/journal.json','utf8')); console.log('journal json ok')"
```

Expected output:

```text
journal json ok
```

Atomic commit suggestion:

```bash
git add packages/i18n/src/locales/en/journal.json apps/desktop/src/renderer/src/components/journal apps/desktop/src/renderer/src/pages/journal.tsx apps/desktop/src/renderer/src/lib/journal-utils.ts apps/desktop/src/renderer/src/hooks/use-journal-reminders.ts
git commit -m "chore(i18n): complete journal string sweep"
```

Skip this commit if all changes were already committed in the smaller chunks.

### 10. Focused Verification

- [ ] Run i18n package typecheck.

```bash
pnpm --filter @memry/i18n typecheck
```

Expected output:

- TypeScript exits 0.

- [ ] Run i18n package tests.

```bash
pnpm --filter @memry/i18n test
```

Expected output:

- Vitest exits 0.

- [ ] Run focused journal renderer tests.

```bash
pnpm --filter @memry/desktop test:renderer -- \
  apps/desktop/src/renderer/src/components/journal/editor-toolbar.test.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-day-panel.test.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx \
  apps/desktop/src/renderer/src/lib/journal-utils.test.ts
```

Expected output:

- Vitest exits 0.
- All named test files pass.

- [ ] Run desktop typecheck.

```bash
pnpm --filter @memry/desktop typecheck
```

Expected output:

- TypeScript exits 0, or only known pre-existing unrelated type errors are reported and documented with exact file/error text.

- [ ] Run lint.

```bash
pnpm lint
```

Expected output:

- ESLint exits 0.
- No new physical RTL classes are introduced in touched code. Existing physical classes may remain if not touched by this migration.

### 11. E2E Smoke Verification

- [ ] Run the i18n E2E smoke.

```bash
pnpm --filter @memry/desktop test:e2e -- i18n.e2e.ts
```

Expected output:

- Playwright exits 0.
- English fallback still renders when non-English locale namespaces are `{}`.

- [ ] Run the journal E2E smoke.

```bash
pnpm --filter @memry/desktop test:e2e -- journal.e2e.ts
```

Expected output:

- Playwright exits 0.
- Journal opens and core interactions still work.

If either E2E command fails because of an environment issue, stop and record:

- command
- exit code
- first failing test
- relevant error lines
- whether focused renderer tests already passed

Do not hide E2E failures behind a generic "flaky" label.

### 12. Final Scope Check

- [ ] Confirm only intended Phase C journal files changed.

```bash
git status --short
```

Expected output:

- Only files from this plan are modified.
- Other agents' Phase C plan files may appear; do not stage or revert them.

- [ ] Confirm no Phase D/E files were edited.

```bash
git diff --name-only
```

Expected output:

- No Phase D menu/error/global migration files.
- No Phase E lint/codemod files.
- No Turkish/Arabic journal locale changes except unchanged literal `{}` files if formatting did not move.

- [ ] Confirm TR/AR journal stubs are unchanged in the diff.

```bash
git diff -- packages/i18n/src/locales/tr/journal.json packages/i18n/src/locales/ar/journal.json
```

Expected output:

- No output.

Final atomic commit suggestion:

```bash
git add \
  packages/i18n/src/locales/en/journal.json \
  apps/desktop/src/renderer/src/pages/journal.tsx \
  apps/desktop/src/renderer/src/lib/journal-utils.ts \
  apps/desktop/src/renderer/src/hooks/use-journal-reminders.ts \
  apps/desktop/src/renderer/src/components/journal \
  apps/desktop/src/renderer/src/lib/journal-utils.test.ts
git commit -m "feat(i18n): migrate journal namespace"
```

Do not use `git add -A`. Do not stage other agents' files.

## Test Plan

Required focused tests:

- `apps/desktop/src/renderer/src/lib/journal-utils.test.ts`
  - Default English labels remain unchanged.
  - Custom translated labels are accepted by pure helpers.
  - Month/weekday short labels do not rely on English `slice(0, 3)`.
- `apps/desktop/src/renderer/src/components/journal/editor-toolbar.test.tsx`
  - Existing toolbar labels still render.
  - Existing image/focus behavior still passes.
- `apps/desktop/src/renderer/src/components/journal/journal-day-panel.test.tsx`
  - Existing day panel behavior still passes with i18n provider.
- `apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx`
  - Journal components render English strings from `journal`.
  - A test resource override changes rendered text without code changes.
  - `tr` or `ar` with `{}` journal namespace falls back to English for one representative journal string.
  - One translated date/month label appears through the date label map.
  - One journal-specific action stays in `journal`, not `common`.

Required commands:

```bash
pnpm --filter @memry/i18n typecheck
pnpm --filter @memry/i18n test
pnpm --filter @memry/desktop test:renderer -- \
  apps/desktop/src/renderer/src/components/journal/editor-toolbar.test.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-day-panel.test.tsx \
  apps/desktop/src/renderer/src/components/journal/journal-i18n.test.tsx \
  apps/desktop/src/renderer/src/lib/journal-utils.test.ts
pnpm --filter @memry/desktop typecheck
pnpm lint
pnpm --filter @memry/desktop test:e2e -- i18n.e2e.ts
pnpm --filter @memry/desktop test:e2e -- journal.e2e.ts
```

Expected final result:

- All focused tests pass.
- Typecheck passes or only documented pre-existing unrelated type errors remain.
- Lint passes.
- E2E smoke passes or environment failure is recorded with exact evidence.
- TR/AR `journal.json` files remain literal `{}`.
- English `journal.json` is populated and parses.

## Completion Checklist

- [ ] English `packages/i18n/src/locales/en/journal.json` contains every migrated journal feature string.
- [ ] `packages/i18n/src/locales/tr/journal.json` remains exactly `{}`.
- [ ] `packages/i18n/src/locales/ar/journal.json` remains exactly `{}`.
- [ ] Journal feature components use `useT('journal')` for journal copy.
- [ ] Shared Phase B verbs/states use `common` only when the key already exists.
- [ ] No Phase D menu/error/global copy was migrated.
- [ ] No Phase E lint/codemod work was added.
- [ ] Pure date helpers remain hook-free.
- [ ] Tiptap extension labels have translated option callbacks with English fallbacks.
- [ ] Focused unit tests and i18n smoke tests pass.
- [ ] E2E smoke result is recorded.
- [ ] Final diff contains only Phase C journal namespace migration files.
