# i18n Phase C Notes Namespace Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate user-facing notes UI copy into the `notes` i18n namespace while preserving Phase A/B infrastructure and Phase B `common` reuse.

**Architecture:** Add English notes copy in `packages/i18n/src/locales/en/notes.json`, keep Turkish and Arabic notes feature files as `{}` for fallback, and replace hardcoded app-owned notes UI strings with `useT('notes')`. Reuse `useT('common')` only for verbs/states already supplied by Phase B.

**Tech Stack:** React 19 renderer, Electron desktop app, `react-i18next`, `@memry/i18n`, JSON locale resources, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`.

**Depends on:** Phase A i18n infrastructure and Phase B `common` namespace. Do not start this plan before those are merged in the target worktree.

**Out of scope:** Phase D error/menu extraction, Phase E lint/codemod gates, full third-party BlockNote dictionary localization, bidi-perfect BlockNote document content handling, user-created note/folder/task/template content, and persisted default names used for new note/folder paths.

---

## Scope Rules

- Notes namespace file: `packages/i18n/src/locales/en/notes.json`.
- Turkish and Arabic notes namespace files remain literal `{}`:
  - `packages/i18n/src/locales/tr/notes.json`
  - `packages/i18n/src/locales/ar/notes.json`
- Use `const { t } = useT('notes')` for notes feature copy.
- Use `const { t: tCommon } = useT('common')` only for keys already present in Phase B, such as `common.button.cancel`, `common.button.delete`, `common.button.retry`, `common.button.remove`, `common.state.loading`, and `common.action.search`.
- Do not translate saved note titles, folder names, note bodies, tag values, property values, template names, task titles, file paths, or URLs.
- Do not localize error extraction fallbacks or toast error copy in this phase. Those belong to Phase D unless this plan explicitly calls out a non-error notes UI label.
- Do not change BlockNote CRDT/content behavior. App-owned editor chrome can be localized; bidi-perfect BlockNote content rendering/editing is a known non-v1 issue.

## Files to Inspect

- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/renderer/use-t.ts`
- `packages/i18n/src/locales/en/common.json`
- `packages/i18n/src/locales/en/notes.json`
- `packages/i18n/src/locales/tr/notes.json`
- `packages/i18n/src/locales/ar/notes.json`
- `apps/desktop/src/renderer/src/pages/note.tsx`
- `apps/desktop/src/renderer/src/components/notes-tree.tsx`
- `apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx`
- `apps/desktop/src/renderer/src/components/note-tree-states.tsx`
- `apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx`
- `apps/desktop/src/renderer/src/hooks/use-note-tree-actions.ts`
- `apps/desktop/src/renderer/src/components/note/note-title/NoteTitle.tsx`
- `apps/desktop/src/renderer/src/components/note/note-title/TitleInput.tsx`
- `apps/desktop/src/renderer/src/components/note/note-title/EmojiPicker.tsx`
- `apps/desktop/src/renderer/src/components/note/note-title/HugeIconGrid.tsx`
- `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`
- `apps/desktop/src/renderer/src/components/note/content-area/wiki-link-menu.tsx`
- `apps/desktop/src/renderer/src/components/note/content-area/hash-tag-menu.tsx`
- `apps/desktop/src/renderer/src/components/note/content-area/paste-link-menu.tsx`
- `apps/desktop/src/renderer/src/components/note/content-area/task-block/task-block-renderer.tsx`
- `apps/desktop/src/renderer/src/components/note/template-selector.tsx`
- `apps/desktop/src/renderer/src/components/note/export-dialog.tsx`
- `apps/desktop/src/renderer/src/components/note/version-history.tsx`
- `apps/desktop/src/renderer/src/components/note/editor-error-boundary.tsx`
- `apps/desktop/src/renderer/src/components/note/note-reminder-button.tsx`
- `apps/desktop/src/renderer/src/components/note/ghost-affordance-row.tsx`
- `apps/desktop/src/renderer/src/components/note/note-breadcrumb.tsx`
- `apps/desktop/src/renderer/src/components/shared/outline-info-panel.tsx`
- `apps/desktop/src/renderer/src/components/note/backlinks/BacklinksSection.tsx`
- `apps/desktop/src/renderer/src/components/note/backlinks/BacklinksLoadingState.tsx`
- `apps/desktop/src/renderer/src/components/note/backlinks/BacklinkCard.tsx`
- `apps/desktop/src/renderer/src/components/note/tags-row/TagsRow.tsx`
- `apps/desktop/src/renderer/src/components/note/tags-row/AddTagButton.tsx`
- `apps/desktop/src/renderer/src/components/note/tags-row/TagInputPopup.tsx`
- `apps/desktop/src/renderer/src/components/note/tags-row/TagChip.tsx`
- `apps/desktop/src/renderer/src/components/note/tags-row/ColorPicker.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/InfoSection.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/AddPropertyPopup.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/TextEditor.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/LongTextEditor.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/NumberEditor.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/SelectEditor.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/MultiSelectEditor.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/StatusEditor.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/RatingEditor.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/UrlEditor.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/DateEditor.tsx`
- `apps/desktop/src/renderer/src/components/note/linked-tasks/index.tsx`
- `apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx`
- `apps/desktop/src/renderer/src/components/notes-tree.test.tsx`
- `apps/desktop/src/renderer/src/components/note/note-title/note-title.test.tsx`
- `apps/desktop/src/renderer/src/components/note/tags-row/tags-row.test.tsx`
- `apps/desktop/src/renderer/src/components/note/info-section/info-section.test.tsx`

