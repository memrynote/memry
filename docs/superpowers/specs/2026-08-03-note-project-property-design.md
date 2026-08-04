# Note → Project via a `project` Property

Date: 2026-08-03
Status: Approved design, not implemented

## Problem

A note is linked to a project through the note page's `⋯` menu → "Add to project",
which opens `AddNoteToProjectDialog` and writes a `project_links` row directly. The
linked projects then render as a separate pill row (`ItemProjectChips`) under the
note title.

This splits one concept across two places: the action lives in an overflow menu, the
result lives in a pill row, and neither is where a user looks for a note's structured
metadata — the Properties section. Journal entries cannot be linked to a project at
all, because the journal page has no such menu item.

## Goal

Assigning a note or journal entry to a project happens in exactly one place: a
`project` property in the Properties section. The `⋯` menu item, its dialog, and the
pill row are removed from the note page.

## Decisions

These were settled during brainstorming and are not open in implementation:

| Decision          | Choice                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| Cardinality       | Multi-valued. A note can belong to several projects.                    |
| Frontmatter value | Project **names**, not ids. The vault stays readable in Obsidian.       |
| Source of truth   | **Frontmatter.** The markdown-note rows of `project_links` are derived. |
| Property key      | Fixed `project`. Not renameable, only one per note.                     |
| Rename / delete   | Propagated eagerly — linked notes' frontmatter is rewritten.            |
| Other write paths | All rerouted in this release (sidebar drag, URL capture, MCP).          |
| Migration         | **None.** The feature is unreleased; no user has project-linked notes.  |

## Current state

| Layer              | Today                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Link store         | `project_links` (data DB): `(project_id, item_type, item_id, position, pinned)`, `item_type ∈ note \| calendar_event \| file`                    |
| Note `⋯` menu      | `apps/desktop/src/renderer/src/pages/note.tsx:1271` → `AddNoteToProjectDialog` → `tasksService.linkProjectItem`                                  |
| Note page pill row | `note.tsx:1361` `ItemProjectChips`                                                                                                               |
| Journal `⋯` menu   | No project item exists                                                                                                                           |
| Property values    | Note frontmatter (YAML). `properties:set` → `updateNote` (notes) or `writeJournalEntryWithContent` (journals)                                    |
| Property types     | `.memry/properties.md` + mirrored into the `property_definitions` table. 8 types: text, number, date, checkbox, url, status, select, multiselect |

Journal entries live in `note_metadata` with a `journalDate`, so a `project_links`
row with `item_type: 'note'` and a journal's note id already resolves correctly in
`getProjectContents`. No schema change is needed for journal support.

## Design

### Ownership split

A `project_links` row is **frontmatter-owned** if its `item_id` resolves to a
`note_metadata` row with `file_type = 'markdown'`. Every other row — files, calendar
events, rows whose target no longer exists — is **table-owned** and keeps behaving
exactly as it does today.

The discriminator is `file_type`, deliberately **not** `item_type`. As
`getProjectContents` already notes (`apps/desktop/src/main/database/queries/projects.ts:700`),
`item_type` records what the user linked, so a binary file can carry
`item_type: 'note'` from before a conversion. Trusting `item_type` would let the
reconciler delete a file's link.

### Frontmatter shape

```yaml
project: [Alpha, Beta]
```

Always an array, even with one entry. The value lives wherever the note's other
properties already live — nested under `properties:` for Memry-written notes,
top-level for Obsidian-written ones. `extractProperties` already reads both; this
design changes neither.

Removing the last project leaves `project: []` and keeps the property row visible so
it can be refilled. Deleting the key entirely is the trash-icon action, same as every
other property.

### New property type

- `packages/contracts/src/property-types.ts`
  - `PropertyTypes.PROJECT = 'project'`
  - `ProjectPropertySchema = z.object({ type: z.literal('project') })` — no `options`;
    the choices come from the `projects` table, not the definition file
  - add it to the `PropertyDefinitionSchema` discriminated union
- `apps/desktop/src/renderer/src/components/note/info-section/types.ts`
  - `PropertyType` union gains `'project'`
  - `PROPERTY_TYPE_CONFIG.project = { label: 'Project', icon: FolderKanban }` —
    `AddPropertyPopup` derives its list from this record, so the entry appears with
    no further wiring
- `AddPropertyPopup` forces the name to `project` when the project type is chosen,
  ignoring whatever is typed in the name field. When the note already has a `project`
  property the entry is disabled — otherwise `getUniquePropertyName` would silently
  create a second, non-functional `project 2`.
- `PropertyRow` passes no `onNameChange` for a project property, so the key cannot be
  renamed.

`project` becomes a **reserved key**: `getPropertyType` returns `'project'` for it
regardless of what the `property_definitions` row or `inferPropertyType` say. Without
this, a note written in Obsidian as `project: [Alpha]` with no definition yet would be
inferred as `multiselect` and render the wrong editor — and the reconciler and the UI
would disagree about the same key.

