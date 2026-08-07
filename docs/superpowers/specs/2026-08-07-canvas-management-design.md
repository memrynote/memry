# Canvas Management — Delete, Rename, Folders, Drag & Drop

- **Date:** 2026-08-07
- **Status:** Draft / design
- **Branch:** `claude/canvas-management-features-9f9528` (worktree `five-issues-parallel-fix-0d1c5b`) — rename to a code-context branch name before pushing
- **Origin:** user feedback on shipped canvases + follow-up scoping with Kaan
- **Related:** `2026-07-17-spatial-canvas-design.md`, `2026-08-03-mcp-canvas-coverage-design.md`, `2026-08-05-mcp-canvas-drawing-design.md`

> Written in English to match every other spec under `docs/superpowers/specs/**`.

---

## 1. Goal

Bring canvases up to the same management parity notes and folders already have. Reported gaps:

1. A canvas cannot be deleted.
2. Canvases cannot be arranged in folders.
3. The context menu is not scrollable and hides options.
4. A canvas cannot be renamed.
5. Sidebar section headings have very low text contrast.

Scoped with Kaan into: **anything a folder or note can do in the sidebar, a canvas can do too** — rename, duplicate, delete, set/remove icon, reveal in Finder, open in an external editor, bookmark, and move between folders by drag & drop or by menu. Plus a real folder tree under the CANVASES section, scrollable when it grows.

### Decisions taken

| Question                                    | Decision                                               |
| ------------------------------------------- | ------------------------------------------------------ |
| Do canvas folders sync across devices?      | **Yes** — `folder` joins the canvas sync payload       |
| What does deleting a canvas do to the file? | **OS trash** (`shell.trashItem`) + confirmation dialog |
| Sort order in the tree                      | **Folders first, then alphabetical**                   |
| Canvas folder icons                         | **Yes, fully synced** — new `canvas_folder` sync type  |
| Delivery                                    | **One PR** covering everything below                   |

### Non-goals

- Canvases living anywhere in the vault tree alongside notes (Obsidian-style). They stay under `<vault>/canvases/`; the user asked for subfolders _under the Canvas section_.
- Multi-select / bulk operations in the canvas tree. Notes have them; canvases can get them later.
- Virtualized rendering. The notes tree virtualizes because vaults hold thousands of notes; canvas counts are an order of magnitude smaller. Revisit if that stops being true.
- Reordering canvases manually. Sort is alphabetical, full stop.

---

## 2. Current state (verified in code)

Worth stating precisely, because a lot of the backend already exists and the plan below is smaller than the feature list suggests.

**Already works:**

- `canvas:delete` → `store.deleteCanvas` tombstones the row (`deletedAt`), prunes `canvas_entity_refs`, and unlinks the file outside the transaction so an fs failure cannot resurrect the canvas.
- `canvas:update` accepts `title`; `store.updateCanvas` renames the file to track it via `allocateCanvasPath` + `renameCanvasFile`, and keeps the old path on a failed rename rather than losing the file.
- `BookmarkItemTypes.CANVAS` already exists in `packages/contracts/src/bookmark-types.ts`.
- `SidebarSection` already accepts `totalCount` and `actions`.
- `IconPickerButton` (`components/icon-picker-button.tsx`) is already shared between folder and note rows.

**Missing:**

- `SidebarCanvasList` is a flat list with no context menu, no scroll cap, and no folder concept (`components/sidebar/sidebar-canvas-list.tsx`, 124 lines).
- `listCanvasFiles` is a flat, non-recursive `readdir` of `<vault>/canvases`; `allocateCanvasPath` always returns `canvases/<name>.excalidraw`.
- `CanvasSyncPayloadSchema` carries `{id, vaultId, title, scene, clock, deletedAt}` — no placement, no icon.
- No canvas equivalents of `notes:reveal-in-finder` / `notes:open-external` (both are note-id scoped).
- `ContextMenuContent` in `components/ui/context-menu.tsx` has `overflow-hidden` and **no** max-height, while its own `ContextMenuSubContent` already has `max-h-(--radix-context-menu-content-available-height) overflow-y-auto`.

