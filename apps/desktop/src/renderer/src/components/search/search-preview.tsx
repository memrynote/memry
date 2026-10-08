import { useEffect, useRef, useState } from 'react'
import type {
  InboxResultMetadata,
  SearchResultItem as SearchResultItemType,
  TaskResultMetadata
} from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'
import { CheckCircle2, Circle } from '@/lib/icons'
import { notesService } from '@/services/notes-service'
import { journalService } from '@/services/journal-service'
import { tasksService, type Task } from '@/services/tasks-service'
import { inboxService } from '@/services/inbox-service'
import { stripMarkTags } from '@/services/search-service'
import { createLogger } from '@/lib/logger'
import { getRepeatDisplayText } from '@/lib/repeat-utils'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/components/tasks/task-activity-row'
import { PriorityIcon } from '@/components/tasks/priority-icon'
import { priorityConfig } from '@/data/task-model'
import { dbTaskToUiTask } from '@/features/tasks/use-task-queries'
import { HighlightedText, SearchCount } from './search-row'
import { excerpt, matchLines, plainLines } from './search-text'
import { dayLabel, folderSegments, hostOf, isPastDay, priorityFor } from './search-format'
import { resultValue } from './search-result-item'

const log = createLogger('SearchPreview')
/** Arrowing through results should not fire a read per row passed over. */
const LOAD_DELAY_MS = 80

type Detail =
  | { kind: 'body'; lines: string[] }
  | { kind: 'task'; task: Task }
  | { kind: 'inbox'; content: string | null; capturedAt: string }

async function loadDetail(item: SearchResultItemType): Promise<Detail | null> {
  const meta = item.metadata
  switch (meta.type) {
    case 'note': {
      if (meta.fileType && meta.fileType !== 'markdown') return null
      const note = await notesService.get(item.id)
      return note && !note.contentOmitted ? { kind: 'body', lines: plainLines(note.content) } : null
    }
    case 'journal': {
      const entry = await journalService.getEntry(meta.date)
      return entry ? { kind: 'body', lines: plainLines(entry.content) } : null
    }
    case 'task': {
      const task = await tasksService.get(item.id)
      return task ? { kind: 'task', task } : null
    }
    case 'inbox': {
      const inbox = await inboxService.get(item.id)
      return inbox
        ? {
            kind: 'inbox',
            content: inbox.content,
            capturedAt: new Date(inbox.createdAt).toISOString()
          }
        : null
    }
  }
}

function useDetail(item: SearchResultItemType): Detail | null | undefined {
  const cache = useRef(new Map<string, Detail | null>())
  const key = resultValue(item)
  const [, rerender] = useState(0)
  useEffect(() => {
    if (cache.current.has(key)) return
    let cancelled = false
    const timer = setTimeout(() => {
      void loadDetail(item)
        .catch((err) => {
          log.warn('Failed to load search preview', { key, err })
          return null
        })
        .then((detail) => {
          cache.current.set(key, detail)
          if (!cancelled) rerender((n) => n + 1)
        })
    }, LOAD_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [key, item])
  return cache.current.get(key)
}

const Dot = (): React.JSX.Element => <span aria-hidden="true">{'·'}</span>

function MetaLine({ parts }: { parts: React.ReactNode[] }): React.JSX.Element {
  const shown = parts.filter(Boolean)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-0.5 text-xs leading-4 text-text-tertiary">
      {shown.map((part, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <Dot />}
          {part}
        </span>
      ))}
    </div>
  )
}

