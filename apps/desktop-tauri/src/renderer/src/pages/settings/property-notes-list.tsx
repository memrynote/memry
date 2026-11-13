import { useQuery } from '@tanstack/react-query'
import type { PropertyUsage } from '@memry/contracts/properties-api'
import { useT } from '@memry/i18n/renderer'
import { useTabs } from '@/contexts/tabs'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { AlertTriangle, FileText } from '@/lib/icons'

const propertyUsageKeys = {
  all: ['property-usage'] as const,
  notes: (name: string) => ['property-usage', name] as const
}

// Nothing invalidates these when a note's properties change, so every mount
// of the section reads the index again rather than show a count from before.
const READ_ON_MOUNT = 0

/** Note counts per property name. */
export function usePropertyUsage(): Map<string, PropertyUsage> {
  const { data } = useQuery({
    queryKey: propertyUsageKeys.all,
    queryFn: () => notesService.getPropertyUsage(),
    staleTime: READ_ON_MOUNT
  })
  return new Map((data ?? []).map((usage) => [usage.name, usage]))
}

/**
 * The notes that use one property. A property is vault-wide, so a `rating` on
 * a book and a `rating` on a film are the same property; this list is how the
 * user sees every place it is used, and which values its type cannot show.
 */
export function PropertyNotesList({
  name,
  typeLabel
}: {
  name: string
  typeLabel: string
}): React.JSX.Element {
  const { t } = useT('settings')
  const { openTab } = useTabs()
  const { close: closeSettings } = useSettingsModal()
  const { data, isLoading, error } = useQuery({
    queryKey: propertyUsageKeys.notes(name),
    queryFn: () => notesService.listNotesWithProperty(name),
    staleTime: READ_ON_MOUNT
  })

  if (isLoading) {
    return <p className="ps-5 py-1 text-xs/4 text-muted-foreground">{t('properties.loading')}</p>
  }
  if (error) {
    return (
      <p className="ps-5 py-1 text-xs/4 text-destructive" role="alert">
        {extractErrorMessage(error, t('properties.usage.loadFailed'))}
      </p>
    )
  }
  if (!data || data.length === 0) {
    return <p className="ps-5 py-1 text-xs/4 text-muted-foreground">{t('properties.usage.none')}</p>
  }

  return (
    <ul className="flex flex-col">
      {data.map((note) => (
        <li key={note.id}>
          <button
            type="button"
            onClick={() => {
              closeSettings()
              openTab({
                type: 'note',
                title: note.title,
                icon: 'file-text',
                path: `/notes/${note.id}`,
                entityId: note.id,
                isPinned: false,
                isModified: false,
                isPreview: true,
                isDeleted: false
              })
            }}
            className="flex w-full items-center gap-2 rounded-md ps-5 pe-1 py-1 text-start hover:bg-muted/60"
          >
            {note.emoji ? (
              <NoteIconDisplay value={note.emoji} className="shrink-0 text-sm leading-none" />
            ) : (
              <FileText className="size-3.5 shrink-0 text-muted-foreground/70" />
            )}
            <span className="min-w-0 grow truncate text-[13px]/4 text-foreground">
              {note.title}
            </span>
            {note.mismatch && (
              <span className="flex shrink-0 items-center gap-1 text-xs/4 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3" aria-hidden="true" />
                {t('properties.usage.mismatchNote', { type: typeLabel })}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
