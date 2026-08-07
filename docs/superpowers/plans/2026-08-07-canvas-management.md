# Canvas Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give canvases the same sidebar management a note or folder already has — rename, duplicate, delete, icon, reveal, open externally, bookmark — plus a real synced folder tree with drag & drop.

**Architecture:** The `.excalidraw` file stays the source of truth for ink and for _placement_: a canvas in `Work/Q3` is a file at `<vault>/canvases/Work/Q3/Plan.excalidraw`. The `canvases` table gains `folder` + `icon` columns as its index of that. A new `canvas_folders` table exists only to carry folder icons and to let empty folders reach other devices; its row id is derived from the folder path so two offline devices mint the same row. The renderer gets a new small, non-virtualized tree beside the existing notes tree rather than a generalization of it.

**Tech Stack:** Electron + React 19, Drizzle ORM over better-sqlite3 (data DB), Zod v4 contracts in `packages/contracts`, generated RPC bindings, Vitest, Playwright, Tailwind v4 with logical properties.

**Spec:** `docs/superpowers/specs/2026-08-07-canvas-management-design.md`

## Global Constraints

- **Production app, backward compatibility is mandatory.** No DB resets. Data-DB migrations are hand-written and additive (Drizzle snapshots broken past 0021). Next free migration number is `0048`.
- **Deploy ordering:** the sync-server must be deployed before the desktop release ships. `apps/sync-server/src/lib/sync-types.ts` builds `SUPPORTED` from `RECORD_SYNC_ITEM_TYPES`; an old server silently drops `canvas_folder` from the negotiated `X-Memry-Sync-Types` header.
- **Logging:** `createLogger('Scope')`, never raw `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **IPC:** all renderer↔main types live in `packages/contracts`. Run `pnpm ipc:generate` then `pnpm ipc:check` after any contract edit.
- **RTL / logical Tailwind properties are mandatory in new files:** `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`. Never `ml-*`, `mr-*`, `pl-*`, `pr-*`, `left-*`, `right-*`, `text-left`, `text-right`.
- **i18n:** every user-facing string goes through `@memry/i18n`; no literals in JSX. `pnpm --filter @memry/desktop i18n:check` gates English only.
- **No `Co-Authored-By` trailers in commit messages.**
- **Branch:** rename off `claude/canvas-management-features-9f9528` to a code-context name (e.g. `canvas-folder-management`) before pushing.
- **Timestamps in the canvas domain are INTEGER epoch ms** (`Date.now()`), matching `canvases`. Do NOT copy `utcNow()` ISO strings from `savedFilters`.
- Vault-relative paths are always forward-slashed, on every platform.

---

## File Structure

**Contracts (`packages/contracts/src/`)**
| File | Responsibility |
|---|---|
| `canvas-api.ts` (modify) | `folder`/`icon` on summary + update schema; new channel names |
| `canvas-folder-api.ts` (create) | Folder contract: schemas, responses, events |
| `canvas-folder-types.ts` (create) | `canvasFolderSyncId`, path normalization helpers — no Zod, importable from db-schema and SQL-adjacent code |
| `ipc-channels.ts` (modify) | `CanvasChannels.invoke` additions + `CanvasFolderChannels` |
| `sync-api.ts` (modify) | `canvas_folder` in four arrays |
| `sync-payloads.ts` (modify) | `folder`/`icon` on canvas payload; `CanvasFolderSyncPayloadSchema` |

**Schema (`packages/db-schema/src/`)**
| File | Responsibility |
|---|---|
| `schema/canvas.ts` (modify) | `folder` + `icon` columns |
| `schema/canvas-folder.ts` (create) | `canvasFolders` table |

**Main (`apps/desktop/src/main/`)**
| File | Responsibility |
|---|---|
| `database/drizzle-data/0048_canvas_folders.sql` (create) | The migration |
| `canvas/scene-file.ts` (modify) | Recursive listing, folder-aware path allocation, portable folder segments |
| `canvas/folder-paths.ts` (create) | Pure path algebra: normalize, join, prefix-rewrite, descendant check |
| `canvas/store.ts` (modify) | `folder`/`icon` through CRUD; `moveCanvas`, `duplicateCanvas`; trash on delete |
| `canvas/folder-store.ts` (create) | Folder CRUD across disk + `canvas_folders` |
| `canvas/reconcile.ts` (modify) | Adopt folder from file path |
| `sync/item-handlers/canvas-handler.ts` (modify) | Apply `folder`/`icon` |
| `sync/item-handlers/canvas-folder-handler.ts` (create) | New sync type handler |
| `sync/canvas-folder-sync.ts` (create) | Record sync service |
| `ipc/canvas-handlers.ts` (modify) | duplicate / reveal / open-external |
| `ipc/canvas-folder-handlers.ts` (create) | Folder IPC |
| `agent/mcp/tools/canvas-handles.ts` (modify) | Folder-qualified resolution |

**Renderer (`apps/desktop/src/renderer/src/`)**
| File | Responsibility |
|---|---|
| `components/sidebar/canvas-tree/canvas-tree-model.ts` (create) | Pure: flat → sorted tree, drop legality, prefix rewrite |
| `components/sidebar/canvas-tree/canvas-tree.tsx` (create) | Tree render + DnD state |
| `components/sidebar/canvas-tree/canvas-row.tsx` (create) | Canvas row + context menu |
| `components/sidebar/canvas-tree/canvas-folder-row.tsx` (create) | Folder row + context menu |
| `components/sidebar/canvas-tree/use-canvas-tree.ts` (create) | Data load + event subscriptions |
| `components/ui/context-menu.tsx` (modify) | Scroll fix |
| `components/sidebar-section.tsx` (modify) | Heading contrast token |
| `assets/base.css` (modify) | `--sidebar-section-heading` per theme |
| `services/canvas-folder-service.ts` (create) | Renderer forwarder |
| `components/app-sidebar.tsx` (modify) | Swap list → tree, pass `totalCount` |

`sidebar-canvas-list.tsx` and its test are **deleted** in Task 15 once the tree replaces them.

---

## Task 1: Context menu scroll fix

Independent of everything else and fixes a reported bug app-wide. Ship it first so it can be reviewed on its own.

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/ui/context-menu.tsx:67`
- Test: `apps/desktop/src/renderer/src/components/ui/context-menu.test.tsx` (create)

**Interfaces:**

- Consumes: nothing
- Produces: nothing — pure styling fix

- [ ] **Step 1: Read the current component**

Read `apps/desktop/src/renderer/src/components/ui/context-menu.tsx`. Note that `ContextMenuContent` (~line 67) has `overflow-hidden` and no max-height, while `ContextMenuSubContent` (~line 90) already has `max-h-(--radix-context-menu-content-available-height) ... overflow-x-hidden overflow-y-auto`. The fix is to bring the root content in line with its own sub-content.

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/renderer/src/components/ui/context-menu.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from './context-menu'

