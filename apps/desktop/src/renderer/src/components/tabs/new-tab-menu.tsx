import { useCallback, useState, useEffect } from 'react'
import { Plus } from '@/lib/icons'
import { useTabs } from '@/contexts/tabs'
import { newItemViewState } from '@/contexts/tabs/helpers'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { revealNoteInSidebar } from '@/lib/reveal-in-sidebar'
import { useSelectedFolder } from '@/contexts/selected-folder-context'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useT } from '@memry/i18n/renderer'
import { Picker } from '@/components/ui/picker'
import { NewItemMenuItems } from './new-item-menu-items'
import { getI18n } from 'react-i18next'

const log = createLogger('NewTabMenu')

interface NewTabMenuProps {
  groupId: string
}

export function NewTabMenu({ groupId }: NewTabMenuProps): React.JSX.Element {
  const { t: tPhaseF } = useT('common')
  const { openTab } = useTabs()
  const { selectedFolder } = useSelectedFolder()
  const { settings: generalSettings } = useGeneralSettings()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener('memry:new-tab-menu', handler)
    return () => window.removeEventListener('memry:new-tab-menu', handler)
  }, [])

  const handleNewNote = useCallback(async () => {
    const folder = generalSettings.createInSelectedFolder ? selectedFolder : ''

    if (folder) {
      window.dispatchEvent(
        new CustomEvent('memry:expand-folder', { detail: { folderPath: folder } })
      )
    }

    try {
      const result = await notesService.create({
        title: 'Untitled Note',
        content: '',
        folder: folder || undefined
      })

      if (result.success && result.note) {
        openTab(
          {
            type: 'note',
            title: result.note.title || 'Untitled Note',
            icon: 'file-text',
            path: `/note/${result.note.id}`,
            entityId: result.note.id,
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          },
          { groupId }
        )
        // The expand above is a guess from the selection; this reveals where
        // the note actually landed, and scrolls it into view.
        revealNoteInSidebar(result.note.id)
      }
    } catch (error) {
      log.error('Failed to create new note', error)
      toast.error(
        extractErrorMessage(
          error,
          getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToCreateNote')
        )
      )
    }
  }, [openTab, groupId, selectedFolder, generalSettings.createInSelectedFolder])

  const handleNewJournal = useCallback(() => {
    openTab(
      {
        type: 'journal',
        title: 'Journal',
        icon: 'book-open',
        path: '/journal',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      },
      { groupId }
    )
  }, [openTab, groupId])

  const handleNewTask = useCallback(() => {
    openTab(
      {
        type: 'tasks',
        title: 'Tasks',
        icon: 'list-todo',
        path: '/tasks',
        viewState: newItemViewState('tasks'),
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      },
      { groupId }
    )
  }, [openTab, groupId])

  const handleOpenCalendar = useCallback(() => {
    openTab(
      {
        type: 'calendar',
        title: 'Calendar',
        icon: 'calendar',
        path: '/calendar',
        viewState: newItemViewState('calendar'),
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      },
      { groupId }
    )
  }, [openTab, groupId])

  const handleOpenInbox = useCallback(() => {
    openTab(
      {
        type: 'inbox',
        title: 'Inbox',
        icon: 'inbox',
        path: '/inbox',
        viewState: newItemViewState('inbox'),
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      },
      { groupId }
    )
  }, [openTab, groupId])

  const handleOpenTags = useCallback(() => {
    openTab(
      {
        type: 'tags',
        title: 'Tags',
        icon: 'tag',
        path: '/tags',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      },
      { groupId }
    )
  }, [openTab, groupId])

  return (
    <Picker open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Picker.Trigger asChild>
            <button
              type="button"
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md',
                'text-text-tertiary hover:text-foreground',
                'hover:bg-surface-active/50',
                'transition-all duration-150 ease-out',
                'active:scale-95 active:bg-surface-active/70'
              )}
              aria-label={tPhaseF('phaseF.componentsTabsNewTabMenu.newTab')}
            >
              <Plus className="w-4 h-4" />
            </button>
          </Picker.Trigger>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="text-xs px-2.5 py-1.5 font-medium bg-primary text-primary-foreground border-0"
        >
          {tPhaseF('phaseF.componentsTabsNewTabMenu.newTab2')}
        </TooltipContent>
      </Tooltip>
      <Picker.Content width={200} align="start" side="bottom">
        <NewItemMenuItems
          actions={{
            onNewNote: () => void handleNewNote(),
            onJournal: handleNewJournal,
            onCalendar: handleOpenCalendar,
            onInbox: handleOpenInbox,
            onTasks: handleNewTask,
            onTags: handleOpenTags
          }}
        />
      </Picker.Content>
    </Picker>
  )
}
