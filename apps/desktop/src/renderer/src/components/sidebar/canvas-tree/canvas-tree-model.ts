/**
 * Pure model behind the sidebar canvas tree: rows in, rows out, no I/O and no
 * React. Keeping it separate is what makes the ordering and the drop rules
 * testable without mounting a tree.
 *
 * The path algebra below is a deliberate copy of `main/canvas/folder-paths.ts`
 * — the renderer cannot import from `main/`. The semantics must stay IDENTICAL:
 * this module decides which drops the UI OFFERS, and the store decides which it
 * ACCEPTS. A divergence would show the user a drop target that then refuses.
 *
 * @module components/sidebar/canvas-tree/canvas-tree-model
 */

import type { CanvasSummary } from '@/services/canvas-service'
import type { CanvasFolder } from '@/services/canvas-folder-service'

// ============================================================================
// Path algebra (mirrors main/canvas/folder-paths.ts)
// ============================================================================

/**
 * Deepest nesting a canvas folder may reach. A deliberate copy of
 * `main/canvas/folder-paths.MAX_CANVAS_FOLDER_DEPTH`, and it MUST stay equal to
 * it: the store refuses anything past this, so a UI that did not know the number
 * would offer a drop, draw the indicator, and then have nothing happen.
 */
export const MAX_CANVAS_FOLDER_DEPTH = 8

/**
 * Comparison key for "is this the same folder?" — never for opening one.
 * NFC + lowercase, because macOS and Windows default to case-insensitive
 * filesystems and macOS stores filenames decomposed. Mirrors `canvasPathKey`.
 */
function canvasPathKey(relativePath: string): string {
  return relativePath.normalize('NFC').toLowerCase()
}

/**
 * The parts of a folder path. Total — never throws, and applies no depth cap,
 * because everything reaching this module is already stored: the tree must be
 * able to render a folder written by another device or a future version, the
 * same way `normalizeStoredFolder` reads one.
 */
function folderSegments(folder: string | null | undefined): string[] {
  if (!folder) return []
  return folder
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/**
 * True when `candidate` IS `ancestor` or sits beneath it. Segment-wise rather
 * than string `startsWith`, so `Workshop` is not treated as a child of `Work`,
 * and compared through `canvasPathKey` so `work/q3` IS a child of `Work`.
 */
function isDescendantFolder(candidate: string | null, ancestor: string | null): boolean {
  const ancestorSegments = folderSegments(ancestor)
  if (ancestorSegments.length === 0) return true // everything lives under root
  const candidateSegments = folderSegments(candidate)
  if (candidateSegments.length < ancestorSegments.length) return false
  return ancestorSegments.every(
    (segment, index) => canvasPathKey(candidateSegments[index]) === canvasPathKey(segment)
  )
}

// ============================================================================
// Tree
// ============================================================================

export interface CanvasTreeFolderNode {
  kind: 'folder'
  /** Path relative to `canvases/`, forward-slashed. Also the expansion key. */
  path: string
  /** Last segment of `path`, as stored. */
  name: string
  icon: string | null
  depth: number
  /**
   * Canvases anywhere BENEATH this folder, not just its direct children.
   *
   * A collapsed folder hides its whole subtree, so a count of direct children
   * only would read as "this folder is nearly empty" for a folder holding
   * dozens. It is also what a folder delete takes with it, which is the number
   * the confirmation has to state.
   */
  canvasCount: number
  /**
   * True when NO `canvas_folders` row backs this node — it exists only because
   * some canvas's `folder` string (or a deeper folder row's path) named it.
   *
   * The row is what rename, move and set-icon resolve first, so a materialized
   * folder is one every such call would return null for. The tree turns the flag
   * into a row before it mutates; see `ensureFolderRow` in `canvas-tree.tsx`.
   */
  materialized: boolean
  children: CanvasTreeNode[]
}

export interface CanvasTreeCanvasNode {
  kind: 'canvas'
  canvas: CanvasSummary
  depth: number
}

export type CanvasTreeNode = CanvasTreeFolderNode | CanvasTreeCanvasNode

interface BuildFolder {
  path: string
  name: string
  icon: string | null
  /** Flipped on by the folder-row pass; drives `materialized` on the node. */
  hasRow: boolean
  folders: Map<string, BuildFolder>
  canvases: CanvasSummary[]
}

/**
 * Walks `segments`, creating any folder that does not exist yet, and returns
 * the deepest one (`null` for the root).
 *
 * The created path is built from the PARENT's stored path, not from the caller's
 * segments, so a canvas filed under `work/q3` lands beneath the existing `Work`
 * row and its child keeps the on-disk-canonical `Work/q3`.
 */
function ensureFolder(roots: Map<string, BuildFolder>, segments: string[]): BuildFolder | null {
  let level = roots
  let parent: BuildFolder | null = null

  for (const name of segments) {
    const key = canvasPathKey(name)
    let node = level.get(key)
    if (!node) {
      node = {
        path: parent ? `${parent.path}/${name}` : name,
        name,
        icon: null,
        hasRow: false,
        folders: new Map(),
        canvases: []
      }
      level.set(key, node)
    }
    parent = node
    level = node.folders
  }

  return parent
}

/** Locale-aware, case-insensitive — `Éclair` before `Zebra`, `Apple` before `zebra`. */
function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

/** Canvases anywhere beneath `nodes` — what a folder's badge and its delete state. */
export function countCanvasNodes(nodes: CanvasTreeNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.kind === 'canvas' ? 1 : countCanvasNodes(node.children)),
    0
  )
}

