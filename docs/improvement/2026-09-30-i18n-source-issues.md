# i18n source issues that translation cannot fix

Date: 2026-09-30. Owner: Kaan. Status: proposed. Baseline: `main` @ `e8541ae`.

## Context

The `desktop-i18n-translations` branch completes all 31 non-English desktop locales: every
English key is translated, orphan keys are gone, and each string passes the ICU, placeholder
and CLDR plural checks. The translator and reviewer agents also reported problems that live
in the source code or in the English strings. Those still show broken or mixed-language UI in
every locale, whatever the translation says.

Each item below was verified against the code; none were fixed on that branch. `R/` means
`apps/desktop/src/renderer/src/`. "Locales" is roughly how many of the 31 locales reported it.

## Dead components

These files are never imported or rendered. They carry the same bugs, but no user sees them.
Delete them rather than fix them, after Kaan approves the removal:

- `subtask-dots.tsx`, `subtask-progress-badge.tsx`, `today-task-row.tsx`,
  `edit-repeating-task-dialog.tsx`
- `keyboard-shortcuts-modal.tsx`, `empty-states/simple-empty-state.tsx`,
  `empty-states/collapsed-empty-section.tsx`, `filters/filter-chip.tsx`
- `tasks/dialogs/{delete-parent,complete-parent,parent-picker}-dialog.tsx`, `MultiTaskBadge`
  (`multi-drag-overlay.tsx:298`)
- `components/bulk/delete-confirmation-dialog.tsx`, `components/bulk/ai-cluster-suggestion.tsx`
- `components/inbox/inbox-list.tsx` (and with it `QuickFileDropdown`),
  `drag-drop/sidebar-drop-zones.tsx`, `quick-add/quick-add-help.tsx`, `snooze-countdown.tsx`

## Issues

| #   | Issue                                                                           | Main location                           | Locales | Impact   |
| --- | ------------------------------------------------------------------------------- | --------------------------------------- | ------- | -------- |
| 1   | Sync popover joins hard-coded English words with translated fragments           | `R/components/sync/sync-status.tsx`     | ~28     | High     |
| 2   | English plural `s` appended in code                                             | task bulk dialogs, custom repeat        | ~31     | High     |
| 3   | Relative times always English (date-fns without a locale, hand-rolled "5m ago") | device list, sync status, note cards    | ~20     | High     |
| 4   | Journal dates built in English order from nominative month names                | `R/lib/journal-utils.ts:190`            | ~17     | High     |
| 5   | Hard-coded English strings with no key (aria labels, toasts, tool labels)       | tasks, agent chat, sync                 | ~18-29  | High/Med |
| 6   | Fragments closed by a quote or `?` hard-coded in JSX                            | view switcher, icon picker, tag dialogs | ~30     | Med      |
| 7   | Number printed outside the string, so the noun cannot agree                     | row context menu, search, graph         | ~18     | Med      |
| 8   | Sentences split around `<kbd>`, links or an email address                       | shortcuts dialog, account section       | ~11     | Med      |
| 9   | Recurrence text: ordinal/weekday gender, English-only day suffix, ASCII lists   | `R/lib/repeat-utils.ts:81-178`          | ~15     | Med      |
| 10  | English `one {…}` branches without `#` also fire for 2, 21, …                   | 32 en keys                              | ~17     | Med      |
| 11  | English count strings with no plural block                                      | ~30 keys                                | ~21     | Low/Med  |
| 12  | English text out of date with current behavior                                  | settings, calendar, agent chat          | 6-16    | Low/Med  |
| 13  | `{title}` receives either a real title or the phrase "this note"                | `in-page-review-pointer.tsx`            | ~7      | Low      |
| 14  | 409 English keys no code references                                             | `i18n:check` output                     | ~24     | Low      |

### 1. Sync popover

- `R/components/sync/sync-status.tsx:237-300` writes "change/changes", "note/notes" and
  "conflict/conflicts" in English next to the fragments
  `settings:phaseF.componentsSyncSyncStatus.pending/localOnly/detected/items`. Turkish shows
  "3 conflicts algılandı".