## Files to Modify or Create

- Modify `packages/i18n/src/locales/en/notes.json`
- Modify `packages/i18n/src/locales/tr/notes.json`
- Modify `packages/i18n/src/locales/ar/notes.json`
- Modify `apps/desktop/src/renderer/src/pages/note.tsx`
- Modify `apps/desktop/src/renderer/src/components/notes-tree.tsx`
- Modify `apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx`
- Modify `apps/desktop/src/renderer/src/components/note-tree-states.tsx`
- Modify `apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx`
- Modify relevant note editor chrome files under `apps/desktop/src/renderer/src/components/note/**`
- Modify `apps/desktop/src/renderer/src/components/shared/outline-info-panel.tsx` if it is rendered inside notes detail chrome
- Modify `apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx` for the note body placeholder/loading/empty copy used by note detail
- Modify existing tests that render migrated components without an i18n provider
- Create `packages/i18n/src/shared/notes-namespace.test.ts`
- Create focused renderer i18n smoke tests only where existing component tests do not cover the migrated copy

## Translation Key Plan

Use nested camel-case keys. This is the intended shape; adjust names only to reduce duplication during implementation.

```json
{
  "page": {
    "empty": {
      "title": "No note selected",
      "body": "Select a note from the sidebar to view it"
    },
    "error": {
      "title": "Failed to load note"
    }
  },
  "tree": {
    "aria": {
      "tree": "Notes tree",
      "openFolderView": "Open folder view"
    },
    "empty": {
      "title": "No notes yet",
      "body": "Create a note to get started",
      "newNote": "New Note"
    },
    "loadingError": "Failed to load notes",
    "actions": {
      "newNote": "New Note",
      "newFolder": "New Folder",
      "rename": "Rename",
      "openExternal": "Open in External Editor",
      "revealInFinder": "Reveal in Finder",
      "setDefaultTemplate": "Set Default Template",
      "clearDefaultTemplate": "Clear Default Template",
      "setIcon": "Set Icon",
      "removeIcon": "Remove Icon",
      "deleteSelectedNotes": "Delete {{count}} Notes",
      "deleteSelectedItems": "Delete {{count}} items"
    },
    "deleteDialog": {
      "noteTitle": "Delete Note",
      "folderTitle": "Delete Folder",
      "itemsTitle": "Delete {{count}} Items",
      "noteBody": "Are you sure you want to delete \"{{name}}\"? This action cannot be undone.",
      "folderBody": "Are you sure you want to delete \"{{name}}\" and all notes inside it? This action cannot be undone.",
      "itemsBody": "Are you sure you want to delete {{count}} items? This action cannot be undone.",
      "folderSuffix": "folder",
      "moreItems": "...and {{count}} more",
      "deleting": "Deleting...",
      "deleteCount": "Delete {{count}}"
    }
  },
  "editor": {
    "title": {
      "untitled": "Untitled",
      "aria": "Note title"
    },
    "content": {
      "placeholder": "Start writing, or press '/' for commands...",
      "regionAria": "Note editor",
      "richTextAria": "Rich text editor",
      "headingPlaceholder": "Heading",
      "listPlaceholder": "List item",
      "todoPlaceholder": "To-do item"
    },
    "toolbar": {
      "reminderSet": "Reminder set",
      "setReminder": "Set reminder",
      "removeBookmark": "Remove bookmark",
      "addBookmark": "Add bookmark",
      "hideLocalGraph": "Hide local graph",
      "showLocalGraph": "Show local graph",
      "versionHistory": "Version history",
      "export": "Export",
      "fullWidth": "Full width",
      "disableLocalOnly": "Disable local only",
      "setLocalOnly": "Set local only"
    },
    "breadcrumb": {
      "locationAria": "Note location",
      "parentFolderAria": "Go to parent folder"
    },
    "errorBoundary": {
      "title": "Editor Error",
      "body": "The editor encountered an error. Your note content is safe.",
      "technicalDetails": "Technical details",
      "reloadAria": "Reload editor",
      "reload": "Reload Editor"
    }
  },
  "menus": {
    "wiki": {
      "aria": "Note suggestions",
      "loading": "Loading notes...",
      "empty": "No notes found",
      "create": "Create new note"
    },
    "tags": {
      "aria": "Tag suggestions",
      "loading": "Loading tags...",
      "empty": "Type to create a new tag",
      "create": "Create #{{tag}}"
    },
    "pasteLink": {
      "title": "Paste as",
      "url": "URL",
      "mention": "Mention",
      "embedVideo": "Embed video"
    },
    "emoji": {
      "aria": "Emoji and icon picker",
      "emojiTab": "Emoji",
      "iconsTab": "Icons",
      "searchPlaceholder": "Search",
      "noIcons": "No icons found"
    }
  },
  "detail": {
    "bodyPlaceholder": "Write your note..."
  },
  "outline": {
    "title": "Outline",
    "aria": "Document outline",
    "empty": "No headings",
    "readTime": "{{count}} min read",
    "words": "{{count}} words",
    "created": "Created",
    "modified": "Modified"
  },
  "backlinks": {
    "title": "Backlinks",
    "sortRecent": "Recent",
    "sortAlpha": "A-Z",
    "sortMentions": "Most mentions",
    "summary": "{{notes}} notes · {{references}} references",
    "listAria": "Backlinks list",
    "fromAria": "Backlinks from {{title}}",
    "collapse": "Collapse",
    "expand": "Expand",
    "showMore": "Show more"
  },
  "tagsRow": {
    "aria": "Tags",
    "empty": "Add tags",
    "add": "Add tag",
    "removeAria": "Remove tag: {{tag}}",
    "inputPlaceholder": "Type tag name...",
    "recent": "Recent",
    "matching": "Matching Tags",
    "all": "All Tags",
    "none": "No tags found",
    "colorAria": "Select {{color}} color"
  },
  "properties": {
    "noteAria": "Note properties",
    "workspaceAria": "Workspace properties",
    "listAria": "Properties list",
    "add": "Add property",
    "addDescription": "Add a new property to this note",
    "namePlaceholder": "Property name",
    "nameAria": "Property name",
    "typeSection": "Type",
    "empty": "Empty",
    "dragAria": "Drag to reorder property",
    "editName": "Edit property name",
    "delete": "Delete property",
    "searchOptions": "Search options...",
    "noOptions": "No options yet",
    "optionName": "Option name",
    "newOption": "New option",
    "ratingAria": "Rating",
    "openUrlAria": "Open URL"
  },
  "templateSelector": {
    "title": "Choose Your Canvas",
    "description": "Select a template to begin your note",
    "searchPlaceholder": "Search templates...",
    "loading": "Loading templates...",
    "empty": "No templates found",
    "myTemplates": "My Templates",
    "essentials": "Essentials",
    "setFolderDefault": "Set as folder default",
    "useTemplate": "Use Template",
    "createNote": "Create Note"
  },
  "exportDialog": {
    "title": "Export Note",
    "description": "Export \"{{title}}\" to a file",
    "format": "Format",
    "pdfDescription": "Best for printing and sharing",
    "htmlDescription": "Best for web publishing",
    "pageSize": "Page Size",
    "selectPageSize": "Select page size",
    "options": "Options",
    "includeMetadata": "Include metadata",
    "exporting": "Exporting...",
    "exported": "Exported!",
    "export": "Export"
  },
  "versionHistory": {
    "title": "Version History",
    "description": "View and restore previous versions of this note",
    "hidePreview": "Hide Preview",
    "showPreview": "Show Preview",
    "empty": "No versions saved yet",
    "latest": "Latest",
    "autoSaved": "Auto-saved",
    "words": "{{count}} words",
    "selectPrompt": "Select a version to preview",
    "restore": "Restore",
    "deleteTitle": "Delete this version?",
    "restoreTitle": "Restore this version?",
    "restoring": "Restoring..."
  },
  "reminders": {
    "summary": "Reminder: {{date}}",
    "summaryWithMore": "Reminder: {{date}} (+{{count}} more)",
    "hasReminders": "Has reminders",
    "setReminder": "Set reminder"
  },
  "linkedTasks": {
    "title": "Linked Tasks",
    "loading": "Loading linked tasks..."
  }
}
```

