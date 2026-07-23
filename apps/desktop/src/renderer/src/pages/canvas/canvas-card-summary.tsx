/**
 * CanvasCardSummary — the cheap, flattened card body.
 *
 * This is the level-of-detail fallback, not the default look: cards normally
 * render their entity exactly as the editor does (canvas-card-body.tsx). The
 * layer drops to this render when zoomed far out or when too many cards are
 * mounted (see canvas-card-render-mode.ts), where the full render costs an
 * editor mount per card but is too small to read anyway.
 */

import React from 'react'
import { CheckCircle, Circle, CalendarClock } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { renderTaskDescriptionMarkdown } from '@/components/tasks/task-description-preview'
import { useT } from '@memry/i18n/renderer'
import { formatEventTime } from './canvas-cards'
import type { CanvasEntityState } from './use-canvas-entities'

function formatDueDate(dueDate: string | null): string | null {
  if (!dueDate) return null
  const parsed = new Date(`${dueDate}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return dueDate
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface CanvasCardSummaryProps {
  state: Extract<CanvasEntityState, { status: 'ready' }>
}

export const CanvasCardSummary = ({ state }: CanvasCardSummaryProps): React.JSX.Element => {
  const { t } = useT('common')

  if (state.kind === 'note') {
    return (
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
    )
  }

  if (state.kind === 'task') {
    return (
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
    )
  }

  return (
    <div className="flex h-full flex-col justify-center gap-1 p-3">
      <span className="text-[13px] font-medium text-foreground">
        {state.title || t('canvas.card.untitled')}
      </span>
      <span className="flex items-center gap-1 text-[11px] text-text-tertiary">
        <CalendarClock className="size-3" aria-hidden="true" />
        {formatEventTime(state.startAt, state.isAllDay, t('canvas.card.allDay'))}
      </span>
    </div>
  )
}