function Header({
  eyebrow,
  title,
  query,
  meta
}: {
  eyebrow: React.ReactNode
  title: string
  query: string
  meta?: React.ReactNode[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {eyebrow && <div className="text-xs leading-4 text-text-tertiary">{eyebrow}</div>}
      <h2 className="text-xl font-semibold leading-[26px] tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]">
        <HighlightedText text={title} query={query} />
      </h2>
      {meta && <MetaLine parts={meta} />}
    </div>
  )
}

function Body({ text }: { text: string }): React.JSX.Element | null {
  if (!text) return null
  return <p className="text-[13px] leading-[21px] text-text-secondary">{text}</p>
}

function Matches({ lines, query }: { lines: string[]; query: string }): React.JSX.Element | null {
  const { t } = useT('common')
  const found = matchLines(lines, query)
  if (found.total === 0) return null
  return (
    <section className="flex flex-col gap-0.5">
      <div className="flex justify-between pb-1.5 text-[11px] font-medium leading-[14px] text-text-tertiary">
        <span>{t('searchPalette.matches')}</span>
        <SearchCount value={found.total} />
      </div>
      {found.lines.map((line, i) => (
        <div key={i} className="flex min-h-7 items-center gap-2.5">
          <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-border" />
          <HighlightedText
            text={line}
            query={query}
            className="min-w-0 truncate text-xs leading-[18px] text-text-secondary"
          />
        </div>
      ))}
    </section>
  )
}

const Divider = (): React.JSX.Element => <div className="h-px shrink-0 bg-border" />

function Property({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-7 items-center">
      <span className="w-24 shrink-0 text-xs leading-4 text-text-tertiary">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-foreground">
        {children}
      </span>
    </div>
  )
}

function TaskPreview({
  item,
  meta,
  task,
  query
}: {
  item: SearchResultItemType
  meta: TaskResultMetadata
  task: Task | null
  query: string
}): React.JSX.Element {
  const { t, i18n } = useT('common')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const priority = priorityFor(meta.priority)
  const overdue = meta.dueDate !== null && !meta.completedAt && isPastDay(meta.dueDate)
  const description = task?.description ? excerpt(plainLines(task.description), 400) : ''
  const repeat = task?.repeatConfig ? dbTaskToUiTask(task).repeatConfig : null
  return (
    <>
      <Header
        eyebrow={
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: meta.projectColor }} />
            {meta.projectName}
          </span>
        }
        title={item.title}
        query={query}
      />
      <div className="flex flex-col">
        <Property label={t('searchPalette.preview.status')}>
          {meta.completedAt ? (
            <CheckCircle2 className="size-[13px] text-text-tertiary" />
          ) : (
            <Circle className="size-[13px] text-text-tertiary" />
          )}
          {meta.statusName ?? t('searchPalette.preview.noStatus')}
        </Property>
        {meta.dueDate && (
          <Property label={t('searchPalette.preview.due')}>
            <span className={cn(overdue && 'text-destructive')}>
              {dayLabel(meta.dueDate, locale)}
              {task?.dueTime ? `, ${task.dueTime}` : ''}
            </span>
          </Property>
        )}
        {priority !== 'none' && (
          <Property label={t('searchPalette.preview.priority')}>
            <PriorityIcon priority={priority} />
            {priorityConfig[priority].label}
          </Property>
        )}
        {repeat && (
          <Property label={t('searchPalette.preview.repeats')}>
            {getRepeatDisplayText(repeat, t)}
          </Property>
        )}
      </div>
      {description && (
        <>
          <Divider />
          <Body text={description} />
        </>
      )}
    </>
  )
}

function InboxPreview({
  item,
  meta,
  detail,
  query
}: {
  item: SearchResultItemType
  meta: InboxResultMetadata
  detail: Extract<Detail, { kind: 'inbox' }> | null
  query: string
}): React.JSX.Element {
  const { t, i18n } = useT('common')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const text = detail?.content
    ? excerpt(plainLines(detail.content), 400)
    : stripMarkTags(item.snippet)
  return (
    <>
      {meta.sourceUrl && (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3.5 py-3">
          <span className="text-xs leading-4 text-text-secondary">
            {meta.sourceTitle ?? hostOf(meta.sourceUrl)}
          </span>
          <span className="truncate text-xs leading-4 text-text-tertiary">{meta.sourceUrl}</span>
        </div>
      )}
      <Header
        eyebrow={null}
        title={item.title}
        query={query}
        meta={[
          <span key="type" className="capitalize">
            {meta.itemType}
          </span>,
          detail &&
            t('searchPalette.preview.captured', {
              when: formatRelativeTime(detail.capturedAt, locale)
            }),
          meta.filedAt ? t('searchPalette.preview.filed') : t('searchPalette.preview.notFiled')
        ]}
      />
      <Body text={text} />
    </>
  )
}

/** Read-only detail for the selected result. Never takes focus. */
export function SearchPreview({
  item,
  query
}: {
  item: SearchResultItemType
  query: string
}): React.JSX.Element {
  const { t, i18n } = useT('common')
  const locale = i18n.resolvedLanguage ?? i18n.language
  const detail = useDetail(item)
  const meta = item.metadata
  const edited = t('searchPalette.preview.edited', {
    when: formatRelativeTime(item.modifiedAt, locale)
  })

  let content: React.ReactNode
  switch (meta.type) {
    case 'task':
      content = (
        <TaskPreview
          item={item}
          meta={meta}
          task={detail?.kind === 'task' ? detail.task : null}
          query={query}
        />
      )
      break
    case 'inbox':
      content = (
        <InboxPreview
          item={item}
          meta={meta}
          detail={detail?.kind === 'inbox' ? detail : null}
          query={query}
        />
      )
      break
    default: {
      const lines = detail?.kind === 'body' ? detail.lines : null
      const isFile = meta.type === 'note' && meta.fileType && meta.fileType !== 'markdown'
      const words = meta.wordCount
      content = (
        <>
          <Header
            eyebrow={
              meta.type === 'journal'
                ? t('searchPalette.types.journal')
                : folderSegments(meta.path).join(' / ')
            }
            title={item.title}
            query={query}
            meta={[
              edited,
              isFile && <span className="uppercase">{meta.type === 'note' && meta.fileType}</span>,
              !isFile && words ? t('searchPalette.preview.words', { count: words }) : null,
              ...meta.tags
                .slice(0, 4)
                .map((tag) => <span key={tag} className="text-text-secondary">{`#${tag}`}</span>)
            ]}
          />
          {!isFile && (
            <>
              <Divider />
              <Body text={lines ? excerpt(lines, 240, item.title) : stripMarkTags(item.snippet)} />
              {lines && <Matches lines={lines} query={query} />}
            </>
          )}
        </>
      )
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-8 py-7">{content}</div>
  )
}
