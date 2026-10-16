import type { RefObject } from 'react'
import { useAppCommands } from '@/commands'
import type { NotesTreeActions } from '@/components/notes-tree'
import { expandSidebarSection } from '@/components/sidebar-section'

interface SidebarTreeCommandsArgs {
  notesTreeRef: RefObject<NotesTreeActions | null>
  /** The folder tree is mounted and on screen: the sidebar is open and Settings is not covering it. */
  isTreeVisible: boolean
  isCanvasEnabled: boolean
  createCanvas: () => Promise<void>
  createProject: () => void
  onFoldersExpandedChange: (expanded: boolean) => void
}

/**
 * The owner of the commands the sidebar carries out: its folder tree actions and
 * the creators beside them. The tree commands wait for the tree to be on screen,
 * because a new folder asks for its name in place. They open the Collections
 * section first, because it starts collapsed and would hide that field.
 */
export function useSidebarTreeCommands({
  notesTreeRef,
  isTreeVisible,
  isCanvasEnabled,
  createCanvas,
  createProject,
  onFoldersExpandedChange
}: SidebarTreeCommandsArgs): void {
  useAppCommands('sidebarTree', {
    'create.folder': {
      enabled: isTreeVisible,
      run: () => {
        expandSidebarSection('collections')
        notesTreeRef.current?.createFolder()
      }
    },
    'create.canvas': { enabled: isCanvasEnabled, run: createCanvas },
    'create.project': { run: createProject },
    'folders.expandAll': {
      enabled: isTreeVisible,
      run: () => {
        expandSidebarSection('collections')
        notesTreeRef.current?.expandAll()
        onFoldersExpandedChange(true)
      }
    },
    'folders.collapseAll': {
      enabled: isTreeVisible,
      run: () => {
        notesTreeRef.current?.collapseAll()
        onFoldersExpandedChange(false)
      }
    }
  })
}