Do not copy task-block renderer labels such as task names, task panel actions, or task deleted/loading states into `notes.json` unless the notes spec is explicitly widened. Those belong to task/editor follow-up work, not this notes namespace migration.

## Implementation Steps

- [ ] Preflight the branch and Phase A/B prerequisites.
  - Commands:
    ```bash
    git status --short
    test -f packages/i18n/src/renderer/use-t.ts
    test -f packages/i18n/src/locales/en/common.json
    test -f packages/i18n/src/locales/en/notes.json
    test -f packages/i18n/src/locales/tr/notes.json
    test -f packages/i18n/src/locales/ar/notes.json
    ```
  - Expected output:
    - `git status --short` may show other agents' unrelated files. Do not edit or revert them.
    - All `test -f` commands exit `0`.
  - Commit: none.

- [ ] Inventory hardcoded notes strings before editing.
  - Commands:
    ```bash
    rg -n "\"(No note selected|Select a note|Failed to load note|No notes yet|New Note|Rename|Delete|Untitled|Start writing|Note editor|Rich text editor|Loading notes|No notes found|Paste as|Export Note|Version History|Backlinks|Add tags|Add property|Choose Your Canvas|Write your note)\"" apps/desktop/src/renderer/src/pages/note.tsx apps/desktop/src/renderer/src/components/notes-tree.tsx apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx apps/desktop/src/renderer/src/components/note-tree-states.tsx apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx apps/desktop/src/renderer/src/components/note apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx
    ```
  - Expected output:
    - Matches only in notes UI files listed in this plan, plus any already-known note subcomponents.
    - Treat `use-note-tree-actions.ts` names like `Untitled`, `Untitled Folder`, and `Folder` as persisted defaults, not UI chrome.
  - Commit: none.

