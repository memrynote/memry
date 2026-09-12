/**
 * The cover band: a full-bleed strip across the top of a note.
 *
 * Two kinds share one box. An image cover paints a photo whose vertical focus
 * the reader can drag; a wash cover paints a gradient from a fixed pigment
 * table. A photo that fails to load falls back to a wash keyed off the note id,
 * so a moved or deleted file leaves a calm colour rather than a broken image.
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
  type PointerEvent
} from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  clampCoverFocus,
  coverWashForSeed,
  coverWashGradient,
  type CoverValue
} from '@memry/shared/cover-image'
import { Image, Move, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import { useVault } from '@/hooks/use-vault'
import { resolveNoteRelativeUrl } from '@/lib/resolve-note-relative-url'

export interface NoteCoverProps {
  cover: CoverValue
  noteId: string
  notePath: string
  /** Vertical focus of an image cover, 0 (top) to 100 (bottom). */
  focus: number
  credit?: string | null
  creditUrl?: string | null
  onChange: () => void
  onRemove: () => void
  onFocusChange: (focus: number) => void
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

/** Where the pointer sits down the band, as a focus percentage. */
function focusFromPointer(rect: DOMRect, clientY: number): number {
  if (rect.height === 0) return 50
  return clampCoverFocus(((clientY - rect.top) / rect.height) * 100)
}

export const NoteCover = memo(function NoteCover({
  cover,
  noteId,
  notePath,
  focus,
  credit,
  creditUrl,
  onChange,
  onRemove,
  onFocusChange,
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

  // The drag's own copy of the focus, plus the value `esc` restores. Derived
  // during render from the controlled flag so no effect has to chase it.
  const [drag, setDrag] = useState<{ original: number; draft: number } | null>(() =>
    repositioning ? { original: focus, draft: focus } : null
  )
  const [wasRepositioning, setWasRepositioning] = useState(repositioning)
  if (wasRepositioning !== repositioning) {
    setWasRepositioning(repositioning)
    setDrag(repositioning ? { original: focus, draft: focus } : null)
  }

  const canReposition = cover.kind === 'image' && !showWash && !disabled
  const isRepositioning = repositioning && canReposition && drag !== null
  const appliedFocus = drag?.draft ?? focus

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
    if (drag && drag.draft !== drag.original) onFocusChange(drag.draft)
    stopReposition()
  }, [drag, onFocusChange, stopReposition])

  const cancel = useCallback(() => {
    if (drag && drag.draft !== drag.original) onFocusChange(drag.original)
    stopReposition()
  }, [drag, onFocusChange, stopReposition])

  const trackPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const rect = bandRef.current?.getBoundingClientRect()
      if (!rect) return
      const next = focusFromPointer(rect, event.clientY)
      setDrag((current) => (current === null ? current : { ...current, draft: next }))
    },
    [setDrag]
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

  const washId = cover.kind === 'wash' ? cover.id : coverWashForSeed(noteId)

  return (
    <div
      ref={bandRef}
      className={cn(
        'group/cover relative h-[200px] w-full overflow-hidden border-b border-border bg-muted',
        isRepositioning && 'cursor-ns-resize select-none'
      )}
      data-testid="note-cover"
      data-cover-kind={showWash ? 'wash' : 'image'}
      data-repositioning={isRepositioning || undefined}
      tabIndex={isRepositioning ? 0 : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onKeyDown={(event) => {
        if (!isRepositioning) return
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          const delta = event.key === 'ArrowUp' ? -NUDGE_STEP : NUDGE_STEP
          setDrag((current) =>
            current === null
              ? current
              : { ...current, draft: clampCoverFocus(current.draft + delta) }
          )
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
          style={{ objectPosition: `50% ${appliedFocus}%` } as CSSProperties}
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

      {isRepositioning ? (
        <div
          data-testid="note-cover-reposition-hint"
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-1/2 mx-auto w-fit translate-y-1/2',
            'flex items-center gap-2 rounded-lg px-3 py-1.5',
            'border border-border bg-background/92 text-[12px] text-text-tertiary'
          )}
        >
          {t('cover.repositionHint')}
          <span className="flex items-center gap-1">
            <Kbd>{'\u21b5'}</Kbd>
            {t('cover.repositionSave')}
          </span>
          <span aria-hidden>{'\u00b7'}</span>
          <span className="flex items-center gap-1">
            <Kbd>{'esc'}</Kbd>
            {t('cover.repositionCancel')}
          </span>
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