describe('ContextMenuContent', () => {
  it('constrains its height and scrolls instead of clipping', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>trigger</ContextMenuTrigger>
        <ContextMenuContent forceMount data-testid="content">
          <ContextMenuItem>one</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    const content = screen.getByTestId('content')
    expect(content.className).toContain('overflow-y-auto')
    expect(content.className).toContain('max-h-(--radix-context-menu-content-available-height)')
    expect(content.className).not.toContain('overflow-hidden')
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
pnpm --filter @memry/desktop test:renderer -- context-menu
```

Expected: FAIL — the class list contains `overflow-hidden` and neither of the other two classes.

- [ ] **Step 4: Apply the fix**

In `ContextMenuContent`'s `cn(...)` call, replace `overflow-hidden` with:

```
max-h-(--radix-context-menu-content-available-height) overflow-x-hidden overflow-y-auto
```

Leave every other class untouched, and leave `ContextMenuSubContent` alone — it is already correct.

- [ ] **Step 5: Run the test and confirm it passes**

```bash
pnpm --filter @memry/desktop test:renderer -- context-menu
```

Expected: PASS.

- [ ] **Step 6: Check for visual regressions in long menus**

```bash
pnpm --filter @memry/desktop test:renderer -- virtualized-notes-tree
```

Expected: PASS. The notes tree renders the app's other long menus; nothing should change.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/ui/context-menu.tsx apps/desktop/src/renderer/src/components/ui/context-menu.test.tsx
git commit -m "fix(ui): let context menus scroll instead of clipping their options"
```

---

## Task 2: Sidebar section heading contrast

**Files:**

- Modify: `apps/desktop/src/renderer/src/assets/base.css` (three theme blocks + the `@theme inline` map)
- Modify: `apps/desktop/src/renderer/src/components/sidebar-section.tsx:126`

**Interfaces:**

- Consumes: nothing
- Produces: CSS variable `--sidebar-section-heading` / Tailwind class `text-sidebar-section-heading`

- [ ] **Step 1: Measure the current ratios**

The heading renders at 11px, which WCAG AA treats as small text (4.5:1 required). Current values, from `base.css`:

| Theme | Token             | Value     | Background                     |
| ----- | ----------------- | --------- | ------------------------------ |
| Paper | `--sidebar-muted` | `#b5b0a6` | `--sidebar` in the paper block |
| White | `--sidebar-muted` | `#b0afab` | `#f9f8f7`                      |
| Dark  | `--sidebar-muted` | `#6b6b6b` | `#1a1a1a`                      |

Compute each contrast ratio with the WCAG formula. Record the "before" numbers — they go in the PR description.

- [ ] **Step 2: Pick values that clear 4.5:1**

Add a new token per theme. Do **not** change `--sidebar-muted` itself: it also colors chevrons and decorative icon buttons, where extra weight fights the calm direction in `PRODUCT.md`.

Starting points to verify and adjust until each clears 4.5:1 against its own `--sidebar`:

```css
/* paper block */
--sidebar-section-heading: #6b6459;
/* .white block */
--sidebar-section-heading: #6b6966;
/* .dark block */
--sidebar-section-heading: #9d9d9d;
```

Confirm each measured ratio is ≥ 4.5:1 before moving on. If one falls short, darken (light themes) or lighten (dark theme) until it clears.

- [ ] **Step 3: Register the token with Tailwind**

In the `@theme inline` block of `base.css`, beside `--color-sidebar-muted`:

```css
--color-sidebar-section-heading: var(--sidebar-section-heading);
```

- [ ] **Step 4: Use it in the heading**

In `sidebar-section.tsx`, in the header `<button>`'s `cn(...)`, change:

```
'text-sidebar-muted hover:text-sidebar-foreground',
```

to:

```
'text-sidebar-section-heading hover:text-sidebar-foreground',
```

Leave `SectionChevron`'s `text-sidebar-muted` alone — the chevron is decorative and exempt.

- [ ] **Step 5: Verify in all three themes**

```bash
pnpm dev
```

Switch through paper / white / dark in settings. The section headings (NOTES, PROJECTS, BOOKMARKS, CANVASES, TAGS) should read clearly; the chevrons and the `(n)` count should look unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/assets/base.css apps/desktop/src/renderer/src/components/sidebar-section.tsx
git commit -m "fix(sidebar): raise section heading contrast to WCAG AA"
```

---

## Task 3: Path algebra (pure, no I/O)

Every folder rule that is worth testing lives here, so the store and the renderer both stay thin. Written before any storage change because both depend on it.

**Files:**

- Create: `apps/desktop/src/main/canvas/folder-paths.ts`
- Test: `apps/desktop/src/main/canvas/folder-paths.test.ts`

**Interfaces:**

- Consumes: `canvasPathKey` from `./scene-file`
- Produces:
  - `normalizeFolder(folder: string | null | undefined): string | null` — `''`/whitespace/`'.'` → `null`; strips leading and trailing slashes; collapses repeats
  - `folderSegments(folder: string | null): string[]`
  - `joinFolder(parent: string | null, name: string): string`
  - `isDescendantFolder(candidate: string | null, ancestor: string | null): boolean` — true when `candidate` is `ancestor` or sits beneath it
  - `rewriteFolderPrefix(folder: string | null, from: string, to: string): string | null`
  - `parentFolder(folder: string | null): string | null`
  - `MAX_CANVAS_FOLDER_DEPTH = 8`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/main/canvas/folder-paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  folderSegments,
  isDescendantFolder,
  joinFolder,
  normalizeFolder,
  parentFolder,
  rewriteFolderPrefix
} from './folder-paths'

describe('normalizeFolder', () => {
  it('treats empty-ish values as root', () => {
    expect(normalizeFolder(null)).toBeNull()
    expect(normalizeFolder(undefined)).toBeNull()
    expect(normalizeFolder('')).toBeNull()
    expect(normalizeFolder('   ')).toBeNull()
    expect(normalizeFolder('.')).toBeNull()
    expect(normalizeFolder('/')).toBeNull()
  })

  it('strips and collapses slashes', () => {
    expect(normalizeFolder('/Work/')).toBe('Work')
    expect(normalizeFolder('Work//Q3')).toBe('Work/Q3')
  })
})

describe('joinFolder', () => {
  it('joins onto root and onto a parent', () => {
    expect(joinFolder(null, 'Work')).toBe('Work')
    expect(joinFolder('Work', 'Q3')).toBe('Work/Q3')
  })
})

describe('parentFolder', () => {
  it('walks up one level', () => {
    expect(parentFolder('Work/Q3')).toBe('Work')
    expect(parentFolder('Work')).toBeNull()
    expect(parentFolder(null)).toBeNull()
  })
})

describe('isDescendantFolder', () => {
  it('matches self and descendants', () => {
    expect(isDescendantFolder('Work', 'Work')).toBe(true)
    expect(isDescendantFolder('Work/Q3', 'Work')).toBe(true)
    expect(isDescendantFolder('Work/Q3/Deep', 'Work')).toBe(true)
  })

  it('rejects siblings and unrelated folders', () => {
    expect(isDescendantFolder('Workshop', 'Work')).toBe(false)
    expect(isDescendantFolder('Personal', 'Work')).toBe(false)
    expect(isDescendantFolder('Work', 'Work/Q3')).toBe(false)
  })

  it('treats every folder as a descendant of root', () => {
    expect(isDescendantFolder('Work/Q3', null)).toBe(true)
    expect(isDescendantFolder(null, null)).toBe(true)
  })

  it('compares case- and unicode-insensitively', () => {
    expect(isDescendantFolder('work/q3', 'Work')).toBe(true)
  })
})

describe('rewriteFolderPrefix', () => {
  it('rewrites the folder itself and its descendants', () => {
    expect(rewriteFolderPrefix('Work', 'Work', 'Job')).toBe('Job')
    expect(rewriteFolderPrefix('Work/Q3', 'Work', 'Job')).toBe('Job/Q3')
  })

  it('leaves unrelated folders alone, including prefix lookalikes', () => {
    expect(rewriteFolderPrefix('Workshop', 'Work', 'Job')).toBe('Workshop')
    expect(rewriteFolderPrefix(null, 'Work', 'Job')).toBeNull()
  })
})

describe('folderSegments', () => {
  it('splits a folder into its parts', () => {
    expect(folderSegments('Work/Q3')).toEqual(['Work', 'Q3'])
    expect(folderSegments(null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:main -- folder-paths
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/canvas/folder-paths.ts`:

```ts
/**
 * Pure path algebra for canvas folders.
 *
 * A canvas folder is a path relative to `<vault>/canvases`, always
 * forward-slashed (`Work/Q3`), with `null` meaning the root. No I/O here on
 * purpose: the store, the sync handler and the renderer all need the same
 * rules, and rules that touch the filesystem cannot be tested cheaply.
 *
 * @module canvas/folder-paths
 */

import { canvasPathKey } from './scene-file'

/** Deepest nesting the recursive walk will follow. */
export const MAX_CANVAS_FOLDER_DEPTH = 8

export function normalizeFolder(folder: string | null | undefined): string | null {
  if (!folder) return null
  const cleaned = folder
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
  return cleaned.length > 0 ? cleaned : null
}

export function folderSegments(folder: string | null): string[] {
  return normalizeFolder(folder)?.split('/') ?? []
}

export function joinFolder(parent: string | null, name: string): string {
  const base = normalizeFolder(parent)
  const leaf = normalizeFolder(name)
  if (!leaf) throw new Error('Canvas folder name cannot be empty')
  return base ? `${base}/${leaf}` : leaf
}

export function parentFolder(folder: string | null): string | null {
  const segments = folderSegments(folder)
  if (segments.length <= 1) return null
  return segments.slice(0, -1).join('/')
}

/**
 * True when `candidate` IS `ancestor` or sits beneath it. Compared through
 * `canvasPathKey` (NFC + lowercase) because macOS and Windows are
 * case-insensitive and macOS stores filenames decomposed — `work/q3` and
 * `Work/Q3` are one folder there, and a cycle guard that missed that would
 * let a drag detach a whole subtree.
 *
 * Segment-wise rather than string `startsWith`, so `Workshop` is not treated
 * as a child of `Work`.
 */
export function isDescendantFolder(candidate: string | null, ancestor: string | null): boolean {
  const ancestorSegments = folderSegments(ancestor)
  if (ancestorSegments.length === 0) return true // everything lives under root
  const candidateSegments = folderSegments(candidate)
  if (candidateSegments.length < ancestorSegments.length) return false
  return ancestorSegments.every(
    (segment, index) => canvasPathKey(candidateSegments[index]) === canvasPathKey(segment)
  )
}

export function rewriteFolderPrefix(
  folder: string | null,
  from: string,
  to: string
): string | null {
  if (!isDescendantFolder(folder, from)) return normalizeFolder(folder)
  const rest = folderSegments(folder).slice(folderSegments(from).length)
  const target = normalizeFolder(to)
  const joined = [...folderSegments(target), ...rest].join('/')
  return joined.length > 0 ? joined : null
}
```

- [ ] **Step 4: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:main -- folder-paths
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/canvas/folder-paths.ts apps/desktop/src/main/canvas/folder-paths.test.ts
git commit -m "feat(canvas): add pure path algebra for canvas folders"
```

---

## Task 4: Folder-aware scene files

**Files:**

- Modify: `apps/desktop/src/main/canvas/scene-file.ts`
- Test: `apps/desktop/src/main/canvas/scene-file.test.ts` (extend)

**Interfaces:**

- Consumes: `normalizeFolder`, `folderSegments`, `MAX_CANVAS_FOLDER_DEPTH` from `./folder-paths`
- Produces:
  - `allocateCanvasPath(vaultPath, title, taken?, current?, folder?)` — `folder` is a new fifth parameter, default `null`
  - `listCanvasFiles(vaultPath)` — now recursive
  - `folderOfCanvasPath(relativePath: string): string | null` — `canvases/Work/Plan.excalidraw` → `Work`
  - `ensureCanvasFolderDir(vaultPath: string, folder: string | null): void`
  - `portableCanvasFolder(folder: string | null): string | null` — sanitizes each segment

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/main/canvas/scene-file.test.ts`:

```ts
describe('folder-aware canvas paths', () => {
  it('allocates inside the target folder', () => {
    const dir = makeTempVault()
    expect(allocateCanvasPath(dir, 'Plan', new Set(), null, 'Work')).toBe(
      'canvases/Work/Plan.excalidraw'
    )
  })

  it('lets the same title exist in two folders', () => {
    const dir = makeTempVault()
    writeCanvasFileSync(resolveCanvasFile(dir, 'canvases/Work/Plan.excalidraw'), '{}')
    expect(allocateCanvasPath(dir, 'Plan', new Set(), null, 'Personal')).toBe(
      'canvases/Personal/Plan.excalidraw'
    )
  })

  it('uniquifies within a folder, not across folders', () => {
    const dir = makeTempVault()
    writeCanvasFileSync(resolveCanvasFile(dir, 'canvases/Work/Plan.excalidraw'), '{}')
    expect(allocateCanvasPath(dir, 'Plan', new Set(), null, 'Work')).toBe(
      'canvases/Work/Plan 2.excalidraw'
    )
  })

  it('lists files in subfolders', () => {
    const dir = makeTempVault()
    writeCanvasFileSync(resolveCanvasFile(dir, 'canvases/Root.excalidraw'), '{}')
    writeCanvasFileSync(resolveCanvasFile(dir, 'canvases/Work/Q3/Deep.excalidraw'), '{}')
    expect(listCanvasFiles(dir)).toEqual([
      'canvases/Root.excalidraw',
      'canvases/Work/Q3/Deep.excalidraw'
    ])
  })

  it('skips dot-directories and dotfiles', () => {
    const dir = makeTempVault()
    writeCanvasFileSync(resolveCanvasFile(dir, 'canvases/.trash/Old.excalidraw'), '{}')
    writeCanvasFileSync(resolveCanvasFile(dir, 'canvases/.hidden.excalidraw'), '{}')
    expect(listCanvasFiles(dir)).toEqual([])
  })

  it('reads the folder back out of a stored path', () => {
    expect(folderOfCanvasPath('canvases/Work/Q3/Plan.excalidraw')).toBe('Work/Q3')
    expect(folderOfCanvasPath('canvases/Plan.excalidraw')).toBeNull()
  })

  it('sanitizes folder segments the same way it sanitizes filenames', () => {
    expect(portableCanvasFolder('CON/Q3 ')).toBe('CON canvas/Q3')
  })

  it('refuses a folder that would escape the vault', () => {
    const dir = makeTempVault()
    expect(() => resolveCanvasFile(dir, 'canvases/../../etc/passwd')).toThrow(/escapes the vault/)
  })
})
```

Use whatever temp-vault helper the existing test file already defines; if it has none, add `makeTempVault()` using `mkdtempSync(path.join(tmpdir(), 'canvas-'))` and register cleanup in `afterEach`.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:main -- scene-file
```

Expected: FAIL — the new exports do not exist and `allocateCanvasPath` ignores its fifth argument.

- [ ] **Step 3: Implement the new exports**

In `scene-file.ts`, add imports from `./folder-paths` and these functions:

```ts
/** Sanitizes each folder segment. Windows rejects `CON` as a directory too. */
export function portableCanvasFolder(folder: string | null): string | null {
  const segments = folderSegments(folder).map((segment) => portableCanvasBase(segment))
  return segments.length > 0 ? segments.join('/') : null
}

/** The folder a stored canvas path sits in, or null for the canvases root. */
export function folderOfCanvasPath(relativePath: string): string | null {
  const segments = relativePath.split('/').filter(Boolean)
  // Drop the leading CANVAS_DIR segment and the filename.
  const folderSegs = segments.slice(1, -1)
  return folderSegs.length > 0 ? folderSegs.join('/') : null
}

export function ensureCanvasFolderDir(vaultPath: string, folder: string | null): void {
  const normalized = portableCanvasFolder(folder)
  const target = normalized
    ? path.join(canvasDirPath(vaultPath), ...normalized.split('/'))
    : canvasDirPath(vaultPath)
  mkdirSync(target, { recursive: true })
}
```

- [ ] **Step 4: Make `canvasRelativePath` and `allocateCanvasPath` folder-aware**

```ts
function canvasRelativePath(filename: string, folder: string | null = null): string {
  const normalized = portableCanvasFolder(folder)
  return normalized ? `${CANVAS_DIR}/${normalized}/${filename}` : `${CANVAS_DIR}/${filename}`
}
```

In `allocateCanvasPath`, add the fifth parameter and thread it through both `canvasRelativePath` calls:

```ts
export function allocateCanvasPath(
  vaultPath: string,
  title: string | null,
  taken: ReadonlySet<string> = new Set(),
  current: string | null = null,
  folder: string | null = null
): string {
  const base = portableCanvasBase(title)
  const claimed = new Set([...taken].map(canvasPathKey))
  const own = current ? canvasPathKey(current) : null
  let candidate = canvasRelativePath(`${base}${CANVAS_FILE_EXT}`, folder)
  let counter = 1
  while (
    canvasPathKey(candidate) !== own &&
    (claimed.has(canvasPathKey(candidate)) || existsSync(resolveCanvasFile(vaultPath, candidate)))
  ) {
    counter += 1
    candidate = canvasRelativePath(`${base} ${counter}${CANVAS_FILE_EXT}`, folder)
  }
  return candidate
}
```

The uniquification loop is unchanged — because the candidate now carries the folder, collisions are already scoped per folder.

- [ ] **Step 5: Make `listCanvasFiles` recursive**

```ts
/**
 * Vault-relative paths of every canvas document, sorted for stable adoption.
 *
 * Recursive since canvases gained folders. Dot-directories are skipped so a
 * cloud client's `.tmp`/`.trash` staging area never becomes a visible folder,
 * and depth is capped so a symlink loop in a synced vault cannot hang open.
 */
export function listCanvasFiles(vaultPath: string): string[] {
  const root = canvasDirPath(vaultPath)
  if (!existsSync(root)) return []

  const found: string[] = []
  const walk = (absDir: string, relSegments: string[]): void => {
    if (relSegments.length > MAX_CANVAS_FOLDER_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return // an unreadable directory must not take the whole listing down
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        walk(path.join(absDir, entry.name), [...relSegments, entry.name])
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(CANVAS_FILE_EXT)) {
        found.push([CANVAS_DIR, ...relSegments, entry.name].join('/'))
      }
    }
  }

  walk(root, [])
  return found.sort()
}
```

Add `Dirent` to the `fs` import.

- [ ] **Step 6: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:main -- scene-file
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/canvas/scene-file.ts apps/desktop/src/main/canvas/scene-file.test.ts
git commit -m "feat(canvas): make scene file paths folder-aware"
```

---

## Task 5: Contracts and schema

Grouped because a partial contract change does not typecheck — `pnpm typecheck` is the gate for the whole set.

**Files:**

- Create: `packages/contracts/src/canvas-folder-types.ts`
- Create: `packages/contracts/src/canvas-folder-api.ts`
- Modify: `packages/contracts/src/canvas-api.ts`
- Modify: `packages/contracts/src/ipc-channels.ts`
- Modify: `packages/contracts/src/sync-api.ts`
- Modify: `packages/contracts/src/sync-payloads.ts`
- Create: `packages/db-schema/src/schema/canvas-folder.ts`
- Modify: `packages/db-schema/src/schema/canvas.ts`, `src/data-schema.ts`, `src/schema/index.ts`
- Create: `apps/desktop/src/main/database/drizzle-data/0048_canvas_folders.sql`
- Test: `packages/contracts/src/canvas-folder-types.test.ts`, extend `sync-payloads.test.ts`

**Interfaces:**

- Produces:
  - `canvasFolderSyncId(path: string): string`
  - `CanvasSummary` gains `folder: string | null`, `icon: string | null`, `unreadable?: boolean`
  - `CanvasUpdateSchema` gains `folder`, `icon`
  - `CanvasFolder { id, path, icon, createdAt, updatedAt }`
  - `CanvasFolderChannels`
  - `canvasFolders` Drizzle table

- [ ] **Step 1: Write the failing id test**

Create `packages/contracts/src/canvas-folder-types.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { canvasFolderSyncId } from './canvas-folder-types'

describe('canvasFolderSyncId', () => {
  it('is deterministic for the same path', () => {
    expect(canvasFolderSyncId('Work')).toBe(canvasFolderSyncId('Work'))
  })

  it('collapses case and unicode form, so two devices mint one row', () => {
    expect(canvasFolderSyncId('work')).toBe(canvasFolderSyncId('Work'))
    expect(canvasFolderSyncId('Yağmur'.normalize('NFD'))).toBe(
      canvasFolderSyncId('Yağmur'.normalize('NFC'))
    )
  })

  it('distinguishes nested paths from their parents', () => {
    expect(canvasFolderSyncId('Work/Q3')).not.toBe(canvasFolderSyncId('Work'))
  })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/contracts test -- canvas-folder-types
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `canvas-folder-types.ts`**

```ts
/**
 * Canonical canvas-folder identity, shared by contracts, db-schema and SQL.
 */

/**
 * Deterministic canvas folder id.
 *
 * Two devices that create `Work/` while offline would otherwise mint two rows
 * for one logical folder and collide on the `(vault_id, path)` unique index at
 * pull time. Deriving the id from the path makes both produce the identical
 * row, so LWW merges it — the same trick `bookmarkSyncId` uses.
 *
 * NFC + lowercase because macOS stores filenames decomposed and both macOS and
 * Windows are case-insensitive: `Work` and `work` are one directory there, and
 * a vault must stay portable across all three platforms.
 *
 * MUST stay character-identical to the SQL in migration 0048.
 */
export function canvasFolderSyncId(path: string): string {
  return `cvf_${path.normalize('NFC').toLowerCase()}`
}
```

- [ ] **Step 4: Run and confirm passing**

```bash
pnpm --filter @memry/contracts test -- canvas-folder-types
```

Expected: PASS.

- [ ] **Step 5: Extend the canvas API contract**

In `packages/contracts/src/canvas-api.ts`:

```ts
export interface CanvasSummary {
  id: string
  title: string | null
  /** Path relative to `canvases/`, forward-slashed. Null means the root. */
  folder: string | null
  icon: string | null
  /**
   * The document could not be read — a legacy row this device holds no key
   * for, or a file moved/deleted outside the app. Surfaced in list responses so
   * the sidebar can show it as degraded instead of pretending it opens.
   */
  unreadable?: boolean
  createdAt: number
  updatedAt: number
}
```

Add to `CanvasCreateSchema`:

```ts
  folder: z.string().nullable().optional(),
  icon: z.string().nullable().optional()
```

Add the same two lines to `CanvasUpdateSchema`. Add to `CanvasChannels.invoke` in `ipc-channels.ts`:

```ts
    DUPLICATE: 'canvas:duplicate',
    REVEAL_IN_FINDER: 'canvas:reveal-in-finder',
    OPEN_EXTERNAL: 'canvas:open-external',
```

- [ ] **Step 6: Add the folder contract**

Create `packages/contracts/src/canvas-folder-api.ts`:

```ts
/**
 * Canvas folder IPC contract.
 *
 * A canvas folder is a real directory under `<vault>/canvases`. Placement of a
 * canvas lives on the canvas row (`folder`), so these rows carry only the
 * folder's icon and its existence — which is what lets an EMPTY folder reach
 * another device.
 *
 * @module contracts/canvas-folder-api
 */

import { z } from 'zod'
import { CanvasFolderChannels } from './ipc-channels.ts'
export { CanvasFolderChannels }

export interface CanvasFolder {
  /** Deterministic, derived from `path` — see canvasFolderSyncId. */
  id: string
  /** Path relative to `canvases/`, forward-slashed. Never null: root is not a row. */
  path: string
  icon: string | null
  createdAt: number
  updatedAt: number
}

export const CanvasFolderCreateSchema = z.object({
  /** Parent folder, or null to create at the canvases root. */
  parent: z.string().nullable().optional(),
  name: z.string().min(1)
})

export const CanvasFolderRenameSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1)
})

