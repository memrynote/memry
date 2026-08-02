import type React from 'react'
import { useMemo } from 'react'
import { useFolderView } from '@/hooks/use-folder-view'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useDisplayDensity } from '@/hooks/use-display-density'
import { useTabActions } from '@/contexts/tabs/context'
import { FolderListView } from '@/components/folder-view/folder-list-view'
import { FolderGalleryView } from '@/components/folder-view/folder-gallery-view'
import type { TagMetaMap } from '@/components/folder-view/note-card-pieces'
import { FolderTableView } from '@/components/folder-view/folder-table-view'
import { Skeleton } from '@/components/ui/skeleton'
import { Folder as FolderIcon } from '@/lib/icons/icon-map'
import { DEFAULT_COLUMNS } from '@memry/contracts/folder-view-api'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { useT } from '@memry/i18n/renderer'

type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'url'
  | 'rating'

export function FolderWidget({ config }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const folderPath = typeof config.folderPath === 'string' ? config.folderPath : ''
  const viewName = typeof config.viewName === 'string' ? config.viewName : undefined

  const {
    activeView,
    notes,
    availableProperties,
    formulasMap,
    updateNoteProperty,
    updateSorting,
    updateColumns,
    updateDisplayName,
    isLoading,
    error
  } = useFolderView({ scope: { kind: 'folder', path: folderPath }, initialViewName: viewName })
  const { tags: allTags } = useNoteTagsQuery()
  const { density } = useDisplayDensity()
  const { openTab } = useTabActions()

  const tagMetaMap = useMemo<TagMetaMap>(() => {
    const map: TagMetaMap = new Map()
    for (const tag of allTags) {
      map.set(tag.tag.toLowerCase(), { color: tag.color, icon: tag.icon ?? null })
    }
    return map
  }, [allTags])

  const propertyTypes = useMemo(() => {
    const map: Record<string, PropertyType> = {}
    for (const prop of availableProperties) {
      map[prop.name] = prop.type as PropertyType
    }
    return map
  }, [availableProperties])

  const handleNoteOpen = (noteId: string): void => {
    const note = notes.find((n) => n.id === noteId)
    if (!note) return
    openTab({
      type: 'note',
      title: note.title,
      icon: 'file-text',
      emoji: note.emoji,
      path: `/notes/${note.id}`,
      entityId: note.id,
      isPinned: false,
      isModified: false,
      isPreview: true,
      isDeleted: false
    })
  }

  if (!folderPath)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center text-[var(--text-tertiary)]">
        <FolderIcon className="size-6 opacity-50" aria-hidden="true" />
        <span className="text-xs">{t('home.widget.folderNoSelection')}</span>
      </div>
    )

  if (isLoading)
    return (
      <div className="flex flex-col gap-1" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    )

  if (error)
    return (
      <div role="alert" className="text-xs text-destructive" title={error}>
        {t('home.widget.loadError')}
      </div>
    )

  const viewType = activeView?.type ?? 'table'
  const columns = activeView?.columns ?? DEFAULT_COLUMNS

  return (
    <div data-widget-folder-view={viewType} className="h-full">
      {viewType === 'table' ? (
        <FolderTableView
          notes={notes}
          columns={columns}
          formulas={formulasMap}
          propertyTypes={propertyTypes}
          initialSorting={activeView?.order}
          onNoteOpen={handleNoteOpen}
          onOpenInNewTab={handleNoteOpen}
          onPropertyUpdate={(...args) => void updateNoteProperty(...args)}
          onSortingChange={(...args) => void updateSorting(...args)}
          onColumnsChange={(...args) => void updateColumns(...args)}
          onDisplayNameChange={(...args) => void updateDisplayName(...args)}
          density={density}
          className="h-full"
        />
      ) : viewType === 'grid' ? (
        <FolderGalleryView
          notes={notes}
          tagMetaMap={tagMetaMap}
          onNoteOpen={handleNoteOpen}
          className="h-full"
        />
      ) : (
        <FolderListView
          notes={notes}
          density={density}
          tagMetaMap={tagMetaMap}
          onNoteOpen={handleNoteOpen}
          className="h-full"
        />
      )}
    </div>
  )
}