- `${n} pushed` / `${n} pulled` (lines 256-257) and "Session expired — sign in again"
  (line 317) are English literals. Lines 237-238 join "Last synced " to an English relative
  time.
- **Fix:** reuse the existing ICU keys `account.sync.statuses.pushed/pulled/changesPending`,
  add plural keys for local-only notes, detected conflicts and `{current}/{total}` items, and
  delete the fragments.

### 2. English plural `s` in code

The code appends `{n !== 1 ? 's' : ''}` after a translated noun. German shows "alle 2 Tags",
Turkish "Sil 3 görevs?".

- `R/components/tasks/bulk-actions/bulk-delete-dialog.tsx:57-64,81-87,102-105`
- `R/components/tasks/bulk-actions/bulk-due-date-picker.tsx:77-79`
- `R/components/tasks/bulk-actions/bulk-action-dropdown.tsx:83-86` (also renders "for 3tasks"
  with no space, in English too)
- `R/components/tasks/delete-project-dialog.tsx:60-62`
- `R/components/tasks/drag-drop/multi-drag-overlay.tsx:215-218`
- `R/components/tasks/custom-repeat-dialog.tsx:521-535`
- `R/components/sync/device-revoked-dialog.tsx:59-60` (whole sentence English, plus "Exported"
  at line 78)
- **Fix:** one ICU plural message per sentence, e.g.
  `{count, plural, one {Delete # task?} other {Delete # tasks?}}`. `common:count.task` exists.

### 3. Relative times

- `formatDistanceToNow` without a locale: `R/components/sync/device-list.tsx:199-205`
  (German shows "Zuletzt gesehen vor 5 minutes"; with `addSuffix: false` the bare nominative
  after "vor/před/prije" is also the wrong case), `R/hooks/use-sync-status.ts:170` (feeds
  `R/pages/settings/account-section.tsx:545,628`), `R/components/sync/sync-history.tsx:73`,
  `R/components/note/version-history.tsx:395` (plus `format(…, 'p')` at line 430).
- Hand-rolled English: `R/components/folder-view/note-card-pieces.tsx:80-92` returns "now" /
  "5m ago" for the folder list, gallery and `home.widget.recentMeta/openedMeta`.
  `R/pages/project/use-relative-time.ts:45-51` uses compact "m/h/d".
- English month/weekday names from `format` without a locale:
  `R/components/tasks/custom-repeat-dialog.tsx:273,352`,
  `R/components/calendar/calendar-note-popover.tsx:64-67`.
- **Fix:** move the `Intl.RelativeTimeFormat` helper in
  `R/components/tasks/task-activity-row.tsx:121-131` (copied in `general-section.tsx:626`) to a
  shared lib and use it everywhere; date-fns has no Filipino locale. Change
  `devices.lastSeen/linked` to "Last seen {time}" and pass the whole suffixed phrase (those two
  keys then need retranslating). Use `Intl.DateTimeFormat(getActiveLocale(), …)` for dates.

### 4. Journal dates

- `formatDayHeader` builds `` `${monthName} ${dayNum}, ${year}` ``
  (`R/lib/journal-utils.ts:176-195`). Polish shows "styczeń 15, 2026".
- `R/components/journal/journal-date-display.tsx:58` renders `{dayName}, {month} {day}`.
  Spanish shows "Lunes, enero 5".
- `journal:export.noteTitle` puts a nominative `{month}` into a date
  (`R/pages/journal.tsx:357-364`); Czech, Finnish, Greek and Slavic languages need another case.
- **Fix:** `Intl.DateTimeFormat(locale, { weekday, month: 'long', day, year })`, and change the
  title key to "Journal - {date}". The title is display-only, so no stored data changes.

### 5. Hard-coded English with no key

- `R/components/tasks/custom-repeat-dialog.tsx`: ", selected" aria (line 88), "Pick a date"
  (273), preview headers (331-338).
