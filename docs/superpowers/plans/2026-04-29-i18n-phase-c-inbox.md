# i18n Phase C — Inbox Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate inbox feature UI strings to the `inbox.json` namespace while preserving English behavior and leaving Turkish/Arabic inbox resources as English-fallback stubs.

**Architecture:** Phase C is a renderer-only namespace migration on top of Phase A/B i18n plumbing. Add English inbox keys in `packages/i18n/src/locales/en/inbox.json`, keep `tr/inbox.json` and `ar/inbox.json` as literal `{}`, then replace inbox feature literals with `useT('inbox')` and already-supplied common verbs with `useT('common')` only where the key exists in Phase B. No main-process strings, error taxonomy, native menu, lint rule, or codemod work belongs here.

**Tech Stack:** TypeScript, React 19, `react-i18next`, `@memry/i18n`, ICU strings via `i18next-icu`, Vitest, Testing Library, Electron renderer.

---

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Depends on:**
- Phase A merged: `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- Phase B merged: `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- Existing Phase B common keys available for shared verbs: `common.button.cancel`, `common.button.delete`, `common.button.retry`, `common.button.open`, `common.button.add`, `common.button.close`, `common.action.search`, `common.state.loading`, `common.state.searching`

**Out of scope:**
- Phase D: `errors.json`, native `menu.json`, main-process or IPC error messages
- Phase E: `pnpm i18n:check`, ESLint rule, JSX literal codemod, Tailwind logical-property codemod
- Notes/calendar/journal/settings/tasks namespace migration
- Translating Turkish or Arabic inbox content; `tr/inbox.json` and `ar/inbox.json` remain `{}` so i18next falls back to English
- Backend/domain inbox strings that are not rendered directly to users

## Files

Inspect before editing:
- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- `packages/i18n/src/locales/en/common.json`
- `packages/i18n/src/renderer/use-t.ts`
- `packages/i18n/src/shared/types.ts`
- `apps/desktop/src/renderer/src/pages/inbox.tsx`
- `apps/desktop/src/renderer/src/pages/inbox/inbox-list-view.tsx`
- `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx`
- `apps/desktop/src/renderer/src/pages/inbox/inbox-health-view.tsx`
- `apps/desktop/src/renderer/src/components/inbox/inbox-segment-control.tsx`
- `apps/desktop/src/renderer/src/components/inbox/inbox-list.tsx`
- `apps/desktop/src/renderer/src/components/inbox/triage-action-bar.tsx`
- `apps/desktop/src/renderer/src/components/inbox/triage-snooze-picker.tsx`
- `apps/desktop/src/renderer/src/components/inbox/triage-complete.tsx`
- `apps/desktop/src/renderer/src/components/inbox/inbox-archived-view.tsx`
- `apps/desktop/src/renderer/src/components/empty-state/inbox-zero-state.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/inbox-detail-panel.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/detail-header.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/filing-section.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/link-input.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/content-section.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/reminder-detail.tsx`
- `apps/desktop/src/renderer/src/components/quick-actions.tsx`
- `apps/desktop/src/renderer/src/components/bulk/bulk-action-bar.tsx`
- `apps/desktop/src/renderer/src/components/bulk/bulk-file-panel.tsx`
- `apps/desktop/src/renderer/src/components/bulk/bulk-tag-popover.tsx`
- `apps/desktop/src/renderer/src/components/bulk/archive-confirmation-dialog.tsx`

Modify:
- `packages/i18n/src/locales/en/inbox.json`
- `packages/i18n/src/locales/tr/inbox.json`
- `packages/i18n/src/locales/ar/inbox.json`
- `apps/desktop/src/renderer/src/pages/inbox.tsx`
- `apps/desktop/src/renderer/src/pages/inbox/inbox-list-view.tsx`
- `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx`
- `apps/desktop/src/renderer/src/pages/inbox/inbox-health-view.tsx`
- `apps/desktop/src/renderer/src/components/inbox/inbox-segment-control.tsx`
- `apps/desktop/src/renderer/src/components/inbox/inbox-list.tsx`
- `apps/desktop/src/renderer/src/components/inbox/triage-action-bar.tsx`
- `apps/desktop/src/renderer/src/components/inbox/triage-snooze-picker.tsx`
- `apps/desktop/src/renderer/src/components/inbox/triage-complete.tsx`
- `apps/desktop/src/renderer/src/components/inbox/inbox-archived-view.tsx`
- `apps/desktop/src/renderer/src/components/empty-state/inbox-zero-state.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/inbox-detail-panel.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/detail-header.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/filing-section.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/link-input.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/content-section.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/reminder-detail.tsx`
- `apps/desktop/src/renderer/src/components/quick-actions.tsx`
- `apps/desktop/src/renderer/src/components/bulk/bulk-action-bar.tsx`
- `apps/desktop/src/renderer/src/components/bulk/bulk-file-panel.tsx`
- `apps/desktop/src/renderer/src/components/bulk/bulk-tag-popover.tsx`
- `apps/desktop/src/renderer/src/components/bulk/archive-confirmation-dialog.tsx`

Create:
- `apps/desktop/src/renderer/src/components/inbox/inbox-i18n.test.tsx`

Do not edit:
- `packages/i18n/src/locales/en/errors.json`
- `packages/i18n/src/locales/en/menu.json`
- `packages/i18n/src/locales/en/notes.json`
- `packages/i18n/src/locales/en/calendar.json`
- `packages/i18n/src/locales/en/journal.json`
- `apps/desktop/src/main/**`
- `apps/desktop/scripts/**`
- any other Phase C plan file written by another agent

## Namespace Shape

Populate `packages/i18n/src/locales/en/inbox.json` with semantic keys, not English-text keys:

