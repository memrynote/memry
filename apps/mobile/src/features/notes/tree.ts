import type { SidebarSortMode } from '@memry/contracts/sidebar-sort'

/**
 * The notes tree the mobile list renders. Folders are derived from each note's
 * `folderPath`, with the sort and filter rules laid over them.
 *
 * Nothing here touches SQLite, React or a logger. The screen reads the rows and
 * owns the state; this module is a function of what it already has, so the tree
 * can be rebuilt on a keystroke and pinned by tests without a device.
 */

export type NoteFileType = 'markdown' | 'pdf' | 'image' | 'audio' | 'video'

export interface NoteEntry {
  id: string
  title: string
  /** `''` means the vault root. */
  folderPath: string
  fileType: NoteFileType
  /** `sync_items.updated_at`. */
  updatedAt: number
  /** Parsed `payload.createdAt`, falling back to `updatedAt`. */
  createdAt: number
  hasBody: boolean
}

export interface FolderNode {
  /** `''` for the synthetic root. */
  path: string
  name: string
  /** The folder-config emoji or icon, `null` when there is none. */
  icon: string | null
  folders: FolderNode[]
  notes: NoteEntry[]
  /** RECURSIVE: own notes plus every descendant's. */
  noteCount: number
}

export type NoteTreeRow =
  | { kind: 'folder'; key: string; node: FolderNode; level: number; expanded: boolean }
  | { kind: 'note'; key: string; note: NoteEntry; level: number }

// --- sorting ---------------------------------------------------------------

/**
 * The sort modes this surface offers, a subset of the desktop sidebar's.
 *
 * `manual` is deliberately absent. It means "use the stored per-item order",
 * and `NoteSyncPayloadSchema` has no `position` field — unlike the task and
 * project payloads next to it — so no per-item order ever reaches the device.
 * Offering it would be a mode that changes nothing, which is the same argument
 * the contract itself makes for `canvases`.
 *
 * `as const satisfies`, NOT `: readonly SidebarSortMode[]`. The annotation
 * widens each element to the whole union, and `Record<MobileSortMode, string>`
 * would then demand `manual` / `count-desc` / `count-asc` entries for modes
 * this surface does not offer. `satisfies` keeps the six literals while still
 * failing to compile if the contract renames or drops one of them.
 */
export const MOBILE_SORT_MODES = [
  'name-asc',
  'name-desc',
  'modified-desc',
  'modified-asc',
  'created-desc',
  'created-asc'
] as const satisfies readonly SidebarSortMode[]

export type MobileSortMode = (typeof MOBILE_SORT_MODES)[number]

/**
 * The notes screen already reads `ORDER BY s.updated_at DESC`, and folders stay
 * A→Z under every mode, so this default reproduces the existing list exactly:
 * shipping sort modes moves nobody's tree.
 */
export const MOBILE_SORT_DEFAULT: MobileSortMode = 'modified-desc'

export const MOBILE_SORT_LABELS: Record<MobileSortMode, string> = {
  'name-asc': 'Name A → Z',
  'name-desc': 'Name Z → A',
  'modified-desc': 'Modified: newest first',
  'modified-asc': 'Modified: oldest first',
  'created-desc': 'Created: newest first',
  'created-asc': 'Created: oldest first'
}

export function isMobileSortMode(value: unknown): value is MobileSortMode {
  return typeof value === 'string' && MOBILE_SORT_MODES.some((mode) => mode === value)
}

export const NOTE_FILE_TYPE_TONE: Record<
  NoteFileType,
  'destructive' | 'blue' | 'green' | 'purple' | 'tertiary'
> = {
  markdown: 'tertiary',
  pdf: 'destructive',
  image: 'blue',
  audio: 'green',
  video: 'purple'
}

/**
 * Case-insensitive, and deliberately not `localeCompare`.
 *
 * This module runs on Hermes on device and on Node with full ICU under test,
 * and the two disagree on collation — a locale-sensitive comparator is simply
 * not the same function in the two places, so a test could pin an order the
 * phone never produces. Raw `<` / `>` on the lowercased strings is identical
 * everywhere; the raw strings break a case-only tie so the order stays total.
 */
function compareText(a: string, b: string): number {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  if (a !== b) return a < b ? -1 : 1
  return 0
}

/**
 * Every comparator ends here, including the descending ones: two notes with
 * identical timestamps must not swap places between renders. Determinism is the
 * goal, not symmetry.
 */
