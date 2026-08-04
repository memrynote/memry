# Template Editor as Note Page — Design

**Date:** 2026-08-04
**Status:** Approved, ready for implementation plan

## Problem

Templates are created and edited in a bespoke screen (`apps/desktop/src/renderer/src/pages/template-editor.tsx`) that looks nothing like the rest of the app: its own header bar, a `description` textarea, and the note editor stuffed into a bordered box. The result reads as a form, not as Memry.

Templates _are_ notes with a name, tags, properties, and a body. The editing surface should be the note surface.

## Goal

Opening a template — new or existing — gives you the note page. Title is the template name. Tags, properties, and content behave exactly as they do on a note. The top-right action area (where a note shows reminder / bookmark / ⋯) carries a **Create Template** or **Update** button. Work is not lost: a new template is a draft that prompts on tab close; a saved template auto-saves silently.

## Non-goals

- Changing `pages/note.tsx`. It is 54K and bound to `noteId`, CRDT Y.Docs, version history, review comments, and the local graph. A template has none of those. We reuse the _components_ and the _layout_, not the page.
- Journal/note template consumption. Already works: `hooks/use-journal-entry.ts:209` applies the journal default template, `components/note/template-selector.tsx` covers the note side. No change needed.
- Schema, IPC contract, or sync protocol changes. None are required.
- Guarding window close / app quit. Out of scope (see Accepted Losses).

## Current state (verified)

| Thing                 | Where                                                                                                          | Note                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Template editor page  | `pages/template-editor.tsx`                                                                                    | Rewritten wholesale                                                                    |
| Template list page    | `pages/templates.tsx` (19K)                                                                                    | **Unreachable** — no code opens a `templates` tab. Dead.                               |
| Settings list         | `pages/settings/templates-section.tsx`                                                                         | The only real entry point                                                              |
| Settings preview      | `pages/settings/template-preview.tsx`                                                                          | Shown on row click                                                                     |
| Unsaved-changes guard | `components/tabs/unsaved-changes-dialog.tsx`                                                                   | Written but **wired to nothing**; only referenced from a test                          |
| Tab close             | `contexts/tabs/context.tsx:355-386`                                                                            | `closeTab` / `closeOtherTabs` / `closeTabsToRight` / `closeAllTabs`, all dispatch-only |
| Tab close call sites  | `regular-tab.tsx`, `pinned-tab.tsx`, `accessible-tab.tsx`, `tab-context-menu.tsx`, `use-menu-commands.ts` (⌘W) | 6+ places call `closeTab` directly                                                     |
| Layout                | `components/note/note-layout.tsx`                                                                              | Generic; takes `actions`, `breadcrumb`, `headings`, `children`                         |
| Icon editing          | `components/icon-picker-button.tsx`                                                                            | Reusable; already used by folders, projects, tags                                      |

## Design

### 1. The editing surface

`pages/template-editor.tsx` is rewritten to compose:

- `NoteLayout` — `actions` slot, no `breadcrumb`, no `sideRail`
- `IconPickerButton` + `NoteTitle` — title is the template name
- `TagsRow` (`hideWhenEmpty`, `hideAddButton`)
- `InfoSection` (`variant="embedded"`, `hideAddButton`)
- `GhostAffordanceRow` — the hover affordance for adding a tag / property
- `ContentArea` — markdown body, unboxed, same as a note

Note-only chrome is absent: no breadcrumb, reminder, bookmark, version history, local graph, review rail, project chips.

**Icon:** `NoteTitle` renders `emoji` read-only and only when non-null — it has no picker callback. Rather than modify `NoteTitle` (which would touch the note page), the template editor renders `IconPickerButton` beside it. This also fixes a live bug: `template-editor.tsx:182` binds `const icon = initialTemplate.icon` with no setter, so a template's icon is currently _not editable at all_.

**`{{title}}` hint:** folded into the `ContentArea` placeholder text. No separate hint block.

**Action area** (`NoteLayout actions`):