- `R/hooks/use-undoable-task-actions.ts:182,186`: toast descriptions.
- `R/components/tasks/filters/active-filters-bar.tsx:31`: `Remove ${label} filter`.
- "Click to change." aria labels: `interactive-due-date-badge.tsx:105`,
  `interactive-status-badge.tsx:37`, `interactive-priority-badge.tsx:86`,
  `inline-status-popover.tsx:66`, `inline-priority-popover.tsx:81`, `project-picker.tsx:290`.
- `R/components/tasks/kanban/kanban-column.tsx:172` ("Add task to …"),
  `R/components/folder-view/filter-row.tsx:389` ("Pick a date").
- `R/agent-chat/messages/tool-call-message.tsx:45-131`: the `toolLabels` map and
  `getDesktopToolLabel` are English and feed `{tool}` in `alwaysAllowHint`
  (`approval-actions.tsx:72-74`), so Greek shows "Creating note" inside a Greek sentence.
- `task-activity-row.tsx:97` shows booleans as "true"/"false"; `stop-repeating-dialog.tsx:48-50`
  hard-codes "on a schedule" and lowercases localized text.
- The i18n ESLint rules do not inspect JS strings or template literals, so these pass lint.
  `R/components/folder-view/row-context-menu.tsx:215` ("Move {n} Notes to Folder...") also
  slips through: the item contains ⇧⌘M, so `isShortcutDisplayElement`
  (`apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.mjs:44,55-58`) skips it.

### 6. Fragments closed by a quote or `?` in JSX

Translators must open with an ASCII `"` to match, so Greek shows `"Όνομα"?` instead of «…»;.
Sites: `R/components/folder-view/view-switcher.tsx:412-413`, `R/components/icon-picker.tsx:629-630`,
`R/components/sidebar/tag-delete-dialog.tsx:56-57`, `tag-rename-dialog.tsx:90-92`,
`delete-project-dialog.tsx:53-54`, `R/components/filing/folder-selector.tsx:258-259`,
`R/components/tabs/pinned-tab.tsx:109`, `R/components/note/content-area/slash-menu.tsx:341`,
`stop-repeating-dialog.tsx:67-68`.
**Fix:** one message with a placeholder, as `MoveToFolderDialog.createFolderNamed` already does.

### 7. Number printed outside the string

Czech shows "Smazat 5 poznámky"; Croatian "21 rezultata". Sites: `row-context-menu.tsx:221-222`,
`R/components/search/search-result-group.tsx:60-61`, `grouped-table.tsx:1482-1485` (can reuse
`common:action.showMore`), `kanban-column.tsx:230`, `bulk-action-toolbar.tsx:175-177`,
`priority-panel.tsx:131`, `tag-panel.tsx:128`, `task-badges.tsx:128,226-227`,
`R/pages/settings/tasks-section.tsx:181`, `R/components/graph/graph-page.tsx:254-262` (picks
English singular/plural, `${type}s` fallback), `R/components/journal/journal-year-view.tsx:131,147-148`
(`=== 1` choice and a "k" suffix; use `Intl.NumberFormat` compact), `todays-notes.tsx:103-114`,
`ai-connections-panel.tsx:131-133`, `custom-repeat-dialog.tsx:170-200`.
**Fix:** pass `count` into a single ICU plural message.

### 8. Sentences split around elements

`R/components/keyboard/keyboard-shortcuts-dialog.tsx:340-344`,
`R/components/ui/autocomplete-dropdown.tsx:133-139`, `account-section.tsx:90-117`
(`account.community.*`, final "." hard-coded), `account-section.tsx:740-747`,
`R/components/sync/otp-verification.tsx:34-35`. Russian and Ukrainian need a comma after the
key chip; Japanese needs the verb after the keys.
**Fix:** one message with a `{keys}`/`{link}` slot rendered by a small split-on-placeholder
helper. `IcuFormatter` sets `ignoreTag: true`; check whether react-i18next `<Trans>` works with it
before choosing that route.