function byId(a: NoteEntry, b: NoteEntry): number {
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

const NOTE_COMPARATORS: Record<MobileSortMode, (a: NoteEntry, b: NoteEntry) => number> = {
  'name-asc': (a, b) => compareText(a.title, b.title) || byId(a, b),
  'name-desc': (a, b) => -compareText(a.title, b.title) || byId(a, b),
  'modified-desc': (a, b) => b.updatedAt - a.updatedAt || byId(a, b),
  'modified-asc': (a, b) => a.updatedAt - b.updatedAt || byId(a, b),
  'created-desc': (a, b) => b.createdAt - a.createdAt || byId(a, b),
  'created-asc': (a, b) => a.createdAt - b.createdAt || byId(a, b)
}

// --- tree ------------------------------------------------------------------

function segmentsOf(folderPath: string): string[] {
  return folderPath.split('/').filter((segment) => segment.length > 0)
}

function makeFolder(path: string, name: string, icons: ReadonlyMap<string, string>): FolderNode {
  return { path, name, icon: icons.get(path) ?? null, folders: [], notes: [], noteCount: 0 }
}

function sortFolders(node: FolderNode): void {
  node.folders.sort((a, b) => compareText(a.name, b.name))
  for (const child of node.folders) sortFolders(child)
}

/**
 * Build the tree from a flat list of notes.
 *
 * Folders are sorted A→Z here, once, and the sort mode never touches them
 * again. That is the desktop contract: folders carry no timestamp anywhere in
 * the tree payload, so they stay A→Z under every time mode, in that direction
 * regardless of the mode's own direction.
 */
export function buildFolderTree(
  entries: NoteEntry[],
  icons: ReadonlyMap<string, string>
): FolderNode {
  const root = makeFolder('', '', icons)
  const index = new Map<string, FolderNode>([['', root]])

  for (const entry of entries) {
    let node = root
    // `noteCount` is recursive, so every node on the way down takes the note,
    // not just the one that ends up holding it.
    node.noteCount += 1
    let path = ''
    for (const segment of segmentsOf(entry.folderPath)) {
      path = path === '' ? segment : `${path}/${segment}`
      let child = index.get(path)
      if (!child) {
        child = makeFolder(path, segment, icons)
        index.set(path, child)
        node.folders.push(child)
      }
      node = child
      node.noteCount += 1
    }
    node.notes.push(entry)
  }

  sortFolders(root)
  return root
}

export function findFolder(root: FolderNode, path: string): FolderNode | null {
  let node = root
  for (const segment of segmentsOf(path)) {
    const child = node.folders.find((candidate) => candidate.name === segment)
    if (!child) return null
    node = child
  }
  return node
}

// --- flattening ------------------------------------------------------------

interface FlattenContext {
  expanded: ReadonlySet<string>
  compare: (a: NoteEntry, b: NoteEntry) => number
  /** Already trimmed and lowercased; `''` means no filter. */
  query: string
}

function visibleNotes(node: FolderNode, ctx: FlattenContext): NoteEntry[] {
  const kept =
    ctx.query === ''
      ? // A copy, because `node.notes` is the tree's own array and the tree
        // outlives the render. Sorting it in place would reorder shared state.
        [...node.notes]
      : node.notes.filter((note) => note.title.toLowerCase().includes(ctx.query))
  return kept.sort(ctx.compare)
}

function noteRow(note: NoteEntry, level: number): NoteTreeRow {
  return { kind: 'note', key: `n:${note.id}`, note, level }
}

function emitFolder(node: FolderNode, level: number, ctx: FlattenContext): NoteTreeRow[] {
  const expanded = ctx.query !== '' || ctx.expanded.has(node.path)
  const children: NoteTreeRow[] = []
  if (expanded) {
    for (const child of node.folders) {
      for (const row of emitFolder(child, level + 1, ctx)) children.push(row)
    }
    for (const note of visibleNotes(node, ctx)) children.push(noteRow(note, level + 1))
  }
  // Under a query an empty subtree means nothing below here matched, so the
  // folder goes too. Without one, an empty folder is just a folder.
  if (ctx.query !== '' && children.length === 0) return []
  // The tree's OWN node, never a rebuilt one: `noteCount` stays the unfiltered
  // recursive total under a query, and the renderer keeps its identity across
  // keystrokes.
  return [{ kind: 'folder', key: `f:${node.path}`, node, level, expanded }, ...children]
}

export function flattenFolderTree(
  root: FolderNode,
  opts: { expanded: ReadonlySet<string>; sort: MobileSortMode; query: string }
): NoteTreeRow[] {
  const ctx: FlattenContext = {
    expanded: opts.expanded,
    compare: NOTE_COMPARATORS[opts.sort],
    query: opts.query.trim().toLowerCase()
  }

  const rows: NoteTreeRow[] = []
  for (const folder of root.folders) {
    for (const row of emitFolder(folder, 0, ctx)) rows.push(row)
  }
  // The synthetic root emits no row of its own, and its loose notes come after
  // every folder.
  for (const note of visibleNotes(root, ctx)) rows.push(noteRow(note, 0))
  return rows
}