function toNodes(
  folders: Map<string, BuildFolder>,
  canvases: CanvasSummary[],
  depth: number
): CanvasTreeNode[] {
  const folderNodes: CanvasTreeNode[] = [...folders.values()]
    .sort((a, b) => compareLabels(a.name, b.name))
    .map((folder) => {
      const children = toNodes(folder.folders, folder.canvases, depth + 1)
      return {
        kind: 'folder',
        path: folder.path,
        name: folder.name,
        icon: folder.icon,
        depth,
        canvasCount: countCanvasNodes(children),
        materialized: !folder.hasRow,
        children
      }
    })

  const canvasNodes: CanvasTreeNode[] = [...canvases]
    .sort((a, b) => compareLabels(a.title ?? '', b.title ?? ''))
    .map((canvas) => ({ kind: 'canvas', canvas, depth }))

  // Folders first, then canvases — the concatenation IS the rule.
  return [...folderNodes, ...canvasNodes]
}

/**
 * Builds the sidebar tree from the canvas rows and the folder rows.
 *
 * A canvas whose folder has no matching folder row still appears: the missing
 * folders are materialized on the way down. A canvas can arrive from sync
 * before its folder row does, and dropping it would make the user's canvas
 * invisible in the app while it sits in plain view in Finder.
 */
export function buildCanvasTree(
  canvases: CanvasSummary[],
  folders: CanvasFolder[]
): CanvasTreeNode[] {
  const roots = new Map<string, BuildFolder>()
  const rootCanvases: CanvasSummary[] = []

  // Folder rows first: they own the display name and the icon, and a canvas
  // processed later then merges into the row rather than forking a sibling.
  for (const row of folders) {
    const node = ensureFolder(roots, folderSegments(row.path))
    if (node) {
      node.icon = row.icon
      node.hasRow = true
    }
  }

  for (const canvas of canvases) {
    const node = ensureFolder(roots, folderSegments(canvas.folder))
    if (node) node.canvases.push(canvas)
    else rootCanvases.push(canvas)
  }

  return toNodes(roots, rootCanvases, 0)
}

/**
 * How many folder levels sit BELOW `node` — 0 for one with no subfolders.
 *
 * This is the term the depth rule has to be judged on. `relocateFolder` rewrites
 * EVERY descendant folder path through `rewriteFolderPrefix`, which asserts the
 * cap on each, so a folder that would land legally is still refused when a child
 * of it would not. Canvases contribute no level of their own: a canvas is a file
 * inside a folder, so its placement is that folder's depth.
 */
export function folderSubtreeDepth(node: CanvasTreeFolderNode): number {
  let deepest = 0
  for (const child of node.children) {
    if (child.kind !== 'folder') continue
    deepest = Math.max(deepest, 1 + folderSubtreeDepth(child))
  }
  return deepest
}