```json
{
  "view": {
    "tabs": {
      "inbox": "Inbox",
      "archived": "Archived",
      "insights": "Insights",
      "ariaLabel": "Inbox view selection"
    },
    "triageButton": "Triage",
    "processInboxTitle": "Process inbox (Cmd+P)",
    "itemCaptured": "Item captured",
    "searchArchivedTitle": "Search archived items",
    "searchPlaceholder": "Search...",
    "snoozed": {
      "show": "Show snoozed items",
      "showWithCount": "Show snoozed items ({count})",
      "hide": "Hide snoozed items"
    },
    "filter": {
      "button": "Filter",
      "byType": "Filter by type",
      "active": "{count, plural, one {Filtering by # type} other {Filtering by # types}}",
      "clearAll": "Clear all"
    },
    "jobs": {
      "running": "{count, plural, one {# background job running} other {# background jobs running}}",
      "failed": "{count} failed"
    }
  },
  "type": {
    "link": "Link",
    "links": "Links",
    "note": "Note",
    "notes": "Notes",
    "image": "Image",
    "images": "Images",
    "voice": "Voice",
    "video": "Video",
    "clip": "Clip",
    "clips": "Clips",
    "pdf": "PDF",
    "pdfs": "PDFs",
    "social": "Social",
    "reminder": "Reminder",
    "reminders": "Reminders",
    "text": "Text",
    "other": "Other"
  },
  "empty": {
    "successAria": "Success, inbox is empty",
    "title": "Inbox Zero",
    "body": "Everything's processed. Capture something new with the input above, or paste a link to get started.",
    "filedThisWeek": "{count, plural, one {# filed this week} other {# filed this week}}",
    "dayStreak": "{count, plural, one {# day streak} other {# day streak}}",
    "tipPrefix": "Tip: use",
    "tipSuffix": "to quick-capture from clipboard",
    "archivedNone": "No archived items",
    "archivedNoMatches": "No matching archived items",
    "noItemsYet": "No items yet",
    "noItemsFiled": "No items filed yet",
    "noItemTypes": "No item types to display",
    "noFolders": "No folders found",
    "noFolderMatch": "No folders match \"{query}\"",
    "noNotes": "No notes found",
    "allMatchesLinked": "All matches already linked"
  },
  "list": {
    "ariaLabel": "Inbox items",
    "section": {
      "today": "Today",
      "yesterday": "Yesterday",
      "older": "Older"
    },
    "selectItem": "Select {title}",
    "itemAria": "{type}: {title}",
    "untitled": "Untitled",
    "untitledItem": "Untitled Item",
    "transcribing": "Transcribing...",
    "transcriptionFailed": "Transcription failed",
    "retryTranscription": "Retry",
    "pageCount": "{count, plural, one {# page} other {# pages}}",
    "snoozedUntilShort": "snoozed til {date}",
    "capturedAgo": "Captured {time}"
  },
  "loading": {
    "inbox": "Loading inbox...",
    "failed": "Failed to load inbox",
    "tryAgain": "Try again",
    "capturingImage": "Capturing image...",
    "dropImageTitle": "Drop image to capture",
    "dropImageTypes": "PNG, JPEG, GIF, WebP, SVG",
    "unsupportedImageType": "Unsupported image type: {type}"
  },
  "toast": {
    "failedArchiveItem": "Failed to archive item",
    "failedArchiveItems": "Failed to archive items",
    "failedFile": "Failed to file",
    "failedFileItem": "Failed to file item",
    "failedFileItems": "Failed to file items",
    "failedSnooze": "Failed to snooze",
    "failedSnoozeItem": "Failed to snooze item",
    "failedApplyTags": "Failed to apply tags",
    "linkedToNote": "Linked to note",
    "linkedToNotes": "Linked to {count} notes",
    "filedTo": "Filed to {folder}",
    "filedItemsTo": "Filed {count} items to {folder}",
    "filedPartial": "Filed {processed} of {total} items",
    "appliedTags": "{tagCount, plural, one {Applied # tag} other {Applied # tags}} to {itemCount, plural, one {# item} other {# items}}",
    "archivedItems": "{count, plural, one {Archived # item} other {Archived # items}}",
    "snoozedUntil": "Snoozed until {time}",
    "snoozedItemsUntil": "{count, plural, one {Snoozed # item until {time}} other {Snoozed # items until {time}}}"
  },
  "triage": {
    "modeTitle": "Triage Mode",
    "exitHint": "Esc to exit",
    "exitAria": "Exit triage mode",
    "position": "{current} of {total}",
    "action": {
      "discard": "Discard",
      "archive": "Archive",
      "open": "Open",
      "toTask": "To Task",
      "toNote": "To Note",
      "file": "File",
      "snooze": "Snooze",
      "cancel": "Cancel"
    },
    "snoozeUntil": "Snooze until...",
    "complete": {
      "title": "Inbox Zero",
      "processed": "{count, plural, one {# item processed} other {# items processed}}",
      "streak": "streak",
      "back": "Back to Inbox",
      "motivation0": "Your future self thanks you.",
      "motivation1": "Everything in its place.",
      "motivation2": "Clear inbox, clear mind.",
      "motivation3": "Decision debt: paid in full.",
      "motivation4": "That felt good, didn't it?"
    }
  },
  "bulk": {
    "selected": "{count} selected",
    "deselectAll": "Deselect all",
    "ariaLabel": "Bulk actions for {count} selected items",
    "file": "File",
    "tag": "Tag",
    "snooze": "Snooze",
    "archive": "Archive",
    "add": "Add",
    "dismissSuggestion": "Dismiss suggestion",
    "hint": {
      "file": "file",
      "tag": "tag",
      "snooze": "snooze",
      "archive": "archive",
      "deselect": "deselect"
    },
    "archiveDialog": {
      "title": "{count, plural, one {Archive # item?} other {Archive # items?}}",
      "description": "These items will be archived. You can view archived items later.",
      "confirm": "{count, plural, one {Archive # item} other {Archive # items}}"
    },
    "filePanel": {
      "title": "{count, plural, one {File # Item} other {File # Items}}",
      "itemsToFile": "Items to file",
      "multipleNoteLinksUnavailable": "Note: Links to other notes cannot be added when filing multiple items.",
      "filing": "Filing...",
      "submit": "{count, plural, one {File # item} other {File # items}}",
      "macHint": "⌘⏎ to file · Esc to close",
      "ctrlHint": "Ctrl+Enter to file · Esc to close"
    },
    "tagPopover": {
      "title": "{count, plural, one {Tag # Item} other {Tag # Items}}",
      "placeholder": "Type to search tags...",
      "applying": "Applying...",
      "apply": "{count, plural, one {Apply to # item} other {Apply to # items}}"
    }
  },
  "quickActions": {
    "groupAria": "Quick actions",
    "archiveItem": "Archive item",
    "archive": "Archive",
    "snooze": "Snooze"
  },
  "detail": {
    "ariaLabel": "Item details",
    "closePanel": "Close panel",
    "resizeFiling": "Resize filing section",
    "restore": "Restore",
    "delete": "Delete",
    "archive": "Archive",
    "file": "File",
    "keyboardHint": "{modifier}⏎ file · 1-5 folder · Esc close",
    "voiceTitlePlaceholder": "Name this voice memo...",
    "fileTo": "File to",
    "ai": "AI",
    "selectFolder": "Select folder",
    "searchOrCreateFolder": "Search or create with /...",
    "suggested": "Suggested",
    "notesRoot": "Notes",
    "notesRootLabel": "Notes (root)",
    "createFolder": "Create \"{name}\"",
    "addTags": "Add tags...",
    "linkToNote": "Link to note",
    "linkNotesPlaceholder": "Link notes...",
    "searchNotesAria": "Search notes to link",
    "linkedNotesAria": "Linked notes",
    "removeLinkTo": "Remove link to {title}",
    "contentEditorAria": "Content editor",
    "notePlaceholder": "Write your note...",
    "textPlaceholder": "Edit your captured text..."
  },
  "content": {
    "capturedAt": "Captured {date}",
    "todayAt": "today at {time}",
    "yesterdayAt": "yesterday at {time}",
    "dateAt": "{date} at {time}",
    "words": "{count, plural, one {# word} other {# words}}",
    "duration": "Duration: {duration}",
    "dimensions": "Dimensions",
    "format": "Format",
    "size": "Size",
    "voiceMemo": "Voice memo",
    "play": "Play",
    "pause": "Pause",
    "audioPosition": "Audio position",
    "transcription": "Transcription",
    "processing": "processing",
    "pending": "pending",
    "failed": "failed",
    "copyTranscription": "Copy transcription",
    "transcribingAudio": "Transcribing audio...",
    "awaitingTranscription": "Awaiting transcription...",
    "noTranscription": "No transcription available",
    "failedPlayAudio": "Failed to play audio",
    "failedLoadAudio": "Failed to load audio",
    "video": "Video",
    "unsupportedVideo": "Your browser does not support the video tag."
  },
  "reminder": {
    "dataUnavailable": "Reminder data unavailable.",
    "triggered": "Reminder triggered",
    "noteLabel": "Reminder Note",
    "source": "Source",
    "journalTitle": "Journal — {date}",
    "noteFallback": "Note",
    "journalFallback": "Journal",
    "highlighted": "Highlighted: \"{text}\"",
    "viewed": "Viewed",
    "markViewed": "Mark as viewed",
    "notYetViewed": "Not yet viewed",
    "snooze": "Snooze",
    "presetInOneHour": "1 hour",
    "presetTomorrow": "Tomorrow",
    "presetNextWeek": "Next week",
    "custom": "Custom..."
  },
  "insights": {
    "loading": "Loading insights...",
    "captureActivity": "Capture Activity",
    "byType": "By Type",
    "itemTypes": "Item Types",
    "itemTypesDescription": "Distribution of content formats",
    "recentFilings": "Recent Filings",
    "recentlyFiled": "Recently Filed",
    "recentlyFiledDescription": "Latest actions on your inbox",
    "captured": "Captured",
    "capturedThisWeek": "+{count} this week",
    "processed": "Processed",
    "processRate": "{rate}% rate",
    "stale": "Stale",
    "needsAttention": "needs attention",
    "allClear": "all clear",
    "avgTimeToFile": "Avg Time to File",
    "noCapturesYet": "No captures yet",
    "captures": "{count, plural, one {# capture} other {# captures}}",
    "peak": "Peak: {day} {start}–{end}",
    "convertedToTask": "Converted to task",
    "linked": "Linked",
    "now": "now",
    "timeAgoMinutes": "{count}m ago",
    "timeAgoHours": "{count}h ago",
    "timeAgoDays": "{count}d ago"
  }
}
```