export const CanvasFolderMoveSchema = z.object({
  path: z.string().min(1),
  /** New parent, or null for the canvases root. */
  parent: z.string().nullable()
})

export const CanvasFolderSetIconSchema = z.object({
  path: z.string().min(1),
  icon: z.string().nullable()
})

export interface CanvasFolderListResponse {
  folders: CanvasFolder[]
}

export interface CanvasFolderMutationResponse {
  folder: CanvasFolder | null
}

export interface CanvasFolderDeleteResponse {
  success: boolean
  /** Canvases tombstoned along with the folder. */
  deletedCanvasIds: string[]
}

export interface CanvasFolderCreatedEvent {
  folder: CanvasFolder
}
export interface CanvasFolderUpdatedEvent {
  folder: CanvasFolder
  /** Set when the change moved the folder, so listeners can re-key state. */
  previousPath?: string
}
export interface CanvasFolderDeletedEvent {
  path: string
}
```

In `ipc-channels.ts`, beside `CanvasChannels`:

```ts
export const CanvasFolderChannels = {
  invoke: {
    LIST: 'canvasFolder:list',
    CREATE: 'canvasFolder:create',
    RENAME: 'canvasFolder:rename',
    MOVE: 'canvasFolder:move',
    DELETE: 'canvasFolder:delete',
    SET_ICON: 'canvasFolder:set-icon'
  },
  events: {
    CREATED: 'canvasFolder:created',
    UPDATED: 'canvasFolder:updated',
    DELETED: 'canvasFolder:deleted'
  }
} as const

