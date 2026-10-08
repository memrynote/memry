import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import type { UnsentNotesResult } from '@memry/contracts/ipc-sync-ops'
import { useT } from '@memry/i18n/renderer'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('UnsentNotesList')

/**
 * Notes with changes the server has not stored (#2647): queued body or record
 * changes, a file the note's synced body has not taken yet (including notes
 * the first launch after #2646 recorded), and pushes the server refused.
 * Hidden when there are none.
 */
export function UnsentNotesList(): React.JSX.Element | null {
  const { t } = useT('settings')
  const [data, setData] = useState<UnsentNotesResult | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.syncOps
      .getUnsentNotes()
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err) => log.warn('Could not list notes with unsent changes', err))
    return () => {
      cancelled = true
    }
  }, [])

  if (!data || data.total === 0) return null

  const hidden = data.total - data.notes.length

  return (
    <div data-testid="unsent-notes-list">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full min-h-11 items-center gap-2 py-2.5 text-start"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px]/4 text-foreground">
          {t('account.sync.unsent.title')}
        </span>
        <span className="shrink-0 text-xs/4 text-muted-foreground tabular-nums">
          {t('account.sync.unsent.count', { count: data.total })}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-3 pb-3 ps-3.5">
          <p className="text-xs/4 text-muted-foreground">{t('account.sync.unsent.description')}</p>
          <ul className="space-y-2">
            {data.notes.map((note) => (
              <li
                key={note.id}
                className="flex items-center justify-between gap-3"
                data-sync-state={note.state}
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px]/4 text-foreground">{note.title}</p>
                  <p className="truncate font-mono text-xs/4 text-muted-foreground">{note.path}</p>
                </div>
                <div className="shrink-0 text-end">
                  <p
                    className={cn(
                      'text-xs/4',
                      note.reasons.includes('rejected')
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                    )}
                  >
                    {note.reasons
                      .map((reason) => t(`account.sync.unsent.reasons.${reason}`))
                      .join(' · ')}
                  </p>
                  {note.waitingSince !== null && (
                    <p className="text-xs/4 tabular-nums text-muted-foreground">
                      {t('account.sync.unsent.waitingSince', {
                        time: formatDistanceToNow(note.waitingSince, { addSuffix: true })
                      })}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <p className="text-xs/4 text-muted-foreground">
              {t('account.sync.unsent.more', { count: hidden })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
