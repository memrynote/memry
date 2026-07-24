/**
 * One result row in the canvas "Add card" picker.
 *
 * The picker is a placement surface, so a row has to answer "which entity is
 * this?" at a glance. It borrows the vocabulary the user already learned
 * elsewhere: the note's own icon as the sidebar shows it, the task's
 * check/circle plus priority and due date as the task list shows them, and the
 * event's clock as the calendar card shows it (canvas-card-summary.tsx).
 */

import React from 'react'
import { CalendarClock, CheckCircle, Circle, FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { priorityConfig } from '@/data/task-model'
import { DB_PRIORITY_MAP } from '@/components/note/content-area/task-block/task-block-utils'
import { formatEventTime } from './canvas-cards'
import { formatDueDate, formatShortDate, type AddCardCandidate } from './canvas-add-card'

/** A metadata chip: never wider than its content, never wrapping mid-word. */
function Meta({
  children,
  style
}: {
  children: React.ReactNode
  style?: React.CSSProperties
}): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap" style={style}>
      {children}
    </span>
  )
}

function RowIcon({ candidate }: { candidate: AddCardCandidate }): React.JSX.Element {
  const { detail } = candidate

  if (detail.type === 'note') {
    return detail.emoji ? (
      <NoteIconDisplay
        value={detail.emoji}
        className="flex size-4 shrink-0 items-center justify-center text-sm"
      />
    ) : (
      <FileText className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
    )
  }

  if (detail.type === 'task') {
    return detail.completed ? (
      <CheckCircle className="size-4 shrink-0 text-primary" aria-hidden="true" />
    ) : (
      <Circle className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
    )
  }

  return <CalendarClock className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
}

function RowMeta({
  candidate,
  createdLabel,
  allDayLabel
}: {
  candidate: AddCardCandidate
  createdLabel: (date: string) => string
  allDayLabel: string
}): React.JSX.Element | null {
  const { detail } = candidate

  if (detail.type === 'note') {
    const created = formatShortDate(detail.createdAt)
    return (
      <div className="flex items-center gap-2 text-xs text-text-tertiary">
        <span className="truncate">{detail.path}</span>
        {created ? <Meta>{createdLabel(created)}</Meta> : null}
      </div>
    )
  }

  if (detail.type === 'task') {
    const priority = DB_PRIORITY_MAP[detail.priority] ?? 'none'
    const due = formatDueDate(detail.dueDate)
    const created = formatShortDate(detail.createdAt)
    return (
      <div className="flex items-center gap-2 text-xs text-text-tertiary">
        <Meta>
          <span
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: detail.projectColor }}
            aria-hidden="true"
          />
          <span className="max-w-32 truncate">{detail.projectName}</span>
        </Meta>
        {detail.statusName ? <Meta>{detail.statusName}</Meta> : null}
        {priority !== 'none' ? (
          <Meta style={{ color: priorityConfig[priority].color ?? undefined }}>
            {priorityConfig[priority].label}
          </Meta>
        ) : null}
        {due ? <Meta>{due}</Meta> : null}
        {created ? <Meta>{createdLabel(created)}</Meta> : null}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 text-xs text-text-tertiary">
      <Meta>{formatEventTime(detail.startAt, detail.isAllDay, allDayLabel)}</Meta>
    </div>
  )
}

export interface CanvasAddCardRowProps {
  candidate: AddCardCandidate
  /** Renders "Created {date}" — passed in so this file stays i18n-hook-free. */
  createdLabel: (date: string) => string
  allDayLabel: string
  onCanvasLabel: string
}

export function CanvasAddCardRow({
  candidate,
  createdLabel,
  allDayLabel,
  onCanvasLabel
}: CanvasAddCardRowProps): React.JSX.Element {
  const isCompletedTask = candidate.detail.type === 'task' && candidate.detail.completed

  return (
    <>
      <span className="mt-0.5 flex shrink-0 items-start">
        <RowIcon candidate={candidate} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            'truncate text-sm font-medium',
            isCompletedTask ? 'text-text-tertiary line-through' : 'text-foreground'
          )}
        >
          {candidate.title}
        </span>
        <RowMeta candidate={candidate} createdLabel={createdLabel} allDayLabel={allDayLabel} />
      </span>
      {candidate.onCanvas ? (
        <span className="mt-0.5 shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-text-tertiary">
          {onCanvasLabel}
        </span>
      ) : null}
    </>
  )
}