- Primary button: **Create Template** (draft) / **Update** (saved)
- ⋯ menu: Duplicate, Delete — custom templates only

### 2. Save state machine

```
draft ──(Create Template)──> saved ⇄ dirty ──(800ms debounce)──> saved
```

**draft** (new template, nothing written yet)

- No DB write. The template does not appear in any list.
- Tab title mirrors the name field live; empty name → `"New Template"`.
- `setTabModified(tabId, true)` → the tab shows its unsaved dot.
- **Create Template** is disabled while the name is blank (`TemplateCreateSchema` requires `name.min(1)`).
- On click: `createTemplate()` → write `entityId` and path `/templates/:id` onto the tab, `setTabModified(false)`, button becomes **Update**.

**saved / dirty** (template exists)

- Every edit marks dirty and schedules an 800ms debounced `updateTemplate()`. Success → `setTabModified(false)`.
- **Update** is enabled only while dirty; clicking flushes the pending save immediately.
- Save failure keeps the tab dirty and surfaces `extractErrorMessage(err, fallback)` via toast. The close guard therefore still fires — a failed auto-save cannot silently discard work.
- Opening an existing template starts in `saved`, so the close prompt never appears for it unless the user actually edits.

**built-in**

- All fields disabled. Primary button reads **Duplicate & Edit** → `duplicateTemplate()` (existing API), opens the copy in a new tab in `saved` state.

**Sync interaction:** template sync landed in #938 (`main/sync/template-sync.ts`). Every persisted update enqueues a sync push, so auto-save must not fire on no-op edits. Two guards: the 800ms debounce, and a value comparison against the last-persisted snapshot — identical payload, no write.

### 3. Property type round-trip (existing data-loss bug)

`template-editor.tsx:80-89` `mapFromTemplatePropertyType` maps only `text | number | checkbox | date | url` and falls back to `'text'` for everything else. `select`, `multiselect`, and `rating` therefore degrade to `text` on load; saving after any unrelated edit writes the degraded type back. Today, editing a template that has a select property permanently destroys it.

Fix in the rewrite: `TemplateProperty[]` is the source of truth, held with stable generated ids (not `prop-${index}`, which also breaks under reorder). The UI layer only ever mutates `value`, `name`, and order. `type` and `options` are set once at add-time and otherwise carried through untouched. No mapping table can lose a type because no round-trip mapping happens.

Property parity with the note page: `onPropertyNameChange` and `onPropertyOrderChange` are wired (`InfoSection` already supports both; stable ids make reorder correct).

### 4. Tab close guard — centralized

Rather than patch six call sites, the guard lives inside the tabs context.

`contexts/tabs/context.tsx` gains:

- `registerCloseGuard(tabId, { isDirty, save }): () => void` — returns an unregister function; the template editor registers on mount, unregisters on unmount.
- `closeTab` consults the registry. Clean or unguarded → close as today (byte-identical path). Dirty → stash a pending-close and open the dialog instead.
- `closeOtherTabs` / `closeTabsToRight` / `closeAllTabs` partition their target set: clean tabs close immediately, dirty guarded tabs enter a queue and are prompted one at a time. **Cancel** on any queued prompt aborts the remainder of the queue.