export type CanvasFolderInvokeChannel =
  (typeof CanvasFolderChannels.invoke)[keyof typeof CanvasFolderChannels.invoke]
export type CanvasFolderEventChannel =
  (typeof CanvasFolderChannels.events)[keyof typeof CanvasFolderChannels.events]
```

- [ ] **Step 7: Register the sync type**

In `packages/contracts/src/sync-api.ts`, add `'canvas_folder'` to **all four** arrays: `SYNC_ITEM_TYPES`, `RECORD_SYNC_ITEM_TYPES`, `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, `ENCRYPTABLE_ITEM_TYPES`.

Do **not** touch `LEGACY_RECORD_SYNC_ITEM_TYPES` — it is a frozen list that protects binaries already in users' hands.

- [ ] **Step 8: Extend the sync payloads**

In `sync-payloads.ts`, add to `CanvasSyncPayloadSchema`:

```ts
  folder: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
```

and add:

```ts
/**
 * Canvas folder sync payload. All-optional for the same forward-tolerance
 * reason as every other payload here: a newer client's row must still parse on
 * an older one. `path` is validated at the apply site, never here.
 */
export const CanvasFolderSyncPayloadSchema = z.object({
  id: z.string().optional(),
  vaultId: z.string().optional(),
  path: z.string().optional(),
  icon: z.string().nullable().optional(),
  clock: VectorClockSchema.optional(),
  deletedAt: z.number().nullable().optional()
})
export type CanvasFolderSyncPayload = z.infer<typeof CanvasFolderSyncPayloadSchema>
```

Add to `sync-payloads.test.ts`:

```ts
describe('CanvasFolderSyncPayloadSchema', () => {
  it('parses a full payload', () => {
    const parsed = CanvasFolderSyncPayloadSchema.safeParse({
      id: 'cvf_work',
      vaultId: 'v1',
      path: 'Work',
      icon: '📁',
      clock: { deviceA: 1 },
      deletedAt: null
    })
    expect(parsed.success).toBe(true)
  })

  it('parses an empty payload from a future client', () => {
    expect(CanvasFolderSyncPayloadSchema.safeParse({}).success).toBe(true)
  })
})

describe('CanvasSyncPayloadSchema folder tolerance', () => {
  it('parses an old payload with no folder or icon', () => {
    const parsed = CanvasSyncPayloadSchema.safeParse({ id: 'c1', title: 'Plan', scene: '{}' })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.folder).toBeUndefined()
  })
})
```

- [ ] **Step 9: Add the Drizzle table and columns**

Create `packages/db-schema/src/schema/canvas-folder.ts`:

```ts
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { VectorClock } from '@memry/contracts/sync-api'

/**
 * Canvas folders — real directories under `<vault>/canvases`.
 *
 * Placement lives on the canvas row, so this table carries only a folder's
 * icon and its existence. That existence is what lets an EMPTY folder reach
 * another device; drop either need and this table goes with them.
 *
 * `id` is derived from `path` (canvasFolderSyncId), so two devices creating the
 * same folder offline converge on one row instead of colliding on the unique
 * index at pull time.
 */
export const canvasFolders = sqliteTable(
  'canvas_folders',
  {
    id: text('id').primaryKey(),
    vaultId: text('vault_id').notNull(),
    /** Forward-slashed, relative to `canvases/`. Never empty. */
    path: text('path').notNull(),
    icon: text('icon'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Soft delete: tombstones must stay visible to sync. */
    deletedAt: integer('deleted_at'),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    syncedAt: integer('synced_at')
  },
  (table) => [uniqueIndex('canvas_folders_vault_path_idx').on(table.vaultId, table.path)]
)

export type CanvasFolderRow = typeof canvasFolders.$inferSelect
export type NewCanvasFolderRow = typeof canvasFolders.$inferInsert
```

Export it from `packages/db-schema/src/data-schema.ts` and `src/schema/index.ts`.

In `packages/db-schema/src/schema/canvas.ts`, add to the `canvases` table:

```ts
    /**
     * Path relative to `canvases/`, forward-slashed (`Work/Q3`). Null is the
     * root. The FILE's location is the truth; this is the index of it.
     */
    folder: text('folder'),
    icon: text('icon'),
```

- [ ] **Step 10: Write the migration by hand**

Create `apps/desktop/src/main/database/drizzle-data/0048_canvas_folders.sql`:

```sql
-- Canvas folders: placement + icon for canvases.
-- Additive only. Existing rows keep NULL, which already means "root, no icon".
ALTER TABLE `canvases` ADD `folder` text;--> statement-breakpoint
ALTER TABLE `canvases` ADD `icon` text;--> statement-breakpoint
CREATE TABLE `canvas_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`path` text NOT NULL,
	`icon` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`clock` text,
	`synced_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_folders_vault_path_idx` ON `canvas_folders` (`vault_id`,`path`);
```

Do **not** run `db:generate` — data-DB migrations are hand-written here. Apply with:

```bash
pnpm --filter @memry/desktop db:push
```

- [ ] **Step 11: Register the migration in tests that enumerate migrations**

Grep for tests that list migration files explicitly:

```bash
rg -n "0045_canvas_files|0046_|0047_" apps/desktop/src --glob '*.test.ts'
```

Every hit that hand-builds a canvas schema needs `0048_canvas_folders.sql` added to its list — the same trap PR #946 hit with `0045`. `apps/desktop/tests/utils/test-db.ts` reads the real folder and needs nothing.

- [ ] **Step 12: Typecheck and test**

```bash
pnpm --filter @memry/contracts test
pnpm typecheck
```

Expected: `typecheck` fails in exactly one place — `apps/sync-server/src/services/sync-telemetry.ts`, whose `toSyncDomain` switch is exhaustive over `SyncItemType` with no default. Add:

```ts
    case 'canvas_folder':
      return 'canvas'
```

beside the existing `case 'canvas'`. Re-run `pnpm typecheck`; expected: clean.

- [ ] **Step 13: Commit**

```bash
git add packages/contracts packages/db-schema apps/desktop/src/main/database/drizzle-data/0048_canvas_folders.sql apps/sync-server/src/services/sync-telemetry.ts
git commit -m "feat(canvas): add folder and icon contracts, schema and migration"
```

---

## Task 6: Canvas store — folder, icon, move, duplicate, trash

**Files:**

- Modify: `apps/desktop/src/main/canvas/store.ts`
- Test: `apps/desktop/src/main/canvas/store.test.ts` (extend)

**Interfaces:**

- Consumes: Task 3 path algebra, Task 4 scene-file exports, Task 5 schema
- Produces:
  - `createCanvas(db, vaultPath, vaultId, input)` — `input` gains `folder?`, `icon?`
  - `updateCanvas(db, vaultPath, id, input)` — `input` gains `folder?`, `icon?`
  - `duplicateCanvas(db, vaultPath, vaultId, id): Canvas | null`
  - `deleteCanvas(db, vaultPath, id, trash: (absPath: string) => Promise<void>): Promise<boolean>`
  - `listCanvases(db, vaultId): CanvasSummary[]` — returns `folder` + `icon`

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/main/canvas/store.test.ts`:

```ts
describe('canvas folders', () => {
  it('creates a canvas inside a folder', () => {
    const { db, vaultPath, vaultId } = setup()
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Plan', folder: 'Work' })
    expect(canvas.folder).toBe('Work')
    expect(existsSync(path.join(vaultPath, 'canvases', 'Work', 'Plan.excalidraw'))).toBe(true)
  })

  it('moves the file when the folder changes', () => {
    const { db, vaultPath, vaultId } = setup()
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Plan' })
    const result = updateCanvas(db, vaultPath, canvas.id, { folder: 'Work' })

    expect(result.ok).toBe(true)
    expect(existsSync(path.join(vaultPath, 'canvases', 'Plan.excalidraw'))).toBe(false)
    expect(existsSync(path.join(vaultPath, 'canvases', 'Work', 'Plan.excalidraw'))).toBe(true)
  })

  it('keeps the ink when a canvas moves', () => {
    const { db, vaultPath, vaultId } = setup()
    const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a' }] })
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Plan', scene })
    updateCanvas(db, vaultPath, canvas.id, { folder: 'Work' })

    const moved = getCanvas(db, vaultPath, canvas.id)
    expect(moved?.unreadable).toBeFalsy()
    expect(moved?.scene).toContain('"id":"a"')
  })

  it('stores an icon and returns it in the list', () => {
    const { db, vaultPath, vaultId } = setup()
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Plan' })
    updateCanvas(db, vaultPath, canvas.id, { icon: '🎨' })
    expect(listCanvases(db, vaultId)[0].icon).toBe('🎨')
  })
})

describe('duplicateCanvas', () => {
  it('copies the scene into a new canvas in the same folder', () => {
    const { db, vaultPath, vaultId } = setup()
    const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a' }] })
    const original = createCanvas(db, vaultPath, vaultId, {
      title: 'Plan',
      folder: 'Work',
      scene
    })

    const copy = duplicateCanvas(db, vaultPath, vaultId, original.id)

    expect(copy).not.toBeNull()
    expect(copy!.id).not.toBe(original.id)
    expect(copy!.folder).toBe('Work')
    expect(copy!.title).toBe('Plan 2')
    expect(copy!.scene).toContain('"id":"a"')
  })

  it('copies canvas_assets rows so the original save cannot orphan them', () => {
    const { db, vaultPath, vaultId } = setup()
    const original = createCanvas(db, vaultPath, vaultId, { title: 'Plan' })
    db.insert(canvasAssets)
      .values({
        canvasId: original.id,
        fileId: 'f1',
        attachmentId: 'a1',
        contentHash: 'hash1',
        chunkHashes: ['c1'],
        mimeType: 'image/png',
        sizeBytes: 10,
        filename: 'hash1.png'
      })
      .run()

    const copy = duplicateCanvas(db, vaultPath, vaultId, original.id)
    const copiedRows = db
      .select()
      .from(canvasAssets)
      .where(eq(canvasAssets.canvasId, copy!.id))
      .all()

    expect(copiedRows).toHaveLength(1)
    expect(copiedRows[0].contentHash).toBe('hash1')
  })
})

describe('deleteCanvas', () => {
  it('sends the file to the trash instead of unlinking it', async () => {
    const { db, vaultPath, vaultId } = setup()
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Plan' })
    const trashed: string[] = []

    const ok = await deleteCanvas(db, vaultPath, canvas.id, async (abs) => {
      trashed.push(abs)
    })

    expect(ok).toBe(true)
    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toContain('Plan.excalidraw')
    expect(getCanvas(db, vaultPath, canvas.id)).toBeNull()
  })

  it('still tombstones the row when trashing fails', async () => {
    const { db, vaultPath, vaultId } = setup()
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Plan' })

    const ok = await deleteCanvas(db, vaultPath, canvas.id, async () => {
      throw new Error('trash unavailable')
    })

    expect(ok).toBe(true)
    expect(getCanvas(db, vaultPath, canvas.id)).toBeNull()
  })
})
```

