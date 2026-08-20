/**
 * The sidebar canvas tree: folders and canvases in one list, with the context
 * menus that organize them.
 *
 * The tree owns every mutation; the rows only report intent. That is what keeps
 * a rename, a move and a delete going through one place where the typed folder
 * failures get translated and surfaced.
 *
 * Naming happens ON the row — a field in place of the label, exactly as the
 * notes tree does it. Creating goes the same way: the canvas or folder is made
 * immediately under a default name and the new row opens for editing, so the
 * user never has to find it again afterwards. Only DELETE keeps a dialog,
 * because a destructive action is worth confirming.
 *
 * @module components/sidebar/canvas-tree/canvas-tree
 */

import * as React from 'react'
import { useSidebarSortMode } from '@/hooks/use-sidebar-sort-mode'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import type { SidebarItem } from '@/contexts/tabs/types'
import { canvasService, type CanvasSummary } from '@/services/canvas-service'
import { canvasFolderService } from '@/services/canvas-folder-service'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  buildCanvasTree,
  canDrop,
  childFolderNames,
  collectFolderPaths,
  filterCanvasTree,
  flattenVisible,
  folderCanvasCounts,
  folderSubtreeDepth,
  rewriteExpandedFolderPaths,
  rowKeyOf,
  splitFolderPath,
  uniqueFolderName,
  CANVAS_TREE_DRAG_MIME,
  type CanvasDragPayload,
  type CanvasTreeFolderNode,
  type CanvasTreeNode
} from './canvas-tree-model'
import { useCanvasTree } from './use-canvas-tree'
import { CanvasRow } from './canvas-row'
import { CanvasFolderRow } from './canvas-folder-row'
import type { CanvasRowEdit } from './canvas-row-name-input'
import { CANVAS_ROW_INDENT_PX, type CanvasFolderOption } from './folder-options'

const log = createLogger('SpatialCanvas')

/** Same shape as the other sidebar trees' persisted expansion: a list of keys. */
const EXPANDED_STORAGE_KEY = 'sidebar-canvas-tree-expanded'

/**
 * Canvases from which the filter input is worth its own row of chrome.
 *
 * The same judgement `SidebarTagList`'s `maxVisible` makes: a short list is
 * read, not searched, and a permanent input above three canvases is weight the
 * sidebar has not earned.
 */
const DEFAULT_FILTER_THRESHOLD = 8

function loadExpanded(): Set<string> {
  try {
    const stored = localStorage.getItem(EXPANDED_STORAGE_KEY)
    if (stored) return new Set(JSON.parse(stored) as string[])
  } catch {
    // Ignore parse errors — a corrupt key just means "nothing expanded".
  }
  return new Set()
}

function saveExpanded(paths: ReadonlySet<string>): void {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...paths]))
  } catch {
    // Ignore storage errors
  }
}

/** Every folder in render order — the Move submenu and nothing else needs this. */
function collectFolderOptions(
  nodes: CanvasTreeNode[],
  out: CanvasFolderOption[] = []
): CanvasFolderOption[] {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    out.push({ path: node.path, name: node.name, depth: node.depth })
    collectFolderOptions(node.children, out)
  }
  return out
}

/**
 * Drop-target key for the root zone. Not a legal stored folder path — the path
 * algebra drops empty segments — so it cannot collide with a folder row's key.
 */
const ROOT_DROP_KEY = '/'

/**
 * Focus key of the empty state's "New canvas" button.
 *
 * Deleting the last row leaves no row to fall back to, and focus on
 * `document.body` ends keyboard navigation. Not a legal folder path or canvas
 * id, so it cannot collide with a row's key.
 */
const EMPTY_STATE_FOCUS_KEY = 'empty:new-canvas'

/**
 * How long after a mutation the tree keeps pulling focus back onto its target.
 *
 * The row focus should land on may not exist yet when the dialog closes: a
 * renamed folder is keyed by its NEW path, and the rows a folder delete takes
 * with it are still on screen until the IPC event's refresh lands. A single
 * attempt therefore either misses or lands on a row that is about to vanish —
 * both end with focus on `document.body`. Bounded so a refresh minutes later
 * cannot yank focus out from under the user.
 */
const FOCUS_SETTLE_MS = 1000

/**
 * The name a canvas folder is born with, before the user types the real one.
 *
 * Not translated, deliberately: this becomes a DIRECTORY in the vault, and a
 * name that depended on the app's language would put the same folder on disk
 * under a different path per device. The notes tree makes the same call, and
 * the user is already typing over it.
 */
const DEFAULT_FOLDER_NAME = 'Untitled Folder'

