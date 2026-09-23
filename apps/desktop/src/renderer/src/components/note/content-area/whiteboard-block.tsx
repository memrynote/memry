import React, { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { createReactBlockSpec } from '@blocknote/react'
import { whiteboardConfig, whiteboardUrl } from '@memry/editor-schema/blocks'
import { blockExternalHTML } from '@memry/editor-schema/server'
import { useT } from '@memry/i18n/renderer'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTabActions } from '@/contexts/tabs'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { Check, ExternalLink, Pencil, PenTool } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { tabFromMemryHref } from '@/lib/memry-links'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import type { CanvasEditorHandle } from '@/pages/canvas/canvas-editor'
import { InsideCanvasSurfaceContext } from '@/pages/canvas/canvas-surface-context'
import {
  canvasService,
  onCanvasCreated,
  onCanvasDeleted,
  onCanvasUpdated,
  type Canvas
} from '@/services/canvas-service'
import type { EditorSchema } from './editor-schema'

/**
 * The block reuses the canvas tab's own editor — persistence, image
 * externalization, cards, links, the agent live registry — rather than a
 * second Excalidraw integration. Lazy for the reason `CanvasPage` lazy-loads
 * it: @excalidraw/excalidraw and its CSS stay out of the main bundle, and are
 * never fetched while the flag is off or no board is on screen.
 */
const LazyCanvasEditor = React.lazy(async () => ({
  default: (await import('@/pages/canvas/canvas-editor')).CanvasEditor
}))

const log = createLogger('WhiteboardBlock')

/**
 * Boards this window just created with `/whiteboard`. A new board opens ready
 * to draw on; every other board opens in view mode, so scrolling past one
 * never lands the pointer on a live drawing surface.
 */
const freshBoards = new Set<string>()

interface WhiteboardNode {
  props: { canvasId: string }
}

type BoardState =
  | { status: 'loading' }
  // `revision` keys the mounted editor: Excalidraw reads its scene once, at
  // mount, so a change made elsewhere is shown by mounting a fresh one.
  | { status: 'ready'; canvas: Canvas; revision: number }
  | { status: 'missing' }
  | { status: 'failed'; error: unknown }