Keep these files as literal empty objects:

```json
{}
```

- `packages/i18n/src/locales/tr/inbox.json`
- `packages/i18n/src/locales/ar/inbox.json`

## Task 1: Populate English Inbox Namespace

**Files:**
- Modify: `packages/i18n/src/locales/en/inbox.json`
- Modify: `packages/i18n/src/locales/tr/inbox.json`
- Modify: `packages/i18n/src/locales/ar/inbox.json`

- [ ] **Step 1: Replace `en/inbox.json` with the namespace shape above**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/en/inbox.json','utf8')); console.log('OK')"
```

Expected: prints `OK`.

- [ ] **Step 2: Verify TR/AR fallback stubs stay empty**

Run:
```bash
cat packages/i18n/src/locales/tr/inbox.json
cat packages/i18n/src/locales/ar/inbox.json
```

Expected: both print exactly `{}`. Do not add empty-string values.

- [ ] **Step 3: Verify typed keys update**

Run:
```bash
pnpm --filter @memry/i18n typecheck
```

Expected: PASS. If it fails on JSON import typing, fix the JSON shape, not `types.ts`; Phase A already wires `en/inbox.json` into `Resources`.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/src/locales/en/inbox.json packages/i18n/src/locales/tr/inbox.json packages/i18n/src/locales/ar/inbox.json
git commit -m "feat(i18n): add English inbox namespace"
```

