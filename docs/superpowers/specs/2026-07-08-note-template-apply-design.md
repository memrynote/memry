# Apply Template to an Individual Note

**Date:** 2026-07-08
**Status:** Approved design

## Problem

Templates today only reach notes at **creation time**: a folder can carry a default
template, the journal has a default template, and the new-note flow shows a
`TemplateSelector`. There is no way to apply a template to an **existing, individual
note**. Users want to right-click a note (or use the note-page 3-dots menu) and drop a
template into it.

Because applying a template overwrites the note body, doing this on a note that already
has content is destructive and must be confirmed.

## Goals

- Apply any template (built-in or custom) to an existing note from two entry points:
  1. Note right-click context menu in the notes tree.
  2. The 3-dots menu on the note page.
- Reuse the existing template selector and `applyTemplate` logic — no parallel system.
- When the note body is non-empty, require an explicit confirmation before replacing it.
- At confirmation, let the user choose whether to also apply the template's tags and
  properties, or to keep the note's existing metadata.
- Metadata merge is **non-destructive**: existing tags/properties are preserved; the
  template's are added on top.
- Keep an open editor in sync live when its note is retargeted.

## Non-goals

- No "template linkage" / ongoing association between a note and a template. Apply is a
  one-shot injection.
- No new template authoring UI (templates are created/edited as they are today).
- No changes to folder-default or journal-default behavior.
- No append/insert-at-cursor mode. Apply replaces the body.

## Behavior

Entry point → `TemplateSelector` (in a new `applyToNote` mode: no folder/journal-default
checkboxes, primary button reads "Apply") → user picks a template → **Apply**.

Then:

- **Note body is empty** → apply immediately, no dialog. Mode is `full` (body + merged
  metadata). Merge is non-destructive, so nothing is lost.
- **Note body is non-empty** → show a confirmation dialog. The dialog states that the
  note's content will be replaced and offers three actions:
  - **Replace content & add template details** — `mode: 'full'`. Body ← template body;
    tags = union(existing, template); properties = merge, with **existing values winning**
    on key conflicts.
  - **Replace content only** — `mode: 'body'`. Body ← template body; tags and properties
    left untouched.
  - **Cancel** — no change.

`{{title}}` in the template body resolves to the note's current title, via the existing
`applyTemplate(template, title)`.

### "Has content" detection

The trigger determines whether a confirmation is needed by inspecting the note body:

- Note-page 3-dots: the note is open, so the renderer already knows the body.
- Notes-tree right-click: the note may not be open. The renderer fetches the note body
  (existing `notes.get`/`getNoteById` read) before deciding.

"Non-empty" = template-independent body text is non-empty after trim. Tags/properties
alone do **not** trigger confirmation, because the merge never removes them.

## Data flow

### New IPC method

`notes.applyTemplate({ noteId: string, templateId: string, mode: 'full' | 'body' })`
→ returns the updated note.

Added to `packages/contracts` (notes API) and wired in `notes-handlers`. Run
`pnpm ipc:generate` then `pnpm ipc:check` after the contract edit.

### Main-process handler

1. Load the note (title, absolute path, current frontmatter, current body).
2. `const template = await getTemplate(templateId)`; if missing → error.
3. `const applied = applyTemplate(template, note.title)` → `{ content, tags, properties }`.
4. Build the new frontmatter by mode:
   - `full`: `tags = union(existingTags, applied.tags)`;
     `properties = { ...applied.properties, ...existingProperties }` (existing wins).
   - `body`: keep the note's existing `tags` and `properties` verbatim.
5. `serializeNote(newFrontmatter, applied.content)` → `atomicWrite(filePath, ...)`.
6. `syncNoteToCache(...)` to update the index DB, mirroring `createNote`.
7. **Live editor sync:** if the note's Y.Doc is currently open, perform a full XML-fragment
   replace with the new body so an open editor updates instantly.

### CRDT sync (the one real risk)

`watcher.ts:feedExternalEditToCrdt(noteId, markdown)` already performs exactly the needed
operation: `fragment.delete(0, len); blocksToYFragment(markdownToBlocks(md))` inside a
`doc.transact(..., ORIGIN_LOCAL)`, guarded by `provider.getDoc(noteId)` (no-op if the doc
is not open).

Plan:

- **Extract** `feedExternalEditToCrdt` from `watcher.ts` into a small shared module
  (e.g. `apps/desktop/src/main/sync/crdt-feed.ts`) and have both the watcher and the new
  handler call the one implementation.
- The handler feeds CRDT **explicitly and exactly once**. Because our own `atomicWrite`
  goes through the existing writeback-ignore path, the watcher must not also re-feed the
  same edit. The plan verifies the ignore interaction and guarantees a single apply (no
  double fragment replace, no flicker).

## Components / files touched

- `packages/contracts` — new `applyTemplate` notes method + Zod schema.
- `apps/desktop/src/main/vault/notes-crud.ts` (or a sibling) — `applyTemplateToNote(...)`
  main logic (reuses `getTemplate`, `applyTemplate`, `serializeNote`, `syncNoteToCache`).
- `apps/desktop/src/main/sync/crdt-feed.ts` — extracted shared `feedExternalEditToCrdt`.
- `apps/desktop/src/main/vault/watcher.ts` — import the extracted helper (behavior
  unchanged).
- `apps/desktop/src/main/ipc/notes-handlers.ts` — IPC wiring.
- `apps/desktop/src/preload` — regenerated RPC/preload for the new method.
- `apps/desktop/src/renderer/src/components/note/template-selector.tsx` — support an
  `applyToNote` mode (hide default checkboxes; relabel primary button).
- `apps/desktop/src/renderer/src/components/note/apply-template-confirm-dialog.tsx` — new
  confirmation dialog (three actions).
- `apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx` — "Apply Template…"
  context-menu item + `onApplyTemplateToNote` callback.
- `apps/desktop/src/renderer/src/components/note/note-header.tsx` — "Apply Template…" in
  the 3-dots menu.
- A renderer hook/service (`use-apply-note-template` or extend an existing notes service)
  to orchestrate: fetch body → decide confirm → call IPC.
- `apps/desktop` i18n `notes` namespace — new keys for the menu item, dialog title/body,
  and the three action labels (English `en/notes.json` required for the i18n gate).

## Error handling

- Template not found → surfaced via `extractErrorMessage`, toast in renderer.
- Note not found / read failure → same.
- No vault open → existing `VaultError` path.
- CRDT doc not open → feed is a no-op; the file + index are still updated, and the editor
  loads the new body when next opened.

## Testing

- **Main unit** (`notes-crud`-level, no Electron): `full` vs `body` mode produce correct
  body, tag union, and property merge (existing-wins). `{{title}}` resolves. Empty-body
  path applies `full`. Missing template errors.
- **CRDT feed**: extracted `feedExternalEditToCrdt` keeps its existing watcher tests green;
  add a test that the handler triggers exactly one fragment replace when a doc is open and
  zero when it is not.
- **Renderer**: selector `applyToNote` mode hides default checkboxes; confirm dialog shows
  only when body non-empty; each action calls IPC with the right `mode`; empty-body skips
  the dialog. Menu items appear in both entry points.
- **i18n**: `pnpm --filter @memry/desktop i18n:check`.

## Backward compatibility

No DB schema, sync-protocol, vault file-format, or settings-shape changes. The only
contract change is an additive IPC method. Existing templates, folder defaults, and journal
defaults are untouched. Safe for all existing installs.