- [ ] Populate `en/notes.json` and preserve TR/AR fallback files.
  - Edits:
    - Fill `packages/i18n/src/locales/en/notes.json` with the notes keys needed by the migrated UI.
    - Keep `packages/i18n/src/locales/tr/notes.json` exactly `{}`.
    - Keep `packages/i18n/src/locales/ar/notes.json` exactly `{}`.
  - Commands:
    ```bash
    node -e "for (const f of ['packages/i18n/src/locales/en/notes.json','packages/i18n/src/locales/tr/notes.json','packages/i18n/src/locales/ar/notes.json']) JSON.parse(require('fs').readFileSync(f, 'utf8')); console.log('notes locale json ok')"
    pnpm --filter @memry/i18n typecheck
    ```
  - Expected output:
    - `notes locale json ok`
    - Typecheck exits `0`.
  - Atomic commit suggestion:
    ```bash
    git add packages/i18n/src/locales/en/notes.json packages/i18n/src/locales/tr/notes.json packages/i18n/src/locales/ar/notes.json
    git commit -m "feat(i18n): add notes namespace copy"
    ```

- [ ] Add namespace fallback tests.
  - Create:
    - `packages/i18n/src/shared/notes-namespace.test.ts`
  - Test coverage:
    - English returns populated notes copy, for example `notes:page.empty.title`.
    - Turkish falls back to English for notes keys because `tr/notes.json` is `{}`.
    - Arabic falls back to English for notes keys because `ar/notes.json` is `{}`.
    - Missing keys still behave consistently with the i18n test conventions already in the package.
  - Commands:
    ```bash
    pnpm --filter @memry/i18n test -- notes-namespace
    pnpm --filter @memry/i18n typecheck
    ```
  - Expected output:
    - The new notes namespace test passes.
    - Typecheck exits `0`.
  - Atomic commit suggestion:
    ```bash
    git add packages/i18n/src/shared/notes-namespace.test.ts
    git commit -m "test(i18n): cover notes namespace fallback"
    ```