**Useful property:** canvases live at `<vault>/canvases/`, but the notes tree is rooted at `config.defaultNoteFolder`. Canvas subfolders therefore cannot leak into the notes tree.

---

## 3. Data model

Data-DB migrations are **hand-written** and additive (Drizzle snapshots have been broken since 0021). Next free number is `0048`.

### 3.1 `canvases` — two additive columns

```sql
ALTER TABLE canvases ADD COLUMN folder TEXT;
ALTER TABLE canvases ADD COLUMN icon TEXT;
```

- `folder` — path **relative to `canvases/`**, always forward-slashed (`Work/Q3`). `NULL` or `''` means root. Forward slashes for the same reason `file_path` uses them: a vault written on Windows must open on macOS after a copy.
- `icon` — nullable, same encoding as `notes.emoji` and `folder_configs.icon`, so `IconPickerButton` drops straight in.

Both nullable with no backfill: `NULL` already means "root, no icon", which is exactly what every existing row should mean.

### 3.2 `canvas_folders` — new table

```sql
CREATE TABLE canvas_folders (
  id TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  icon TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  clock TEXT,
  synced_at INTEGER
);
CREATE UNIQUE INDEX canvas_folders_vault_path_idx ON canvas_folders (vault_id, path);
```

This table exists for exactly two reasons: to carry a folder's **icon**, and to let an **empty** folder reach other devices. Placement itself lives on the canvas row, so a folder is never a hard dependency of its contents — a canvas whose folder row failed to arrive still renders in the right place, because its own `folder` string says where it goes.

**`id` is derived from the path, not random.** Two devices that create `Work/` while offline must mint the _same_ row or they collide on the unique index at pull time. Same problem bookmarks solved in migration 0043, same solution:

```ts
// packages/contracts/src/canvas-folder-types.ts
export function canvasFolderSyncId(path: string): string {
  return `cvf_${path.normalize('NFC').toLowerCase()}`
}
```

The NFC + lowercase normalization mirrors `canvasPathKey`: macOS stores filenames decomposed and both macOS and Windows are case-insensitive, so `Work` and `work` must be one folder everywhere or a vault stops being portable. As with `bookmarkSyncId`, this function **must stay character-identical to the SQL in its migration**.

**Consequence of path-as-identity:** renaming a folder is a tombstone of the old id plus an insert of the new one, carrying the icon across. Two devices renaming the same folder concurrently produce two folders, each holding whichever canvases that device moved. No data is lost (canvases carry their own `folder`), and the user can merge by dragging. That is a better failure mode than a merge rule that silently discards one rename.

---

## 4. Disk layout — the file stays the truth

`<vault>/canvases/Work/Q3/Plan.excalidraw`

Changes in `main/canvas/scene-file.ts`:

- `listCanvasFiles` walks recursively instead of a flat `readdir`. Skips dotfiles and dot-directories, caps depth (8 levels), and keeps returning sorted vault-relative forward-slashed paths so adoption order stays stable.
- `canvasRelativePath(filename, folder)` and `allocateCanvasPath(vaultPath, title, taken, current, folder)` gain a folder argument. Uniquification happens **within the target folder** — `Plan` may exist in both `Work/` and `Personal/`.
- Folder segments go through `portableCanvasBase` too: Windows reserved device names (`CON`, `LPT1`…) and trailing dots/spaces bite on directories exactly as they do on files.
- `resolveCanvasFile`'s existing `..` refusal already covers deeper paths — it filters segments before joining, so nothing new is needed there. A test pins that a folder named `..` cannot escape the vault.

`main/canvas/reconcile.ts` at vault open:

- Adopting a file records its folder from the file's own path.
- A file the user moved into a subfolder in Finder updates `canvases.folder` on the next open. **Path is truth for placement**, the same way the file is truth for ink.
- Unchanged: never tombstone a row whose file is missing.

---

## 5. Sync

### 5.1 Canvas payload

```ts
export const CanvasSyncPayloadSchema = z.object({
  id: z.string().optional(),
  vaultId: z.string().optional(),
  title: z.string().nullable().optional(),
  scene: z.string().optional(),
  folder: z.string().nullable().optional(), // NEW
  icon: z.string().nullable().optional(), // NEW
  clock: VectorClockSchema.optional(),
  deletedAt: z.number().nullable().optional()
})
```