export function WhiteboardBlockRenderer({ block }: { block: WhiteboardNode }): React.JSX.Element {
  const { t } = useT('notes')
  const canvasId = block.props.canvasId
  const insideCanvas = useContext(InsideCanvasSurfaceContext)
  const { flags, isLoading: flagsLoading } = useFeatureFlags()
  const { openTab } = useTabActions()
  const enabled = flags.spatialCanvas

  const [board, setBoard] = useState<BoardState>({ status: 'loading' })
  const [title, setTitle] = useState<string | null>(null)
  const [editing, setEditing] = useState(() => freshBoards.has(canvasId))
  const editorRef = useRef<CanvasEditorHandle>(null)
  const editingRef = useRef(editing)
  /** Set while Done is saving and re-reading the board; see `finishEditing`. */
  const settlingRef = useRef(false)

  useEffect(() => {
    editingRef.current = editing
  }, [editing])

  useEffect(() => {
    freshBoards.delete(canvasId)
  }, [canvasId])

  useEffect(() => {
    if (!enabled || !canvasId) return
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const canvas = await canvasService.get(canvasId)
        if (cancelled) return
        if (!canvas) {
          setBoard({ status: 'missing' })
          return
        }
        setTitle(canvas.title)
        setBoard((current) => {
          if (current.status !== 'ready') return { status: 'ready', canvas, revision: 0 }
          // A rename, or bytes this board already shows, needs no fresh editor.
          const { scene, unreadable } = current.canvas
          if (scene === canvas.scene && unreadable === canvas.unreadable) return current
          return { status: 'ready', canvas, revision: current.revision + 1 }
        })
      } catch (err) {
        if (cancelled) return
        log.error('Failed to load whiteboard canvas', err)
        trackRendererError('whiteboard_load', err)
        setBoard({ status: 'failed', error: err })
      }
    }

    // While the board is being edited here it is the newest copy there is, and
    // every save it makes echoes back as an update; a remount would throw the
    // live surface away mid-stroke. Done re-reads it once instead.
    const reload = (): void => {
      if (editingRef.current || settlingRef.current) return
      void load()
    }

    void load()
    const offUpdated = onCanvasUpdated(({ canvas }) => {
      if (canvas.id !== canvasId) return
      setTitle(canvas.title)
      reload()
    })
    // A note can reach a device before the board it embeds; the board then
    // arrives as a created canvas.
    const offCreated = onCanvasCreated(({ canvas }) => {
      if (canvas.id === canvasId) reload()
    })
    const offDeleted = onCanvasDeleted(({ id }) => {
      if (id !== canvasId) return
      setEditing(false)
      setBoard({ status: 'missing' })
    })
    return () => {
      cancelled = true
      offUpdated()
      offCreated()
      offDeleted()
    }
  }, [enabled, canvasId])

  /**
   * Saves, leaves edit mode, and re-reads the board without remounting it.
   *
   * The save runs while the surface is still editable and mounted, so nothing
   * drawn in the last debounce window is lost. The re-read hands the editor
   * the bytes now on disk as its new baseline; without it the next Edit would
   * rewrite an unchanged scene the first time anything on it moved.
   */
  const finishEditing = useCallback(async (): Promise<void> => {
    settlingRef.current = true
    try {
      await editorRef.current?.flush()
      setEditing(false)
      const canvas = await canvasService.get(canvasId)
      if (canvas) {
        setBoard((current) => (current.status === 'ready' ? { ...current, canvas } : current))
      }
    } catch (err) {
      log.error('Failed to re-read whiteboard after editing', err)
    } finally {
      settlingRef.current = false
    }
  }, [canvasId])

  const displayTitle = title || t('editor.whiteboard.untitled')

  const openInTab = async (): Promise<void> => {
    // Two live editors on one canvas are last-write-wins, so the tab takes
    // over from this one rather than racing it.
    if (editingRef.current) await finishEditing()
    const href = whiteboardUrl(canvasId)
    const tab = tabFromMemryHref(href, { title: displayTitle, now: Date.now() })
    if (tab) openTab(tab)
  }

  if (!canvasId) {
    return (
      <WhiteboardFrame>
        <WhiteboardNotice withIcon body={t('editor.whiteboard.noCanvas')} />
      </WhiteboardFrame>
    )
  }

  if (!enabled) {
    return (
      <WhiteboardFrame>
        {flagsLoading ? (
          <Skeleton className="h-[420px] w-full rounded-xl" />
        ) : (
          <WhiteboardNotice
            withIcon
            title={t('editor.whiteboard.disabledTitle')}
            body={t('editor.whiteboard.disabledBody')}
          />
        )}
      </WhiteboardFrame>
    )
  }

  const ready = board.status === 'ready' && !board.canvas.unreadable ? board : null
  const header = (
    <div className="flex items-center gap-2 pb-1.5">
      <PenTool className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
        {board.status === 'loading' ? t('editor.whiteboard.loading') : displayTitle}
      </span>
      {board.status === 'ready' ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => void openInTab()}
        >
          <ExternalLink />
          {t('editor.whiteboard.openInTab')}
        </Button>
      ) : null}
      {ready && !insideCanvas ? (
        <Button
          type="button"
          variant={editing ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 px-2"
          onClick={() => (editing ? void finishEditing() : setEditing(true))}
        >
          {editing ? <Check /> : <Pencil />}
          {editing ? t('editor.whiteboard.done') : t('editor.whiteboard.edit')}
        </Button>
      ) : null}
    </div>
  )

  if (insideCanvas) {
    return (
      <WhiteboardFrame>
        {header}
        <WhiteboardNotice body={t('editor.whiteboard.nested')} />
      </WhiteboardFrame>
    )
  }

  if (board.status === 'loading') {
    return (
      <WhiteboardFrame>
        {header}
        <Skeleton className="h-[420px] w-full rounded-xl" />
      </WhiteboardFrame>
    )
  }

  // No header on these two: there is no title to show, and nothing to open.
  if (board.status === 'missing') {
    return (
      <WhiteboardFrame>
        <WhiteboardNotice
          withIcon
          title={t('editor.whiteboard.missingTitle')}
          body={t('editor.whiteboard.missingBody')}
        />
      </WhiteboardFrame>
    )
  }

  if (board.status === 'failed') {
    return (
      <WhiteboardFrame>
        <WhiteboardNotice
          withIcon
          body={extractErrorMessage(board.error, t('editor.whiteboard.loadFailed'))}
          destructive
        />
      </WhiteboardFrame>
    )
  }

  // Same rule as CanvasPage: an index row whose document cannot be read here
  // must not mount an editor, whose first autosave would write an empty scene
  // over ink that is still recoverable.
  if (!ready) {
    return (
      <WhiteboardFrame>
        {header}
        <WhiteboardNotice
          title={t('editor.whiteboard.unreadableTitle')}
          body={t('editor.whiteboard.unreadableBody')}
        />
      </WhiteboardFrame>
    )
  }

  return (
    <WhiteboardFrame>
      {header}
      <div
        className="whiteboard-surface relative h-[420px] w-full overflow-hidden rounded-xl border border-border"
        role="group"
        aria-label={t('editor.whiteboard.surfaceLabel', { title: displayTitle })}
        data-whiteboard-editing={editing ? 'true' : undefined}
        // In view mode the board is a picture in the note, and a picture does
        // not take the note's scroll: Excalidraw pans on every wheel event
        // over it. A pinch (or Ctrl/Cmd+wheel) still zooms. Stopped in the
        // capture phase so the event never reaches Excalidraw's own listener.
        onWheelCapture={(event) => {
          if (!editing && !event.ctrlKey && !event.metaKey) event.stopPropagation()
        }}
        // Leaving the board is the last moment its strokes can be saved from
        // a live surface: a tab switch unmounts the note, and by the time the
        // editor's own teardown flush runs Excalidraw has already emptied its
        // scene (which that flush rightly refuses to save).
        onBlur={(event) => {
          const next = event.relatedTarget
          if (editing && !(next instanceof Node && event.currentTarget.contains(next))) {
            void editorRef.current?.flush()
          }
        }}
      >
        <React.Suspense fallback={<Skeleton className="h-full w-full rounded-none" />}>
          <LazyCanvasEditor
            key={`${ready.canvas.id}:${ready.revision}`}
            ref={editorRef}
            canvasId={ready.canvas.id}
            initialScene={ready.canvas.scene}
            embed={{ editing }}
          />
        </React.Suspense>
      </div>
    </WhiteboardFrame>
  )
}

