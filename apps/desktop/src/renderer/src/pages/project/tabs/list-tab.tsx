import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { InboxListSection } from '@/components/inbox'
import { DENSITY_CONFIG } from '@/hooks/use-display-density'
import type { TimePeriod } from '@/lib/inbox-utils'
import type { ProjectHubData } from '../use-project-hub'
import { NoteRow } from '../rows/note-row'
import { FileRow } from '../rows/file-row'
import { EventRow } from '../rows/event-row'
import {
  groupEventsByStart,
  groupFilesByModified,
  groupNotesByModified,
  periodLabelKey,
  type EventPeriod
} from '../hub-groups'
import { HubSectionHeader } from './hub-section'
import type { HubHandlers } from './hub-handlers'

type ListKind = 'notes' | 'files' | 'events'

/**
 * `InboxListSection` carries the Inbox's multi-select context. The hub does not
 * select rows, so it hands over an empty selection and no-op callbacks rather
 * than forking the component and letting the two headers drift apart.
 */
const NO_SELECTION: Set<string> = new Set()
const noop = (): void => {}

/** The Inbox renders its list at compact density; the hub matches it. */
const SECTION_SPACING = DENSITY_CONFIG.compact.sectionSpacing

const EMPTY_LABEL_KEY: Record<ListKind, string> = {
  notes: 'projectHub.sections.emptyNotes',
  files: 'projectHub.sections.emptyFiles',
  events: 'projectHub.sections.emptyEvents'
}

interface HubListSection {
  period: TimePeriod | EventPeriod
  rows: React.JSX.Element[]
}

interface ListTabProps {
  kind: ListKind
  hub: ProjectHubData
  handlers: HubHandlers
}

/**
 * The Notes / Files / Events tabs. One component because they differ only in
 * which row renders — splitting them would be three copies of the same shell.
 * Tasks is not here: it keeps the existing virtualized list with its subtasks,
 * drag-and-drop and quick-add.
 *
 * Rows are grouped into the Inbox's time sections. Notes and files use its
 * Today / Yesterday / Older buckets off `modifiedAt`; events use forward-facing
 * ones off `startAt`, because every future event would otherwise read as "Older".
 */
export const ListTab = ({ kind, hub, handlers }: ListTabProps): React.JSX.Element => {
  const { t } = useT('tasks')

  const onAdd =
    kind === 'notes'
      ? handlers.onAddNote
      : kind === 'files'
        ? handlers.onAddFile
        : handlers.onAddEvent

  const sections = useMemo<HubListSection[]>(() => {
    if (kind === 'notes') {
      return groupNotesByModified(hub.notes).map((group) => ({
        period: group.period,
        rows: group.items.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            onOpen={handlers.onOpenNote}
            onIconChange={handlers.onNoteIconChange}
          />
        ))
      }))
    }
    if (kind === 'files') {
      return groupFilesByModified(hub.files).map((group) => ({
        period: group.period,
        rows: group.items.map((file) => (
          <FileRow key={file.id} file={file} onOpen={handlers.onOpenFile} />
        ))
      }))
    }
    return groupEventsByStart(hub.events).map((group) => ({
      period: group.period,
      rows: group.items.map((event) => (
        <EventRow key={event.id} event={event} onOpen={handlers.onOpenEvent} />
      ))
    }))
  }, [kind, hub.notes, hub.files, hub.events, handlers])

  return (
    <div className="px-4 py-3 pb-6">
      <HubSectionHeader
        title={t(`projectHub.tabs.${kind}`)}
        count={hub.counts[kind]}
        onAdd={onAdd}
      />

      {sections.length === 0 ? (
        <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{t(EMPTY_LABEL_KEY[kind])}</p>
      ) : (
        <div className={SECTION_SPACING}>
          {sections.map((section) => (
            <InboxListSection
              key={section.period}
              title={t(periodLabelKey(section.period))}
              count={section.rows.length}
              collapsible
              density="compact"
              selectedIds={NO_SELECTION}
              focusedId={null}
              onSelect={noop}
              onFocus={noop}
            >
              {section.rows}
            </InboxListSection>
          ))}
        </div>
      )}
    </div>
  )
}
