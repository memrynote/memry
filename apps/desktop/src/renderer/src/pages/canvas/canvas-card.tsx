/**
 * CanvasCard — an idle card: the entity rendered exactly as its editor renders
 * it, read-only.
 *
 * There is no separate "preview" layout any more. The idle card mounts the same
 * <CanvasCardBody> the active card does, with `interactive={false}`, so a
 * double-click only makes the leaves writable — nothing reflows, resizes, or
 * re-typesets. The cheap flattened render (CanvasCardSummary) survives only as
 * the level-of-detail fallback for far-out zoom / crowded scenes.
 *
 * The card body is pointer-events:none so canvas pan/draw/select passes through
 * to the underlying Excalidraw rectangle (which owns geometry, resize, and
 * arrow-binding), and `inert` keeps the read-only editor tree out of the focus
 * and accessibility trees. Only the ↗ redirect button is interactive.
 * Overflowing content is clipped with a bottom fade and scrolled imperatively by
 * the overlay's wheel handler (canvas-card-scroll.ts).
 */

import React from 'react'
import { ArrowUpRight, AlertTriangle } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import type { CanvasCardRef } from './canvas-cards'
import type { NoteLockReason } from './canvas-note-lock'
import type { CanvasEntityState } from './use-canvas-entities'
import { CanvasCardBody } from './canvas-card-body'
import { CanvasCardSummary } from './canvas-card-summary'

/** Marks the scroll container the overlay's wheel handler drives. */
export const CARD_SCROLL_ATTR = 'data-canvas-card-scroll'

interface CanvasCardProps {
  cardRef: CanvasCardRef
  state: CanvasEntityState | undefined
  onRedirect: (cardRef: CanvasCardRef) => void
  /**
   * False when the layer is in level-of-detail fallback (zoomed far out or too
   * many cards mounted) — the card draws the cheap summary instead.
   */
  rich?: boolean
  /**
   * Non-null when in-place editing is unavailable for this card (the same note
   * is live in a visible tab, or another card already owns it). The card still
   * renders its content in full; it just cannot be activated, and it points at
   * the surface that can edit.
   */
  locked?: NoteLockReason | null
}

const CanvasCardInner = ({
  cardRef,
  state,
  onRedirect,
  rich = true,
  locked
}: CanvasCardProps): React.JSX.Element => {
  const { t } = useT('common')

  const handleRedirect = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    onRedirect(cardRef)
  }

  const dangling = state?.status === 'dangling'
  const ready = state?.status === 'ready' ? state : null

  return (
    <div
      className={cn(
        'group/card pointer-events-none relative flex h-full w-full flex-col overflow-hidden rounded-md border bg-white text-start shadow-sm dark:bg-zinc-900',
        dangling ? 'border-dashed border-destructive/50' : 'border-border'
      )}
      data-canvas-card-id={cardRef.elementId}
      data-canvas-card-entity={`${cardRef.entityType}:${cardRef.entityId}`}
      data-canvas-card-state={state?.status ?? 'loading'}
      data-canvas-card-locked={locked ? 'true' : undefined}
    >
      {/* Redirect button — the one interactive region on an idle card. */}
      <button
        type="button"
        data-canvas-redirect=""
        onClick={handleRedirect}
        onPointerDown={(e) => e.stopPropagation()}
        className="pointer-events-auto absolute end-1.5 top-1.5 z-10 flex size-6 items-center justify-center rounded-md bg-background/70 text-text-secondary opacity-0 shadow-sm transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100"
        aria-label={t('canvas.card.open')}
      >
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
      </button>

      {dangling ? (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 p-3 text-center">
          <AlertTriangle className="size-4 text-destructive/70" aria-hidden="true" />
          <span className="text-xs text-text-tertiary">{t('canvas.card.deleted')}</span>
        </div>
      ) : !ready ? (
        <div className="flex h-full items-center justify-center p-3">
          <span className="text-xs text-text-tertiary">{t('canvas.card.loading')}</span>
        </div>
      ) : rich ? (
        <div
          {...{ [CARD_SCROLL_ATTR]: cardRef.elementId }}
          // overflow-hidden (not auto) keeps the scrollbar and native wheel
          // handling out of the way: the overlay scrolls this element
          // imperatively so an un-scrollable card still zooms the canvas.
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]"
          // The read-only editor tree must never take focus or appear to screen
          // readers as an editable surface while the card is idle.
          inert
        >
          <CanvasCardBody cardRef={cardRef} state={state} interactive={false} />
        </div>
      ) : (
        <CanvasCardSummary state={ready} />
      )}
      {locked ? (
        <button
          type="button"
          data-canvas-redirect=""
          onClick={handleRedirect}
          onPointerDown={(e) => e.stopPropagation()}
          className="pointer-events-auto flex w-full shrink-0 items-center justify-center gap-1 border-t border-border bg-muted/60 px-2 py-1 text-[10px] font-medium text-text-secondary hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ArrowUpRight className="size-3" aria-hidden="true" />
          {t('canvas.card.openToEdit')}
        </button>
      ) : null}
    </div>
  )
}

export const CanvasCard = React.memo(CanvasCardInner)