/**
 * A stored folder path split into the two halves the create IPC takes: the
 * parent (`null` at the root) and the leaf name.
 */
export function splitFolderPath(folder: string): { parent: string | null; name: string } {
  const segments = folderSegments(folder)
  return {
    parent: segments.length > 1 ? segments.slice(0, -1).join('/') : null,
    name: segments.at(-1) ?? ''
  }
}

/**
 * Stable identity of a rendered row: the React key, the `data-row-key`
 * attribute, and the token the tree hands its focus restorer. One function
 * because a focus target that disagreed with the rendered attribute would
 * silently drop focus to the document body.
 */
export function rowKeyOf(node: CanvasTreeNode): string {
  return node.kind === 'folder' ? `folder:${node.path}` : `canvas:${node.canvas.id}`
}

/**
 * Depth-first flattening that stops at a collapsed folder. `expanded` holds
 * folder `path` values.
 */
export function flattenVisible(
  nodes: CanvasTreeNode[],
  expanded: ReadonlySet<string>
): CanvasTreeNode[] {
  const result: CanvasTreeNode[] = []
  for (const node of nodes) {
    result.push(node)
    if (node.kind === 'folder' && expanded.has(node.path)) {
      result.push(...flattenVisible(node.children, expanded))
    }
  }
  return result
}

// ============================================================================
// Filtering
// ============================================================================

/** Comparison form for a filter: NFC + lowercase, the same key paths use. */
function searchKey(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

function filterNodes(
  nodes: CanvasTreeNode[],
  needle: string,
  ancestorMatched: boolean
): CanvasTreeNode[] {
  const result: CanvasTreeNode[] = []
  for (const node of nodes) {
    if (node.kind === 'canvas') {
      if (ancestorMatched || searchKey(node.canvas.title ?? '').includes(needle)) result.push(node)
      continue
    }
    // The FULL path, so typing `work/q3` finds the nested folder and typing
    // `work` keeps everything under it — a canvas whose folder path matches is
    // kept by `ancestorMatched` without re-reading `canvas.folder`.
    const selfMatched = ancestorMatched || searchKey(node.path).includes(needle)
    const children = filterNodes(node.children, needle, selfMatched)
    if (!selfMatched && children.length === 0) continue
    result.push({ ...node, children, canvasCount: countCanvasNodes(children) })
  }
  return result
}

/**
 * The subtree of `nodes` that `query` matches, on canvas titles and folder
 * paths both.
 *
 * A folder survives when its own path matches or when anything beneath it did,
 * so a match is never orphaned from the folder that explains where it lives.
 * `canvasCount` is recomputed on the way out: the badge must describe what the
 * user can actually see, not what the folder holds unfiltered.
 *
 * Returns the input array unchanged for an empty query, so the caller's
 * `useMemo` identity — and the expansion state keyed off it — stays stable.
 */
export function filterCanvasTree(nodes: CanvasTreeNode[], query: string): CanvasTreeNode[] {
  const needle = searchKey(query.trim())
  if (!needle) return nodes
  return filterNodes(nodes, needle, false)
}

/**
 * Every folder path in `nodes` mapped to the canvases beneath it.
 *
 * Read off the UNFILTERED tree so a destructive confirmation can state its real
 * blast radius: `filterCanvasTree` recomputes `canvasCount` to describe what the
 * user can currently SEE, which is right for the badge and a lie for a delete.
 */
export function folderCanvasCounts(
  nodes: CanvasTreeNode[],
  out: Map<string, number> = new Map()
): Map<string, number> {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    out.set(node.path, node.canvasCount)
    folderCanvasCounts(node.children, out)
  }
  return out
}

/** Every folder path in `nodes`, at any depth. */
export function collectFolderPaths(
  nodes: CanvasTreeNode[],
  out: Set<string> = new Set()
): Set<string> {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    out.add(node.path)
    collectFolderPaths(node.children, out)
  }
  return out
}

