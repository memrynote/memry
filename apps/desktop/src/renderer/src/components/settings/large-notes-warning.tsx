import { useEffect, useState } from 'react'
import type { LargeNotesResult } from '@memry/contracts/ipc-sync-ops'
import { useT } from '@memry/i18n/renderer'
import { formatBytes } from '@/lib/format'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('LargeNotesWarning')

/**
 * The storage bar answers "how much am I using". It cannot answer "which note
 * is about to stop syncing", because a note body only ever moves the aggregate
 * number. This names them, before the ceiling is reached and after (#1465).
 */
export function LargeNotesWarning(): React.JSX.Element | null {
  const { t } = useT('settings')
  const [data, setData] = useState<LargeNotesResult | null>(null)
  const [expanded, setExpanded] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.syncOps
      .getLargeNotes()
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err) => {
        // Nothing to warn about is the common case; a failure here must not
        // push an error into a settings screen the user opened for something
        // else.
        log.warn('Could not list notes near the sync limit', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!data || data.notes.length === 0) return null

  const isExpanded = expanded ?? data.notes.some((note) => note.status === 'over')

  return (
    <div className="border-b border-border" data-testid="large-notes-warning">
      <button
        type="button"
        onClick={() => setExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        className="flex w-full min-h-11 items-center gap-2 py-2.5 text-start"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px]/4 text-foreground">
          {t('vault.groups.largeNotes')}
        </span>
        <span className="shrink-0 text-xs/4 text-muted-foreground tabular-nums">
          {t('vault.v2.largeNotesCount', { count: data.notes.length })}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <div className="space-y-3 pb-3 ps-3.5">
          <p className="text-xs/4 text-muted-foreground">
            {t('vault.largeNotes.description', { limit: formatBytes(data.maxBytes) })}
          </p>

          <ul className="space-y-2">
            {data.notes.map((note) => (
              <li key={note.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px]/4 text-foreground truncate">{note.title}</p>
                  <p className="font-mono text-xs/4 text-muted-foreground truncate">{note.path}</p>
                </div>
                <div className="shrink-0 text-end">
                  <p className="text-xs/4 tabular-nums text-muted-foreground">
                    {formatBytes(note.sizeBytes)}
                  </p>
                  <p
                    className={
                      note.status === 'over'
                        ? 'text-xs/4 text-destructive'
                        : 'text-xs/4 text-muted-foreground'
                    }
                  >
                    {note.status === 'over'
                      ? t('vault.largeNotes.over')
                      : t('vault.largeNotes.approaching')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