/**
 * The block's root. Everything inside is the board's, not the note's:
 *
 * - `data-marquee-ignore`: a press on the board is a stroke, not the start of
 *   a block marquee.
 * - `onKeyDown` stops at the block: Excalidraw's own key handler has run by the
 *   time a key reaches here (React delegates it from the same root), so what
 *   is left are the note's and the app's bubble-phase shortcuts — Cmd+Z would
 *   otherwise also pop the app's undo stack. ProseMirror itself never sees
 *   these events: the spec is non-selectable (see `createWhiteboardBlock`).
 */
function WhiteboardFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="whiteboard-block my-2 w-full"
      contentEditable={false}
      data-marquee-ignore=""
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}

/** A board that cannot be drawn here, said in the frame the drawing would use. */
function WhiteboardNotice({
  title,
  body,
  destructive = false,
  withIcon = false
}: {
  title?: string
  body: string
  destructive?: boolean
  /** Only where no header above already carries the whiteboard icon. */
  withIcon?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border px-3 py-2.5 text-sm">
      {withIcon ? (
        <PenTool className="mt-0.5 size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
      ) : null}
      <div className="min-w-0">
        {title ? <p className="font-medium text-foreground">{title}</p> : null}
        <p className={destructive ? 'text-destructive' : 'text-text-tertiary'}>{body}</p>
      </div>
    </div>
  )
}

/**
 * What reaches the vault is the shared package's DOM (`blockExternalHTML`), so
 * this editor and the main process write the same `![whiteboard](…)` line. A
 * React spec's `toExternalHTML` is a component, so the package's nodes are
 * moved into the one element this renders rather than restated as JSX.
 */
function WhiteboardExternalHTML({ block }: { block: WhiteboardNode }): React.JSX.Element {
  return (
    <div
      ref={(element) => {
        element?.replaceChildren(...blockExternalHTML.whiteboard(block).dom.childNodes)
      }}
    />
  )
}

// Type/props/content come from the shared package so the main process
// registers the same node. Non-selectable, which is what makes the board an
// island inside the note: BlockNote then answers ProseMirror's `stopEvent` with
// true for every event from inside the block, so a key, paste, drop or press on
// the drawing never edits — or node-selects and replaces — the note around it.
export const createWhiteboardBlock = createReactBlockSpec(whiteboardConfig, {
  meta: { selectable: false },
  // Keyed by canvas id so a block re-pointed at another canvas (undo, a synced
  // edit) starts over rather than carrying one board's edit state to the next.
  render: (props) => {
    const block = props.block as WhiteboardNode
    return <WhiteboardBlockRenderer key={block.props.canvasId} block={block} />
  },
  toExternalHTML: (props) => <WhiteboardExternalHTML block={props.block as WhiteboardNode} />
})

type WhiteboardEditor = EditorSchema['BlockNoteEditor']

/**
 * `/whiteboard`: a new canvas owned by this note, drawn right where the slash
 * was typed.
 *
 * The canvas is created FIRST and the block written with its id after: a block
 * with an empty `canvasId` writes nothing to disk, so a board inserted ahead of
 * its canvas would vanish on the next save if the create failed.
 */
export function getWhiteboardSlashMenuItem(
  editor: WhiteboardEditor,
  noteId: string,
  labels: { title: string; group: string; subtext: string },
  resolveNoteTitle: () => Promise<string | undefined>
) {
  return {
    title: labels.title,
    onItemClick: async () => {
      // Captured before the awaits: the caret can move while the canvas is
      // being created, and the board belongs where the slash was typed.
      const originId = editor.getTextCursorPosition().block.id
      const tNotes = getI18n().getFixedT(null, 'notes')

      let canvasId: string
      try {
        const noteTitle = (await resolveNoteTitle())?.trim()
        const title = noteTitle
          ? tNotes('editor.whiteboard.noteName', { note: noteTitle })
          : tNotes('editor.whiteboard.defaultName')
        canvasId = (await canvasService.create({ title, ownerNoteId: noteId })).id
      } catch (err) {
        log.error('Failed to create whiteboard canvas', err)
        trackRendererError('whiteboard_create', err)
        toast.error(extractErrorMessage(err, tNotes('editor.whiteboard.createFailed')))
        return
      }

      freshBoards.add(canvasId)
      if (editor.getBlock(originId)) editor.setTextCursorPosition(originId, 'end')
      insertOrUpdateBlockForSlashMenu(editor, { type: 'whiteboard', props: { canvasId } })
    },
    aliases: ['whiteboard', 'canvas', 'excalidraw', 'draw', 'sketch', 'board'],
    group: labels.group,
    subtext: labels.subtext
  }
}