Reuse the file's existing `setup()` helper; if it has none, build one that opens an in-memory data DB with the real migration folder and a temp vault dir.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:main -- canvas/store
```

Expected: FAIL — `duplicateCanvas` is not exported, `deleteCanvas` takes three arguments, folder/icon are ignored.

- [ ] **Step 3: Thread folder + icon through create, update and list**

In `toSummary`, add `folder: row.folder ?? null` and `icon: row.icon ?? null`, and widen its `Pick<...>`.

In `CanvasCreateInput` and `CanvasUpdateInput`, add `folder?: string | null` and `icon?: string | null`.

In `createCanvas`, before writing:

```ts
const folder = normalizeFolder(input.folder)
if (folder) ensureCanvasFolderDir(vaultPath, folder)
const filePath = allocateCanvasPath(vaultPath, input.title ?? null, new Set(), null, folder)
```

and add `folder`, `icon: input.icon ?? null` to the insert values and the returned object.

In `updateCanvas`, replace the rename block with one that reacts to a title change, a folder change, or both:

```ts
const nextTitle = input.title !== undefined ? input.title : row.title
const nextFolder =
  input.folder !== undefined ? normalizeFolder(input.folder) : normalizeFolder(row.folder)
if (input.title !== undefined) changes.title = input.title
if (input.icon !== undefined) changes.icon = input.icon
if (input.folder !== undefined) changes.folder = nextFolder

// Keep the file tracking title AND placement. A failed move keeps the old
// path — the index is cosmetic, the ink is not.
let filePath = row.filePath
const titleChanged = input.title !== undefined && input.title !== row.title
const folderChanged = input.folder !== undefined && nextFolder !== normalizeFolder(row.folder)
if (titleChanged || folderChanged) {
  if (nextFolder) ensureCanvasFolderDir(vaultPath, nextFolder)
  const target = allocateCanvasPath(vaultPath, nextTitle, new Set(), row.filePath, nextFolder)
  filePath = renameCanvasFile(vaultPath, row.filePath, target)
  if (filePath !== row.filePath) changes.filePath = filePath
  // The move may have failed; the row must describe where the file IS.
  changes.folder = folderOfCanvasPath(filePath)
}
```

and extend the returned summary to `toSummary({ ...row, title: nextTitle, folder: changes.folder ?? row.folder, icon: changes.icon ?? row.icon, updatedAt: now })`.

Add `folder: canvases.folder` and `icon: canvases.icon` to the select lists in `listCanvases` and `listCanvasesWithCounts`.

- [ ] **Step 4: Implement `duplicateCanvas`**

```ts
/**
 * Copy a canvas into a new one beside it.
 *
 * The `canvas_assets` rows are copied too, and that is not optional: asset GC
 * (`assets/dedup-plan.ts`) decides a contentHash is orphaned when no OTHER
 * canvas references it. A duplicate whose scene shows images but whose rows
 * are missing would make the ORIGINAL's next save dereference those chunks on
 * the server, breaking the copy silently and later.
 */
export function duplicateCanvas(
  db: DataDb,
  vaultPath: string,
  vaultId: string,
  id: string
): Canvas | null {
  const row = db
    .select()
    .from(canvases)
    .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
    .get()
  if (!row) return null

  const scene = readCanvasScene(vaultPath, row.filePath)
  // Refuse to duplicate ink we cannot read: the copy would be an empty canvas
  // wearing the original's name.
  if (scene === null) return null

  const folder = normalizeFolder(row.folder)
  const created = createCanvas(db, vaultPath, vaultId, {
    title: row.title,
    folder,
    icon: row.icon,
    scene
  })

  const assets = db.select().from(canvasAssets).where(eq(canvasAssets.canvasId, id)).all()
  for (const asset of assets) {
    db.insert(canvasAssets)
      .values({ ...asset, canvasId: created.id })
      .onConflictDoNothing()
      .run()
  }

  return created
}
```

`createCanvas`'s `allocateCanvasPath` already turns a second `Plan` into `Plan 2` within the folder; set the new row's `title` from the allocated filename so the sidebar label and the file agree — read it back via `folderOfCanvasPath`/`path.basename` after allocation if the title must match exactly.

- [ ] **Step 5: Make delete trash the file**

```ts
export async function deleteCanvas(
  db: DataDb,
  vaultPath: string,
  id: string,
  trash: (absolutePath: string) => Promise<void>
): Promise<boolean> {
  const filePath = db.transaction((tx) => {
    /* unchanged tombstone body */
  })

  if (filePath === null) return false
  if (filePath) {
    const absolutePath = resolveCanvasFile(vaultPath, filePath)
    try {
      await trash(absolutePath)
    } catch (err) {
      // Trash can be unavailable (network volumes, some Linux setups). The
      // tombstone is the sync truth and must stand either way; fall back to a
      // plain unlink so a deleted canvas does not keep haunting the folder.
      log.warn('Could not trash canvas file; falling back to unlink', {
        code: (err as NodeJS.ErrnoException).code
      })
      deleteCanvasFileSync(absolutePath)
    }
  }
  return true
}
```

Add `import { createLogger } from '../lib/logger'` and a module logger if the file lacks one.

- [ ] **Step 6: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:main -- canvas/store
```

