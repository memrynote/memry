import { useEffect, useEffectEvent, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useSidebar } from '@/components/ui/sidebar'
import { useActiveTab } from '@/contexts/tabs'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { SettingsContent } from '@/pages/settings'
import { getSettingsParent } from '@/pages/settings/settings-navigation'

/**
 * Settings, shown in the workspace in place of the tab panes. Its navigation
 * renders in the sidebar panel (AppSidebar swaps in `SettingsNav`). Mounted
 * only while settings is open.
 */
export function SettingsView() {
  const { close, activeSection, setActiveSection } = useSettingsModal()
  const { t } = useT('settings')

  useExpandSidebarWhileMounted()

  // Anything that activates a different tab (⌘K, back/forward, a link, a
  // notification) is a request to leave settings for that tab. Those paths are
  // spread across the app, so settings watches the result instead of each caller.
  const activeTabId = useActiveTab()?.id
  const [openedOnTabId] = useState(activeTabId)
  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler */
  useEffect(() => {
    if (activeTabId !== openedOnTabId) close()
  }, [activeTabId, openedOnTabId, close])
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Open menus, selects and dialogs consume their own Escape (Radix marks it
      // prevented), as does a non-empty settings search.
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      // In a drill-in sub-page, Escape steps back instead of leaving settings.
      const parent = getSettingsParent(activeSection)
      if (parent) setActiveSection(parent)
      else close()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSection, setActiveSection, close])

  return (
    <section
      aria-label={t('page.title')}
      data-testid="settings-view"
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Title row: the tab bars normally sit here. Empty, it drags the window. */}
      <div className="drag-region h-9 shrink-0" />
      <SettingsContent />
    </section>
  )
}

/**
 * The settings nav lives in the sidebar panel, so a collapsed panel would hide
 * it. Expand it for the visit and collapse it again on the way out.
 */
function useExpandSidebarWhileMounted(): void {
  const { open, setOpen } = useSidebar()
  const [wasCollapsed] = useState(!open)
  const setSidebarOpen = useEffectEvent((value: boolean) => setOpen(value))

  useEffect(() => {
    if (!wasCollapsed) return
    setSidebarOpen(true)
    return () => setSidebarOpen(false)
  }, [wasCollapsed])
}
