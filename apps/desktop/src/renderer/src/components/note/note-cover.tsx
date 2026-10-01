/**
 * The cover band: a full-bleed strip across the top of a note.
 *
 * Two kinds share one box. An image cover paints a photo the reader can frame:
 * drag its focal point, zoom around it, and drag the band's bottom edge to set
 * its height. A wash cover paints a gradient from a fixed pigment table. A photo
 * that fails to load falls back to a wash keyed off the note id, so a moved or
 * deleted file leaves a calm colour rather than a broken image.
 *
 * @module components/note/note-cover
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent
} from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  MAX_COVER_HEIGHT,
  MAX_COVER_ZOOM,
  MIN_COVER_HEIGHT,
  MIN_COVER_ZOOM,
  clampCoverFocus,
  clampCoverHeight,
  clampCoverZoom,
  coverWashForSeed,
  coverWashGradient,
  type CoverFraming,
  type CoverValue
} from '@memry/shared/cover-image'
import { Image, Move, X, ZoomIn, ZoomOut } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import { useVault } from '@/hooks/use-vault'
import { resolveNoteRelativeUrl } from '@/lib/resolve-note-relative-url'

export interface NoteCoverProps {
  cover: CoverValue
  noteId: string
  notePath: string
  /** Focal point, zoom and band height; see `CoverFraming`. */
  framing: CoverFraming
  credit?: string | null
  creditUrl?: string | null
  onChange: (event: ReactMouseEvent<HTMLElement>) => void
  onRemove: () => void
  /** Called on save with only the framing fields that changed. */
  onFramingChange: (changes: Partial<CoverFraming>) => void
  /** Reposition is controlled so the picker's "Apply & reposition" can start it. */
  repositioning?: boolean
  onRepositioningChange?: (repositioning: boolean) => void
  disabled?: boolean
}

const REVEAL_CLASS = cn(
  'opacity-0 transition-opacity duration-150 motion-reduce:transition-none',
  'group-hover/cover:opacity-100 group-focus-within/cover:opacity-100'
)

const TOOLBAR_BUTTON_CLASS = cn(
  'flex items-center gap-1.5 rounded-md px-2 py-1',
  'text-[12px] font-medium text-text-tertiary',
  'transition-colors duration-150 motion-reduce:transition-none',
  'hover:text-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  'disabled:pointer-events-none disabled:opacity-50'
)

const NUDGE_STEP = 2
const ZOOM_STEP = 0.1
const HEIGHT_STEP = 8

const FRAMING_FIELDS = ['focusX', 'focusY', 'zoom', 'height'] as const

/** Where the pointer sits in the band, as a focal point in percent. */
function focusFromPointer(
  rect: DOMRect,
  clientX: number,
  clientY: number
): Pick<CoverFraming, 'focusX' | 'focusY'> {
  return {
    focusX: rect.width === 0 ? 50 : clampCoverFocus(((clientX - rect.left) / rect.width) * 100),
    focusY: rect.height === 0 ? 50 : clampCoverFocus(((clientY - rect.top) / rect.height) * 100)
  }
}

/** The fields of `draft` that differ from `original`. */
function changedFraming(original: CoverFraming, draft: CoverFraming): Partial<CoverFraming> {
  const changes: Partial<CoverFraming> = {}
  for (const field of FRAMING_FIELDS) {
    if (draft[field] !== original[field]) changes[field] = draft[field]
  }
  return changes
}

