import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import type { NoteSyncState } from '@memry/contracts/ipc-sync-ops'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'

const log = createLogger('NoteSyncLine')

/** Re-read while the info panel is open, so a push that lands shows up. */
const REFRESH_MS = 2000

const DOT: Record<NoteSyncState['state'], string> = {
  not_syncing: 'bg-muted-foreground/40',
  local_only: 'bg-muted-foreground/40',
  pending: 'bg-amber-500',
  sent: 'bg-amber-500',
  confirmed: 'bg-emerald-500',
  not_recorded: 'bg-muted-foreground/40',
  rejected: 'bg-destructive'
}

function ago(at: number): string {
  return formatDistanceToNow(at, { addSuffix: true })
}

/**
 * Whether this note's latest text has reached the server (#2647). Only a body
 * push the server stored counts as confirmed; the record sync stamp does not.
 */
export function NoteSyncLine({ noteId }: { noteId: string }): React.JSX.Element | null {
  const { t } = useT('notes')
  const [state, setState] = useState<NoteSyncState | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      window.api.syncOps
        .getNoteSyncState(noteId)
        .then((next) => {
          if (!cancelled) setState(next)
        })
        .catch((err) => log.warn('Could not read the note sync state', err))
    }
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [noteId])

  if (!state) return null

  let detail: string
  switch (state.state) {
    case 'confirmed':
      detail =
        state.bodyConfirmedAt === null
          ? t('outline.sync.notRecorded')
          : t('outline.sync.confirmed', { time: ago(state.bodyConfirmedAt) })
      break
    case 'pending':
      detail =
        state.waitingSince === null
          ? t('outline.sync.waiting')
          : t('outline.sync.pending', { time: ago(state.waitingSince) })
      break
    case 'sent':
      detail = t('outline.sync.sent')
      break
    case 'rejected':
      detail = t('outline.sync.rejected')
      break
    case 'not_recorded':
      detail = t('outline.sync.notRecorded')
      break
    case 'local_only':
      detail = t('outline.sync.localOnly')
      break
    default:
      detail = t('outline.sync.notSyncing')
  }

  return (
    <div
      className="flex items-center justify-between gap-3"
      data-testid="note-sync-line"
      data-sync-state={state.state}
    >
      <span className="text-[11px] text-text-tertiary leading-3.5">{t('outline.sync.label')}</span>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary leading-3.5">
        <span
          className={cn('size-1.5 shrink-0 rounded-full', DOT[state.state])}
          aria-hidden="true"
        />
        <span className="truncate">{detail}</span>
      </span>
    </div>
  )
}