- [ ] Migrate note tree chrome.
  - Files:
    - `apps/desktop/src/renderer/src/components/notes-tree.tsx`
    - `apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx`
    - `apps/desktop/src/renderer/src/components/note-tree-states.tsx`
    - `apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx`
  - Replace:
    - Empty state title/body/new-note button.
    - Tree aria labels.
    - Context menu labels for notes and folders.
    - Delete dialog titles, body copy, counts, and progress button label.
  - Reuse:
    - `common.button.cancel`
    - `common.button.delete`
  - Do not replace:
    - Real note titles, folder names, file names, or path-derived names.
    - `extractErrorMessage(..., 'Failed to load notes')` fallback if it is only an error fallback. Phase D owns error fallback extraction.
  - Test updates:
    - Wrap note tree tests with `I18nextProvider` and `createRendererI18n` if the migrated components now call `useT`.
    - Add one TR or AR fallback assertion that a notes-tree label still renders in English.
  - Commands:
    ```bash
    pnpm --filter @memry/desktop test --run src/renderer/src/components/notes-tree.test.tsx
    pnpm --filter @memry/desktop typecheck:web
    ```
  - Expected output:
    - Notes tree tests pass.
    - Renderer web typecheck exits `0`, except for any documented pre-existing unrelated failures from the target branch.
  - Atomic commit suggestion:
    ```bash
    git add apps/desktop/src/renderer/src/components/notes-tree.tsx apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx apps/desktop/src/renderer/src/components/note-tree-states.tsx apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx apps/desktop/src/renderer/src/components/notes-tree.test.tsx
    git commit -m "feat(i18n): migrate notes tree copy"
    ```

- [ ] Migrate note page and editor shell chrome.
  - Files:
    - `apps/desktop/src/renderer/src/pages/note.tsx`
    - `apps/desktop/src/renderer/src/components/note/note-title/NoteTitle.tsx`
    - `apps/desktop/src/renderer/src/components/note/note-title/TitleInput.tsx`
    - `apps/desktop/src/renderer/src/components/note/note-title/EmojiPicker.tsx`
    - `apps/desktop/src/renderer/src/components/note/note-title/HugeIconGrid.tsx`
    - `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`
    - `apps/desktop/src/renderer/src/components/note/content-area/wiki-link-menu.tsx`
    - `apps/desktop/src/renderer/src/components/note/content-area/hash-tag-menu.tsx`
    - `apps/desktop/src/renderer/src/components/note/content-area/paste-link-menu.tsx`
    - `apps/desktop/src/renderer/src/components/note/editor-error-boundary.tsx`
    - `apps/desktop/src/renderer/src/components/note/note-reminder-button.tsx`
    - `apps/desktop/src/renderer/src/components/note/ghost-affordance-row.tsx`
    - `apps/desktop/src/renderer/src/components/note/note-breadcrumb.tsx`
    - `apps/desktop/src/renderer/src/components/shared/outline-info-panel.tsx`
  - Replace:
    - `No note selected`, `Select a note...`, note loading/empty UI copy.
    - Note title placeholder and title aria label.
    - App-owned content placeholder and editor aria labels.
    - App-owned slash/wiki/tag/paste menu labels.
    - Toolbar/action labels visible from notes page: reminder, bookmark, local graph, version history, export, full width, local only.
    - Breadcrumb, outline, reminder, ghost affordance, and editor error boundary labels.
  - Reuse:
    - `common.button.retry` for retry buttons when already in Phase B.
    - `common.button.remove` for remove controls when already in Phase B.
    - `common.action.search` only where the visible label is exactly the common search action.
  - Special handling:
    - Keep BlockNote dictionaries as-is unless Phase A already provides a supported localized BlockNote dictionary path. Do not claim full BlockNote localization.
    - For `editor-error-boundary.tsx`, avoid hooks inside the class component. Add a thin functional wrapper that calls `useT('notes')` and passes a `labels` prop into the class, or convert only as much as needed while preserving boundary behavior.
    - Keep persisted new note defaults from hooks unchanged.
  - Test updates:
    - Wrap `note-title.test.tsx` with an i18n provider.
    - Add or update assertions for placeholder fallback under `tr` or `ar`.
  - Commands:
    ```bash
    pnpm --filter @memry/desktop test --run src/renderer/src/components/note/note-title/note-title.test.tsx
    pnpm --filter @memry/desktop typecheck:web
    ```
  - Expected output:
    - Note title tests pass.
    - Renderer web typecheck exits `0`, except for any documented pre-existing unrelated failures from the target branch.
  - Atomic commit suggestion:
    ```bash
    git add apps/desktop/src/renderer/src/pages/note.tsx apps/desktop/src/renderer/src/components/note/note-title apps/desktop/src/renderer/src/components/note/content-area apps/desktop/src/renderer/src/components/note/editor-error-boundary.tsx apps/desktop/src/renderer/src/components/note/note-reminder-button.tsx apps/desktop/src/renderer/src/components/note/ghost-affordance-row.tsx apps/desktop/src/renderer/src/components/note/note-breadcrumb.tsx apps/desktop/src/renderer/src/components/shared/outline-info-panel.tsx
    git commit -m "feat(i18n): migrate note editor chrome"
    ```