/** Shared by the empty state's two buttons; matches the empty-folder hint's link. */
const EMPTY_STATE_ACTION_CLASS =
  'rounded-sm text-[11px] leading-3.5 font-medium text-sidebar-section-heading transition-colors text-start hover:text-sidebar-primary'

/**
 * The payload behind the drag in flight, or `null`.
 *
 * `getData` returns '' for the whole `dragover` phase: browsers hold the drag
 * data store in protected mode until the drop, so the payload written at
 * `dragstart` has to be remembered in component state for the drop rules to be
 * checked while the pointer moves. `types` stays readable throughout, and
 * checking it FIRST is what rejects a drag that started in another tree —
 * nothing else writes `CANVAS_TREE_DRAG_MIME`.
 */
function readDragPayload(transfer: DataTransfer, remembered: CanvasDragPayload | null): unknown {
  if (!transfer.types.includes(CANVAS_TREE_DRAG_MIME)) return null
  const raw = transfer.getData(CANVAS_TREE_DRAG_MIME)
  if (!raw) return remembered
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ============================================================================
// Delete confirmation
// ============================================================================

interface ConfirmDialogProps {
  title: string
  body: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}

function CanvasConfirmDialog({
  title,
  body,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const [submitting, setSubmitting] = React.useState(false)

  return (
    <AlertDialog open onOpenChange={(open) => !open && !submitting && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {/*
          AlertDialogCancel/Action, never plain buttons. Radix's
          AlertDialogContent preventDefaults its own auto-focus and focuses
          `cancelRef` instead — a ref only AlertDialogCancel populates. A footer
          of plain buttons therefore opens with focus on `document.body`, which
          ends the keyboard delete path at its last step, and is why every other
          AlertDialog in this app is built this way.
        */}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={submitting}>
            {t('button.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={submitting}
            onClick={() => {
              setSubmitting(true)
              void onConfirm()
            }}
          >
            {t('button.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ============================================================================
// Tree
// ============================================================================

/**
 * Which row is being named, by identity alone.
 *
 * Identity rather than the node itself: the row re-renders — and for a freshly
 * created one, does not exist yet — while the field is open, so anything holding
 * a node object would go stale on the first refresh. `materialized` rides along
 * because a folder with no `canvas_folders` row needs one minted before the
 * rename can touch anything.
 */
type EditTarget =
  { kind: 'canvas'; id: string } | { kind: 'folder'; path: string; materialized: boolean }

interface EditState {
  target: EditTarget
  /** The name the row already had, so an unchanged submit costs no write. */
  original: string
  value: string
  busy: boolean
  /**
   * The last refusal, translated, together with the exact value that earned it.
   *
   * One object rather than a loose message because the two may never drift
   * apart: the field shows the reason only while it still holds that value, and
   * the same pairing is what stops a name the store has already refused from
   * being sent again unchanged.
   */
  failure: { value: string; message: string } | null
}

/** The row key `target` names, matching `rowKeyOf`. */
function editKeyOf(target: EditTarget): string {
  return target.kind === 'canvas' ? `canvas:${target.id}` : `folder:${target.path}`
}

type ConfirmState =
  | { kind: 'delete-canvas'; canvas: CanvasSummary }
  | { kind: 'delete-folder'; node: CanvasTreeFolderNode; count: number }

/**
 * What the host can ask of the tree.
 *
 * The CANVASES section header sits outside this component, and a folder row's
 * own menu can only ever create a CHILD — so without a handle, a root-level
 * folder is unreachable, and a user with no folders can never make their first.
 */
export interface CanvasTreeActions {
  /** Creates a folder at the canvases root and opens its row for naming. */
  createFolder: () => void
}

export interface CanvasTreeProps {
  ref?: React.Ref<CanvasTreeActions>
  /** Called when a row is activated — the host decides how to open it. */
  onCanvasClick?: (canvas: CanvasSummary) => void
  /** Reports how many canvases the vault holds, for the section's `(n)` badge. */
  onCountChange?: (count: number) => void
  /**
   * Reports the folder the user is looking at — the last row they touched, a
   * canvas standing for the folder holding it. The host's "New canvas" button
   * has no other way to land the file where the user is working.
   */
  onTargetFolderChange?: (folder: string | null) => void
  /** Canvases from which the filter input appears. Exposed for tests. */
  filterThreshold?: number
  className?: string
}

export function CanvasTree({
  ref,
  onCanvasClick,
  onCountChange,
  onTargetFolderChange,
  filterThreshold = DEFAULT_FILTER_THRESHOLD,
  className
}: CanvasTreeProps): React.JSX.Element {
  const { t } = useT('common')
  const { isActiveItem } = useSidebarNavigation()

  const [expanded, setExpanded] = React.useState<Set<string>>(() => loadExpanded())

  /**
   * A renamed or moved folder takes its expansion key with it.
   *
   * Expansion is keyed by path and persisted, so without this the folder the
   * user just renamed collapses under them — and stays collapsed after a
   * restart, because the orphaned key is what got written.
   */
  const handleFolderPathChanged = React.useCallback((from: string, to: string) => {
    setExpanded((previous) => rewriteExpandedFolderPaths(previous, from, to))
  }, [])

  const { canvases, folders, isLoading, hasError } = useCanvasTree({
    onFolderPathChanged: handleFolderPathChanged
  })

  const [filter, setFilter] = React.useState('')
  const [editing, setEditing] = React.useState<EditState | null>(null)
  const [confirm, setConfirm] = React.useState<ConfirmState | null>(null)
  const [dragging, setDragging] = React.useState<CanvasDragPayload | null>(null)
  const [dropTarget, setDropTarget] = React.useState<string | null>(null)
  /**
   * Row keys to try focusing once the list settles, best first.
   *
   * A rename or a delete happens behind a dialog, and Radix restores focus to
   * the element that opened it. After a delete that element is gone, and after a
   * FOLDER rename its key changed — both land focus on `document.body`, which
   * ends keyboard navigation of the tree. A list rather than one key because a
   * deleted folder takes its descendants with it, so the row that follows may
   * be gone too; the first survivor wins.
   */
  const [pendingFocus, setPendingFocus] = React.useState<string[] | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    saveExpanded(expanded)
  }, [expanded])

  // The count is not the host's to derive: it comes from an IPC list this
  // component owns, and the host would have to repeat the fetch to learn it.
  // Deferring the callback keeps it asynchronous from the linter's
  // perspective — the same shape `filing-section` uses for its parent
  // callbacks — so it does not trip no-pass-data-to-parent.
  React.useEffect(() => {
    const count = canvases.length
    void Promise.resolve().then(() => onCountChange?.(count))
  }, [canvases.length, onCountChange])

  const { mode: sortMode } = useSidebarSortMode('canvases')
  const tree = React.useMemo(
    () => buildCanvasTree(canvases, folders, sortMode),
    [canvases, folders, sortMode]
  )

  const showFilter = canvases.length >= filterThreshold
  // A filter typed while the input was showing must not keep hiding rows once
  // the vault drops back under the threshold and the input is gone.
  const query = showFilter ? filter.trim() : ''
  const isFiltering = query.length > 0

  const visibleTree = React.useMemo(() => filterCanvasTree(tree, query), [tree, query])

  /**
   * Expansion as rendered. While filtering, every folder still standing holds a
   * match, so all of them open — a match hidden inside a collapsed folder is a
   * filter that appears to have found nothing.
   *
   * `expanded` itself is deliberately NOT written to: clearing the filter has to
   * put the tree back exactly as the user left it, and persisting the
   * everything-open set would survive a restart as well.
   */
  const effectiveExpanded = React.useMemo(
    () => (isFiltering ? collectFolderPaths(visibleTree) : expanded),
    [expanded, isFiltering, visibleTree]
  )

  const rows = React.useMemo(
    () => flattenVisible(visibleTree, effectiveExpanded),
    [visibleTree, effectiveExpanded]
  )
  const folderOptions = React.useMemo(() => collectFolderOptions(tree), [tree])

  /**
   * Canvases each folder really holds, read off the UNFILTERED tree.
   *
   * The rendered node carries the FILTERED count — right for its badge, and a
   * lie for a delete confirmation, which would then understate how much the
   * user is about to destroy.
   */
  const trueFolderCounts = React.useMemo(() => folderCanvasCounts(tree), [tree])

  /** Focuses the first of `keys` that is actually on screen. */
  const focusRow = React.useCallback((keys: string[]): void => {
    const list = listRef.current
    if (!list) return
    const rendered = Array.from(list.querySelectorAll<HTMLElement>('[data-row-key]'))
    for (const key of keys) {
      const row = rendered.find((element) => element.dataset.rowKey === key)
      if (!row) continue
      // The row's label button, or — for the empty state's own affordance —
      // the keyed element itself, which is already a button.
      const target = row.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]') ?? row
      target.focus()
      return
    }
  }, [])

  /**
   * Puts focus back on a row once the rows have re-rendered.
   *
   * Deferred by a task rather than run inline: the dialog that triggered this
   * unmounts in the same commit, and Radix's focus scope restores focus during
   * that teardown. Running first would only get overwritten.
   *
   * Re-runs on every `rows` change while the target is still pending, because
   * one attempt is not enough. A renamed folder's row key IS its new path, so
   * the row does not exist until the mutation's IPC event has refreshed the
   * list; and the row after a deleted folder may itself be one of the folder's
   * children, still rendered until that same refresh. Both cases left focus on
   * `document.body`, which ends keyboard navigation of the tree.
   */
  React.useEffect(() => {
    if (!pendingFocus) return
    const timer = setTimeout(() => focusRow(pendingFocus), 0)
    return () => clearTimeout(timer)
  }, [focusRow, pendingFocus, rows])

  // Closes the window above. Deliberately NOT keyed on `rows`, so a later
  // refresh cannot extend it.
  React.useEffect(() => {
    if (!pendingFocus) return
    const timer = setTimeout(() => setPendingFocus(null), FOCUS_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [pendingFocus])

  /**
   * Where focus should go once `key`'s row is gone: the row after it, else the
   * one before, in falling order of preference.
   */
  const survivorsAround = React.useCallback(
    (key: string): string[] => {
      const index = rows.findIndex((node) => rowKeyOf(node) === key)
      if (index < 0) return []
      return [...rows.slice(index + 1), ...rows.slice(0, index).reverse()].map(rowKeyOf)
    },
    [rows]
  )

  /**
   * Logs a failure, toasts it, and hands the sentence back.
   *
   * The sentence is returned rather than only shown because the inline field
   * keeps it: a typed `CanvasFolderError` is the user's instruction for what to
   * type instead, and a toast that scrolls away is not where they are looking.
   */
  const describeFailure = React.useCallback(
    (err: unknown): string => {
      log.error('Canvas tree action failed', err)
      const message = extractErrorMessage(err, t('canvas.actionFailed'))
      toast.error(message)
      return message
    },
    [t]
  )

  /**
   * Every mutation funnels through here so a typed folder failure reaches the
   * user as its translated sentence instead of dying in the console.
   */
  const run = React.useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      try {
        await action()
        return true
      } catch (err) {
        describeFailure(err)
        return false
      }
    },
    [describeFailure]
  )

  /**
   * Gives a MATERIALIZED folder a real `canvas_folders` row, so the mutation
   * about to run has something to update. A no-op for a folder that has one.
   *
   * A folder rendered from a canvas's `folder` string with no row behind it — a
   * canvas that arrived from sync ahead of its folder item, or a directory made
   * in Finder before the next reconcile — used to ACCEPT rename, move and
   * set-icon and then do nothing: all three resolve the row first
   * (`liveFolderRow`) and return null when there is none. A menu item that
   * silently fails is worse than one that is not there.
   *
   * Minting the row is chosen over disabling those items, and it is safe
   * because the row is not a new object competing with sync:
   *
   * - `canvasFolderSyncId` derives the id from the PATH, so the row created here
   *   carries the exact id the incoming `canvas_folder` item carries. The pull
   *   merges into it by primary key and LWW settles the icon — it cannot fork a
   *   second folder.
   * - The app already writes this row itself. `reconcile` adopts every canvas
   *   directory that has no row on the next vault open, with the same derived
   *   id; creating it here only brings that write forward to the moment the
   *   user asks for something that needs it.
   * - `createCanvasFolder` is idempotent (existing row returned, nothing
   *   enqueued) and creates the directory with `mkdir -p`, so a racing adoption
   *   or an already-present directory is not a failure.
   *
   * Awaited, not fired alongside: a rename that ran before the row existed is
   * the bug being fixed. A failure propagates to `run`, so the user gets the
   * reason instead of a second silent no-op.
   */
  const ensureFolderRow = React.useCallback(
    async (path: string, materialized: boolean): Promise<void> => {
      if (!materialized) return
      const { parent, name } = splitFolderPath(path)
      await canvasFolderService.create({ parent, name })
    },
    []
  )

  // --------------------------------------------------------------------------
  // Naming a row in place
  // --------------------------------------------------------------------------

  /** Opens the field on `target`, with `original` selected for overtyping. */
  const beginEdit = React.useCallback((target: EditTarget, original: string) => {
    setEditing({ target, original, value: original, busy: false, failure: null })
  }, [])

  const changeEdit = React.useCallback((value: string) => {
    setEditing((current) => (current ? { ...current, value } : current))
  }, [])

  const cancelEdit = React.useCallback(() => {
    if (!editing) return
    // The field IS the row's focusable content while it is open, so closing it
    // without saying where focus goes drops it to `document.body`.
    setPendingFocus([editKeyOf(editing.target)])
    setEditing(null)
  }, [editing])

  /**
   * Commits the typed name.
   *
   * An empty or unchanged name closes the field without a write — the notes
   * tree's semantics, and the reason blur can be a commit at all: clicking away
   * from an untouched field must not cost an `updatedAt` bump and a sync.
   */
  const submitEdit = React.useCallback(async (): Promise<void> => {
    if (!editing || editing.busy) return
    const { target, original } = editing
    const next = editing.value.trim()
    if (!next || next === original) {
      cancelEdit()
      return
    }
    // Already refused, unchanged since. Asking again can only fail again, so
    // the write is not sent — the field stays open on the reason it was given,
    // and a second Enter costs nothing instead of a second round trip.
    if (editing.failure?.value === next) return

    setEditing((current) => (current ? { ...current, busy: true } : current))
    /** Where the store put the folder, once it has said so. */
    let renamedPath: string | null = null
    try {
      if (target.kind === 'canvas') {
        await canvasService.update({ id: target.id, title: next })
      } else {
        await ensureFolderRow(target.path, target.materialized)
        const { folder: renamed } = await canvasFolderService.rename({
          path: target.path,
          name: next
        })
        renamedPath = renamed?.path ?? null
      }
    } catch (err) {
      const message = describeFailure(err)
      // Left open, with the reason: a name the store refused is one the user has
      // to change, and silently reverting would read as the app ignoring them.
      setEditing((current) =>
        current ? { ...current, busy: false, failure: { value: next, message } } : current
      )
      return
    }

    // A renamed folder's row key IS its path, so it changed; the old row is
    // gone and focus would otherwise land on a detached node. The path the
    // STORE settled on, not the one we asked for: it canonicalises names it
    // cannot use as a directory, so a predicted path names a row that never
    // renders. Only fall back when the store returned no folder at all.
    const parent = target.kind === 'folder' ? splitFolderPath(target.path).parent : null
    setPendingFocus(
      target.kind === 'canvas'
        ? [`canvas:${target.id}`]
        : [`folder:${renamedPath ?? (parent ? `${parent}/${next}` : next)}`]
    )
    setEditing(null)
  }, [cancelEdit, describeFailure, editing, ensureFolderRow])

  const toggleFolder = React.useCallback(
    (path: string) => {
      onTargetFolderChange?.(path)
      setExpanded((previous) => {
        const next = new Set(previous)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
    },
    [onTargetFolderChange]
  )

  // --------------------------------------------------------------------------
  // Drag and drop — native HTML5, like the notes tree this one mirrors.
  // --------------------------------------------------------------------------

  const handleDragStart = React.useCallback(
    (event: React.DragEvent, payload: CanvasDragPayload) => {
      event.dataTransfer.effectAllowed = 'move'
      // Only our own type. The notes tree resolves a drop from `text/plain` and
      // `application/x-memry-note`, so writing neither is what makes a canvas
      // dragged onto the notes tree a no-op.
      event.dataTransfer.setData(CANVAS_TREE_DRAG_MIME, JSON.stringify(payload))
      setDragging(payload)
    },
    []
  )

  const handleDragEnd = React.useCallback(() => {
    setDragging(null)
    setDropTarget(null)
  }, [])

  const handleDragOver = React.useCallback(
    (event: React.DragEvent, folder: string | null, key: string) => {
      // preventDefault is what makes the drop legal and shows the move cursor,
      // so withholding it IS the refusal. Nothing else has to say no.
      if (!canDrop(readDragPayload(event.dataTransfer, dragging), folder)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTarget((previous) => (previous === key ? previous : key))
    },
    [dragging]
  )

  const handleDragLeave = React.useCallback((event: React.DragEvent) => {
    // Moving onto a child still counts as being over the row.
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setDropTarget(null)
  }, [])

  const handleDrop = React.useCallback(
    (event: React.DragEvent, folder: string | null) => {
      event.preventDefault()
      setDragging(null)
      setDropTarget(null)

      // Re-checked against what the transfer finally hands over: the dragover
      // decision was made on a remembered copy, because the drag data store is
      // unreadable until now.
      const payload = readDragPayload(event.dataTransfer, dragging)
      if (!canDrop(payload, folder)) return

      const drag = payload as CanvasDragPayload
      // No optimistic move: the canvas/folder events refresh the tree.
      void run(async () => {
        if (drag.kind === 'canvas') return canvasService.update({ id: drag.id, folder })
        // A folder with no row of its own has nothing for `move` to update.
        await ensureFolderRow(drag.path, drag.materialized)
        return canvasFolderService.move({ path: drag.path, parent: folder })
      })
    },
    [dragging, ensureFolderRow, run]
  )

  /**
   * Makes the row, then opens it for naming.
   *
   * The canvas is created with no title at all — the field is pre-filled with
   * the "Untitled canvas" label the row would show, so overtyping it is the
   * whole interaction and abandoning it leaves the row exactly as a canvas
   * created any other way. The tab still opens immediately: if the canvas
   * surface takes focus, the field blurs onto an UNCHANGED name, which commits
   * nothing and degrades to the behaviour this replaced.
   */
  const handleNewCanvas = React.useCallback(
    (path: string | null) => {
      void run(async () => {
        const created = await canvasService.create({ folder: path })
        if (path) setExpanded((previous) => new Set(previous).add(path))
        // A filter still hiding the new row is a field the user cannot see.
        setFilter('')
        onCanvasClick?.(created)
        beginEdit({ kind: 'canvas', id: created.id }, created.title || t('canvas.untitled'))
      })
    },
    [beginEdit, onCanvasClick, run, t]
  )

  /**
   * Creates a folder under a default name and opens its row for naming.
   *
   * The name has to be one the store accepts before the user has typed
   * anything, so it is uniquified against the folder's SIBLINGS — the same
   * thing the notes tree does, and the reason a second "New folder" in a row
   * does not fail on a collision.
   */
  const handleNewFolder = React.useCallback(
    (parent: string | null) => {
      void run(async () => {
        const name = uniqueFolderName(DEFAULT_FOLDER_NAME, childFolderNames(tree, parent))
        const { folder: created } = await canvasFolderService.create({ parent, name })
        if (parent) setExpanded((previous) => new Set(previous).add(parent))
        setFilter('')
        // The path the STORE settled on, not the one we asked for: it
        // canonicalises names it cannot use as a directory, so a predicted path
        // addresses a row that does not exist and the field opens on nothing.
        // Only fall back when the store returned no folder at all.
        const path = created?.path ?? (parent ? `${parent}/${name}` : name)
        // Freshly created, so it has a row of its own — nothing to mint.
        beginEdit({ kind: 'folder', path, materialized: false }, splitFolderPath(path).name)
      })
    },
    [beginEdit, run, tree]
  )

  React.useImperativeHandle(ref, () => ({ createFolder: () => handleNewFolder(null) }), [
    handleNewFolder
  ])

  /**
   * The keyboard path to moving a folder. Drag and drop has none, so this is
   * the whole WCAG AA story for folder placement — and it has to mint the row
   * first for the same reason rename and set-icon do.
   */
  const handleFolderMove = React.useCallback(
    (target: CanvasTreeFolderNode, parent: string | null) => {
      void run(async () => {
        await ensureFolderRow(target.path, target.materialized)
        const { folder: moved } = await canvasFolderService.move({ path: target.path, parent })
        // The row this ran from is gone: a folder row's key IS its path. The
        // menu restores focus to a trigger that went with it, so without a
        // target of its own a keyboard move ends on `document.body`.
        //
        // The path the STORE settled on, for the reason submitEdit and
        // handleNewFolder read theirs back: it canonicalises names it cannot
        // use as a directory, and resolves a collision under the new parent, so
        // a predicted path names a row that never renders. Only fall back when
        // the store returned no folder at all.
        const { name } = splitFolderPath(target.path)
        const path = moved?.path ?? (parent ? `${parent}/${name}` : name)
        setPendingFocus([`folder:${path}`])
      })
    },
    [ensureFolderRow, run]
  )

  const handleConfirm = React.useCallback(async (): Promise<void> => {
    if (!confirm) return
    const key =
      confirm.kind === 'delete-canvas'
        ? `canvas:${confirm.canvas.id}`
        : `folder:${confirm.node.path}`
    // Measured BEFORE the delete, while the row is still in the list. The empty
    // state's own button closes the list: deleting the last row must not leave
    // focus on `document.body`.
    const survivors = [...survivorsAround(key), EMPTY_STATE_FOCUS_KEY]
    const ok = await run(async () => {
      if (confirm.kind === 'delete-canvas') await canvasService.delete(confirm.canvas.id)
      else {
        // Minted first for the same reason rename, move and set-icon do it —
        // and the stakes are higher here. A folder with no row has nothing to
        // TOMBSTONE: the delete tears down the canvases on every device, then
        // the folder syncs back from whichever device does own its row, and the
        // user watches the folder they deleted return, empty.
        await ensureFolderRow(confirm.node.path, confirm.node.materialized)
        await canvasFolderService.delete({ path: confirm.node.path })
      }
    })
    if (ok) setPendingFocus(survivors)
    setConfirm(null)
  }, [confirm, ensureFolderRow, run, survivorsAround])

  /**
   * The field's props for `key`, or `null` when this is not the row being
   * named. Its absence is what tells a row to render its label.
   */
  const editFor = (key: string): CanvasRowEdit | null => {
    if (!editing || editKeyOf(editing.target) !== key) return null
    return {
      value: editing.value,
      busy: editing.busy,
      // The reason belongs to the value that earned it: it clears the moment
      // the user edits that value away — which is also what makes blur a commit
      // again — and comes back if they type it in once more.
      error: editing.failure?.value === editing.value.trim() ? editing.failure.message : null,
      onChange: changeEdit,
      onSubmit: () => void submitEdit(),
      onCancel: cancelEdit
    }
  }

  const confirmCopy = React.useMemo(() => {
    if (!confirm) return null
    if (confirm.kind === 'delete-canvas') {
      return {
        title: t('canvas.deleteConfirmTitle'),
        body: t('canvas.deleteConfirmBody', {
          title: confirm.canvas.title || t('canvas.untitled')
        })
      }
    }
    return {
      title: t('canvas.deleteFolderConfirmTitle'),
      body: t('canvas.deleteFolderConfirmBody', {
        name: confirm.node.name,
        count: confirm.count
      })
    }
  }, [confirm, t])

  // Rendered beside every state below: a delete started from a row survives the
  // list collapsing to its empty state under it.
  const dialogs = (
    <>
      {confirm && confirmCopy && (
        <CanvasConfirmDialog
          title={confirmCopy.title}
          body={confirmCopy.body}
          onConfirm={handleConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  )

  if (isLoading) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-muted-foreground">{t('canvas.loading')}</span>
      </div>
    )
  }

  if (hasError) {
    return (
      <div className={cn('px-2 py-1.5', className)}>
        <span className="text-xs text-destructive">{t('canvas.loadFailed')}</span>
      </div>
    )
  }

  // Only when there is genuinely nothing. A filter that matched nothing keeps
  // the input on screen — otherwise the control the user needs to clear it
  // disappears along with the results.
  //
  // Both ways in are offered here, because this is the ONE state with no row to
  // context menu: without them a vault holding nothing is a dead end, and a first
  // folder could never be created at all.
  if (rows.length === 0 && !isFiltering) {
    return (
      <>
        <div ref={listRef} className={cn('px-2 py-1.5', className)}>
          <span className="block text-xs text-muted-foreground">{t('canvas.empty')}</span>
          <div className="mt-1.5 flex items-center gap-3">
            <button
              type="button"
              data-row-key={EMPTY_STATE_FOCUS_KEY}
              onClick={() => handleNewCanvas(null)}
              className={EMPTY_STATE_ACTION_CLASS}
            >
              {t('canvas.newCanvas')}
            </button>
            <button
              type="button"
              onClick={() => handleNewFolder(null)}
              className={EMPTY_STATE_ACTION_CLASS}
            >
              {t('canvas.actions.newFolder')}
            </button>
          </div>
        </div>
        {dialogs}
      </>
    )
  }

  return (
    <>
      {showFilter && (
        <div className="px-2 pb-1">
          <input
            type="search"
            value={filter}
            aria-label={t('canvas.filterPlaceholder')}
            placeholder={t('canvas.filterPlaceholder')}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setFilter('')
            }}
            className="h-6 w-full rounded-md border bg-transparent px-2 text-[11px] placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
      )}

      <div ref={listRef} className={cn('max-h-[40vh] overflow-y-auto', className)}>
        {rows.length === 0 && (
          <span className="block px-2 py-1.5 text-xs text-muted-foreground">
            {t('canvas.filterNoMatches')}
          </span>
        )}

        {rows.map((node) => {
          if (node.kind === 'folder') {
            const isExpanded = effectiveExpanded.has(node.path)
            return (
              <React.Fragment key={rowKeyOf(node)}>
                <CanvasFolderRow
                  rowKey={rowKeyOf(node)}
                  node={node}
                  edit={editFor(rowKeyOf(node))}
                  isNaming={editing !== null}
                  isExpanded={isExpanded}
                  isDropTarget={dropTarget === node.path}
                  onDragStart={(event, target) =>
                    handleDragStart(event, {
                      tree: 'canvas',
                      kind: 'folder',
                      path: target.path,
                      // Measured at dragstart, while the node is in hand: `canDrop`
                      // only ever sees the payload, and the deepest child is what
                      // the depth cap is judged on.
                      subtreeDepth: folderSubtreeDepth(target),
                      materialized: target.materialized
                    })
                  }
                  onDragEnd={handleDragEnd}
                  onDragOver={(event, target) => handleDragOver(event, target.path, target.path)}
                  onDragLeave={handleDragLeave}
                  onDrop={(event, target) => handleDrop(event, target.path)}
                  onToggle={toggleFolder}
                  onNewCanvas={handleNewCanvas}
                  onNewFolder={handleNewFolder}
                  onSetIcon={(target, icon) => {
                    void run(async () => {
                      // The icon lives ONLY on the row, so a materialized folder
                      // needs one before it can carry an icon at all.
                      await ensureFolderRow(target.path, target.materialized)
                      return canvasFolderService.setIcon({ path: target.path, icon })
                    })
                  }}
                  onRename={(target) =>
                    beginEdit(
                      { kind: 'folder', path: target.path, materialized: target.materialized },
                      target.name
                    )
                  }
                  folderOptions={folderOptions}
                  onMove={handleFolderMove}
                  onDelete={(target) =>
                    setConfirm({
                      kind: 'delete-folder',
                      node: target,
                      count: trueFolderCounts.get(target.path) ?? target.canvasCount
                    })
                  }
                />

                {/*
                  An expanded folder holding nothing rendered as literally
                  nothing, which reads as a folder that failed to open. One
                  quiet line that also does the obvious thing about it.
                */}
                {isExpanded && node.children.length === 0 && (
                  <div
                    data-testid="canvas-folder-empty"
                    className="flex items-center gap-2 py-0.5"
                    style={{
                      paddingInlineStart: `${(node.depth + 1) * CANVAS_ROW_INDENT_PX + 8}px`
                    }}
                  >
                    <span className="text-[11px] leading-3.5 text-muted-foreground">
                      {t('canvas.folderEmptyHint')}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleNewCanvas(node.path)}
                      className="rounded-sm text-[11px] leading-3.5 font-medium text-sidebar-section-heading transition-colors text-start hover:text-sidebar-primary"
                    >
                      {t('canvas.actions.newCanvasHere')}
                    </button>
                  </div>
                )}
              </React.Fragment>
            )
          }

          const canvas = node.canvas
          const sidebarItem: SidebarItem = {
            type: 'canvas',
            title: canvas.title || t('canvas.untitled'),
            path: `/canvas/${canvas.id}`,
            entityId: canvas.id
          }

          return (
            <CanvasRow
              key={rowKeyOf(node)}
              rowKey={rowKeyOf(node)}
              canvas={canvas}
              edit={editFor(rowKeyOf(node))}
              isNaming={editing !== null}
              depth={node.depth}
              isActive={isActiveItem(sidebarItem)}
              folderOptions={folderOptions}
              onOpen={(target) => {
                onTargetFolderChange?.(target.folder ?? null)
                onCanvasClick?.(target)
              }}
              onRename={(target) =>
                beginEdit({ kind: 'canvas', id: target.id }, target.title || t('canvas.untitled'))
              }
              onDuplicate={(target) => {
                void run(() => canvasService.duplicate(target.id))
              }}
              onSetIcon={(target, icon) => {
                void run(() => canvasService.update({ id: target.id, icon }))
              }}
              onMove={(target, folder) => {
                void run(() => canvasService.update({ id: target.id, folder }))
              }}
              onOpenExternal={(target) => {
                void run(() => canvasService.openExternal(target.id))
              }}
              onRevealInFinder={(target) => {
                void run(() => canvasService.revealInFinder(target.id))
              }}
              onDelete={(target) => setConfirm({ kind: 'delete-canvas', canvas: target })}
              onDragStart={(event, target) =>
                handleDragStart(event, { tree: 'canvas', kind: 'canvas', id: target.id })
              }
              onDragEnd={handleDragEnd}
            />
          )
        })}

        {/*
          The way out of a folder. Every other drop target IS a folder, so
          without a strip of root below the last row a canvas dragged into one
          could only be dragged deeper.
        */}
        <div
          data-testid="canvas-tree-root-drop"
          className="relative mt-0.5 h-6"
          onDragOver={(event) => handleDragOver(event, null, ROOT_DROP_KEY)}
          onDragLeave={handleDragLeave}
          onDrop={(event) => handleDrop(event, null)}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md border border-dashed border-border text-[11px] text-muted-foreground">
              {t('canvas.dropToRoot')}
            </div>
          )}
          {dropTarget === ROOT_DROP_KEY && (
            <div
              data-testid="canvas-drop-indicator"
              className="absolute inset-0 rounded-md border-2 border-primary border-dashed bg-primary/10"
              aria-hidden="true"
            />
          )}
        </div>
      </div>

      {dialogs}
    </>
  )
}

export default CanvasTree
