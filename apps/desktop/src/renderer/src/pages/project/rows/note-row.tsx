import { useT } from '@memry/i18n/renderer'
import { FileText, X } from '@/lib/icons'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { IconPickerButton } from '@/components/icon-picker-button'
import type { ProjectLinkedNote } from '@memry/rpc/tasks'
import { HubRow } from './hub-row'
import { useRelativeTime } from '../use-relative-time'

interface NoteRowProps {
  note: ProjectLinkedNote
  onOpen: (noteId: string) => void
  onIconChange: (noteId: string, icon: string | null) => void
  /** Supplied only in the overview rail, where a pinned note can be unpinned. */
  onUnpin?: (noteId: string) => void
}

export const NoteRow = ({
  note,
  onOpen,
  onIconChange,
  onUnpin
}: NoteRowProps): React.JSX.Element => {
  const { t, i18n } = useT('tasks')
  const relative = useRelativeTime(note.modifiedAt, i18n.language)

  return (
    <HubRow
      leading={
        <IconPickerButton
          hasIcon={!!note.emoji}
          onIconChange={(icon) => onIconChange(note.id, icon)}
          ariaLabel={t('projectHub.rows.setNoteIcon', { title: note.title })}
        >
          {note.emoji ? (
            <NoteIconDisplay value={note.emoji} className="text-[15px] leading-none" />
          ) : (
            <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
          )}
        </IconPickerButton>
      }
      onOpen={() => onOpen(note.id)}
      openLabel={t('projectHub.rows.openNote', { title: note.title })}
      trailing={
        <>
          <span>{relative}</span>
          {onUnpin ? (
            <button
              type="button"
              onClick={() => onUnpin(note.id)}
              aria-label={t('projectHub.rail.unpinNote', { title: note.title })}
              className="rounded-sm p-1 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </>
      }
    >
      <span className="truncate text-sm">{note.title}</span>
    </HubRow>
  )
}
