# Note-view menu actions — design

**Date:** 2026-07-17
**Status:** Approved (design), implementing.

## Problem

To delete a note you're viewing, you must close its tab first, then delete it
from the note list. The note-view "more" menu (`Picker` in
`apps/desktop/src/renderer/src/pages/note.tsx`) exposes view/tools actions
(Local Graph, Version History, Export, Apply Template, Full Width, Local Only)
but no file actions. Bring the file actions the sidebar/list context menu already
offers into the note-view menu.

## Scope

Add **8 items** to the note-view `Picker`. All wire to existing IPC/hooks — no
backend, no contract change, no migration. **Replace is deferred** (Find is a
read-only CSS-highlight engine; Replace needs a BlockNote/ProseMirror mutation
engine — separate spec).

| Item                 | Icon (hugeicon)        | Mechanism                                                   |
| -------------------- | ---------------------- | ----------------------------------------------------------- |
| Find…                | `Search`               | `findInPage.open()` (hook already in note.tsx)              |
| Rename…              | `PenLine`              | focus + select inline title textarea via ref                |
| Move to folder…      | `FolderInput`          | `MoveToFolderDialog` + `moveNote.mutateAsync`               |
| Copy path            | `Copy`                 | `navigator.clipboard.writeText(note.path)` (vault-relative) |
| Reveal in Finder     | `FolderOpen`           | `notesService.revealInFinder(id)`                           |
| Reveal in navigation | `PanelLeft`            | `reveal-in-sidebar` CustomEvent                             |
| Open in default app  | `ExternalLink`         | `notesService.openExternal(id)`                             |
| Delete note          | `Trash2` (destructive) | confirm → `deleteNote.mutateAsync` → `closeTab`             |

## Menu layout

```
Local Graph                 (existing)
Find…                    ◆
Version History             (existing)
Export                      (existing)
Apply Template              (existing)
Full Width         [toggle] (existing)
──────────
Rename…                  ◆
Move to folder…          ◆
Copy path                ◆
──────────
Reveal in Finder         ◆
Reveal in navigation     ◆
Open in default app      ◆
──────────
Local Only         [toggle] (existing)
──────────
Delete note              ◆   (destructive, bottom)
```

## Key mechanics

- **`Picker.Item`** already supports `icon`, `destructive`, `shortcut`,
  `Picker.Separator`. New items are added to `Picker.List` and dispatched via the
  existing `onValueChange` switch. `closeOnSelect={false}` stays; each action
  calls `setMoreMenuOpen(false)` (dialogs/toggles already do).
- **Delete**: `Picker.Item destructive` → opens an `AlertDialog` confirm (mirrors
  `unsaved-changes-dialog.tsx`) → on confirm `deleteNote.mutateAsync(noteId)` →
  `closeTab(activeTab.id)` (groupId defaults to active group). Matches
  `use-tree-delete.ts` (delete → closeTab) and Obsidian's close-on-delete.
- **Rename**: note title is an always-mounted inline `<textarea>`
  (`TitleInput.tsx`). Thread an optional `inputRef` prop note.tsx → `NoteTitle` →
  `TitleInput` (callback ref merges with the internal auto-resize ref). Rename
  action = `ref.focus()` + `ref.select()`. No new dialog.
- **Move**: mount the existing `MoveToFolderDialog`; `onMove(folder)` →
  `moveNote.mutateAsync({ id, newFolder: folder })`. `currentFolder` derived from
  `note.path` (dirname).
- **Copy path**: copies vault-relative `note.path` (Obsidian parity, no IPC).
- **Reveal in navigation**: dispatch `reveal-in-sidebar` CustomEvent
  (`{ detail: { path: '/notes/'+id, entityId: id } }`), same as row-context-menu.

## Cross-platform (macOS / Linux / Windows)

- `revealInFinder` → `shell.showItemInFolder`; `openExternal` → `shell.openPath`.
  Both are cross-platform Electron APIs (already used by the list context menu).
- Copy path uses `note.path` (vault-relative, stored with `/`); no OS path
  concat, no drive-letter pitfalls.
- Find, Rename, Move, Reveal-in-nav, Delete are pure renderer/IPC — OS-agnostic.
- Label "Reveal in Finder" reuses the app's existing string on all platforms
  (matches current sidebar menu convention).

## Guardrails

- All items respect the existing `disabled={isDeleted}` gate on the menu trigger.
- i18n: new `editor.toolbar.*` + `page.deleteConfirm.*` + `page.toast.*` keys under
  the `notes` namespace (English gate; other locales warn-only per repo policy).
- RTL: logical Tailwind (Picker.Item handles); no physical `ml/mr/left/right`.
- Reduced-motion: no new animation introduced.

## Testing

- **Unit (renderer, vitest + jsdom)** — extend `note.test.tsx` / new
  `note-menu-actions.test.tsx`:
  - each item renders with its hugeicon and label
  - Find → `findInPage.open` invoked
  - Copy path → `clipboard.writeText(note.path)`
  - Reveal in Finder / Open in default app → `notesService.revealInFinder` /
    `openExternal` called with note id (mocked — no real OS launch)
  - Reveal in navigation → `reveal-in-sidebar` event dispatched
  - Rename → title textarea focused
  - Move → dialog opens; `onMove` → `moveNote` called
  - Delete → confirm opens; confirm → `deleteNote` called + `closeTab` invoked;
    cancel → nothing deleted
- **E2E (Playwright/Electron)** — new `note-menu-actions.e2e.ts`, side-effect-free
  items only (never actually spawn Finder/Explorer on CI):
  - open menu → all 8 items visible
  - Find → find bar opens
  - Copy path → clipboard holds vault-relative path
  - Rename → title focused, editable
  - Delete → confirm dialog → confirm → tab closes, note gone from list
  - Reveal-in-Finder / Open-in-default-app: assert present + enabled only (IPC
    stub / no click that launches the OS shell)

## Out of scope

Replace, Split view, Merge, Open-in-new-window, Bookmark (already present),
Version History / Export / PDF (already present).
