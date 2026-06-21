import type React from 'react'
import { useMemo } from 'react'
import { useFolderNotes } from '@/hooks/use-folder-notes'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { useDisplayDensity } from '@/hooks/use-display-density'
import { useTabActions } from '@/contexts/tabs/context'
import { FolderListView } from '@/components/folder-view/folder-list-view'
import { FolderBoardView } from '@/components/folder-view/folder-board-view'
import { FolderGalleryView } from '@/components/folder-view/folder-gallery-view'
import type { WidgetComponentProps } from '@/lib/home/widget-registry'
import { useT } from '@memry/i18n/renderer'

type FolderViewType = 'list' | 'board' | 'gallery'

export function FolderWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { t } = useT('common')
  const folderPath = typeof config.folderPath === 'string' ? config.folderPath : ''
  const viewType = (config.viewType as FolderViewType) ?? 'list'
  const limit = size === 'L' ? 24 : 12

  const { notes, isLoading } = useFolderNotes({ folderPath, limit })
  const { tags: allTags } = useNoteTagsQuery()
  const { density } = useDisplayDensity()
  const { openTab } = useTabActions()

  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const tag of allTags) {
      map.set(tag.tag.toLowerCase(), tag.color)
    }
    return map
  }, [allTags])

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
    return <div className="text-xs text-muted-foreground">{t('home.widget.folderPickPrompt')}</div>

  if (isLoading) return <div className="text-xs text-muted-foreground">{t('state.loading')}</div>

  return (
    <div data-widget-folder-view={viewType} className="h-full">
      {viewType === 'board' ? (
        <FolderBoardView
          notes={notes}
          tagColorMap={tagColorMap}
          availableProperties={[]}
          onNoteOpen={handleNoteOpen}
          className="h-full"
        />
      ) : viewType === 'gallery' ? (
        <FolderGalleryView
          notes={notes}
          tagColorMap={tagColorMap}
          onNoteOpen={handleNoteOpen}
          className="h-full"
        />
      ) : (
        <FolderListView
          notes={notes}
          density={density}
          tagColorMap={tagColorMap}
          onNoteOpen={handleNoteOpen}
          className="h-full"
        />
      )}
    </div>
  )
}