/**
 * Expansion keys after a folder moved from `from` to `to`.
 *
 * Expansion is keyed by folder PATH, so a rename or a move silently orphans the
 * stored key and the folder the user was working in collapses under them — and
 * stays collapsed across restarts, because the orphan is what got persisted.
 * Descendants are re-keyed too: renaming `Work` has to carry `Work/Q3` along.
 */
export function rewriteExpandedFolderPaths(
  expanded: ReadonlySet<string>,
  from: string,
  to: string
): Set<string> {
  const fromSegments = folderSegments(from)
  const toSegments = folderSegments(to)
  const next = new Set<string>()
  for (const path of expanded) {
    if (fromSegments.length === 0 || !isDescendantFolder(path, from)) {
      next.add(path)
      continue
    }
    const rewritten = [...toSegments, ...folderSegments(path).slice(fromSegments.length)].join('/')
    if (rewritten) next.add(rewritten)
  }
  return next
}

// ============================================================================
// Drag & drop
// ============================================================================

/**
 * The `dataTransfer` type the canvas tree tags its drags with.
 *
 * Deliberately its own: the notes tree reads `text/plain` and
 * `application/x-memry-note`, and the canvas SURFACE reads
 * `application/x-memry-canvas-item`. Neither tree can read a type it did not
 * write, and that is the whole cross-tree guard — a note dropped here and a
 * canvas dropped there both fall through to nothing.
 */
export const CANVAS_TREE_DRAG_MIME = 'application/x-memry-canvas'

export type CanvasDragPayload =
  | { tree: 'canvas'; kind: 'canvas'; id: string }
  | {
      tree: 'canvas'
      kind: 'folder'
      path: string
      /** `folderSubtreeDepth` of the dragged folder — the depth rule needs it. */
      subtreeDepth: number
      /** `CanvasTreeFolderNode.materialized` — the drop has to mint a row first. */
      materialized: boolean
    }

/**
 * Whether `payload` may be dropped on `targetFolder` (`null` is the root).
 *
 * `payload` is `unknown` because it arrives from the drag layer, which carries
 * whatever any tree in the app put there. Guards run in order: it must be an
 * object, it must come from the canvas tree, and the drop must clear the rules
 * the store enforces —
 *
 * - **the cycle rule** (folders): a folder may not land on itself or one of its
 *   own descendants, which would detach the subtree;
 * - **the depth cap**: a folder lands one level under the target and its whole
 *   subtree rides along at the distance it already has, so the DEEPEST
 *   descendant is what has to fit inside `MAX_CANVAS_FOLDER_DEPTH`. A canvas
 *   adds no level of its own, but the TARGET still has to be a folder the store
 *   will accept.
 *
 * Modelling only the cycle rule is what let the UI draw a drop indicator on a
 * target the store then refused.
 */
export function canDrop(payload: unknown, targetFolder: string | null): boolean {
  if (typeof payload !== 'object' || payload === null) return false

  const candidate = payload as {
    tree?: unknown
    kind?: unknown
    path?: unknown
    subtreeDepth?: unknown
  }
  if (candidate.tree !== 'canvas') return false

  // A canvas is a file, not a level, so it never DEEPENS the tree — but the
  // store still caps the target it is filed under: `updateCanvas` resolves the
  // requested folder through `storedFolderPath` → `portableCanvasFolder` →
  // `normalizeFolder`, which throws past the cap. The tree can render a folder
  // deeper than that (a stored path is read without the construction guard, so
  // a peer running a build with a higher cap shows up here), and offering the
  // drop would draw an indicator on a target the store then refuses.
  if (candidate.kind === 'canvas') {
    return folderSegments(targetFolder).length <= MAX_CANVAS_FOLDER_DEPTH
  }
  if (candidate.kind === 'folder') {
    if (typeof candidate.path !== 'string') return false
    if (isDescendantFolder(targetFolder, candidate.path)) return false
    // Missing or nonsense reads as "no children" rather than as a refusal: the
    // payload comes off the drag layer, and the store still has the last word.
    const subtreeDepth =
      typeof candidate.subtreeDepth === 'number' && candidate.subtreeDepth > 0
        ? candidate.subtreeDepth
        : 0
    return folderSegments(targetFolder).length + 1 + subtreeDepth <= MAX_CANVAS_FOLDER_DEPTH
  }
  return false
}
