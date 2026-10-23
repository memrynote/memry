import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  encodeExternalEventRelationId,
  formatRelationUri,
  isRelationValue
} from '@memry/contracts/relation-uri'
import type { CalendarLinkedNote } from '@memry/contracts/calendar-api'

import { FilePlus, FileText, Link2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { calendarService } from '@/services/calendar-service'
import { notesService, onNoteDeleted, onNoteRenamed, onNoteUpdated } from '@/services/notes-service'
import { propertiesService } from '@/services/properties-service'
import { useRelationSearch } from '@/components/note/info-section/editors/use-relation-search'

import { CalendarCardSection } from './calendar-card'

const log = createLogger('CalendarEventNotes')

/** The relation property a note links its events through. */
export const EVENT_LINK_PROPERTY = 'Event'
/** `NoteCreateSchema` caps a title at 200 characters. */
const MAX_NOTE_TITLE = 200
/** Index reads lag the write, so wait for the projection before refetching. */
const REFRESH_DELAY_MS = 250

export interface CalendarEventNotesTarget {
  sourceType: 'event' | 'external_event'
  sourceId: string
  title: string
}

function eventRelationUri(target: CalendarEventNotesTarget): string {
  return target.sourceType === 'event'
    ? formatRelationUri('event', target.sourceId)
    : formatRelationUri('external-event', encodeExternalEventRelationId(target.sourceId))
}

const ACTION_CLASS =
  'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-(--tint-ring) disabled:opacity-50'

/**
 * The notes linked to one calendar event, with actions to start a note for it
 * or link an existing one. A link is the note's `Event` relation property, so
 * the note stays the one place that records it.
 */
export function CalendarEventNotes({
  target,
  onOpenNote
}: {
  target: CalendarEventNotesTarget
  onOpenNote: (noteId: string) => void
}): React.JSX.Element {
  const { t } = useT('calendar')
  const queryClient = useQueryClient()
  const [linking, setLinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const queryKey = ['calendar', 'linked-notes', target.sourceType, target.sourceId]

  const linkedQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<CalendarLinkedNote[]> =>
      (
        await calendarService.listLinkedNotes({
          sourceType: target.sourceType,
          sourceId: target.sourceId
        })
      ).notes
  })
  const linked = linkedQuery.data ?? []

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['calendar', 'linked-notes'] })
      }, REFRESH_DELAY_MS)
    }
    const offs = [onNoteUpdated(refresh), onNoteRenamed(refresh), onNoteDeleted(refresh)]
    return () => {
      if (timer) clearTimeout(timer)
      offs.forEach((off) => off())
    }
  }, [queryClient])

  const run = async (action: () => Promise<void>, fallbackKey: string): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      const message = extractErrorMessage(err, t(fallbackKey))
      log.error('Event note action failed', { sourceId: target.sourceId, error: message })
      toast.error(message)
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey })
    }
  }

  const createNote = (): Promise<void> =>
    run(async () => {
      const result = await notesService.create({
        title: target.title.trim().slice(0, MAX_NOTE_TITLE) || t('eventNotes.untitled'),
        properties: { [EVENT_LINK_PROPERTY]: [eventRelationUri(target)] }
      })
      if (!result.success || !result.note) throw new Error(result.error)
      onOpenNote(result.note.id)
    }, 'eventNotes.createFailed')

  const linkNote = (note: { id: string; title: string }): Promise<void> =>
    run(async () => {
      const uri = eventRelationUri(target)
      const properties = await propertiesService.get(note.id)
      const current = properties.find((p) => p.name === EVENT_LINK_PROPERTY)?.value
      const empty = current == null || current === '' || (Array.isArray(current) && !current.length)
      if (!empty && !isRelationValue(current)) {
        throw new Error(t('eventNotes.propertyTaken', { name: EVENT_LINK_PROPERTY }))
      }
      const uris = empty ? [] : (current as string[])
      if (!uris.includes(uri)) {
        const result = await propertiesService.merge(note.id, {
          [EVENT_LINK_PROPERTY]: [...uris, uri]
        })
        if (!result.success) throw new Error(result.error)
      }
      setLinking(false)
    }, 'eventNotes.linkFailed')

  return (
    <CalendarCardSection className="grid gap-1 px-3.5 py-2" data-testid="calendar-event-notes">
      <div className="flex items-center gap-1">
        <h4 className="flex-1 text-xs font-medium text-muted-foreground">
          {t('eventNotes.heading')}
        </h4>
        <button
          type="button"
          className={ACTION_CLASS}
          disabled={busy}
          onClick={() => void createNote()}
        >
          <FilePlus className="size-3.5" aria-hidden />
          {t('eventNotes.create')}
        </button>
        <button
          type="button"
          className={cn(ACTION_CLASS, linking && 'bg-accent text-foreground')}
          aria-expanded={linking}
          disabled={busy}
          onClick={() => setLinking((open) => !open)}
        >
          <Link2 className="size-3.5" aria-hidden />
          {t('eventNotes.link')}
        </button>
      </div>

      {linked.length > 0 && (
        <ul className="grid">
          {linked.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                onClick={() => onOpenNote(note.id)}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px]/5 text-foreground outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-(--tint-ring)"
              >
                {note.emoji ? (
                  <span className="size-3.5 shrink-0 text-xs leading-none" aria-hidden>
                    <NoteIconDisplay value={note.emoji} />
                  </span>
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="truncate">{note.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {linking && (
        <NoteSearch exclude={linked} disabled={busy} onPick={(note) => void linkNote(note)} />
      )}

      {linkedQuery.error && (
        <p role="alert" className="text-xs text-destructive">
          {extractErrorMessage(linkedQuery.error, t('eventNotes.loadFailed'))}
        </p>
      )}
    </CalendarCardSection>
  )
}

/** Inline, not a popover: the read-only event card dismisses on any pointerdown outside it. */
function NoteSearch({
  exclude,
  disabled,
  onPick
}: {
  exclude: CalendarLinkedNote[]
  disabled: boolean
  onPick: (note: { id: string; title: string }) => void
}): React.JSX.Element {
  const { t } = useT('calendar')
  const [query, setQuery] = useState('')
  const { notes, loading } = useRelationSearch(query)
  const excluded = new Set(exclude.map((note) => note.id))
  const results = notes.filter((note) => !excluded.has(note.id)).slice(0, 6)

  return (
    <div className="grid gap-1">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('eventNotes.searchPlaceholder')}
        aria-label={t('eventNotes.searchPlaceholder')}
        className="h-7 rounded-md border border-border bg-transparent px-2 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-(--tint-ring)"
      />
      {results.map((note) => (
        <button
          key={note.id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(note)}
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px]/5 outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-(--tint-ring)"
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{note.title}</span>
        </button>
      ))}
      {query.trim() !== '' && !loading && results.length === 0 && (
        <p className="px-1.5 text-xs text-muted-foreground">{t('eventNotes.noResults')}</p>
      )}
    </div>
  )
}