## Task 2: Migrate Inbox Page Toolbar and View Switcher

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/inbox.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox/inbox-segment-control.tsx`

- [ ] **Step 1: Add `useT('inbox')` in `InboxPage`**

In `apps/desktop/src/renderer/src/pages/inbox.tsx`, import:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside `InboxPage`:

```ts
const { t } = useT('inbox')
```

- [ ] **Step 2: Replace toolbar literals**

Use these replacements:

| Existing | Replacement |
|---|---|
| `toast.success('Item captured')` | `toast.success(t('view.itemCaptured'))` |
| `title="Process inbox (Cmd+P)"` | `title={t('view.processInboxTitle')}` |
| `Triage` | `{t('view.triageButton')}` |
| `title="Search archived items"` | `title={t('view.searchArchivedTitle')}` |
| `placeholder="Search..."` | `placeholder={t('view.searchPlaceholder')}` |
| `Hide snoozed items` | `t('view.snoozed.hide')` |
| `Show snoozed items (...)` | `t('view.snoozed.showWithCount', { count: snoozedCount })` |
| `Show snoozed items` | `t('view.snoozed.show')` |
| `Filtering by ...` | `t('view.filter.active', { count: selectedTypes.size })` |
| `Filter by type` | `t('view.filter.byType')` |
| `Filter` | `{t('view.filter.button')}` |
| `Clear all` | `{t('view.filter.clearAll')}` |
| background job text | `t('view.jobs.running', { count: activeJobCount })` |
| failed job text | `t('view.jobs.failed', { count: failedJobCount })` |

- [ ] **Step 3: Replace type labels with typed lookup**

Keep `INBOX_ITEM_TYPES`. Replace `INBOX_TYPE_LABELS` with a function inside `InboxPage` or a small local map of translation keys:

```ts
const typeLabels = useMemo(
  () => ({
    link: t('type.links'),
    note: t('type.notes'),
    image: t('type.images'),
    voice: t('type.voice'),
    video: t('type.video'),
    clip: t('type.clips'),
    pdf: t('type.pdfs'),
    social: t('type.social'),
    reminder: t('type.reminders')
  }),
  [t]
)
```

Then pass `label={typeLabels[type]}` to `Picker.Item`.

- [ ] **Step 4: Migrate segment labels**

In `apps/desktop/src/renderer/src/components/inbox/inbox-segment-control.tsx`, import `useT`, remove hard-coded `TABS` labels, and render labels from:

```ts
const { t } = useT('inbox')
const tabs = [
  { id: 'inbox', label: t('view.tabs.inbox') },
  { id: 'archived', label: t('view.tabs.archived') },
  { id: 'insights', label: t('view.tabs.insights') }
] as const
```

Replace `label="Inbox View Selection"` with `label={t('view.tabs.ariaLabel')}`.

- [ ] **Step 5: Run focused checks**

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop test inbox-list
```

Expected:
- `typecheck:web` PASS
- `inbox-list` PASS with existing assertions still English under default locale

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/inbox.tsx apps/desktop/src/renderer/src/components/inbox/inbox-segment-control.tsx
git commit -m "feat(i18n): migrate inbox toolbar strings"
```

## Task 3: Migrate Inbox List, Empty State, and Loading States

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/inbox/inbox-list-view.tsx`
- Modify: `apps/desktop/src/renderer/src/components/list-view.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox/inbox-list.tsx`
- Modify: `apps/desktop/src/renderer/src/components/empty-state/inbox-zero-state.tsx`

- [ ] **Step 1: Add inbox hook to list page**

In `inbox-list-view.tsx`, add:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside `InboxListView`:

```ts
const { t } = useT('inbox')
```

- [ ] **Step 2: Replace list-view toast and empty/loading literals**

Replace:
- `Failed to archive item` -> `t('toast.failedArchiveItem')`
- `Linked to note` -> `t('toast.linkedToNote')`
- `Linked to ${linkedNoteIds.length} notes` -> `t('toast.linkedToNotes', { count: linkedNoteIds.length })`
- `Filed to ${folderId || 'Notes'}` -> `t('toast.filedTo', { folder: folderId || t('detail.notesRoot') })`
- `Snoozed until ${timeString}` -> `t('toast.snoozedUntil', { time: timeString })`
- `Filed ${itemIds.length} items to ...` -> `t('toast.filedItemsTo', { count: itemIds.length, folder: folderId || t('detail.notesRoot') })`
- `Filed ${result.processedCount} of ${itemIds.length} items` -> `t('toast.filedPartial', { processed: result.processedCount, total: itemIds.length })`
- tag-apply toast -> `t('toast.appliedTags', { tagCount: tags.length, itemCount: result.processedCount })`
- archive bulk toast -> `t('toast.archivedItems', { count: idsToArchive.length })`
- snooze bulk toast -> `t('toast.snoozedItemsUntil', { count: result.processedCount, time: timeString })`
- image drop/loading strings -> `loading.dropImageTitle`, `loading.dropImageTypes`, `loading.capturingImage`
- loading/error text -> `loading.inbox`, `loading.failed`, `loading.tryAgain`
- selected header -> `bulk.selected`, `bulk.deselectAll`

Keep `extractErrorMessage(error, fallback)` but replace fallback English with `t(...)`. This is renderer fallback copy, not Phase D error taxonomy.

- [ ] **Step 3: Add inbox hook to `ListView`**

In `apps/desktop/src/renderer/src/components/list-view.tsx`, add `useT('inbox')`.

Replace:
- `aria-label="Inbox items"` -> `aria-label={t('list.ariaLabel')}`
- `title={group.period}` passed to `InboxListSection` -> translated title:

```ts
const sectionTitle =
  group.period === 'TODAY'
    ? t('list.section.today')
    : group.period === 'YESTERDAY'
      ? t('list.section.yesterday')
      : t('list.section.older')
```

Keep `period={group.period}` unchanged for behavior.

- [ ] **Step 4: Add inbox hook to `InboxListSection` / `InboxListItem` file**

In `apps/desktop/src/renderer/src/components/inbox/inbox-list.tsx`, add `useT('inbox')`.

Replace:
- `Transcribing...` -> `t('list.transcribing')`
- `Transcription failed` -> `t('list.transcriptionFailed')`
- `Retry` -> `t('list.retryTranscription')` or `common.button.retry` if a separate common hook is already convenient
- checkbox aria label -> `t('list.selectItem', { title: displayTitle })`
- listitem aria label -> `t('list.itemAria', { type: t(\`type.${item.type}\`), title: displayTitle })`; use an explicit key map instead of interpolating the translation key if TypeScript rejects dynamic keys
- `page/pages` pill -> `t('list.pageCount', { count: item.pageCount })`
- `snoozed til ...` -> `t('list.snoozedUntilShort', { date })`

