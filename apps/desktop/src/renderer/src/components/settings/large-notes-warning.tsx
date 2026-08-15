import { useEffect, useState } from 'react'
import type { LargeNotesResult } from '@memry/contracts/ipc-sync-ops'
import { useT } from '@memry/i18n/renderer'
import { formatBytes } from '@/lib/format'
import { SettingsGroup } from '@/components/settings/settings-primitives'
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

  return (
    <SettingsGroup label={t('vault.groups.largeNotes')}>
      <div className="py-3 px-4 space-y-3">
        <p className="text-xs/4 text-muted-foreground">
          {t('vault.largeNotes.description', { limit: formatBytes(data.maxBytes) })}
        </p>

        <ul className="space-y-2">
          {data.notes.map((note) => (
            <li key={note.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px]/4 text-foreground truncate">{note.title}</p>
                <p className="text-xs/4 text-muted-foreground truncate">{note.path}</p>
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
    </SettingsGroup>
  )
}
