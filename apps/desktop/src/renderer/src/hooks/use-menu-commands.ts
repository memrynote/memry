import { useEffect, useRef } from 'react'
import { useTheme } from 'next-themes'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { isLastHomeTab } from '@/contexts/tabs/helpers'
import { useSidebar } from '@/components/ui/sidebar'
import { useDayPanel } from '@/contexts/day-panel-context'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import {
  isEditorMenuCommand,
  runEditorMenuCommand,
  runHistoryMenuCommand
} from '@/lib/menu-commands'
import { runMenuUpdateCheck } from '@/lib/menu-update-check'
import { clampZoomFactor, stepZoomFactor, ZOOM_FACTOR_DEFAULT } from '@memry/contracts/app-zoom'

interface MenuCommandHandlers {
  onNewNote: () => void
  onOpenSearch: () => void
}

/**
 * Routes native menu-bar commands (sent from the main process over
 * `app:menu-command`) to existing renderer actions. Editor commands fall
 * through to the focused BlockNote editor.
 */
export function useMenuCommands({ onNewNote, onOpenSearch }: MenuCommandHandlers): void {
  const { state, closeTab } = useTabs()
  const activeTab = useActiveTab()
  const { toggleSidebar } = useSidebar()
  const { toggle: toggleDayPanel } = useDayPanel()
  const { open: openSettings } = useSettingsModal()
  const { setTheme } = useTheme()
  const { settings, updateSettings } = useGeneralSettings()

  const zoomFactor = clampZoomFactor(settings.zoomFactor)
  // Applied before the write is awaited so the keystroke lands instantly; the
  // settings round trip only has to catch up before the next launch.
  const applyZoom = async (factor: number): Promise<void> => {
    window.api.setZoomFactor(factor)
    await updateSettings({ zoomFactor: factor })
  }

  const handlers: Record<string, () => void> = {
    'file.newNote': onNewNote,
    'file.openQuickly': onOpenSearch,
    // Same rule as ⌘W: the last Home tab is the floor, so closing it closes the window.
    'file.closeTab': () => {
      if (!activeTab) return
      if (isLastHomeTab(state, state.activeGroupId)) window.api.windowClose()
      else closeTab(activeTab.id)
    },
    'file.closeWindow': () => window.api.windowClose(),
    'file.exportPdf': () => window.dispatchEvent(new CustomEvent('memry:menu-export')),
    'edit.undo': () => runHistoryMenuCommand('undo'),
    'edit.redo': () => runHistoryMenuCommand('redo'),
    'edit.find': () => window.dispatchEvent(new CustomEvent('memry:menu-find')),
    'app.preferences': () => openSettings(),
    'app.checkForUpdates': () => void runMenuUpdateCheck(),
    'view.zoomIn': () => void applyZoom(stepZoomFactor(zoomFactor, 1)),
    'view.zoomOut': () => void applyZoom(stepZoomFactor(zoomFactor, -1)),
    'view.actualSize': () => void applyZoom(ZOOM_FACTOR_DEFAULT),
    'view.toggleSidebar': toggleSidebar,
    'view.toggleDayPanel': toggleDayPanel,
    'view.shortcuts': () => window.dispatchEvent(new CustomEvent('memry:open-shortcuts')),
    'view.theme.light': () => setTheme('light'),
    'view.theme.dark': () => setTheme('dark'),
    'view.theme.white': () => setTheme('white'),
    'view.theme.system': () => setTheme('system')
  }

  // Keep the latest handlers in a ref so the IPC subscription stays stable.
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    return window.api.onMenuCommand(({ command }) => {
      const handler = handlersRef.current[command]
      if (handler) {
        handler()
        return
      }
      if (isEditorMenuCommand(command)) runEditorMenuCommand(command)
    })
  }, [])
}
