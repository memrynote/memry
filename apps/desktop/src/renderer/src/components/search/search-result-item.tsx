import { CheckCircle2, Circle, FilePdf, FileText, Image, Mic, Video } from '@/lib/icons'
import type {
  NoteFileType,
  SearchResultItem as SearchResultItemType
} from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { InboxTypeIcon } from '@/components/inbox/inbox-type-icon'
import { PriorityIcon } from '@/components/tasks/priority-icon'
import { HighlightedText, SearchRow } from './search-row'
import { dayLabel, folderSegments, hostOf, priorityFor } from './search-format'
import { TYPE_ICONS } from './search-types'

export const resultValue = (item: SearchResultItemType): string => `result:${item.type}:${item.id}`

const FILE_ICONS: Record<Exclude<NoteFileType, 'markdown'>, typeof FileText> = {
  pdf: FilePdf,
  image: Image,
  audio: Mic,
  video: Video
}

function ResultIcon({ item }: { item: SearchResultItemType }): React.JSX.Element {
  const meta = item.metadata
  switch (meta.type) {
    case 'note': {
      if (meta.fileType && meta.fileType !== 'markdown') {
        const FileIcon = FILE_ICONS[meta.fileType]
        return <FileIcon />
      }
      if (meta.emoji) {
        return (
          <NoteIconDisplay
            value={meta.emoji}
            className="flex size-4 items-center justify-center text-sm leading-none"
          />
        )
      }
      return <FileText />
    }
    case 'task':
      return meta.completedAt ? <CheckCircle2 /> : <Circle />
    case 'inbox':
      return <InboxTypeIcon type={meta.itemType} className="size-[15px]" />
    default: {
      const Icon = TYPE_ICONS[item.type]
      return <Icon />
    }
  }
}

function trailingHint(item: SearchResultItemType, locale: string): string | null {
  const meta = item.metadata
  switch (meta.type) {
    case 'note':
      return folderSegments(meta.path).at(-1) ?? null
    case 'journal':
      return dayLabel(meta.date, locale)
    case 'task':
      return meta.dueDate ? dayLabel(meta.dueDate, locale) : null
    case 'inbox':
      return meta.sourceUrl ? hostOf(meta.sourceUrl) : null
  }
}

interface SearchResultItemProps {
  item: SearchResultItemType
  query: string
  onSelect: (item: SearchResultItemType) => void
}

export function SearchResultItem({
  item,
  query,
  onSelect
}: SearchResultItemProps): React.JSX.Element {
  const { i18n } = useT('common')
  const meta = item.metadata
  const isTask = meta.type === 'task'
  return (
    <SearchRow
      value={resultValue(item)}
      onSelect={() => onSelect(item)}
      icon={<ResultIcon item={item} />}
      trailing={trailingHint(item, i18n.resolvedLanguage ?? i18n.language) ?? ''}
      endLane={
        isTask ? (
          meta.priority > 0 ? (
            <PriorityIcon priority={priorityFor(meta.priority)} />
          ) : null
        ) : undefined
      }
      muted={isTask && meta.completedAt !== null}
    >
      <HighlightedText text={item.title} query={query} />
    </SearchRow>
  )
}