- [ ] Migrate note detail supporting chrome.
  - Files:
    - `apps/desktop/src/renderer/src/components/note/template-selector.tsx`
    - `apps/desktop/src/renderer/src/components/note/export-dialog.tsx`
    - `apps/desktop/src/renderer/src/components/note/version-history.tsx`
    - `apps/desktop/src/renderer/src/components/note/backlinks/BacklinksSection.tsx`
    - `apps/desktop/src/renderer/src/components/note/backlinks/BacklinksLoadingState.tsx`
    - `apps/desktop/src/renderer/src/components/note/backlinks/BacklinkCard.tsx`
    - `apps/desktop/src/renderer/src/components/note/tags-row/TagsRow.tsx`
    - `apps/desktop/src/renderer/src/components/note/tags-row/AddTagButton.tsx`
    - `apps/desktop/src/renderer/src/components/note/tags-row/TagInputPopup.tsx`
    - `apps/desktop/src/renderer/src/components/note/tags-row/TagChip.tsx`
    - `apps/desktop/src/renderer/src/components/note/tags-row/ColorPicker.tsx`
    - `apps/desktop/src/renderer/src/components/note/info-section/InfoSection.tsx`
    - `apps/desktop/src/renderer/src/components/note/info-section/AddPropertyPopup.tsx`
    - `apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.tsx`
    - `apps/desktop/src/renderer/src/components/note/info-section/editors/*.tsx`
    - `apps/desktop/src/renderer/src/components/note/linked-tasks/index.tsx`
    - `apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx`
  - Replace:
    - Template selector chrome, search/loading/empty labels, and action labels.
    - Export dialog chrome, format/page/options labels, and progress/success labels.
    - Version history panel and confirmation dialog labels.
    - Backlinks labels, aria labels, sort labels, summary text, loading copy.
    - Tags row labels, tag popup labels, color picker aria labels.
    - Info/properties labels, placeholders, aria labels, select/status option labels.
    - Linked tasks section title/loading copy if rendered as note detail chrome.
    - Inbox note detail body placeholder if it is a note body editor surface.
  - Reuse:
    - `common.button.cancel`
    - `common.button.retry`
    - `common.button.remove`
    - `common.state.loading` only when the exact generic loading label is appropriate.
  - Do not replace:
    - Journal-specific template content unless the note template selector owns the visible chrome.
    - Template names/descriptions loaded from data.
    - Task block renderer strings in `content-area/task-block/task-block-renderer.tsx`; defer task-specific copy to the task namespace work.
    - Error toast text such as export/version failures; Phase D owns error extraction and error copy.
  - Test updates:
    - Wrap `tags-row.test.tsx` and `info-section.test.tsx` with i18n providers.
    - Add one fallback-language smoke assertion for a migrated tag or property label.
  - Commands:
    ```bash
    pnpm --filter @memry/desktop test --run src/renderer/src/components/note/tags-row/tags-row.test.tsx src/renderer/src/components/note/info-section/info-section.test.tsx
    pnpm --filter @memry/desktop typecheck:web
    ```
  - Expected output:
    - Tags row and info section tests pass.
    - Renderer web typecheck exits `0`, except for any documented pre-existing unrelated failures from the target branch.
  - Atomic commit suggestion:
    ```bash
    git add apps/desktop/src/renderer/src/components/note/template-selector.tsx apps/desktop/src/renderer/src/components/note/export-dialog.tsx apps/desktop/src/renderer/src/components/note/version-history.tsx apps/desktop/src/renderer/src/components/note/backlinks apps/desktop/src/renderer/src/components/note/tags-row apps/desktop/src/renderer/src/components/note/info-section apps/desktop/src/renderer/src/components/note/linked-tasks/index.tsx apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx
    git commit -m "feat(i18n): migrate note detail chrome"
    ```