export const NoteCover = memo(function NoteCover({
  cover,
  noteId,
  notePath,
  framing,
  credit,
  creditUrl,
  onChange,
  onRemove,
  onFramingChange,
  repositioning = false,
  onRepositioningChange,
  disabled = false
}: NoteCoverProps) {
  const { t } = useT('notes')
  const { vaultPath } = useVault()
  const bandRef = useRef<HTMLDivElement | null>(null)

  const src =
    cover.kind === 'image' ? resolveNoteRelativeUrl(cover.ref, notePath, vaultPath, noteId) : null

  // Keyed on the source so switching covers retries the new one rather than
  // inheriting the previous image's failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showWash = cover.kind === 'wash' || src === null || failedSrc === src

  // The drag's own copy of the framing, plus the value `esc` restores. Derived
  // during render from the controlled flag so no effect has to chase it.
  const [drag, setDrag] = useState<{ original: CoverFraming; draft: CoverFraming } | null>(() =>
    repositioning ? { original: framing, draft: framing } : null
  )
  const [wasRepositioning, setWasRepositioning] = useState(repositioning)
  if (wasRepositioning !== repositioning) {
    setWasRepositioning(repositioning)
    setDrag(repositioning ? { original: framing, draft: framing } : null)
  }

  const canReposition = cover.kind === 'image' && !showWash && !disabled
  const isRepositioning = repositioning && canReposition && drag !== null
  const applied = drag?.draft ?? framing

  const updateDraft = useCallback((changes: Partial<CoverFraming>) => {
    setDrag((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...changes } }
    )
  }, [])

  // Keys only reach the band once it holds focus, and reposition can start from
  // the picker, where nothing on the band was ever clicked.
  useEffect(() => {
    // Not an event handler in disguise: reposition can start from the picker's
    // "Apply & reposition", where no event on this band ever fired.
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler
    if (isRepositioning) bandRef.current?.focus()
  }, [isRepositioning])

  const stopReposition = useCallback(() => onRepositioningChange?.(false), [onRepositioningChange])

  const commit = useCallback(() => {
    if (drag) {
      const changes = changedFraming(drag.original, drag.draft)
      if (Object.keys(changes).length > 0) onFramingChange(changes)
    }
    stopReposition()
  }, [drag, onFramingChange, stopReposition])

  // The draft never left this component, so leaving reposition is enough. Writing
  // the original back would dirty the note, and a dirty note syncs.
  const cancel = stopReposition

  const trackPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const rect = bandRef.current?.getBoundingClientRect()
      if (!rect) return
      updateDraft(focusFromPointer(rect, event.clientX, event.clientY))
    },
    [updateDraft]
  )

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!isRepositioning) return
      event.currentTarget.setPointerCapture(event.pointerId)
      trackPointer(event)
    },
    [isRepositioning, trackPointer]
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!isRepositioning || !event.currentTarget.hasPointerCapture(event.pointerId)) return
      trackPointer(event)
    },
    [isRepositioning, trackPointer]
  )

  // The bottom edge sets the height from where the band starts, so the edge
  // follows the pointer while the band grows under it.
  const handleResizePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const handleResizePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.stopPropagation()
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      const rect = bandRef.current?.getBoundingClientRect()
      if (!rect) return
      updateDraft({ height: clampCoverHeight(event.clientY - rect.top) })
    },
    [updateDraft]
  )

  const zoomBy = (delta: number) => updateDraft({ zoom: clampCoverZoom(applied.zoom + delta) })

  const washId = cover.kind === 'wash' ? cover.id : coverWashForSeed(noteId)
  // Scaled around the focal point, so zooming keeps the chosen subject in place.
  const imageStyle: CSSProperties = {
    objectPosition: `${applied.focusX}% ${applied.focusY}%`,
    ...(applied.zoom !== 1
      ? {
          transform: `scale(${applied.zoom})`,
          transformOrigin: `${applied.focusX}% ${applied.focusY}%`
        }
      : {})
  }

  return (
    <div
      ref={bandRef}
      className={cn(
        'group/cover relative w-full overflow-hidden border-b border-border bg-muted',
        isRepositioning && 'cursor-move select-none'
      )}
      style={{ height: applied.height }}
      data-testid="note-cover"
      data-cover-kind={showWash ? 'wash' : 'image'}
      data-repositioning={isRepositioning || undefined}
      tabIndex={isRepositioning ? 0 : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      // Leaving the band is a save, not a trap: without this the only way out of
      // reposition is the keyboard, and every click lands on a band that still
      // shows the resize cursor and hides its own toolbar.
      onBlur={(event) => {
        if (!isRepositioning) return
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return
        commit()
      }}
      onKeyDown={(event) => {
        if (!isRepositioning) return
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && event.shiftKey) {
          event.preventDefault()
          const delta = event.key === 'ArrowUp' ? -HEIGHT_STEP : HEIGHT_STEP
          updateDraft({ height: clampCoverHeight(applied.height + delta) })
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          const delta = event.key === 'ArrowUp' ? -NUDGE_STEP : NUDGE_STEP
          updateDraft({ focusY: clampCoverFocus(applied.focusY + delta) })
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          // The photo is never mirrored, so left is the photo's left in RTL too.
          event.preventDefault()
          const delta = event.key === 'ArrowLeft' ? -NUDGE_STEP : NUDGE_STEP
          updateDraft({ focusX: clampCoverFocus(applied.focusX + delta) })
        } else if (event.key === '+' || event.key === '=') {
          event.preventDefault()
          zoomBy(ZOOM_STEP)
        } else if (event.key === '-') {
          event.preventDefault()
          zoomBy(-ZOOM_STEP)
        }
      }}
    >
      {showWash ? (
        <div
          data-testid="note-cover-wash"
          className="h-full w-full"
          style={{ backgroundImage: coverWashGradient(washId) }}
        />
      ) : (
        <img
          src={src ?? undefined}
          alt={t('cover.alt')}
          draggable={false}
          onError={() => setFailedSrc(src)}
          className="h-full w-full object-cover"
          style={imageStyle}
        />
      )}

      {credit && creditUrl && (
        <a
          href={creditUrl}
          target="_blank"
          rel="noreferrer"
          data-testid="note-cover-credit"
          className={cn(
            'absolute bottom-3 start-3 rounded-md px-2 py-1',
            'border border-border bg-background/92',
            'text-[11px] text-text-tertiary hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            REVEAL_CLASS
          )}
        >
          {t('cover.credit', { name: credit })}
        </a>
      )}

      {isRepositioning && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('cover.resize')}
          aria-valuemin={MIN_COVER_HEIGHT}
          aria-valuemax={MAX_COVER_HEIGHT}
          aria-valuenow={applied.height}
          title={t('cover.resize')}
          data-testid="note-cover-resize-handle"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          className="absolute inset-x-0 bottom-0 flex h-2 cursor-ns-resize justify-center"
        >
          <span aria-hidden className="mt-0.5 h-1 w-10 rounded-full bg-background/92" />
        </div>
      )}

      {isRepositioning ? (
        <div
          data-testid="note-cover-reposition-hint"
          // The band treats a press as the start of a drag, so a press that
          // lands on save or cancel must not also move the focal point.
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            'absolute bottom-3 end-3 flex items-center gap-0.5',
            'rounded-lg border border-border bg-background/92 p-0.5'
          )}
        >
          <span className="px-2 py-1 text-[12px] text-text-tertiary">
            {t('cover.repositionHint')}
          </span>
          {/* `aria-disabled`, not `disabled`: a focused button that disables itself
              drops focus off the band, which would save and leave reposition. At
              a bound the click is already a no-op through the clamp. */}
          <button
            type="button"
            onClick={() => zoomBy(-ZOOM_STEP)}
            aria-disabled={applied.zoom <= MIN_COVER_ZOOM}
            aria-label={t('cover.zoomOut')}
            className={cn(TOOLBAR_BUTTON_CLASS, 'px-1.5 aria-disabled:opacity-50')}
            data-testid="note-cover-zoom-out"
          >
            <ZoomOut className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(ZOOM_STEP)}
            aria-disabled={applied.zoom >= MAX_COVER_ZOOM}
            aria-label={t('cover.zoomIn')}
            className={cn(TOOLBAR_BUTTON_CLASS, 'px-1.5 aria-disabled:opacity-50')}
            data-testid="note-cover-zoom-in"
          >
            <ZoomIn className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={commit}
            className={TOOLBAR_BUTTON_CLASS}
            data-testid="note-cover-reposition-save"
          >
            <Kbd>{'\u21b5'}</Kbd>
            {t('cover.repositionSave')}
          </button>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={cancel}
            className={TOOLBAR_BUTTON_CLASS}
            data-testid="note-cover-reposition-cancel"
          >
            <Kbd>{'esc'}</Kbd>
            {t('cover.repositionCancel')}
          </button>
        </div>
      ) : (
        <div
          className={cn(
            'absolute bottom-3 end-3 flex items-center gap-0.5',
            'rounded-lg border border-border bg-background/92 p-0.5',
            REVEAL_CLASS
          )}
        >
          <button
            type="button"
            disabled={disabled}
            onClick={onChange}
            className={TOOLBAR_BUTTON_CLASS}
          >
            <Image className="h-3 w-3" strokeWidth={2} />
            {t('cover.change')}
          </button>
          {canReposition && (
            <button
              type="button"
              onClick={() => onRepositioningChange?.(true)}
              className={TOOLBAR_BUTTON_CLASS}
            >
              <Move className="h-3 w-3" strokeWidth={2} />
              {t('cover.reposition')}
            </button>
          )}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            disabled={disabled}
            onClick={onRemove}
            aria-label={t('cover.remove')}
            className={cn(TOOLBAR_BUTTON_CLASS, 'px-1.5')}
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  )
})
