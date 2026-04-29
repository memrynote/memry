import { useCallback, useState, useEffect } from 'react'
import { Plus, FileText, BookOpen, Calendar, Inbox, ListTodo } from '@/lib/icons'
import { useTabs } from '@/contexts/tabs'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useSelectedFolder } from '@/contexts/selected-folder-context'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useT } from '@memry/i18n/renderer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      },
      { groupId }
    )
  }, [openTab, groupId])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
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
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="text-xs px-2.5 py-1.5 font-medium bg-primary text-primary-foreground border-0"
        >
          {tPhaseF('phaseF.componentsTabsNewTabMenu.newTab2')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="bottom" align="start" className="min-w-[180px]">
        <DropdownMenuItem onClick={handleNewNote}>
          <FileText className="size-4" />
          <span>{tPhaseF('phaseF.componentsTabsNewTabMenu.newNote')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleNewJournal}>
          <BookOpen className="size-4" />
          <span>{tPhaseF('phaseF.componentsTabsNewTabMenu.journal')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleOpenCalendar}>
          <Calendar className="size-4" />
          <span>{tPhaseF('phaseF.componentsTabsNewTabMenu.calendar')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleOpenInbox}>
          <Inbox className="size-4" />
          <span>{tPhaseF('phaseF.componentsTabsNewTabMenu.inboxCapture')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleNewTask}>
          <ListTodo className="size-4" />
          <span>{tPhaseF('phaseF.componentsTabsNewTabMenu.tasks')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