The schema is already all-optional for forward tolerance, so this is free in both directions: an old client parses a new payload and ignores the two fields; a new client parses an old payload and degrades to root-with-no-icon. `canvas-handler.ts` creates the target directory before writing the scene when `folder` is present.

### 5.2 New `canvas_folder` sync type

Follows the `adding-sync-item-type` checklist end to end, copying `filter` as the template (simple record, whole-row LWW, `clock` only — no `fieldClocks`; there is exactly one editable field):

1. `sync-api.ts` — add to all four arrays: `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, `ENCRYPTABLE_ITEM_TYPES`. Missing the last one makes encryption refuse the type and sync drops it silently.
2. `sync-payloads.ts` — `CanvasFolderSyncPayloadSchema` `{id?, vaultId?, path?, icon?, clock?, deletedAt?}` + parse test.
3. `packages/db-schema/src/schema/canvas-folder.ts` + exports from `data-schema.ts` and `schema/index.ts`.
4. `main/sync/item-handlers/canvas-folder-handler.ts` — `applyUpsert` / `applyDelete` / `fetchLocal` / `buildPushPayload` / `markPushSynced` / **`seedUnclocked`**.
5. `item-handlers/index.ts` registry entry.
6. `main/sync/canvas-folder-sync.ts` (copy `filter-sync.ts`).
7. `offline-clock.ts` — `incrementCanvasFolderClockOffline`.
8. `local-mutations.ts` — registry entry, **and every folder mutation must call the enqueue functions**. The registry entry alone seeds once and then never syncs again.
9. `runtime.ts` — init/reset + `createSyncAdapterRegistry` entry.
10. `manifest-check.ts` — `addLocalItem` block selecting `isNotNull(clock)`.
11. `apps/sync-server/src/services/sync-telemetry.ts` — `case 'canvas_folder'` in `toSyncDomain`. The switch is exhaustive with no default; typecheck fails until it's added.
12. `CanvasFolderChannels` in `ipc-channels.ts` (handlers emit through it regardless of renderer CRUD).

### 5.3 Release ordering — hard constraint

`apps/sync-server/src/lib/sync-types.ts` builds its `SUPPORTED` set from `RECORD_SYNC_ITEM_TYPES`. A client that declares `canvas_folder` in `X-Memry-Sync-Types` against an **old** server has that entry dropped on the floor, and the server serves zero rows for the type.

**The sync-server must be deployed before the desktop release ships.** Same rule as PR #754. Canvas folder icons and empty folders simply don't propagate until it is; canvases and their `folder` placement are unaffected, since those ride the existing `canvas` type.

---

## 6. IPC surface

Placement and icon fold into the existing update rather than minting new channels — "move to folder" and "set icon" are both `canvas:update`:

```ts
export const CanvasUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  scene: z.string().optional(),
  folder: z.string().nullable().optional(), // NEW
  icon: z.string().nullable().optional(), // NEW
  entityRefs: z.array(CanvasEntityRefSchema).optional(),
  expectedUpdatedAt: z.number().int().optional()
})
```

New channels:

| Channel                                                                    | Purpose                                                  |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `canvas:duplicate`                                                         | Copy scene + assets into a new canvas in the same folder |
| `canvas:reveal-in-finder`                                                  | Mirrors `notes:reveal-in-finder`, canvas-id scoped       |
| `canvas:open-external`                                                     | Mirrors `notes:open-external`, canvas-id scoped          |
| `canvasFolder:list` / `create` / `rename` / `delete` / `move` / `set-icon` | Folder CRUD                                              |

`CanvasSummary` gains `folder: string \| null` and `icon: string \| null`, so `canvas:list` returns a tree in one round trip.

Run `pnpm ipc:generate` then `pnpm ipc:check` after the contract edits — see the `ipc-contract-change` skill.

---

## 7. Renderer

### 7.1 New module `components/sidebar/canvas-tree/`

| File                    | Responsibility                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `canvas-tree.tsx`       | Builds the tree from flat `{canvases, folders}`; renders rows; owns DnD state       |
| `canvas-folder-row.tsx` | Folder row + its context menu                                                       |
| `canvas-row.tsx`        | Canvas row + its context menu                                                       |
| `use-canvas-tree.ts`    | Data load + event subscriptions (`onCanvasCreated/Updated/Deleted` + folder events) |
| `canvas-tree-model.ts`  | Pure: flat lists → sorted tree, plus the DnD legality predicates                    |

`canvas-tree-model.ts` is pure and holds every rule worth testing without a DOM: sort order, path prefix rewriting on folder rename, and drop legality. Keeping it separate is what stops `canvas-tree.tsx` from growing into another 1000-line file.

**Not** a generalization of `virtualized-notes-tree.tsx` (1127 lines, note-specific, virtualized, multi-select). Reworking it to serve both would risk the app's most-used surface for no user-visible gain.

### 7.2 Behaviour

- Sort: folders first, then alphabetical, both case-insensitive and locale-aware.
- Expansion state persisted per folder path in `localStorage`, matching `SidebarSection`'s existing convention.
- Scroll: `max-h` + `overflow-y-auto` on the tree body, so the section can't push the rest of the sidebar off-screen.
- The section passes `totalCount` so the collapsed header shows the canvas count (§9.5).

**Canvas context menu** — Rename · Duplicate — Set icon / Remove icon — Move to folder ▸ — Open in external editor · Reveal in Finder — Bookmark — **Delete**

**Folder context menu** — New canvas here · New folder — Set icon / Remove icon — Rename — **Delete**

Both reuse `BookmarkMenuItem`, `IconPickerButton`, and the existing rename dialog pattern from the notes tree. Destructive items get `className="text-destructive focus:text-destructive"`, matching folder and note rows.

### 7.3 Drag & drop

HTML5 native DnD, matching the notes tree — **not** dnd-kit. (Projects use dnd-kit; the notes tree does not. Matching the tree that this one mirrors keeps the drop-indicator code and its feel identical.)

Legality rules, all in `canvas-tree-model.ts`:

- Canvas → folder, canvas → root: allowed.
- Folder → folder, folder → root: allowed.
- **Folder → its own descendant: rejected.** Without this the subtree detaches and the canvases inside it become unreachable.
- **Cross-tree drags rejected in both directions.** A canvas dragged onto the notes tree, or a note dragged into the canvas tree, is a no-op — the drag payload carries a source-tree tag and each tree ignores foreign tags.

### 7.4 New-canvas placement

`handleCreateCanvas` in `app-sidebar.tsx` creates at root today. It gains the currently-selected folder as target, mirroring how the notes tree's "New note" uses `onTargetFolderChange`. "New canvas here" in a folder's menu passes that folder explicitly.

---

## 8. Delete semantics

`shell.trashItem` for the `.excalidraw` file, with a fallback to `unlink` when trash is unavailable (network volumes, some Linux setups). The row is still tombstoned exactly as today, so sync behaviour does not change — the trash is a local safety net, not a sync concept.

A confirmation dialog precedes both canvas and folder deletes. Folder delete states how many canvases are inside, trashes the directory, and tombstones every canvas row within it plus the folder row.

**Known divergence, accepted:** `deleteNote` currently hard-unlinks through `vault/file-ops.deleteFile`. Canvases will be safer than notes until notes are moved to the same mechanism. Worth a follow-up issue; explicitly out of scope here.

---

## 9. Cross-cutting items the user did not raise

These came out of the codebase read. Each is either a latent bug this feature would expose, or a gap that makes the feature worse than it looks.

### 9.1 Context-menu clipping is app-wide, not canvas-specific

`ContextMenuContent` sets `overflow-hidden` with no max-height. Its sibling `ContextMenuSubContent`, ten lines below, already has `max-h-(--radix-context-menu-content-available-height) overflow-x-hidden overflow-y-auto`. Copying that onto the root content fixes the reported clipping — and fixes it for notes, folders, tags, and projects at the same time, since they all render through the same component. The canvas menus specified above are among the longest in the app, so the bug would be worse here if left alone.

### 9.2 "Move to folder ▸" is an accessibility requirement, not a convenience

HTML5 drag & drop has no keyboard path. Without a menu-driven move, organizing canvases is mouse-only — and WCAG AA is a stated project constraint (`CLAUDE.md`, "A11y: WCAG AA + reduced-motion + RTL"). The submenu lists every folder as a flat indented path list (`Work`, `Work / Q3`), with "Root" first and the canvas's current folder disabled.

### 9.3 Duplicate must copy `canvas_assets` rows, not just the scene text

`main/canvas/assets/dedup-plan.ts` refcounts assets by union across canvases: `planDereference` treats a `contentHash` as orphaned when no **other** canvas references it, and orphans get dereferenced on the server.

If duplicate copies only the scene JSON, the new canvas's images exist in the scene but have no `canvas_assets` rows. The original's next save computes the union without them, concludes the assets are orphaned, and **dereferences the duplicate's images server-side**. The duplicate breaks, and the break is delayed and silent.

`canvas:duplicate` therefore: inserts the new canvas row, writes the scene (with a fresh `memry` sidecar id), and **inserts `canvas_assets` rows for every descriptor in the copied scene**. Regression test: duplicate a canvas with an image, save the original, assert the duplicate's asset rows and server chunks survive.

New title uses the existing `allocateCanvasPath` counter (`Plan` → `Plan 2`) in the same folder.

### 9.4 MCP tools resolve canvases by name

`main/agent/mcp/tools/canvas-handles.ts` and `canvas-write.ts` resolve a canvas from a user-supplied name. Folders make **duplicate titles legal for the first time** — `Work/Plan` and `Personal/Plan` can coexist.

Today's resolver would pick one arbitrarily and write to it. Both tools need folder-qualified resolution: accept `Work/Plan` as well as `Plan`, and when a bare name is ambiguous, return an error listing the qualified candidates rather than guessing. An agent silently drawing on the wrong canvas is the worst outcome in this whole spec.

### 9.5 Unreadable canvases need a visible state

`Canvas.unreadable` already exists — a legacy row this device holds no key for, or a file moved/deleted outside the app. The editor refuses to mount so it cannot autosave over recoverable ink, but the sidebar renders it identically to a healthy canvas. In a tree with many canvases that is worse than in a short flat list: the user clicks, nothing opens, no explanation.

`canvas:list` returns `unreadable` per summary; the row shows a muted icon plus a tooltip explaining the file is missing or unreadable, and its context menu offers only Reveal in Finder and Delete.

### 9.6 Collapsed-section count

`SidebarSection` already accepts `totalCount` and renders `(n)` when collapsed. The canvases section never passes it. One-line fix, included here because it is the same surface.

### 9.7 Empty folders are why `canvas_folders` exists

Stated plainly so the table is not mistaken for over-engineering: placement rides on the canvas row, so the _only_ things this table buys are folder icons and empty-folder propagation. If either is ever dropped, the table goes with them.

---

## 10. Backward compatibility

Production users on real data. Every item below is a requirement, not a nicety.

| Risk                               | Handling                                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing canvas rows               | New columns are nullable; `NULL` already means root + no icon. No backfill, no reset.                                                                                             |
| Existing `.excalidraw` files       | Root-level files keep working unchanged; the recursive walk is a superset of the flat one.                                                                                        |
| Old client reads new payload       | All-optional schema; unknown fields ignored; canvas lands at root.                                                                                                                |
| New client reads old payload       | `folder`/`icon` absent → root, no icon.                                                                                                                                           |
| Old server, new client             | `canvas_folder` filtered out of the negotiated types. Canvases still sync; folder icons and empty folders don't. Mitigated by §5.3 deploy ordering.                               |
| Vault copied to another machine    | Folder structure is real directories, so it travels with the folder. Reconcile adopts.                                                                                            |
| User reorganizes in Finder         | Reconcile updates `canvases.folder` from the path on next open.                                                                                                                   |
| Rollback to a previous app version | Extra columns and the extra table are ignored by older code; canvases open from their files regardless of nesting, because `file_path` already stores a full vault-relative path. |

---

## 11. Testing

**Main — `main/canvas/`**

- `scene-file`: recursive listing incl. depth cap and dotfile skip; allocation within a folder; per-folder collision (`Work/Plan` + `Personal/Plan` coexist); NFC and case collisions inside a subfolder; folder segment named `..` refused; Windows reserved folder name suffixed.
- `store`: create in folder; move between folders moves the file; rename folder rewrites every child's `folder` prefix and the directory; delete trashes with unlink fallback; duplicate copies `canvas_assets` (§9.3).
- `reconcile`: adopt a file found in a subfolder; a file moved in Finder re-points `folder`; a row whose file is missing is still never tombstoned.

**Sync**

- `canvas-folder-handler.test.ts` — the seven cases from the skill: insert, newer-clock update, older-clock skip, concurrent → `'conflict'`, delete, delete-skip, `seedUnclocked` enqueues.
- `canvas-handler` — payload with `folder` creates the directory; payload without `folder` lands at root; payload without `scene` still never clobbers local ink (existing D5 rule).
- `sync-payloads.test.ts` — both schemas parse old and new shapes.

**Renderer**

- `canvas-tree-model`: sort order; drop legality incl. descendant cycle and cross-tree rejection; path prefix rewrite on folder rename.
- `canvas-tree`: context menu actions fire the right service calls; unreadable row renders its degraded state and restricted menu.
- `context-menu`: long menu scrolls rather than clipping.

**E2E**

- Create folder → drag a canvas in → rename it → duplicate → delete → confirm the trashed file is gone and the tree is correct after a reload.

**Manual**

- Two-profile sync (`dev:a` / `dev:b`): create a folder on A with a canvas inside, confirm both appear on B; move on A, confirm B follows; concurrent rename on both, confirm no loop and no lost canvases.

**Contrast**

- Measured ratios for the new token in all three themes recorded in the PR description (§12).

---

## 12. Sidebar section heading contrast

`SidebarSection` renders its heading at 11px uppercase in `text-sidebar-muted`. WCAG AA requires 4.5:1 for text that small. Measured against each theme's `--sidebar` background:

| Theme | `--sidebar-muted`      | Approx. ratio | AA (4.5:1) |
| ----- | ---------------------- | ------------- | ---------- |
| Paper | `#b5b0a6`              | ~2.0:1        | fail       |
| White | `#b0afab` on `#f9f8f7` | ~2.0:1        | fail       |
| Dark  | `#6b6b6b` on `#1a1a1a` | ~3.3:1        | fail       |

