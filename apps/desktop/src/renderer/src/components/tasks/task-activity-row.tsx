import { memo } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { TFunction } from 'i18next'
import type { TaskActivityEntry } from '@memry/rpc/tasks'
import { cn } from '@/lib/utils'

// ============================================================================
// VALUE FORMATTING
// ============================================================================

/**
 * Field names are system vocabulary; the row shows the label the properties
 * grid already uses. An unmapped field falls back to its raw name rather than
 * disappearing — a missing entry should look like a gap, not like nothing
 * happened.
 */
export function fieldLabel(field: string | null, t: TFunction<'tasks'>): string {
  if (!field) return ''
  const key = `drawer.activityField${field.charAt(0).toUpperCase()}${field.slice(1)}`
  const label = t(key as never)
  return label === key ? field : label
}

function decode(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function formatValue(raw: string | null, t: TFunction<'tasks'>): string {
  const value = decode(raw)
  if (value === null || value === undefined || value === '') return t('drawer.activityEmptyValue')
  if (Array.isArray(value))
    return value.length > 0 ? value.join(', ') : t('drawer.activityEmptyValue')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** `description` rows carry `{ delta }` instead of the body — never the text. */
function descriptionSummary(raw: string | null, t: TFunction<'tasks'>): string {
  const value = decode(raw) as { delta?: number } | null
  const delta = value?.delta ?? 0
  if (delta > 0) return t('drawer.activityCharsAdded', { count: delta })
  if (delta < 0) return t('drawer.activityCharsRemoved', { count: delta })
  return t('drawer.activityCharsSame')
}

export function actionLabel(action: string, t: TFunction<'tasks'>): string {
  const key = `drawer.activityAction${action.charAt(0).toUpperCase()}${action.slice(1)}`
  const label = t(key as never)
  return label === key ? action : label
}

function actorLabel(entry: TaskActivityEntry, t: TFunction<'tasks'>): string {
  if (entry.actor === 'google_calendar') return t('drawer.activityByGoogle')
  if (entry.isThisDevice) return t('drawer.activityByYou')
  return t('drawer.activityBySync')
}

export function formatRelativeTime(iso: string, language: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((then - now) / 1000)
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return formatter.format(Math.round(seconds), 'second')
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour')
  return formatter.format(Math.round(seconds / 86400), 'day')
}

// ============================================================================
// ROW
// ============================================================================

export interface TaskActivityRowProps {
  entry: TaskActivityEntry
  language: string
}

/**
 * One entry on the timeline.
 *
 * The rail is drawn as a `border-s` on a fixed-width gutter with the dot
 * centered inside it, rather than an absolutely positioned dot nudged with a
 * physical translate — that keeps it correct in RTL.
 */
export const TaskActivityRow = memo(function TaskActivityRow({
  entry,
  language
}: TaskActivityRowProps): React.JSX.Element {
  const { t } = useT('tasks')
  const isSuperseded = entry.action === 'superseded'
  const isDescription = entry.field === 'description'

  return (
    <div className="flex gap-2.5">
      <div className="relative flex w-3 shrink-0 justify-center">
        <span
          className={cn('absolute inset-y-0 w-px', isSuperseded ? 'bg-amber-500/40' : 'bg-border')}
          aria-hidden="true"
        />
        <span
          className={cn(
            'relative mt-1.5 size-1.5 shrink-0 rounded-full',
            isSuperseded ? 'bg-amber-500' : 'bg-text-tertiary'
          )}
          aria-hidden="true"
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pb-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] leading-4">
          <span className="text-text-secondary">
            {entry.field ? fieldLabel(entry.field, t) : actionLabel(entry.action, t)}
          </span>

          {isDescription ? (
            <span className="text-text-tertiary">{descriptionSummary(entry.newValue, t)}</span>
          ) : (
            <>
              {entry.oldValue !== null && (
                <span
                  className={cn(
                    'truncate text-text-tertiary',
                    isSuperseded && 'line-through decoration-1 [text-underline-position:from-font]'
                  )}
                >
                  {formatValue(entry.oldValue, t)}
                </span>
              )}
              {entry.oldValue !== null && entry.newValue !== null && (
                <span className="text-text-tertiary" aria-hidden="true">
                  →
                </span>
              )}
              {entry.newValue !== null && (
                <span className="truncate text-text-primary">{formatValue(entry.newValue, t)}</span>
              )}
            </>
          )}
        </div>

        <span className="text-[11px] leading-3.5 text-text-tertiary/70">
          {isSuperseded
            ? t('drawer.activitySupersededNote')
            : `${actorLabel(entry, t)} · ${formatRelativeTime(entry.createdAt, language)}`}
        </span>
      </div>
    </div>
  )
})
