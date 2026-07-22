/**
 * CanvasCard — read-only preview rendered over one card rectangle.
 *
 * The card body is pointer-events:none so canvas pan/draw/select passes through
 * to the underlying Excalidraw rectangle (which owns geometry, resize, and
 * arrow-binding). Only the ↗ redirect button is interactive. Idle previews are
 * static markdown-rendered React (no editor mounted) per the M2 perf strategy.
 */

import React from 'react'
import { ArrowUpRight, CheckCircle, Circle, CalendarClock, AlertTriangle } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { renderTaskDescriptionMarkdown } from '@/components/tasks/task-description-preview'
import { useT } from '@memry/i18n/renderer'
import { formatEventTime, type CanvasCardRef } from './canvas-cards'
import type { NoteLockReason } from './canvas-note-lock'
import type { CanvasEntityState } from './use-canvas-entities'

interface CanvasCardProps {
  cardRef: CanvasCardRef
  state: CanvasEntityState | undefined
  onRedirect: (cardRef: CanvasCardRef) => void
  /**
   * Non-null when in-place editing is unavailable for this card (the same note
   * is live in a visible tab, or another card already owns it). The card stays
   * a read-only preview and points at the surface that can edit.
   */
  locked?: NoteLockReason | null
}

function formatDueDate(dueDate: string | null): string | null {
  if (!dueDate) return null
  const parsed = new Date(`${dueDate}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return dueDate
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const CanvasCardInner = ({
  cardRef,
  state,
  onRedirect,
  locked
}: CanvasCardProps): React.JSX.Element => {
  const { t } = useT('common')

  const handleRedirect = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    onRedirect(cardRef)
  }

  const dangling = state?.status === 'dangling'

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
      ) : state?.status === 'ready' && state.kind === 'note' ? (
        <div className="flex h-full flex-col gap-1.5 p-3">
          <div className="flex items-center gap-1.5">
            {state.emoji ? (
              <NoteIconDisplay
                value={state.emoji}
                className="flex size-4 shrink-0 items-center justify-center text-sm"
              />
            ) : null}
            <h3 className="truncate text-[13px] font-semibold text-foreground">
              {state.title || t('canvas.card.untitled')}
            </h3>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden text-[11px] leading-snug text-text-secondary">
            <p className="line-clamp-6 whitespace-pre-wrap break-words">
              {renderTaskDescriptionMarkdown(state.body)}
            </p>
          </div>
        </div>
      ) : state?.status === 'ready' && state.kind === 'task' ? (
        <div className="flex h-full flex-col justify-center gap-1.5 p-3">
          <div className="flex items-start gap-1.5">
            {state.completed ? (
              <CheckCircle className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <Circle className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
            )}
            <span
              className={cn(
                'text-[13px] font-medium',
                state.completed ? 'text-text-tertiary line-through' : 'text-foreground'
              )}
            >
              {state.title || t('canvas.card.untitled')}
            </span>
          </div>
          {formatDueDate(state.dueDate) ? (
            <span className="ms-5 text-[11px] text-text-tertiary">
              {formatDueDate(state.dueDate)}
            </span>
          ) : null}
        </div>
      ) : state?.status === 'ready' && state.kind === 'calendar_event' ? (
        <div className="flex h-full flex-col justify-center gap-1 p-3">
          <span className="text-[13px] font-medium text-foreground">
            {state.title || t('canvas.card.untitled')}
          </span>
          <span className="flex items-center gap-1 text-[11px] text-text-tertiary">
            <CalendarClock className="size-3" aria-hidden="true" />
            {formatEventTime(state.startAt, state.isAllDay, t('canvas.card.allDay'))}
          </span>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center p-3">
          <span className="text-xs text-text-tertiary">{t('canvas.card.loading')}</span>
        </div>
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