### 9. Recurrence text

`everyNMonthsOnWeekDay` (`R/lib/repeat-utils.ts:171-178`) joins genderless ordinals
(lines 83-93) with `Intl` weekday names: Russian "первый среда", Portuguese "primeira sábado".
The day suffix is English-only and blank elsewhere (lines 96-120); weekday lists are joined
with ASCII ", " (157-160).
**Fix:** pass the weekday as a `select` argument, use `selectordinal` for the day of month, and
`Intl.ListFormat` for lists.

### 10. `one` branches without `#`

32 en keys use `one {Every day}`-style text (`common:recurrence.*`,
`calendar:subscribedEvent.recurrence.*`, `notes:editor.taskRemoval.*`, `tasks:toasts.drag.*`).
In Filipino `one` also matches 2, 3, 5…, so fil shows "Araw-araw" (daily) for "every 2 days"
in 22 keys; in hr, ru and uk `one` matches 21 and 31.
**Fix:** use `=1 {…}` in en and in the locale copies.

### 11. English count strings with no plural block

Wrong in English at 1: `common:canvas.folderCanvasCount` ("1 canvases inside"),
`phaseF.componentsVaultSwitcher.itemsCount`, `settings:vault.accountVaults.itemsCount`,
`setup.linking.vaultRow`, `inbox:toast.linkedToNotes/filedItemsTo`,
`inbox:bulk.selected/ariaLabel`, `journal:aria.notesCreatedToday`,
`journal:count.words/completed/overdue`, `notes:page.largeFile.viewer.lines`,
`notes:outline.words`, `notes:versionHistory.words`, `notes:backlinks.summary/showMore`,
`notes:outgoingLinks.showMore`, `tasks:toasts.bulk.unarchived/undoUnarchive`,
`tasks:drawer.activityCharsAdded/Removed`, `settings:import.stats.skipped`,
`settings:import.dialog.summary.skipped/failed`, `settings:calendar.google.selected`.
Fixed-value keys that read wrong in some languages: `account.billing.historyDays`,
`calendar.providers.pollInterval`, `tasks:drawer.activityRetention`.
**Fix:** wrap in `{count, plural, …}`. Placeholder names stay, so older locale files still work.

### 12. Out-of-date English text

- `settings:tasks.defaultProject.none` says "No default (use Personal)", but
  `apps/desktop/src/main/database/defaults.ts:25` seeds "Inbox" and no Personal project exists.
- `calendar:agent-access-dialog.footnote` points to "Settings → Integrations → Google
  Calendar"; there is no Integrations page (calendar lives under Modules → Calendar,
  `R/pages/settings.tsx:175-193`).
- `agentChat.approval.alwaysInVaultHint` says "Settings › Agent" and
  `canvas.cluster.disabled` says "Settings > AI"; the nav item is "AI & Agents".
- `calendar:timeline.group-by-label` renders "By No grouping"
  (`R/components/calendar/timeline-controls.tsx:118`).

### 13. `{title}` slot

`R/agent-chat/messages/in-page-review-pointer.tsx:57,84-85` and `tool-call-message.tsx:238-240`
pass either a real title or "this note", so the case or quotes are wrong for one of them.
**Fix:** a separate key for the untitled case.

### 14. Unused keys

`pnpm --filter @memry/desktop i18n:check` reports 409 English keys that no scanned source
references, and every locale pays to translate them. Examples: `VaultOnboarding.*`,
`FirstRunOnboarding.*`, `TagDetailView.*`, `MoveToFolderDialog.current/noFoldersMatch/create`,
`SearchCommandPalette.noResultsFor`, `FilterBuilder.allAnd/anyOr/of/ofTheFollowing`,
`settings:shortcuts.custom`, `settings:import.dialog.chooseHint`,
`settings:ai.embedding.embeddings/dimensions`, `settings:agentProviders.actions.models`.
Confirm each is dead before removing it from en and the 31 locales.
