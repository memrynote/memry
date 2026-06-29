# Settings → Templates: inline preview + close-on-open

**Date:** 2026-06-29
**Branch:** `settings-template-preview`
**Status:** approved design, ready for implementation plan

## Problem

In Settings → Templates today:

1. **No way to see inside a template.** Built-in rows show only icon + name + description and a 🔒; there is no click handler and no menu, so users cannot view the actual content/properties. Custom rows only expose Edit/Duplicate/Delete.
2. **"New" opens the editor tab *behind* the still-open settings modal.** `handleCreateTemplate` calls `openTab(...)` but never closes the settings `Dialog`, so the new `template-editor` tab is hidden behind the modal. `handleEditTemplate` has the same problem.

## Goal

- Let users preview any template's real content (built-in and custom) without leaving settings.
- When the user creates or edits a template (an action that opens a tab), close the settings modal so they land on the editor.

## Scope

All renderer-only. No main-process, IPC, contract, or DB changes.

- `apps/desktop/src/renderer/src/pages/settings/templates-section.tsx` — drill-in toggle + close-on-open.
- **New:** `apps/desktop/src/renderer/src/pages/settings/template-preview.tsx` — read-only preview view.
- 1–2 new i18n keys (back label, "Built-in" badge) in the templates i18n namespace.

## Current behavior (verified)

- **Settings is a modal.** `components/settings-modal.tsx` wraps `<SettingsPage />` in a shadcn `<Dialog>`. State via `contexts/settings-modal-context.tsx` → `useSettingsModal()` exposes `{ isOpen, open(section?), close(), ... }`. `close()` sets `isOpen=false`.
- **Templates list** rendered by `TemplatesSettings` in `templates-section.tsx`, fed by `useTemplates()` → `templatesService.list()`, which returns `TemplateListItem` = `{id, name, description, icon, isBuiltIn}` only. Content/properties are **not** in the list payload — they come from `getTemplate(id)`.
- **`handleCreateTemplate`** → `openTab({type:'template-editor', path:'/templates/new'})`, no `entityId`. Does **not** close settings.
- **`handleEditTemplate`** → `openTab({type:'template-editor', entityId:id})`. Does **not** close settings.
- **Read-only render already exists.** `pages/template-editor.tsx` loads a template via `getTemplate(id)` and renders `NoteTitle` + `TagsRow` + `InfoSection` + `ContentArea` (BlockNote). For built-ins it forces read-only (`editable={false}` on `ContentArea`). This proves `ContentArea` renders plain template content read-only **outside** any CRDT/note doc — so it is safe to reuse in the modal.

## Design

### 1. Close settings on create / edit

In `TemplatesSettings`, pull `close` from `useSettingsModal()`. In both `handleCreateTemplate` and `handleEditTemplate`, call `close()` alongside `openTab(...)`. Duplicate and Delete are unchanged (they open no tab).

### 2. Drill-in read-only preview

- Add local state `previewId: string | null` to `TemplatesSettings`.
- Clicking a row **body** (built-in or custom) sets `previewId`. The custom row's `⋯` menu still works for Edit/Duplicate/Delete and must **not** trigger the drill-in (stop propagation on the menu trigger).
- When `previewId` is set, render `<TemplatePreview templateId={previewId} onBack={() => setPreviewId(null)} />` **in place of** the list (drill-in, list hidden).

### `TemplatePreview` component

- Loads the full template via the existing `getTemplate(id)` path (react-query, mirroring `template-editor.tsx`). Render loading + error states.
- Header: `←` back button (calls `onBack`) + template name + a 🔒 "Built-in" badge when `isBuiltIn`.
- Description line when present.
- **Properties:** read-only list of `name · type · value`. Reuse `InfoSection` in a read-only mode if it supports one cleanly; otherwise a minimal local list. (Decide during implementation by reading `InfoSection`.)
- **Content:** reuse `ContentArea` with `editable={false}`, fed the template's `content` — identical to how `template-editor.tsx` renders built-ins read-only.
- Read-only for **all** templates (built-in and custom). The drill-in is a pure preview.

### Decisions

- **Custom preview = pure preview, no inline "Open in editor" button.** Editing a custom template stays on the existing row `⋯ → Edit` path (which now also closes settings). Rationale: lazier, avoids a second edit entry point; can add later if wanted.
- **Reuse over re-mount.** Do **not** embed the whole `TemplateEditorPage` in the modal — it is built for a tab (save bar, `onCloseActiveTab`, tab-title sync, editable-for-custom) and pulls tab context. A focused `TemplatePreview` reusing just `ContentArea` (+ property display) is leaner.

## Non-goals

- No changes to how templates are stored, listed, created, or applied.
- No new tab types, no IPC/contract changes.
- No edit-from-preview affordance (deferred).

## Verification

- `pnpm --filter @memry/desktop typecheck:web`
- `pnpm --filter @memry/desktop test:renderer`
- Manual GUI:
  1. Settings → Templates → click **Meeting Notes** → read-only BlockNote with content + properties → `←` returns to list.
  2. Click a custom template → read-only preview → `←` back.
  3. **+ New** → settings modal closes → new `template-editor` tab is focused and editable.
  4. Custom `⋯ → Edit` → settings modal closes → that template's editor tab is focused.
  5. `⋯` menu on a custom row does not trigger the drill-in.

## Risks / unknowns

- `InfoSection` may not have a clean read-only mode → fall back to a minimal local property list (low risk).
- `ContentArea` reuse is proven by `template-editor.tsx`, but confirm no props are required that only the editor page supplies (e.g. change handlers) — pass no-op/omit where `editable={false}`.