- [ ] **Step 5: Migrate `InboxZeroState`**

In `apps/desktop/src/renderer/src/components/empty-state/inbox-zero-state.tsx`, add `useT('inbox')`.

Replace:
- `aria-label="Success, inbox is empty"` -> `t('empty.successAria')`
- `Inbox Zero` -> `t('empty.title')`
- subtitle -> `t('empty.body')`
- `{processedThisWeek} filed this week` -> `t('empty.filedThisWeek', { count: processedThisWeek })`
- `{currentStreak} day streak` -> `t('empty.dayStreak', { count: currentStreak })`
- tip text -> `t('empty.tipPrefix')` / `t('empty.tipSuffix')`

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter @memry/desktop test inbox-list
pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS. Update only assertions that intentionally check translated aria labels.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/inbox/inbox-list-view.tsx apps/desktop/src/renderer/src/components/list-view.tsx apps/desktop/src/renderer/src/components/inbox/inbox-list.tsx apps/desktop/src/renderer/src/components/empty-state/inbox-zero-state.tsx
git commit -m "feat(i18n): migrate inbox list and empty states"
```

## Task 4: Migrate Triage Mode and Snooze Action Labels

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox/triage-action-bar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox/triage-snooze-picker.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox/triage-complete.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox/streak-badge.tsx`

- [ ] **Step 1: Migrate `triage-view.tsx`**

Add `useT('inbox')` and replace:
- `Action failed` fallback -> keep as-is only if treated as Phase D generic error; otherwise `toast.failed...` if the action context is known
- `Note` / `Journal` fallback tab titles from reminder navigation -> `reminder.noteFallback`, `reminder.journalFallback`
- `aria-label="Exit triage mode"` -> `triage.exitAria`
- `Triage Mode` -> `triage.modeTitle`
- `Esc to exit` -> `triage.exitHint`
- `{current} of {total}` -> `triage.position`
- file picker buttons: `File` -> `triage.action.file`, `Cancel` -> `triage.action.cancel`

- [ ] **Step 2: Migrate `triage-action-bar.tsx`**

Add `useT('inbox')`. Keep shortcut keys `D/T/N/F/S/O` literal.

Replace action labels:
- `Archive` -> `triage.action.archive`
- `Open` -> `triage.action.open`
- `Discard` -> `triage.action.discard`
- `To Task` -> `triage.action.toTask`
- `To Note` -> `triage.action.toNote`
- `File` -> `triage.action.file`
- `Snooze` -> `triage.action.snooze`

- [ ] **Step 3: Migrate triage snooze picker**

Add `useT('inbox')` to `triage-snooze-picker.tsx`.

Replace:
- `Snooze until…` -> `triage.snoozeUntil`
- `Cancel` -> `triage.action.cancel` or `common.button.cancel`; prefer `common` only if adding a second hook is cleaner than duplicating the inbox key

Do not translate preset labels here unless `quickSnoozePresets` is being changed in this task. If labels are still sourced from `snooze-presets.ts`, handle them in Task 8 with the shared snooze picker scope.

- [ ] **Step 4: Migrate triage complete state**

Add `useT('inbox')` to `triage-complete.tsx`.

Replace:
- `Inbox Zero` -> `triage.complete.title`
- item processed text -> `triage.complete.processed`
- `streak` -> `triage.complete.streak`
- `Back to Inbox` -> `triage.complete.back`
- `MOTIVATIONAL_COPY` array -> keys `motivation0` through `motivation4`, with `pickMotivationKey(count)`

- [ ] **Step 5: Migrate streak badge**

Add `useT('inbox')` to `streak-badge.tsx`.

Replace:
- title `${streak} day processing streak` -> add `triage.complete.dayProcessingStreak` if needed, or reuse `empty.dayStreak` plus context only if acceptable
- visible `{streak} streak` -> either `triage.complete.streakCount` if added, or keep numeric + `triage.complete.streak`

If adding keys, add them to `en/inbox.json` in this same task.

- [ ] **Step 6: Run focused checks**

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop test inbox-list
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/i18n/src/locales/en/inbox.json apps/desktop/src/renderer/src/pages/inbox/triage-view.tsx apps/desktop/src/renderer/src/components/inbox/triage-action-bar.tsx apps/desktop/src/renderer/src/components/inbox/triage-snooze-picker.tsx apps/desktop/src/renderer/src/components/inbox/triage-complete.tsx apps/desktop/src/renderer/src/components/inbox/streak-badge.tsx
git commit -m "feat(i18n): migrate inbox triage strings"
```

## Task 5: Migrate Archived Inbox

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/inbox/inbox-archived-view.tsx`

- [ ] **Step 1: Add `useT('inbox')`**

Add import and hook in `InboxArchivedView`. For `ArchivedListItem`, either call `useT('inbox')` inside it or pass labels from the parent; prefer calling it inside if only this file uses the component.

- [ ] **Step 2: Replace archived labels**

Replace:
- list item aria label -> `list.itemAria`
- item fallback `Untitled` -> `list.untitled`
- `Restore to inbox` title/aria -> add `detail.restoreToInbox` if needed, or use `detail.restore` if short label is acceptable for title
- `Delete permanently` title/aria -> add `detail.deletePermanently`
- empty states -> `empty.archivedNoMatches`, `empty.archivedNone`
- `aria-label="Archived items"` -> add `view.archivedItemsAria` or use `view.tabs.archived`

If adding `detail.deletePermanently`, `detail.restoreToInbox`, or `view.archivedItemsAria`, add them to `en/inbox.json` in this task.

- [ ] **Step 3: Run checks**

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/src/locales/en/inbox.json apps/desktop/src/renderer/src/components/inbox/inbox-archived-view.tsx
git commit -m "feat(i18n): migrate archived inbox strings"
```

## Task 6: Migrate Inbox Detail Panel and Filing Controls

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/inbox-detail-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/detail-header.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/filing-section.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/link-input.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx`

- [ ] **Step 1: Migrate panel chrome**

