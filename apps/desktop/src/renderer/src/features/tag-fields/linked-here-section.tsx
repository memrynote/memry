import { useState, type ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { LinkedHereGroup, LinkedNoteItem } from '@memry/contracts/tag-objects-api'
import { CheckSquare, FileText } from '@/lib/icons'
import { getActiveLocale } from '@/lib/active-locale'
import { useTabActions } from '@/contexts/tabs'
import { useOpenTaskDetail } from '@/components/tasks/task-detail-host'
import { TagGlyph } from './object-avatar'
import { useTagLookLookup } from './object-look'
import { useLinkedHere } from './use-linked-here'
import { useOptionalObjectIdentity } from './use-optional-object-identity'
import { openTagTable } from './open-tag-table'

const NEWEST = 2
const EXPANDED = 500

function shortDate(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(getActiveLocale(), { month: 'short', day: 'numeric' }).format(date)
}

export function LinkedHereOrBacklinks({
  noteId,
  fallback
}: {
  noteId: string
  fallback: ReactNode
}): ReactNode {
  const identity = useOptionalObjectIdentity(noteId)
  if (!identity) return fallback
  return <LinkedHereSection noteId={noteId} />
}

export function LinkedHereSection({ noteId }: { noteId: string }): React.JSX.Element | null {
  const { t } = useT('notes')
  const [mentionsExpanded, setMentionsExpanded] = useState(false)
  const { groups } = useLinkedHere(noteId, NEWEST)
  const expanded = useLinkedHere(noteId, mentionsExpanded ? EXPANDED : NEWEST)
  const lookOf = useTagLookLookup()
  const { openTab } = useTabActions()
  const openTaskDetail = useOpenTaskDetail()

  if (groups.length === 0) return null

  const openNote = (item: LinkedNoteItem): void =>
    openTab({
      type: 'note',
      title: item.title,
      icon: 'file-text',
      path: `/notes/${item.noteId}`,
      entityId: item.noteId,
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })

  return (
    <section
      className="flex flex-col gap-4 border-t border-border pt-5"
      aria-label={t('tagObjects.linkedHere.title')}
      data-testid="linked-here"
    >
      <h2 className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {t('tagObjects.linkedHere.title')}
      </h2>
      {groups.map((group) => {
        if (group.kind === 'mentions') {
          const items = mentionsExpanded
            ? (expanded.groups.find((g) => g.kind === 'mentions')?.items ?? group.items)
            : group.items
          return (
            <LinkedGroup
              key="mentions"
              icon={<FileText className="size-3.5 text-muted-foreground" />}
              label={t('tagObjects.linkedHere.mentionedIn')}
              total={group.total}
              meta={t('tagObjects.linkedHere.inTheText')}
              onCount={group.total > NEWEST ? () => setMentionsExpanded((v) => !v) : undefined}
            >
              {items.map((item) => (
                <LinkedRow
                  key={item.noteId}
                  icon={<FileText className="size-3.5 text-muted-foreground" />}
                  title={item.title}
                  end={item.snippet ?? shortDate(item.date)}
                  onClick={() => openNote(item)}
                />
              ))}
            </LinkedGroup>
          )
        }
        if (group.kind === 'relation') {
          const look = lookOf(group.sourceTag)
          const icon = look ? (
            <TagGlyph look={look} />
          ) : (
            <FileText className="size-3.5 text-muted-foreground" />
          )
          return (
            <LinkedGroup
              key={`relation-${group.sourceTag}-${group.field}`}
              icon={icon}
              label={group.label}
              total={group.total}
              meta={t('tagObjects.linkedHere.asField', { field: group.field })}
              onCount={
                group.sourceTag
                  ? () => openTagTable(openTab, group.sourceTag, group.filter)
                  : undefined
              }
            >
              {group.items.map((item) => (
                <LinkedRow
                  key={item.noteId}
                  icon={icon}
                  title={item.title}
                  end={shortDate(item.date)}
                  onClick={() => openNote(item)}
                />
              ))}
            </LinkedGroup>
          )
        }
        return (
          <TaskFieldGroup
            key={`task-${group.tag}-${group.field}`}
            group={group}
            onCount={group.tag ? () => openTagTable(openTab, group.tag, group.filter) : undefined}
            onOpen={openTaskDetail}
          />
        )
      })}
    </section>
  )
}

function TaskFieldGroup({
  group,
  onCount,
  onOpen
}: {
  group: Extract<LinkedHereGroup, { kind: 'task-field' }>
  onCount?: () => void
  onOpen: (taskId: string) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <LinkedGroup
      icon={<CheckSquare className="size-3.5 text-muted-foreground" />}
      label={t('tagObjects.linkedHere.tasks')}
      total={group.total}
      meta={t('tagObjects.linkedHere.asField', { field: group.field })}
      onCount={onCount}
    >
      {group.items.map((item) => (
        <LinkedRow
          key={item.taskId}
          icon={<CheckSquare className="size-3.5 text-muted-foreground" />}
          title={item.title}
          muted={item.completed}
          end={
            item.dueDate ? t('tagObjects.linkedHere.due', { date: shortDate(item.dueDate) }) : ''
          }
          onClick={() => onOpen(item.taskId)}
        />
      ))}
    </LinkedGroup>
  )
}

function LinkedGroup({
  icon,
  label,
  total,
  meta,
  onCount,
  children
}: {
  icon: ReactNode
  label: string
  total: number
  meta: string
  onCount?: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <div className="flex h-7 items-center gap-2 text-[13px]">
        {icon}
        <span className="font-medium text-foreground">{label}</span>
        {onCount ? (
          <button
            type="button"
            className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onCount}
          >
            {total}
          </button>
        ) : (
          <span className="px-1 text-muted-foreground">{total}</span>
        )}
        <span className="ms-auto text-xs text-muted-foreground">{meta}</span>
      </div>
      {children}
    </div>
  )
}

function LinkedRow({
  icon,
  title,
  end,
  muted,
  onClick
}: {
  icon: ReactNode
  title: string
  end: string
  muted?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[30px] w-full items-center gap-2 rounded-[5px] ps-5 pe-1 text-start text-[13px] hover:bg-accent"
    >
      {icon}
      <span className={muted ? 'truncate text-muted-foreground line-through' : 'truncate'}>
        {title}
      </span>
      <span className="ms-auto max-w-[50%] shrink-0 truncate text-xs text-muted-foreground">
        {end}
      </span>
    </button>
  )
}
