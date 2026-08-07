/**
 * The sidebar canvas tree: folders and canvases in one list, with the context
 * menus that organize them.
 *
 * The tree owns every mutation and every dialog; the rows only report intent.
 * That is what keeps a rename, a move and a delete going through one place
 * where the typed folder failures get translated and surfaced.
 *
 * @module components/sidebar/canvas-tree/canvas-tree
 */

import * as React from 'react'
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  buildCanvasTree,
  canDrop,
  collectFolderPaths,
  filterCanvasTree,
  flattenVisible,
  folderCanvasCounts,
  folderSubtreeDepth,
  rewriteExpandedFolderPaths,
  rowKeyOf,
  splitFolderPath,
  CANVAS_TREE_DRAG_MIME,
  type CanvasDragPayload,
  type CanvasTreeFolderNode,
  type CanvasTreeNode
} from './canvas-tree-model'
import { useCanvasTree } from './use-canvas-tree'
import { CanvasRow } from './canvas-row'
import { CanvasFolderRow } from './canvas-folder-row'
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
// Dialogs
// ============================================================================

interface NameDialogProps {
  title: string
  label: string
  initialValue: string
  /** Resolve false to keep the dialog open — a rejected name is worth retyping. */
  onSubmit: (value: string) => Promise<boolean>
  onCancel: () => void
}

function CanvasNameDialog({
  title,
  label,
  initialValue,
  onSubmit,
  onCancel
}: NameDialogProps): React.JSX.Element {
  const { t } = useT('common')
  const [value, setValue] = React.useState(initialValue)
  const [submitting, setSubmitting] = React.useState(false)
  const inputId = React.useId()

  const submit = async (): Promise<void> => {
    const next = value.trim()
    if (!next || submitting) return
    setSubmitting(true)
    const closed = await onSubmit(next)
    if (!closed) setSubmitting(false)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor={inputId}>{label}</Label>
          <Input
            id={inputId}
            value={value}
            autoFocus
            disabled={submitting}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            {t('button.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || !value.trim()}>
            {t('button.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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

type PromptState =
  | { kind: 'rename-canvas'; canvas: CanvasSummary }
  | { kind: 'rename-folder'; node: CanvasTreeFolderNode }
  | { kind: 'new-folder'; parent: string | null }

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
  /** Opens the name dialog for a new folder at the canvases root. */
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
  const [prompt, setPrompt] = React.useState<PromptState | null>(null)
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

  const tree = React.useMemo(() => buildCanvasTree(canvases, folders), [canvases, folders])

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
   * Every mutation funnels through here so a typed folder failure reaches the
   * user as its translated sentence instead of dying in the console.
   */
  const run = React.useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      try {
        await action()
        return true
      } catch (err) {
        log.error('Canvas tree action failed', err)
        toast.error(extractErrorMessage(err, t('canvas.actionFailed')))
        return false
      }
    },
    [t]
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

  React.useImperativeHandle(
    ref,
    () => ({ createFolder: () => setPrompt({ kind: 'new-folder', parent: null }) }),
    []
  )

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

  const handleNewCanvas = React.useCallback(
    (path: string | null) => {
      void run(async () => {
        const created = await canvasService.create({ folder: path })
        if (path) setExpanded((previous) => new Set(previous).add(path))
        onCanvasClick?.(created)
      })
    },
    [onCanvasClick, run]
  )

  /**
   * The keyboard path to moving a folder. Drag and drop has none, so this is
   * the whole WCAG AA story for folder placement — and it has to mint the row
   * first for the same reason rename and set-icon do.
   */
  const handleFolderMove = React.useCallback(
    (target: CanvasTreeFolderNode, parent: string | null) => {
      void run(async () => {
        await ensureFolderRow(target.path, target.materialized)
        return canvasFolderService.move({ path: target.path, parent })
      })
    },
    [ensureFolderRow, run]
  )

  const handleSubmitPrompt = React.useCallback(
    async (value: string): Promise<boolean> => {
      if (!prompt) return true
      const ok = await run(async () => {
        if (prompt.kind === 'rename-canvas') {
          await canvasService.update({ id: prompt.canvas.id, title: value })
        } else if (prompt.kind === 'rename-folder') {
          await ensureFolderRow(prompt.node.path, prompt.node.materialized)
          await canvasFolderService.rename({ path: prompt.node.path, name: value })
        } else {
          await canvasFolderService.create({ parent: prompt.parent, name: value })
        }
      })
      if (!ok) return ok

      // A renamed folder's key IS its path, so it changed; the old row is gone
      // and Radix would restore focus to a detached node.
      if (prompt.kind === 'rename-canvas') {
        setPendingFocus([`canvas:${prompt.canvas.id}`])
      } else {
        const parent =
          prompt.kind === 'rename-folder' ? splitFolderPath(prompt.node.path).parent : prompt.parent
        setPendingFocus([`folder:${parent ? `${parent}/${value}` : value}`])
      }
      setPrompt(null)
      return ok
    },
    [ensureFolderRow, prompt, run]
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

  const promptCopy = React.useMemo(() => {
    if (!prompt) return null
    if (prompt.kind === 'rename-canvas') {
      return {
        title: t('canvas.renameTitle'),
        label: t('canvas.renameLabel'),
        initialValue: prompt.canvas.title ?? ''
      }
    }
    if (prompt.kind === 'rename-folder') {
      return {
        title: t('canvas.renameFolderTitle'),
        label: t('canvas.folderNameLabel'),
        initialValue: prompt.node.name
      }
    }
    return {
      title: t('canvas.newFolderTitle'),
      label: t('canvas.folderNameLabel'),
      initialValue: ''
    }
  }, [prompt, t])

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

  // Rendered beside every state below, the empty one included: the "New folder"
  // affordance a vault with nothing needs is useless without its name dialog.
  const dialogs = (
    <>
      {prompt && promptCopy && (
        <CanvasNameDialog
          title={promptCopy.title}
          label={promptCopy.label}
          initialValue={promptCopy.initialValue}
          onSubmit={handleSubmitPrompt}
          onCancel={() => setPrompt(null)}
        />
      )}

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
              onClick={() => setPrompt({ kind: 'new-folder', parent: null })}
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
                  onNewFolder={(path) => setPrompt({ kind: 'new-folder', parent: path })}
                  onSetIcon={(target, icon) => {
                    void run(async () => {
                      // The icon lives ONLY on the row, so a materialized folder
                      // needs one before it can carry an icon at all.
                      await ensureFolderRow(target.path, target.materialized)
                      return canvasFolderService.setIcon({ path: target.path, icon })
                    })
                  }}
                  onRename={(target) => setPrompt({ kind: 'rename-folder', node: target })}
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
              depth={node.depth}
              isActive={isActiveItem(sidebarItem)}
              folderOptions={folderOptions}
              onOpen={(target) => {
                onTargetFolderChange?.(target.folder ?? null)
                onCanvasClick?.(target)
              }}
              onRename={(target) => setPrompt({ kind: 'rename-canvas', canvas: target })}
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