In `inbox-detail-panel.tsx`, add `useT('inbox')` and replace:
- `keyboardHint` composition -> `t('detail.keyboardHint', { modifier: modifierKeyDisplay })`
- `aria-label="Item details"` -> `detail.ariaLabel`
- placeholder `Name this voice memo...` -> `detail.voiceTitlePlaceholder`
- `aria-label="Resize filing section"` -> `detail.resizeFiling`
- buttons `Restore`, `Delete`, `Archive`, `File` -> `detail.restore`, `detail.delete`, `detail.archive`, `detail.file`

Use `common.button.delete` only if the file already needs a common hook. Otherwise keep destructive inbox detail labels in `inbox`.

- [ ] **Step 2: Migrate detail header**

In `detail-header.tsx`, add `useT('inbox')`.

Replace:
- `getTypeLabel(type)` visible label with a local type-key map using `type.*`
- `aria-label="Close panel"` -> `detail.closePanel`

Do not migrate `formatCompactDate` output in this task.

- [ ] **Step 3: Migrate filing section**

In `filing-section.tsx`, add `useT('inbox')`.

Replace:
- root folder names `Notes (root)` and `Notes` -> `detail.notesRootLabel`, `detail.notesRoot`
- fallback `Select folder` -> `detail.selectFolder`
- `File to` -> `detail.fileTo`
- `AI` -> `detail.ai`
- placeholder `Search or create with /...` -> `detail.searchOrCreateFolder`
- `Suggested` -> `detail.suggested`
- `Create “...”` -> `detail.createFolder`
- `No folders found` -> `empty.noFolders`
- placeholder `Add tags...` -> `detail.addTags`
- `Link to note` -> `detail.linkToNote`

- [ ] **Step 4: Migrate link input**

In `link-input.tsx`, add `useT('inbox')`.

Replace:
- note subtype label `Note` -> `type.note`
- remove aria label -> `detail.removeLinkTo`
- placeholder `Link notes...` -> `detail.linkNotesPlaceholder`
- aria label `Search notes to link` -> `detail.searchNotesAria`
- `Searching...` -> use `common.state.searching` if adding common hook; otherwise add/use `detail.searching`
- no result strings -> `empty.allMatchesLinked`, `empty.noNotes`
- linked notes aria label -> `detail.linkedNotesAria`

- [ ] **Step 5: Migrate note detail**

In `note-detail.tsx`, add `useT('inbox')` and replace `Write your note...` with `detail.notePlaceholder`.

- [ ] **Step 6: Run checks**

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop test inbox-list
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/i18n/src/locales/en/inbox.json apps/desktop/src/renderer/src/components/inbox-detail/inbox-detail-panel.tsx apps/desktop/src/renderer/src/components/inbox-detail/detail-header.tsx apps/desktop/src/renderer/src/components/inbox-detail/filing-section.tsx apps/desktop/src/renderer/src/components/inbox-detail/link-input.tsx apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx
git commit -m "feat(i18n): migrate inbox detail and filing strings"
```

## Task 7: Migrate Inbox Content Preview and Reminder Detail

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/content-section.tsx`
- Modify: `apps/desktop/src/renderer/src/components/inbox-detail/reminder-detail.tsx`

- [ ] **Step 1: Migrate content-section labels**

Add `useT('inbox')` where needed. For helpers that currently live outside React (`formatDate`), either:
- keep date math in helper and return structured values for the component to pass into `t`, or
- pass `t` into a local formatter from the component.

Replace:
- `Captured ...` -> `content.capturedAt`
- `today at`, `yesterday at`, `at` -> `content.todayAt`, `content.yesterdayAt`, `content.dateAt`
- word count -> `content.words`
- `Duration:` -> `content.duration`
- image metadata labels -> `content.dimensions`, `content.format`, `content.size`
- `Voice memo` -> `content.voiceMemo`
- play/pause aria -> `content.play`, `content.pause`
- `Audio position` -> `content.audioPosition`
- `Transcription`, `processing`, `pending`, `failed` -> `content.*`
- copy aria -> `content.copyTranscription`
- transcribing/awaiting/failure/no transcription strings -> `content.transcribingAudio`, `content.awaitingTranscription`, `list.transcriptionFailed`, `content.noTranscription`
- retry -> `common.button.retry` if already supplied by Phase B, or `list.retryTranscription`
- PDF pages -> `list.pageCount`
- video fallback text -> `content.unsupportedVideo`
- `Video` metadata -> `content.video`
- text editor placeholder -> `detail.textPlaceholder`

Do not translate file-size units (`B`, `KB`, `MB`) in this phase.

- [ ] **Step 2: Migrate reminder detail**

Add `useT('inbox')` in `reminder-detail.tsx`.

Replace:
- `Reminder data unavailable.` -> `reminder.dataUnavailable`
- `Reminder triggered` -> `reminder.triggered`
- `Reminder Note` -> `reminder.noteLabel`
- `Source` -> `reminder.source`
- journal title -> `reminder.journalTitle`
- fallback `Note` / `Journal` -> `reminder.noteFallback`, `reminder.journalFallback`
- highlighted label -> `reminder.highlighted`
- `Viewed`, `Mark as viewed`, `Not yet viewed` -> `reminder.viewed`, `reminder.markViewed`, `reminder.notYetViewed`
- `Snooze` -> `reminder.snooze`
- preset labels `1 hour`, `Tomorrow`, `Next week`, `Custom...` -> `reminder.presetInOneHour`, `reminder.presetTomorrow`, `reminder.presetNextWeek`, `reminder.custom`

- [ ] **Step 3: Run checks**

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/inbox-detail/content-section.tsx apps/desktop/src/renderer/src/components/inbox-detail/reminder-detail.tsx
git commit -m "feat(i18n): migrate inbox content preview strings"
```

## Task 8: Migrate Bulk Actions, Archive Dialog, and Quick Actions

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/quick-actions.tsx`
- Modify: `apps/desktop/src/renderer/src/components/bulk/bulk-action-bar.tsx`
- Modify: `apps/desktop/src/renderer/src/components/bulk/bulk-file-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/bulk/bulk-tag-popover.tsx`
- Modify: `apps/desktop/src/renderer/src/components/bulk/archive-confirmation-dialog.tsx`