### `ProjectEditor`

A new editor under `info-section/editors/`, taking over the visual language the pill
row is losing. `getProjectsForItem` already returns `{ id, name, color, icon }`
(`projects.ts:810`), and `projects.icon` holds an emoji, so both are available with no
query change.

- Each selected project renders as: emoji (when set) · color dot · name · `×` —
  matching the tag row's language.
- `+` opens a searchable list of non-archived projects.
- `×` removes one project. A project already in the frontmatter but archived still
  renders (it just isn't offered in the picker).
- A name with no matching project renders as a muted "unknown" chip. It is **not**
  removed and does **not** auto-create a project — a typo in Obsidian must not
  materialise a project, and silently dropping the user's text is worse than showing
  the inconsistency.
- Writes go through the existing `useProperties.updateProperty` path. The editor
  never touches `project_links`.

### Removals

- `note.tsx`: the `add-to-project` `Picker.Item` (`note.tsx:1271`) and its handler.
- `note.tsx`: the `ItemProjectChips` render (`note.tsx:1361`).
- `add-note-to-project-dialog.tsx`: deleted along with its import.

`ItemProjectChips` itself stays — `file.tsx:151` and `calendar-event-form.tsx:223`
still use it, and those item types have no frontmatter.

### Reconciler

A new projector, `note-project-links`, handling `note.upserted` and `note.deleted`.
It follows the shape of `note-derived-state-projector.ts` with one difference: it
writes to the **data DB** (`getDatabase()`), because `project_links` lives there,
while the existing note projector writes to the index DB.

On `note.upserted`:

1. Read `note.properties.project`. Absent or not an array → treat as `[]`.
2. Resolve each name against `projects` case-insensitively. Unresolved names are
   dropped from the link set and logged at debug level; duplicate names resolve to the
   oldest project by `created_at` and log a warning.
3. Diff against the note's existing frontmatter-owned rows. Insert the missing,
   delete the extra. **Rows that survive the diff are never deleted and reinserted** —
   that is what preserves `position` and `pinned`.
4. Enqueue the affected projects for sync.

On `note.deleted`, existing cleanup applies (`cleanupProjectLinksForDeletedNote`).

Journals flow through this unchanged: they are markdown notes with a `journalDate`,
so their properties arrive on the same event.

### Rerouted write paths

`PROJECT_LINK_ITEM` and `PROJECT_UNLINK_ITEM` (`apps/desktop/src/main/ipc/tasks-handlers.ts:222`)
gain a single branch: if the target resolves to a markdown note, update that note's
frontmatter and let the projector derive the link; otherwise write the table row as
today.

Putting the branch in the handler means every caller keeps working untouched:

| Surface                                           | File                                                            |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Sidebar drag-and-drop                             | `sortable-project-item.tsx:101`                                 |
| Project hub URL capture                           | `PROJECT_CAPTURE_URL` handler                                   |
| Project hub file import                           | `PROJECT_IMPORT_FILES` handler (files → unchanged, table-owned) |
| MCP `tasks.linkProjectItem` / `unlinkProjectItem` | already in the MCP allowlist                                    |

The MCP allowlist and every RPC signature stay as they are.

### Rename and delete propagation

`updateProject` (when `name` changes) and `deleteProject` look up the affected
markdown notes through `project_links` and rewrite their frontmatter in one batch:
rename replaces the old name, delete removes the entry. One sync flush at the end
rather than one per note.

This is unavoidable given names-in-frontmatter: without it the vault would carry a
name that no longer exists, and a later re-created project with the same name would
silently re-adopt those notes.

### Sync

The note payload already carries `properties` (`note-handler.ts:254`), so a note's
project membership now arrives **atomically with the note**. This closes the existing
race where a note could arrive before the project link that references it.

The project payload changes on both sides:

- **Push**: frontmatter-owned rows are excluded from the `links` array.
- **Pull**: `reconcileLinks` leaves frontmatter-owned rows alone. Without this, pulling
  a project would wipe locally derived note links.

Payloads written by older builds still carry note links; those entries are ignored
rather than rejected, so the change is backward compatible in both directions.

## Testing

- `property-types` schema: a `project` definition survives a parse → persist → parse
  round-trip through `properties.md`.
- Reconciler: add, remove, reorder; `pinned` and `position` survive a diff; unknown
  name; duplicate names; a journal entry.
- `PROJECT_LINK_ITEM` branch: markdown target writes frontmatter, file target writes
  the table row.
- Rename and delete propagate to every linked note's frontmatter.
- A project pull does not delete derived rows.
- `pnpm ipc:generate && pnpm ipc:check` — contracts change.
- `pnpm test:desktop`, `pnpm lint`, `pnpm typecheck`.

## Out of scope

- Files and calendar events keep the `⋯` → "Add to project" dialog and the pill row.
  Neither has frontmatter.
- Filtering or grouping notes by the `project` property in folder views.
- Project property support in templates.
