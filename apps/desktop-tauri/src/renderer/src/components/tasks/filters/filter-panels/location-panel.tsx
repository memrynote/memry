import { useMemo } from 'react'

import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import type { Task } from '@/data/task-model'
import type { TaskNoteIndex } from '@/lib/task-note-index'
import { buildTaskLocationOptions } from '@/lib/task-location-options'
import { useNoteFoldersQuery } from '@/hooks/use-notes-query'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { BackButton } from './priority-panel'
import { useT } from '@memry/i18n/renderer'

interface LocationPanelProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  selectedFolderPaths: string[]
  selectedNoteIds: string[]
  onToggleFolder: (folderPath: string) => void
  onToggleNote: (noteId: string) => void
  onGoBack: () => void
  tasks: Task[]
  /** `undefined` while the note list loads. */
  noteIndex: TaskNoteIndex | undefined
}

export const LocationIcon = ({ size = 14 }: { size?: number }): React.JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 14 14"
    fill="none"
    className="shrink-0 text-muted-foreground"
  >
    <path
      d="M1.75 4V10.5A1.25 1.25 0 0 0 3 11.75h8A1.25 1.25 0 0 0 12.25 10.5V5.25A1.25 1.25 0 0 0 11 4H7L5.75 2.25H3A1.25 1.25 0 0 0 1.75 3.5z"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
  </svg>
)

const NoteIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    className="shrink-0 text-muted-foreground"
  >
    <path
      d="M3.5 1.75h4.5l2.5 2.5v8h-7z M8 1.75v2.5h2.5"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
  </svg>
)

export function LocationPanel({
  searchQuery,
  onSearchChange,
  selectedFolderPaths,
  selectedNoteIds,
  onToggleFolder,
  onToggleNote,
  onGoBack,
  tasks,
  noteIndex
}: LocationPanelProps): React.JSX.Element {
  const { t } = useT('tasks')

  const options = useMemo(
    () =>
      noteIndex
        ? buildTaskLocationOptions(
            tasks,
            noteIndex,
            { folderPaths: selectedFolderPaths, noteIds: selectedNoteIds },
            searchQuery
          )
        : [],
    [tasks, noteIndex, selectedFolderPaths, selectedNoteIds, searchQuery]
  )
  const isSearching = searchQuery.trim() !== ''

  // The icons the sidebar tree shows. Same query and cache entry as the tree.
  const { folders } = useNoteFoldersQuery()
  const folderIcons = useMemo(
    () =>
      new Map(
        folders.flatMap((folder) => (folder.icon ? [[folder.path, folder.icon] as const] : []))
      ),
    [folders]
  )

  return (
    <>
      <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
        <BackButton onClick={onGoBack} />
        <LocationIcon />
        <span className="text-[13px] text-foreground font-medium leading-4">
          {t('phaseF.componentsTasksFiltersFilterPanelsLocationPanel.location')}
        </span>
      </div>
      <FilterSearchHeader
        value={searchQuery}
        onChange={onSearchChange}
        placeholder={t('phaseF.componentsTasksFiltersFilterPanelsLocationPanel.search')}
        className="py-1.5"
      />
      {/* Scrolls on its own so the header and search stay put in a large vault. */}
      <div className="flex max-h-[min(360px,calc(100vh-220px))] flex-col overflow-y-auto p-1">
        {noteIndex && options.length === 0 && (
          <span className="px-2 py-1.5 text-[12px] text-text-tertiary leading-4">
            {t('phaseF.componentsTasksFiltersFilterPanelsLocationPanel.empty')}
          </span>
        )}
        {options.map((option) => {
          const customIcon = option.kind === 'note' ? option.icon : folderIcons.get(option.value)
          const checked =
            option.kind === 'folder'
              ? selectedFolderPaths.includes(option.value)
              : selectedNoteIds.includes(option.value)
          return (
            <button
              key={`${option.kind}:${option.value}`}
              type="button"
              onClick={() =>
                option.kind === 'folder' ? onToggleFolder(option.value) : onToggleNote(option.value)
              }
              title={option.context ? `${option.context}/${option.label}` : option.label}
              style={{ paddingInlineStart: 8 + option.depth * 12 }}
              className={cn(
                'flex items-center rounded-[5px] py-1.5 pe-2 gap-2 transition-colors',
                checked ? 'bg-accent' : 'hover:bg-accent'
              )}
            >
              {customIcon ? (
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  <NoteIconDisplay
                    value={customIcon}
                    className="text-[12px] leading-none"
                    customIconClassName="size-3.5"
                  />
                </span>
              ) : option.kind === 'note' ? (
                <NoteIcon />
              ) : (
                <LocationIcon size={12} />
              )}
              <span className="flex min-w-0 flex-col items-start">
                <span
                  className={cn(
                    'max-w-full truncate text-[13px] leading-4',
                    checked ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {option.label}
                </span>
                {isSearching && option.context && (
                  <span className="max-w-full truncate text-[11px] text-text-tertiary leading-3.5">
                    {option.context}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  'ms-auto text-[11px] leading-3.5 tabular-nums',
                  checked ? 'text-text-secondary' : 'text-text-tertiary'
                )}
              >
                {option.count}
              </span>
              {checked && <CheckMark className="text-foreground" />}
            </button>
          )
        })}
      </div>
    </>
  )
}