- [ ] **Step 1: Migrate quick actions**

In `quick-actions.tsx`, add `useT('inbox')` and replace:
- `aria-label="Quick actions"` -> `quickActions.groupAria`
- `aria-label="Archive item"` -> `quickActions.archiveItem`
- tooltip `Archive` -> `quickActions.archive`

Leave generic shared snooze picker internals alone unless rendered only from inbox. The visible inbox quick-action tooltip should be `quickActions.snooze` if touched.

- [ ] **Step 2: Migrate bulk action bar**

In `bulk-action-bar.tsx`, add `useT('inbox')`.

Replace:
- toolbar aria -> `bulk.ariaLabel`
- selected badge -> `bulk.selected`
- action labels `File`, `Tag`, `Snooze`, `Archive`, `Add` -> `bulk.*`
- suggestion dismiss aria -> `bulk.dismissSuggestion`
- keyboard hint labels -> `bulk.hint.*`

- [ ] **Step 3: Migrate archive confirmation dialog**

In `archive-confirmation-dialog.tsx`, add `useT('inbox')` and `useT('common')` if using common Cancel.

Replace:
- title -> `bulk.archiveDialog.title`
- description -> `bulk.archiveDialog.description`
- cancel -> `common.button.cancel`
- confirm -> `bulk.archiveDialog.confirm`

- [ ] **Step 4: Migrate bulk file panel**

In `bulk-file-panel.tsx`, add `useT('inbox')`.

Replace:
- root folder `Notes (root)` -> `detail.notesRootLabel`
- keyboard hint -> `bulk.filePanel.macHint` / `bulk.filePanel.ctrlHint`
- title -> `bulk.filePanel.title`
- `Items to file` -> `bulk.filePanel.itemsToFile`
- multiple note links note -> `bulk.filePanel.multipleNoteLinksUnavailable`
- `Filing...` -> `bulk.filePanel.filing`
- submit label -> `bulk.filePanel.submit`

- [ ] **Step 5: Migrate bulk tag popover**

In `bulk-tag-popover.tsx`, add `useT('inbox')`.

Replace:
- title -> `bulk.tagPopover.title`
- placeholder -> `bulk.tagPopover.placeholder`
- `Applying...` -> `bulk.tagPopover.applying`
- submit -> `bulk.tagPopover.apply`

- [ ] **Step 6: Run checks**

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop test delete-confirmation-dialog
```

Expected: PASS. `delete-confirmation-dialog` is not edited here, but it is an existing i18n smoke test for common ICU labels in nearby bulk UI.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/quick-actions.tsx apps/desktop/src/renderer/src/components/bulk/bulk-action-bar.tsx apps/desktop/src/renderer/src/components/bulk/bulk-file-panel.tsx apps/desktop/src/renderer/src/components/bulk/bulk-tag-popover.tsx apps/desktop/src/renderer/src/components/bulk/archive-confirmation-dialog.tsx
git commit -m "feat(i18n): migrate inbox bulk action strings"
```

## Task 9: Migrate Inbox Insights

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/inbox/inbox-health-view.tsx`
- Optional if used by current route: `apps/desktop/src/renderer/src/components/inbox/inbox-insights-view.tsx`
- Optional if used by current route: `apps/desktop/src/renderer/src/components/inbox/inbox-stats-cards.tsx`
- Optional if used by current route: `apps/desktop/src/renderer/src/components/inbox/inbox-capture-heatmap.tsx`
- Optional if used by current route: `apps/desktop/src/renderer/src/components/inbox/inbox-type-distribution.tsx`
- Optional if used by current route: `apps/desktop/src/renderer/src/components/inbox/inbox-filing-history.tsx`

- [ ] **Step 1: Confirm which insights implementation is active**

Current `apps/desktop/src/renderer/src/pages/inbox.tsx` renders `InboxHealthView` from `pages/inbox/inbox-health-view.tsx`. Treat `components/inbox/inbox-insights-view.tsx` and its child components as optional only if another import path still renders them.

- [ ] **Step 2: Migrate active health view**

In `pages/inbox/inbox-health-view.tsx`, add `useT('inbox')`.

Replace:
- day names and peak labels if visible -> use `Intl.DateTimeFormat` for day names where practical, and `insights.peak`
- `No captures yet`, `Capture Activity`, `By Type`, `No items yet`
- stat labels/subvalues: `Captured`, `Processed`, `Stale`, `Avg Time to File`, `+... this week`, `...% rate`, `needs attention`, `all clear`
- `Recent Filings`, `No items filed yet`
- filing row fallback `Untitled`, `Converted to task`
- relative text `now`, `m ago`, `h ago`, `d ago`

Keep compact duration units `m`, `h`, `d` if they are metric-style UI chips; translate only phrase-bearing text.

- [ ] **Step 3: Migrate optional legacy insights components only if active**

If grep shows `InboxInsightsView` is rendered anywhere, migrate the optional files with the same `insights.*`, `type.*`, and `empty.*` keys. If no active route uses them, leave them for a later cleanup note; do not expand scope.

- [ ] **Step 4: Run checks**

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/inbox/inbox-health-view.tsx
git commit -m "feat(i18n): migrate inbox insights strings"
```

If optional components were active and edited:

```bash
git add apps/desktop/src/renderer/src/components/inbox/inbox-insights-view.tsx apps/desktop/src/renderer/src/components/inbox/inbox-stats-cards.tsx apps/desktop/src/renderer/src/components/inbox/inbox-capture-heatmap.tsx apps/desktop/src/renderer/src/components/inbox/inbox-type-distribution.tsx apps/desktop/src/renderer/src/components/inbox/inbox-filing-history.tsx
git commit -m "feat(i18n): migrate legacy inbox insights components"
```

## Task 10: Add Focused i18n Component Tests

**Files:**
- Create: `apps/desktop/src/renderer/src/components/inbox/inbox-i18n.test.tsx`
- Modify if needed: `apps/desktop/src/renderer/src/components/inbox/inbox-list.test.tsx`

- [ ] **Step 1: Create a focused i18n test**