- [ ] Final string sweep.
  - Commands:
    ```bash
    rg -n "\"(No note selected|Select a note from the sidebar|Failed to load note|No notes yet|Create a note to get started|Start writing, or press|Note editor|Rich text editor|Loading notes|No notes found|Loading tags|Paste as|Emoji and icon picker|No icons found|Export Note|Version History|Backlinks|Add tags|Add property|Choose Your Canvas|Write your note|Linked Tasks|Loading linked tasks)\"" apps/desktop/src/renderer/src/pages/note.tsx apps/desktop/src/renderer/src/components/notes-tree.tsx apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx apps/desktop/src/renderer/src/components/note-tree-states.tsx apps/desktop/src/renderer/src/components/note-tree-dialogs.tsx apps/desktop/src/renderer/src/components/note apps/desktop/src/renderer/src/components/shared/outline-info-panel.tsx apps/desktop/src/renderer/src/components/inbox-detail/note-detail.tsx
    ```
  - Expected output:
    - No matches for migrated UI chrome.
    - Allowed matches only for out-of-scope content: user data defaults, task-block renderer strings, third-party BlockNote dictionary strings, or Phase D error fallback copy.
  - Commit:
    - Include only if the sweep finds and fixes missed Phase C notes UI labels.

- [ ] Final verification.
  - Commands:
    ```bash
    pnpm --filter @memry/i18n test
    pnpm --filter @memry/i18n typecheck
    pnpm --filter @memry/desktop test --run src/renderer/src/components/notes-tree.test.tsx src/renderer/src/components/note/note-title/note-title.test.tsx src/renderer/src/components/note/tags-row/tags-row.test.tsx src/renderer/src/components/note/info-section/info-section.test.tsx
    pnpm --filter @memry/desktop typecheck:web
    ```
  - Expected output:
    - i18n package tests pass.
    - i18n package typecheck exits `0`.
    - Focused desktop renderer tests pass.
    - Renderer web typecheck exits `0`, except for documented pre-existing unrelated failures.
  - Manual smoke:
    ```bash
    pnpm dev
    ```
    - Open notes.
    - Switch language to English, Turkish, and Arabic if the settings UI from earlier phases is available.
    - Verify notes UI labels render, TR/AR show English fallback for `notes` strings, no blank labels appear, and app-owned chrome direction follows existing Phase A direction handling.
    - Do not mark BlockNote content editing as bidi-perfect.
  - Atomic commit suggestion:
    ```bash
    git status --short
    git commit -m "test(i18n): verify notes namespace migration"
    ```
    - Use this commit only if verification-only test or plan cleanup files changed.

## Completion Criteria

- `packages/i18n/src/locales/en/notes.json` contains all migrated Phase C notes UI copy.
- `packages/i18n/src/locales/tr/notes.json` is `{}`.
- `packages/i18n/src/locales/ar/notes.json` is `{}`.
- Notes page empty/loading/error chrome, notes tree labels, note editor chrome, note title/body placeholders, note detail empty/loading states, toolbar/action labels, export/version/template/backlink/tag/property labels, and relevant aria labels use `useT('notes')`.
- Phase B common keys are reused only where already supplied.
- Phase D errors/menus and Phase E lint/codemod are not added to this phase.
- BlockNote content handling is not represented as bidi-perfect or complete.
- Focused i18n and renderer tests are updated and passing, or any pre-existing unrelated failures are documented with exact command output.