Expected: PASS. Fix any pre-existing `deleteCanvas` call site the signature change broke (`ipc/canvas-handlers.ts`, `sync/item-handlers/canvas-handler.ts`) by passing `(abs) => shell.trashItem(abs)` in main and a plain unlink shim in sync.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/canvas/store.ts apps/desktop/src/main/canvas/store.test.ts
git commit -m "feat(canvas): folder, icon, duplicate and trash-backed delete in the store"
```

---

## Task 7: Folder store

**Files:**

- Create: `apps/desktop/src/main/canvas/folder-store.ts`
- Test: `apps/desktop/src/main/canvas/folder-store.test.ts`

**Interfaces:**

- Produces:
  - `listCanvasFolders(db, vaultId): CanvasFolder[]`
  - `createCanvasFolder(db, vaultPath, vaultId, parent, name): CanvasFolder`
  - `renameCanvasFolder(db, vaultPath, vaultId, path, name): CanvasFolder | null`
  - `moveCanvasFolder(db, vaultPath, vaultId, path, parent): CanvasFolder | null`
  - `setCanvasFolderIcon(db, vaultId, path, icon): CanvasFolder | null`
  - `deleteCanvasFolder(db, vaultPath, vaultId, path, trash): Promise<string[]>` — returns tombstoned canvas ids

- [ ] **Step 1: Write the failing tests**

```ts
describe('canvas folder store', () => {
  it('creates a real directory and a row', () => {
    const { db, vaultPath, vaultId } = setup()
    const folder = createCanvasFolder(db, vaultPath, vaultId, null, 'Work')

    expect(folder.path).toBe('Work')
    expect(folder.id).toBe(canvasFolderSyncId('Work'))
    expect(existsSync(path.join(vaultPath, 'canvases', 'Work'))).toBe(true)
  })

  it('nests under a parent', () => {
    const { db, vaultPath, vaultId } = setup()
    createCanvasFolder(db, vaultPath, vaultId, null, 'Work')
    expect(createCanvasFolder(db, vaultPath, vaultId, 'Work', 'Q3').path).toBe('Work/Q3')
  })

  it('rewrites descendants and child canvases on rename', () => {
    const { db, vaultPath, vaultId } = setup()
    createCanvasFolder(db, vaultPath, vaultId, null, 'Work')
    createCanvasFolder(db, vaultPath, vaultId, 'Work', 'Q3')
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Plan', folder: 'Work/Q3' })

    renameCanvasFolder(db, vaultPath, vaultId, 'Work', 'Job')

    const folders = listCanvasFolders(db, vaultId)
      .map((f) => f.path)
      .sort()
    expect(folders).toEqual(['Job', 'Job/Q3'])
    expect(listCanvases(db, vaultId).find((c) => c.id === canvas.id)?.folder).toBe('Job/Q3')
    expect(existsSync(path.join(vaultPath, 'canvases', 'Job', 'Q3', 'Plan.excalidraw'))).toBe(true)
  })

  it('does not rewrite a folder that merely shares a prefix', () => {
    const { db, vaultPath, vaultId } = setup()
    createCanvasFolder(db, vaultPath, vaultId, null, 'Work')
    createCanvasFolder(db, vaultPath, vaultId, null, 'Workshop')

    renameCanvasFolder(db, vaultPath, vaultId, 'Work', 'Job')

    expect(
      listCanvasFolders(db, vaultId)
        .map((f) => f.path)
        .sort()
    ).toEqual(['Job', 'Workshop'])
  })

  it('refuses to move a folder into its own descendant', () => {
    const { db, vaultPath, vaultId } = setup()
    createCanvasFolder(db, vaultPath, vaultId, null, 'Work')
    createCanvasFolder(db, vaultPath, vaultId, 'Work', 'Q3')

    expect(() => moveCanvasFolder(db, vaultPath, vaultId, 'Work', 'Work/Q3')).toThrow(/descendant/i)
  })

  it('tombstones the folder and every canvas inside on delete', async () => {
    const { db, vaultPath, vaultId } = setup()
    createCanvasFolder(db, vaultPath, vaultId, null, 'Work')
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Plan', folder: 'Work' })

    const deleted = await deleteCanvasFolder(db, vaultPath, vaultId, 'Work', async () => {})

    expect(deleted).toEqual([canvas.id])
    expect(listCanvasFolders(db, vaultId)).toHaveLength(0)
    expect(listCanvases(db, vaultId)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:main -- folder-store
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `apps/desktop/src/main/canvas/folder-store.ts`. Key rules to encode:

- Every mutation writes **both** the directory and the row, directory first, so a crash leaves a folder the next reconcile can adopt rather than a row with no folder.
- `renameCanvasFolder` and `moveCanvasFolder` share one internal `relocateFolder(from, to)` that: refuses when `isDescendantFolder(to, from)`; `fs.renameSync` the directory; rewrites `canvases.folder` and `canvases.file_path` for every row under `from` using `rewriteFolderPrefix`; tombstones each affected folder row and inserts its replacement under the new `canvasFolderSyncId`, carrying the icon over.
- `deleteCanvasFolder` collects the canvas ids under the folder first, tombstones them through the existing soft-delete path, tombstones every folder row at or under the path, then trashes the directory **outside** the transaction — an fs failure must never roll back a tombstone.
- `listCanvasFolders` filters `isNull(canvasFolders.deletedAt)` and orders by `path`.

Every mutation must call the local-mutations enqueue functions added in Task 9; leave `TODO(task-9)` comments at those five points and remove them there.

- [ ] **Step 4: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:main -- folder-store
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/canvas/folder-store.ts apps/desktop/src/main/canvas/folder-store.test.ts
git commit -m "feat(canvas): add the canvas folder store"
```

---

## Task 8: Reconcile adopts folders

**Files:**

- Modify: `apps/desktop/src/main/canvas/reconcile.ts`
- Test: `apps/desktop/src/main/canvas/reconcile.test.ts` (extend)

**Interfaces:**

- Consumes: `folderOfCanvasPath`, `listCanvasFiles` (Task 4); `canvasFolderSyncId` (Task 5)

- [ ] **Step 1: Write the failing tests**

```ts
describe('folder reconciliation', () => {
  it('adopts a canvas found in a subfolder', async () => {
    const { db, vaultPath, vaultId } = setup()
    writeCanvasFileSync(
      resolveCanvasFile(vaultPath, 'canvases/Work/Adopted.excalidraw'),
      JSON.stringify({ type: 'excalidraw', elements: [] })
    )

    await reconcileCanvases(db, vaultPath, vaultId)

    const adopted = listCanvases(db, vaultId).find((c) => c.title === 'Adopted')
    expect(adopted?.folder).toBe('Work')
  })

  it('re-points a canvas the user moved in Finder', async () => {
    const { db, vaultPath, vaultId } = setup()
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Plan' })
    mkdirSync(path.join(vaultPath, 'canvases', 'Work'), { recursive: true })
    renameSync(
      path.join(vaultPath, 'canvases', 'Plan.excalidraw'),
      path.join(vaultPath, 'canvases', 'Work', 'Plan.excalidraw')
    )

    await reconcileCanvases(db, vaultPath, vaultId)

    expect(listCanvases(db, vaultId).find((c) => c.id === canvas.id)?.folder).toBe('Work')
  })

  it('creates folder rows for directories that arrived with the vault', async () => {
    const { db, vaultPath, vaultId } = setup()
    mkdirSync(path.join(vaultPath, 'canvases', 'Work', 'Q3'), { recursive: true })

    await reconcileCanvases(db, vaultPath, vaultId)

    expect(
      listCanvasFolders(db, vaultId)
        .map((f) => f.path)
        .sort()
    ).toEqual(['Work', 'Work/Q3'])
  })

  it('never tombstones a row whose file is missing', async () => {
    const { db, vaultPath, vaultId } = setup()
    const canvas = createCanvas(db, vaultPath, vaultId, { title: 'Gone' })
    unlinkSync(path.join(vaultPath, 'canvases', 'Gone.excalidraw'))

    await reconcileCanvases(db, vaultPath, vaultId)

    expect(getCanvas(db, vaultPath, canvas.id)?.unreadable).toBe(true)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:main -- canvas/reconcile
```

Expected: FAIL on the three folder cases; the last one should already pass and is here as a regression guard.

- [ ] **Step 3: Implement**

In `reconcile.ts`:

- When adopting a file, set `folder: folderOfCanvasPath(relativePath)` on the inserted row.
- When re-pointing an existing row to a moved file, also update `folder` from the new path.
- After the file pass, walk the canvas directory tree and upsert a `canvas_folders` row for every directory that has no live row, using `canvasFolderSyncId(path)`. Skip dot-directories, same as `listCanvasFiles`.
- Leave the "never tombstone a row whose file is missing" rule exactly as it is.

- [ ] **Step 4: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:main -- canvas/reconcile
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/canvas/reconcile.ts apps/desktop/src/main/canvas/reconcile.test.ts
git commit -m "feat(canvas): adopt folders during vault reconcile"
```

---

## Task 9: Sync wiring

**Files:**

- Modify: `apps/desktop/src/main/sync/item-handlers/canvas-handler.ts`
- Create: `apps/desktop/src/main/sync/item-handlers/canvas-folder-handler.ts` (+ test)
- Modify: `apps/desktop/src/main/sync/item-handlers/index.ts`
- Create: `apps/desktop/src/main/sync/canvas-folder-sync.ts`
- Modify: `apps/desktop/src/main/sync/offline-clock.ts`, `local-mutations.ts`, `runtime.ts`, `manifest-check.ts`

**Interfaces:**

- Produces: `canvasFolderHandler`, `initCanvasFolderSyncService`, `getCanvasFolderSyncService`, `resetCanvasFolderSyncService`, `incrementCanvasFolderClockOffline`

- [ ] **Step 1: Carry folder and icon through the canvas handler**

In `canvas-handler.ts`'s apply path, replace the bare allocation:

```ts
const filePath = allocateCanvasPath(vaultPath, data.title ?? null)
```

with a folder-aware one that creates the directory first:

```ts
const folder = normalizeFolder(data.folder)
if (folder) ensureCanvasFolderDir(vaultPath, folder)
const filePath = allocateCanvasPath(vaultPath, data.title ?? null, new Set(), null, folder)
```

Add `folder` and `icon: data.icon ?? null` to the insert values and to the update `set(...)`. Add both to `buildPushPayload`'s serialized row.

- [ ] **Step 2: Write the failing handler test**

Create `apps/desktop/src/main/sync/item-handlers/canvas-folder-handler.test.ts`, modelled on `task-handler.test.ts`, covering the seven required cases: insert, newer-clock update, older-clock skip, concurrent → `'conflict'`, delete, delete-skip when local has unseen changes, and `seedUnclocked` enqueues one item per unclocked row.

- [ ] **Step 3: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:main -- canvas-folder-handler
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the handler**

Copy `filter-handler.ts` verbatim into `canvas-folder-handler.ts` and change: `savedFilters` → `canvasFolders`; `'filter'` → `'canvas_folder'`; `SavedFiltersChannels` → `CanvasFolderChannels`; the mutable fields to `path` and `icon`; `FilterSyncPayload` → `CanvasFolderSyncPayload`.

Two deliberate deviations from the template:

- **Timestamps are `Date.now()`, not `utcNow()`** — `canvas_folders` uses INTEGER epoch ms to match `canvases`.
- **`applyDelete` soft-deletes.** `filter` hard-deletes; canvas rows must stay visible to sync, so set `deletedAt`/`updatedAt` instead of `tx.delete(...)`, and have `fetchLocal`/`seedUnclocked` filter `isNull(canvasFolders.deletedAt)`.

- [ ] **Step 5: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:main -- canvas-folder-handler
```

Expected: PASS, all seven.

- [ ] **Step 6: Wire the remaining six files**

- `item-handlers/index.ts` — add `['canvas_folder', canvasFolderHandler]` to the Map.
- `canvas-folder-sync.ts` — copy `filter-sync.ts`, substituting table, type string, and names.
- `offline-clock.ts` — add `incrementCanvasFolderClockOffline`, copying `incrementFilterClockOffline` exactly.
- `local-mutations.ts` — add the `{ type: 'canvas_folder', kind: 'record', local: {...} }` block, copying the `filter` block at ~line 147.
- `runtime.ts` — `resetCanvasFolderSyncService()` in teardown, `initCanvasFolderSyncService({ queue, db: runtimeSyncDb, getDeviceId })` in setup, and an entry in `createSyncAdapterRegistry([...])`.
- `manifest-check.ts` — beside the `savedFilters` block:

```ts
const syncedCanvasFolders = db
  .select()
  .from(canvasFolders)
  .where(isNotNull(canvasFolders.clock))
  .all()
for (const f of syncedCanvasFolders) {
  addLocalItem({ id: f.id, type: 'canvas_folder', payload: JSON.stringify(f) })
}
```

- [ ] **Step 7: Call the enqueue functions from the folder store**

Return to `folder-store.ts` and replace every `TODO(task-9)` with the matching call from the local-mutations registry (`enqueueCreate` on create, `enqueueUpdate` on rename/move/set-icon, `enqueueDelete` with a snapshot payload on delete).

**This step is the one that makes folders actually sync.** The registry entry alone seeds once and then goes quiet forever.

- [ ] **Step 8: Verify the whole sync surface**

```bash
pnpm typecheck
pnpm test:desktop
pnpm test:sync-server
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/sync apps/desktop/src/main/canvas/folder-store.ts
git commit -m "feat(sync): sync canvas folders and canvas placement"
```

---

## Task 10: IPC handlers

**Files:**

- Modify: `apps/desktop/src/main/ipc/canvas-handlers.ts`
- Create: `apps/desktop/src/main/ipc/canvas-folder-handlers.ts`
- Modify: the preload API surface and `apps/desktop/src/main/ipc/index.ts` registration
- Test: `apps/desktop/src/main/ipc/canvas-folder-handlers.test.ts`

**Interfaces:**

- Consumes: Tasks 6, 7
- Produces: `window.api.canvas.duplicate/revealInFinder/openExternal`, `window.api.canvasFolder.*`

- [ ] **Step 1: Add the three canvas handlers**

In `registerCanvasHandlers()`:

```ts
// canvas:duplicate - Copy a canvas (scene + asset rows) beside the original
ipcMain.handle(
  CanvasChannels.invoke.DUPLICATE,
  createStringHandler(async (id) => {
    const { db, vaultId, vaultPath } = getCanvasContext()
    const copy = duplicateCanvas(db, vaultPath, vaultId, id)
    if (!copy) return null
    const { scene, ...summary } = copy
    syncCanvasCreate(copy.id, scene)
    emitCanvasEvent(CanvasChannels.events.CREATED, { canvas: summary })
    return summary
  })
)

// canvas:reveal-in-finder
ipcMain.handle(
  CanvasChannels.invoke.REVEAL_IN_FINDER,
  createStringHandler(async (id) => {
    const { db, vaultPath } = getCanvasContext()
    const filePath = getCanvasFilePath(db, id)
    if (!filePath) return
    shell.showItemInFolder(resolveCanvasFile(vaultPath, filePath))
  })
)

// canvas:open-external
ipcMain.handle(
  CanvasChannels.invoke.OPEN_EXTERNAL,
  createStringHandler(async (id) => {
    const { db, vaultPath } = getCanvasContext()
    const filePath = getCanvasFilePath(db, id)
    if (!filePath) return
    await shell.openPath(resolveCanvasFile(vaultPath, filePath))
  })
)
```

Add a small `getCanvasFilePath(db, id): string | null` export to `store.ts`. Import `shell` from `electron`.

- [ ] **Step 2: Switch delete over to the trash**

`deleteCanvas` now takes a trash callback. At the `canvas:delete` handler, pass:

```ts
await deleteCanvas(db, vaultPath, id, (abs) => shell.trashItem(abs))
```

- [ ] **Step 3: Add the folder handlers**

Create `canvas-folder-handlers.ts` with `registerCanvasFolderHandlers()` covering the six invoke channels, each using `createValidatedHandler` with the Task 5 schemas, and each emitting the matching `CanvasFolderChannels.events.*` to all windows through the same fan-out helper `canvas-handlers.ts` uses. Register it wherever `registerCanvasHandlers()` is called.

- [ ] **Step 4: Regenerate and check the IPC map**

```bash
pnpm ipc:generate
pnpm ipc:check
```

Expected: the generated invoke map gains all nine channels and `ipc:check` passes. If it reports the map is out of date, re-run `ipc:generate` and commit the result.

- [ ] **Step 5: Test the handlers**

Write `canvas-folder-handlers.test.ts` asserting each channel validates its input and calls the store. Then:

```bash
pnpm --filter @memry/desktop test:main -- canvas-folder-handlers
pnpm check:architecture && pnpm check:contracts
```

Expected: PASS. `check:architecture` matters here — IPC files must not import queries directly, which is why the stores live under `main/canvas/`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/ipc apps/desktop/src/preload packages/rpc
git commit -m "feat(canvas): add duplicate, reveal, open-external and folder IPC"
```

---

## Task 11: Tree model (pure renderer logic)

**Files:**

- Create: `apps/desktop/src/renderer/src/components/sidebar/canvas-tree/canvas-tree-model.ts`
- Test: `.../canvas-tree-model.test.ts`

**Interfaces:**

- Produces:
  - `type CanvasTreeNode = { kind: 'folder'; path: string; name: string; icon: string | null; depth: number; children: CanvasTreeNode[] } | { kind: 'canvas'; canvas: CanvasSummary; depth: number }`
  - `buildCanvasTree(canvases: CanvasSummary[], folders: CanvasFolder[]): CanvasTreeNode[]`
  - `flattenVisible(nodes: CanvasTreeNode[], expanded: ReadonlySet<string>): CanvasTreeNode[]`
  - `type CanvasDragPayload = { tree: 'canvas'; kind: 'canvas'; id: string } | { tree: 'canvas'; kind: 'folder'; path: string }`
  - `canDrop(payload: unknown, targetFolder: string | null): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
describe('buildCanvasTree', () => {
  it('puts folders before canvases and sorts each alphabetically', () => {
    const tree = buildCanvasTree(
      [canvas('b', 'Beta'), canvas('a', 'Alpha')],
      [folder('Zoo'), folder('Ark')]
    )
    expect(tree.map(label)).toEqual(['Ark', 'Zoo', 'Alpha', 'Beta'])
  })

  it('nests canvases under their folder', () => {
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work')], [folder('Work')])
    expect(tree).toHaveLength(1)
    expect(tree[0].kind).toBe('folder')
    expect(label(tree[0].children[0])).toBe('Plan')
  })

  it('materializes a missing intermediate folder', () => {
    // A canvas can arrive from sync before its folder row does.
    const tree = buildCanvasTree([canvas('a', 'Plan', 'Work/Q3')], [])
    expect(label(tree[0])).toBe('Work')
    expect(label(tree[0].children[0])).toBe('Q3')
  })

  it('sorts case-insensitively', () => {
    const tree = buildCanvasTree([canvas('a', 'zebra'), canvas('b', 'Apple')], [])
    expect(tree.map(label)).toEqual(['Apple', 'zebra'])
  })
})

describe('canDrop', () => {
  const canvasDrag = { tree: 'canvas', kind: 'canvas', id: 'c1' } as const
  const folderDrag = { tree: 'canvas', kind: 'folder', path: 'Work' } as const

  it('accepts a canvas onto a folder or the root', () => {
    expect(canDrop(canvasDrag, 'Work')).toBe(true)
    expect(canDrop(canvasDrag, null)).toBe(true)
  })

  it('rejects a folder dropped into its own descendant', () => {
    expect(canDrop(folderDrag, 'Work/Q3')).toBe(false)
    expect(canDrop(folderDrag, 'Work')).toBe(false)
  })

  it('accepts a folder moved elsewhere', () => {
    expect(canDrop(folderDrag, 'Personal')).toBe(true)
    expect(canDrop(folderDrag, null)).toBe(true)
  })

  it('rejects payloads from another tree', () => {
    expect(canDrop({ tree: 'notes', kind: 'note', id: 'n1' }, 'Work')).toBe(false)
    expect(canDrop(undefined, 'Work')).toBe(false)
    expect(canDrop('garbage', 'Work')).toBe(false)
  })
})
```

Define the `canvas()`, `folder()` and `label()` helpers at the top of the test file.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:renderer -- canvas-tree-model
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Port `normalizeFolder`, `folderSegments` and `isDescendantFolder` semantics for the renderer (a small local copy — the renderer cannot import from `main/`). Build the tree by walking each canvas's folder segments and creating missing nodes on the way, then sort each level with `folders first`, then `localeCompare` with `{ sensitivity: 'base' }`.

`canDrop` guards in this order: payload is an object → `payload.tree === 'canvas'` → for folders, `!isDescendantFolder(target, payload.path)`.

- [ ] **Step 4: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:renderer -- canvas-tree-model
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/sidebar/canvas-tree/canvas-tree-model.ts apps/desktop/src/renderer/src/components/sidebar/canvas-tree/canvas-tree-model.test.ts
git commit -m "feat(canvas): add the sidebar canvas tree model"
```

---

## Task 12: Tree UI and context menus

**Files:**

- Create: `.../canvas-tree/use-canvas-tree.ts`, `canvas-row.tsx`, `canvas-folder-row.tsx`, `canvas-tree.tsx`
- Create: `apps/desktop/src/renderer/src/services/canvas-folder-service.ts`
- Test: `.../canvas-tree/canvas-tree.test.tsx`

**Interfaces:**

- Consumes: Task 11 model, Task 10 IPC
- Produces: `<CanvasTree onCanvasClick={...} onCountChange={...} />`

- [ ] **Step 1: Write the failing tests**

```tsx
describe('CanvasTree', () => {
  it('renders folders before canvases', async () => {
    /* assert row order */
  })

  it('renames a canvas through the context menu', async () => {
    /* right-click a row, click Rename, type, submit, expect canvasService.update
       called with { id, title } */
  })

  it('deletes only after the confirmation is accepted', async () => {
    /* right-click, Delete, expect no service call until confirm is clicked */
  })

  it('moves a canvas via the Move to folder submenu', async () => {
    /* expect canvasService.update called with { id, folder: 'Work' } */
  })

  it('shows an unreadable canvas as degraded with a restricted menu', async () => {
    /* expect the warning affordance, and only Reveal in Finder + Delete in the menu */
  })

  it('bookmarks a canvas', async () => {
    /* expect the BookmarkMenuItem rendered with itemType="canvas" */
  })
})
```

Mock `canvasService` and `canvasFolderService` with `vi.mock`. Follow the mocking style already used by `sidebar-tag-list.test.tsx`.

> Mocked IPC gives false confidence on its own — Task 15's E2E is what proves the wiring. Keep both.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:renderer -- canvas-tree
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Add the renderer service**

Create `services/canvas-folder-service.ts` mirroring `canvas-service.ts` exactly: a `createWindowApiForwarder(() => window.api.canvasFolder)` plus `onCanvasFolderCreated/Updated/Deleted` subscription wrappers returning unsubscribe closures.

- [ ] **Step 4: Implement `use-canvas-tree.ts`**

Loads `canvasService.list()` and `canvasFolderService.list()` in parallel, exposes `{ canvases, folders, isLoading, hasError, refresh }`, and subscribes to all six events (three canvas, three folder), each triggering `refresh`. Same shape as the current `SidebarCanvasList` effect, so the existing loading / error / empty states carry over.

- [ ] **Step 5: Implement the rows**

`canvas-row.tsx` — `ContextMenu` wrapping a `SidebarMenuButton`, with:

Rename · Duplicate — separator — Set icon / Remove icon (only when `icon` is set) — separator — Move to folder ▸ — separator — Open in external editor · Reveal in Finder — separator — `<BookmarkMenuItem itemType="canvas" itemId={canvas.id} />` — separator — Delete (`className="text-destructive focus:text-destructive"`).

Use `IconPickerButton` for the leading glyph, exactly as `NoteRow` does. When `canvas.unreadable`, render the degraded state and show only Reveal in Finder and Delete.

`canvas-folder-row.tsx` — New canvas here · New folder — separator — Set icon / Remove icon — separator — Rename — separator — Delete.

**Move to folder ▸** lists "Root" first, then every folder as an indented path label, with the canvas's current folder disabled. This is the keyboard path for organizing canvases; drag & drop has none.

- [ ] **Step 6: Implement `canvas-tree.tsx`**

Renders `flattenVisible(...)`, owns expansion state persisted per folder path in `localStorage`, and wraps the rows in a scroll container:

```tsx
<div className="max-h-[40vh] overflow-y-auto">
```

Indent with `paddingInlineStart` (a logical property) computed from `depth`, never `paddingLeft`.

- [ ] **Step 7: Add the i18n strings**

Add every new label under the existing `canvas.*` namespace in the English locale — `canvas.actions.rename`, `.duplicate`, `.setIcon`, `.removeIcon`, `.moveToFolder`, `.moveToRoot`, `.openExternal`, `.revealInFinder`, `.newCanvasHere`, `.newFolder`, `.deleteConfirmTitle`, `.deleteConfirmBody`, `.deleteFolderConfirmBody`, `.unreadable`.

```bash
pnpm --filter @memry/desktop i18n:check
```

Expected: PASS.

- [ ] **Step 8: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:renderer -- canvas-tree
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/components/sidebar/canvas-tree apps/desktop/src/renderer/src/services/canvas-folder-service.ts packages/i18n
git commit -m "feat(canvas): add the sidebar canvas tree with full context menus"
```

---

## Task 13: Drag and drop

**Files:**

- Modify: `.../canvas-tree/canvas-tree.tsx`, `canvas-row.tsx`, `canvas-folder-row.tsx`
- Test: `.../canvas-tree/canvas-tree-dnd.test.tsx`

**Interfaces:**

- Consumes: `canDrop`, `CanvasDragPayload` (Task 11)

- [ ] **Step 1: Write the failing tests**

```tsx
describe('canvas tree drag and drop', () => {
  it('moves a canvas into a folder on drop', async () => {
    /* dragStart on a canvas row, drop on a folder row,
       expect canvasService.update called with { id, folder: 'Work' } */
  })

  it('moves a canvas back to the root', async () => {
    /* drop on the root drop zone, expect update with { folder: null } */
  })

  it('moves a folder under another folder', async () => {
    /* expect canvasFolderService.move called with { path, parent } */
  })

  it('rejects dropping a folder into its own descendant', async () => {
    /* expect no service call and no drop indicator */
  })

  it('ignores a drag payload from the notes tree', async () => {
    /* dataTransfer carrying { tree: 'notes', ... } → no service call */
  })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:renderer -- canvas-tree-dnd
```

Expected: FAIL — no drag handlers yet.

- [ ] **Step 3: Implement**

Native HTML5 DnD, matching `virtualized-notes-tree.tsx` rather than dnd-kit:

- `onDragStart` writes `JSON.stringify(payload)` to `dataTransfer` under a `application/x-memry-canvas` type, with the `tree: 'canvas'` tag.
- `onDragOver` parses the payload, runs `canDrop`, and calls `preventDefault()` only when it returns true — that is what makes the drop legal and shows the correct cursor.
- Drop indicator: reuse the notes tree's "inside" style so the two trees feel identical:

```tsx
<div
  className="absolute inset-0 rounded-md border-2 border-primary border-dashed bg-primary/10"
  aria-hidden="true"
/>
```

- `onDrop` calls `canvasService.update({ id, folder })` or `canvasFolderService.move({ path, parent })`, then lets the event subscriptions refresh the tree.
- A root drop zone sits under the last row so a canvas can be dragged out of a folder.

- [ ] **Step 4: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:renderer -- canvas-tree-dnd
```

Expected: PASS.

- [ ] **Step 5: Verify by hand**

```bash
pnpm dev
```

Drag a canvas into a folder, out to the root, and a folder into another folder. Try dragging a folder onto its own child — the drop must be refused with no indicator. Try dragging a note from the notes tree onto the canvas tree — nothing should happen.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/sidebar/canvas-tree
git commit -m "feat(canvas): drag and drop canvases and folders in the sidebar"
```

---

## Task 14: Replace the flat list

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx`
- Delete: `components/sidebar/sidebar-canvas-list.tsx`, `sidebar-canvas-list.test.tsx`
- Modify: `components/sidebar/index.ts`

**Interfaces:**

- Consumes: Tasks 11–13

- [ ] **Step 1: Swap the component in**

In `app-sidebar.tsx`, replace `<SidebarCanvasList onCanvasClick={handleCanvasOpen} />` with `<CanvasTree onCanvasClick={handleCanvasOpen} onCountChange={setCanvasCount} />`, and pass `totalCount={canvasCount}` to the enclosing `SidebarSection` so the collapsed header shows `(n)`.

- [ ] **Step 2: Target the selected folder when creating**

`handleCreateCanvas` currently calls `canvasService.create({})`. Thread the tree's selected folder through so a new canvas lands where the user is looking, mirroring how the notes tree's "New note" uses `onTargetFolderChange`.

- [ ] **Step 3: Delete the old list**

```bash
git rm apps/desktop/src/renderer/src/components/sidebar/sidebar-canvas-list.tsx apps/desktop/src/renderer/src/components/sidebar/sidebar-canvas-list.test.tsx
```

Remove its export from `components/sidebar/index.ts` and any remaining import.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @memry/desktop test:renderer -- app-sidebar
pnpm typecheck
```

Expected: PASS with no dangling imports.

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop/src/renderer/src/components
git commit -m "feat(canvas): replace the flat sidebar list with the folder tree"
```

---

## Task 15: MCP folder-qualified resolution

Folders make duplicate canvas titles legal for the first time. Today's resolver picks one arbitrarily — an agent silently drawing on the wrong canvas is the worst outcome in this change.

**Files:**

- Modify: `apps/desktop/src/main/agent/mcp/tools/canvas-handles.ts`
- Modify: `apps/desktop/src/main/agent/mcp/tools/canvas-write.ts` (only if it resolves names itself)
- Test: `.../canvas-handles.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

```ts
describe('canvas name resolution with folders', () => {
  it('resolves a folder-qualified name', () => {
    /* two canvases titled Plan in Work/ and Personal/;
       resolving 'Work/Plan' returns the Work one */
  })

  it('refuses an ambiguous bare name and lists the candidates', () => {
    /* resolving 'Plan' returns an error naming 'Work/Plan' and 'Personal/Plan' */
  })

  it('still resolves an unambiguous bare name', () => {
    /* one canvas titled Plan in Work/; resolving 'Plan' returns it */
  })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @memry/desktop test:main -- canvas-handles
```

Expected: FAIL — ambiguity currently resolves silently to whichever row comes first.

- [ ] **Step 3: Implement**

Match on the qualified path (`folder ? \`${folder}/${title}\` : title`) first. If no qualified match, fall back to matching on title alone. If that yields more than one, return a structured error listing every qualified candidate rather than guessing.

- [ ] **Step 4: Run and confirm passing**

```bash
pnpm --filter @memry/desktop test:main -- canvas-handles
pnpm --filter @memry/desktop test:main -- canvas-write
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/agent/mcp/tools
git commit -m "fix(mcp): resolve canvases by folder-qualified name"
```

---

## Task 16: E2E, docs and full verification

**Files:**

- Create: `apps/desktop/tests/e2e/canvas-management.spec.ts`
- Modify: `apps/docs/src/**` as `docs:impact` directs

- [ ] **Step 1: Write the E2E spec**

Cover one full journey: create a folder → create a canvas inside it → rename it → duplicate it → drag it to the root → delete it with confirmation → reload and assert the tree matches.

Watch for the two known E2E traps: the onboarding tour blocks the suite unless dismissed, and a stale build makes the run test old code.

- [ ] **Step 2: Run the E2E suite**

```bash
pnpm test:e2e
```

Expected: PASS. If a native module fails to load, run `pnpm --filter @memry/desktop rebuild:electron` — the Node rebuild does not fix Electron runtime.

- [ ] **Step 3: Two-profile sync check by hand**

```bash
pnpm --filter @memry/desktop dev:a
```

```bash
pnpm --filter @memry/desktop dev:b
```

On A: create folder `Work`, put a canvas in it, set a folder icon. On B: confirm the folder, the canvas placement, and the icon all arrive. Create an **empty** folder on A and confirm it reaches B — that is the one thing `canvas_folders` exists for. Move the canvas on A and confirm B follows. Rename the same folder on both while B is offline, reconnect, and confirm no sync loop and no lost canvases.

- [ ] **Step 4: Full verification sweep**

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm check:architecture && pnpm check:contracts && pnpm ipc:check
```

```bash
pnpm --filter @memry/desktop i18n:check
```

```bash
git diff --check
```

Expected: all clean. Verify lint with `--no-cache` if it passes suspiciously fast — the ESLint cache has masked warnings before.

- [ ] **Step 5: Docs gate**

```bash
pnpm docs:impact --base origin/main --strict
```

If it reports `missing-docs`, update `apps/docs/src/**` (canvas folder management belongs with the existing canvas docs) or run `pnpm docs:ai-update --base origin/main`, then re-run the impact check and:

```bash
pnpm docs:build
```

- [ ] **Step 6: Rename the branch and open a draft PR**

```bash
git branch -m canvas-folder-management
```

The PR description must record: the contrast ratios measured in Task 2 (before and after, all three themes), and — prominently — **the sync-server must be deployed before the desktop release**, because `resolveSyncTypes` derives its supported set from `RECORD_SYNC_ITEM_TYPES` and an old server silently drops `canvas_folder`.

Draft is the default unless Kaan asks for ready-for-review. No agent or tool branding anywhere in the description.

- [ ] **Step 7: Commit any remaining docs**

```bash
git add apps/docs apps/desktop/tests/e2e/canvas-management.spec.ts
git commit -m "test(canvas): cover canvas folder management end to end"
```

---

## Self-Review Notes

**Spec coverage.** §3 data model → Task 5. §4 disk → Tasks 3, 4, 8. §5 sync → Tasks 5, 9; §5.3 deploy ordering → Global Constraints + Task 16 Step 6. §6 IPC → Tasks 5, 10. §7 renderer → Tasks 11–14. §8 delete → Task 6 Step 5, Task 10 Step 2. §9.1 → Task 1. §9.2 → Task 12 Step 5. §9.3 → Task 6 Step 4. §9.4 → Task 15. §9.5 → Tasks 5, 12. §9.6 → Task 14 Step 1. §9.7 → Task 7. §10 compat → Task 5 Steps 10–11. §11 testing → distributed. §12 contrast → Task 2.

**Type consistency.** `folder: string | null` everywhere (never `undefined` in stored shapes — Drizzle needs `null` in `.values()`). `CanvasFolder.path` is `string`, never null, because root is not a row. `deleteCanvas` is async from Task 6 onward; every call site is updated in the same task.

**Open item carried from the spec.** Task 2 Step 2's colour values are starting points, not answers; the acceptance bar is the measured ≥4.5:1, and the plan requires recording the numbers.