Create `apps/desktop/src/renderer/src/components/inbox/inbox-i18n.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeAll } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { InboxSegmentControl } from './inbox-segment-control'
import { TriageActionBar } from './triage-action-bar'
import { InboxZeroState } from '@/components/empty-state/inbox-zero-state'

describe('inbox i18n', () => {
  let i18nEn: I18nInstance
  let i18nTr: I18nInstance

  beforeAll(async () => {
    i18nEn = await createRendererI18n({ locale: 'en' })
    i18nTr = await createRendererI18n({ locale: 'tr' })
  })

  it('renders English inbox namespace labels', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <InboxSegmentControl value="inbox" onChange={() => {}} />
      </I18nextProvider>
    )

    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.getByText('Insights')).toBeInTheDocument()
  })

  it('falls back to English for Turkish inbox namespace stubs', () => {
    render(
      <I18nextProvider i18n={i18nTr}>
        <InboxSegmentControl value="archived" onChange={() => {}} />
      </I18nextProvider>
    )

    expect(screen.getByText('Inbox')).toBeInTheDocument()
    expect(screen.getByText('Archived')).toBeInTheDocument()
  })

  it('renders triage action labels from the inbox namespace', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <TriageActionBar
          itemType="note"
          activePicker={null}
          onPickerChange={() => {}}
          onDiscard={() => {}}
          onConvertToTask={() => {}}
          onExpandToNote={() => {}}
        />
      </I18nextProvider>
    )

    expect(screen.getByText('Discard')).toBeInTheDocument()
    expect(screen.getByText('To Task')).toBeInTheDocument()
    expect(screen.getByText('To Note')).toBeInTheDocument()
    expect(screen.getByText('File')).toBeInTheDocument()
    expect(screen.getByText('Snooze')).toBeInTheDocument()
  })

  it('renders inbox zero copy through i18n', () => {
    render(
      <I18nextProvider i18n={i18nEn}>
        <InboxZeroState itemsProcessedToday={0} processedThisWeek={3} currentStreak={2} />
      </I18nextProvider>
    )

    expect(screen.getByText('Inbox Zero')).toBeInTheDocument()
    expect(screen.getByText('3 filed this week')).toBeInTheDocument()
    expect(screen.getByText('2 day streak')).toBeInTheDocument()
  })
})
```

If `InboxZeroState` is not exported from its file, export it by name without changing behavior.

- [ ] **Step 2: Run the new test**

```bash
pnpm --filter @memry/desktop test inbox-i18n
```

Expected: PASS.

- [ ] **Step 3: Run existing inbox tests**

```bash
pnpm --filter @memry/desktop test inbox-list
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/inbox/inbox-i18n.test.tsx apps/desktop/src/renderer/src/components/empty-state/inbox-zero-state.tsx apps/desktop/src/renderer/src/components/inbox/inbox-list.test.tsx
git commit -m "test(i18n): cover inbox namespace fallback"
```

## Task 11: Final Verification

**Files:**
- All files modified in Tasks 1-10

- [ ] **Step 1: Verify JSON and fallback stubs**

```bash
node -e "for (const f of ['en','tr','ar']) { const p = `packages/i18n/src/locales/${f}/inbox.json`; JSON.parse(require('fs').readFileSync(p,'utf8')); console.log(p, 'OK') }"
cat packages/i18n/src/locales/tr/inbox.json
cat packages/i18n/src/locales/ar/inbox.json
```

Expected:
- all three JSON files print `OK`
- TR and AR files remain exactly `{}`

- [ ] **Step 2: Run focused i18n and inbox tests**

```bash
pnpm --filter @memry/i18n test
pnpm --filter @memry/desktop test inbox-i18n
pnpm --filter @memry/desktop test inbox-list
pnpm --filter @memry/desktop test delete-confirmation-dialog
```

Expected: all PASS.

- [ ] **Step 3: Run renderer typecheck**

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS.

- [ ] **Step 4: Run full desktop validation before PR**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check
```

Expected:
- `pnpm lint` PASS
- `pnpm typecheck` PASS, ignoring only pre-existing known test-file type errors if they are still documented in `AGENTS.md`
- `pnpm test` PASS
- `pnpm ipc:check` PASS; no IPC artifacts should change in Phase C

- [ ] **Step 5: Manual smoke test**

```bash
pnpm dev
```

Expected in the running app:
- Inbox tab labels still read `Inbox`, `Archived`, `Insights`
- Inbox empty state still reads `Inbox Zero`
- Triage mode labels still read `Discard`, `To Task`, `To Note`, `File`, `Snooze`
- Archived actions still expose restore/delete labels and aria labels
- Settings -> General -> Language -> Türkçe keeps inbox strings in English because `tr/inbox.json` is `{}` fallback
- Settings -> General -> Language -> العربية keeps inbox strings in English and `<html dir="rtl">` still flips from Phase A

- [ ] **Step 6: Final commit**

If the last verification caused small test-only or key additions:

```bash
git add packages/i18n/src/locales/en/inbox.json packages/i18n/src/locales/tr/inbox.json packages/i18n/src/locales/ar/inbox.json apps/desktop/src/renderer/src
git commit -m "chore(i18n): verify inbox namespace migration"
```

Otherwise no extra commit; keep the task commits atomic.

## Implementation Notes

- Use `useT('inbox')` for inbox feature nouns, labels, aria labels, empty states, toasts, and action labels that are specific to inbox workflows.
- Use `useT('common')` only for Phase B keys that already exist and are truly universal, such as Cancel, Delete, Retry, Search, Loading. Do not add new common keys from this phase.
- Do not put empty strings in `tr/inbox.json` or `ar/inbox.json`; empty strings render blank UI and bypass fallback.
- Prefer complete ICU messages over string concatenation for counts and word order.
- Preserve user-content strings and dynamic titles. Do not translate note titles, folder names, tags, domains, URLs, file names, transcript text, tweet content, or captured content.
- Keep keyboard shortcut glyphs literal (`Esc`, `⌘`, `Ctrl+`, `D`, `F`, `S`) unless a future accessibility pass changes shortcut display globally.
- Do not touch physical Tailwind classes as part of this phase. Logical-property cleanup is Phase E/deferred.