The dialog is the existing `UnsavedChangesDialog` (Save / Don't Save / Cancel), rendered by the tabs provider. **Save** invokes the guard's `save()`; it closes only on success, so a failed save leaves the tab open and dirty.

This covers every close path at once: X button, middle-click, tab context menu, close others / to-right / all, and ⌘W via `use-menu-commands.ts` `file.closeTab`.

`useUnsavedChangesGuard` — the current dead hook — is replaced by this registry and deleted.

### 5. Settings entry point

`pages/settings/templates-section.tsx`:

- Row click opens the editor tab directly (previously opened the in-settings preview).
- Row ⋯ menu keeps Edit / Duplicate / Delete; Edit opens the same tab.
- Built-in rows open the read-only tab.
- Settings modal closes on open, as it does today.

### 6. Deletions

- `pages/templates.tsx` + `pages/templates.test.tsx`
- `TabType 'templates'` (`contexts/tabs/types.ts:29`) and its `SINGLETON_TAB_TYPES` entry
- `templates` case in `components/split-view/tab-content.tsx:206`
- `templates` entries in `App.tsx`, `contexts/tabs/helpers.ts`, `components/tabs/tab-icon.tsx`
- `pages/settings/template-preview.tsx` + `template-preview.test.tsx`
- `components/tabs/unsaved-changes-dialog.tsx`'s `useUnsavedChangesGuard` hook (dialog component stays)
- Old `pages/template-editor.test.tsx`, replaced by the new suite

Removing the `templates` TabType is safe on restore, but not for the reason one might assume. `isRestorableTabType` (`persistence/serialization.ts:24`) returns `true` for any type it does not recognize as a feature flag, so a persisted `templates` tab **is** restored rather than dropped. It then falls to the `default` branch of `tab-content.tsx:252`, which renders a benign "Unknown tab type" panel — no crash. And in practice no such tab exists, since nothing in the app ever opened one. No migration needed; noted here so the assumption is on record rather than inferred.

## Testing

**`pages/template-editor.test.tsx`** (new)

- draft → Create: no write before click, `createTemplate` called with trimmed name, tab gains `entityId`, button flips to Update
- Create disabled while name blank
- auto-save: edit → advance 800ms → `updateTemplate` called once; identical payload → not called
- save failure keeps tab dirty and toasts
- built-in: fields disabled, Duplicate & Edit calls `duplicateTemplate`
- property round-trip: template with `select` + `rating` properties, edit the title only, save → types unchanged
- tab title tracks the name field live; blank → "New Template"

**`contexts/tabs/context.test.tsx`** (extended)

- unguarded tab closes with no dialog (regression guard for every existing close path)
- guarded + clean closes immediately
- guarded + dirty → dialog; Don't Save closes; Cancel keeps open; Save calls `save()` then closes; failed save keeps it open
- `closeAllTabs` with two dirty guarded tabs → clean tabs gone, prompts sequential, Cancel aborts the rest

**`pages/settings/templates-section.test.tsx`** (updated) — row click opens a `template-editor` tab and closes the settings modal

**i18n** — `packages/i18n/src/locales/*/notes.json` and `settings.json`; ~10 new keys across all 32 locales, plus removal of the keys orphaned by the deleted screens.

**Commands:** `pnpm test:desktop`, `pnpm typecheck`, `pnpm lint`, `pnpm --filter @memry/desktop i18n:check`, `pnpm check:architecture`.

## Risks

1. **Tabs context is load-bearing.** The guard sits in the path of every tab close in the app. Mitigation: unguarded tabs take the identical code path, and that is the first test written.
2. **Auto-save × sync churn.** Debounce plus no-op comparison; verified by the "identical payload → no write" test.
3. **Backward compatibility.** No schema, IPC, vault-format, or sync-protocol change. `description` values already stored stay in the data and are still shown in the settings list; they simply become uneditable. Templates written by older versions load unchanged — and load _better_, since the property-type degradation stops.

## Accepted losses

- Uncommitted drafts do not survive app quit or restart. Tabs are restored from `persistence/serialization.ts`, which has no draft payload; a restored new-template tab comes back empty. This follows from the in-memory draft model chosen over persisting drafts.
- `description` is no longer editable anywhere. Existing values persist and remain visible in the settings list.

## Decisions

| Question                | Decision                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| New-template save model | Draft until **Create Template**; auto-save after that                                                      |
| `description` / `icon`  | Icon becomes editable via `IconPickerButton`; description dropped from the editor, value preserved in data |
| Built-in templates      | Read-only tab with **Duplicate & Edit**                                                                    |
| Dead code               | Delete `templates.tsx`, the `templates` TabType, and `template-preview.tsx`                                |
| Close-prompt scope      | Renderer tab-close paths only; not window close / app quit                                                 |
| i18n                    | English plus all 32 locales                                                                                |