`--sidebar-muted` is also used for chevrons and decorative icon buttons, where darkening would over-weight them against the calm-and-restrained direction in `PRODUCT.md`. So: a **new** `--sidebar-section-heading` token per theme, consumed only by `SidebarSection`.

Exact values are computed and verified during implementation rather than guessed here; the acceptance bar is ≥4.5:1 in all three themes, with the ratios recorded in the PR description.

---

## 13. Verification

```bash
pnpm --filter @memry/desktop db:push
pnpm ipc:generate && pnpm ipc:check
pnpm check:contracts && pnpm check:architecture
pnpm lint && pnpm typecheck
pnpm test:desktop && pnpm test:sync-server
pnpm test:e2e
pnpm --filter @memry/desktop i18n:check
pnpm docs:impact --base origin/main --strict && pnpm docs:build
```

New user-facing strings go through `@memry/i18n`; no literals in JSX. New Tailwind classes use logical properties (`ms-*`, `ps-*`, `start-*`, `text-start`, `border-s`, `rounded-s-*`) per `CLAUDE.md` — the canvas tree is new code, so the RTL rules apply in full.

---

## 14. Open items for implementation

- Exact `--sidebar-section-heading` values per theme (§12).
- Whether `canvas:duplicate` copies the scene's `memryAssets` descriptors verbatim or re-uploads. Verbatim plus new `canvas_assets` rows is the intent (§9.3); confirm against `asset-service.ts` before writing it.
- Depth cap for the recursive walk is proposed at 8; confirm nothing in the vault legitimately nests deeper.
