import { Command } from 'cmdk'
import { FileText, BookOpen, CheckSquare, Inbox, Calendar, Tag, ExternalLink } from '@/lib/icons'
import type {
  SearchResultItem as SearchResultItemType,
  ContentType,
  NoteResultMetadata,
  JournalResultMetadata,
  TaskResultMetadata,
  InboxResultMetadata
} from '@memry/contracts/search-api'
import { highlightTerms, stripMarkTags } from '@/services/search-service'

interface SearchResultItemProps {
  item: SearchResultItemType
  query: string
  onSelect: (item: SearchResultItemType) => void
}

const TYPE_ICONS: Record<ContentType, typeof FileText> = {
  note: FileText,
  journal: BookOpen,
  task: CheckSquare,
  inbox: Inbox
}

function HighlightedText({ text, query }: { text: string; query: string }): React.JSX.Element {
  const segments = highlightTerms(stripMarkTags(text), query)
  return (
    <>
      {segments.map((seg, i) =>
        seg.highlight ? (
          <mark
            key={i}
            className="bg-amber-200/60 dark:bg-amber-500/30 text-inherit rounded-sm px-0.5"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  )
}

function NoteMetadata({
  meta,
  query
}: {
  meta: NoteResultMetadata
  query: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs text-text-tertiary mt-0.5">
      <span className="truncate max-w-48">{meta.path}</span>
      {meta.tags.length > 0 && (
        <span className="flex items-center gap-1">
          <Tag className="size-3" />
          {meta.tags.slice(0, 3).join(', ')}
        </span>
      )}
    </div>
  )
}

function JournalMetadata({ meta }: { meta: JournalResultMetadata }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs text-text-tertiary mt-0.5">
      <Calendar className="size-3" />
      <span>{meta.date}</span>
      {meta.tags.length > 0 && (
        <span className="flex items-center gap-1">
          <Tag className="size-3" />
          {meta.tags.slice(0, 3).join(', ')}
        </span>
      )}
    </div>
  )
}

function TaskMetadata({ meta }: { meta: TaskResultMetadata }): React.JSX.Element {
  const priorityColors: Record<number, string> = {
    4: 'text-red-500',
    3: 'text-orange-500',
    2: 'text-yellow-500',
    1: 'text-blue-400'
  }
  return (
    <div className="flex items-center gap-2 text-xs text-text-tertiary mt-0.5">
      <span
        className="inline-block size-2 rounded-full shrink-0"
        style={{ backgroundColor: meta.projectColor }}
      />
      <span className="truncate max-w-32">{meta.projectName}</span>
      {meta.dueDate && (
        <span className="flex items-center gap-1">
          <Calendar className="size-3" />
          {meta.dueDate}
        </span>
      )}
      {meta.priority > 0 && (
        <span className={priorityColors[meta.priority] ?? ''}>P{meta.priority}</span>
      )}
      {meta.statusName && <span className="text-muted-foreground">{meta.statusName}</span>}
    </div>
  )
}

function InboxMetadata({ meta }: { meta: InboxResultMetadata }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs text-text-tertiary mt-0.5">
      <span className="capitalize">{meta.itemType}</span>
      {meta.sourceUrl && (
        <span className="flex items-center gap-1 truncate max-w-48">
          <ExternalLink className="size-3" />
          {meta.sourceTitle ?? meta.sourceUrl}
        </span>
      )}
    </div>
  )
}

function MetadataRenderer({
  item,
  query
}: {
  item: SearchResultItemType
  query: string
}): React.JSX.Element | null {
  switch (item.metadata.type) {
    case 'note':
      return <NoteMetadata meta={item.metadata} query={query} />
    case 'journal':
      return <JournalMetadata meta={item.metadata} />
    case 'task':
      return <TaskMetadata meta={item.metadata} />
    case 'inbox':
      return <InboxMetadata meta={item.metadata} />
    default:
      return null
  }
}

export function SearchResultItem({
  item,
  query,
  onSelect
}: SearchResultItemProps): React.JSX.Element {
  const Icon = TYPE_ICONS[item.type]
  const noteEmoji = item.metadata.type === 'note' ? item.metadata.emoji : null

  return (
    <Command.Item
      value={`${item.type}-${item.id}`}
      onSelect={() => onSelect(item)}
      className="flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer
        data-[selected=true]:bg-muted
        transition-colors duration-75"
    >
      {noteEmoji ? (
        <span className="size-4 shrink-0 mt-0.5 text-sm leading-none flex items-center justify-center">
          {noteEmoji}
        </span>
      ) : (
        <Icon className="size-4 shrink-0 mt-0.5 text-text-tertiary" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">
          <HighlightedText text={item.title} query={query} />
        </div>
        {item.snippet && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            <HighlightedText text={item.snippet} query={query} />
          </div>
        )}
        <MetadataRenderer item={item} query={query} />
      </div>
      {item.matchType === 'fuzzy' && (
        <span className="text-[10px] text-text-tertiary shrink-0 mt-1">fuzzy</span>
      )}
    </Command.Item>
  )
}
