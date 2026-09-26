import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Settings } from '@/lib/icons'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { toUpdatePresentation } from '@/components/updater/update-presentation'
import { UpdatePopover } from '@/components/updater/update-popover'
import { DockButton } from '@/components/sidebar/footer-dock'

/**
 * Settings gear in the footer dock. When an update is waiting on the user
 * (available with auto-download off, or downloaded) the gear carries a tint dot
 * and a click opens the update popover, which links on to Settings. Otherwise a
 * click opens Settings directly. Downloading and failed installs keep their
 * full-width row above the dock (progress bar, recovery), see SidebarUpdateRow.
 */
export function SidebarSettingsButton(): React.JSX.Element {
  const { t } = useT('common')
  const { open: openSettings } = useSettingsModal()
  const { state } = useAppUpdater()
  const [open, setOpen] = useState(false)

  const presentation = toUpdatePresentation(state)
  const settingsLabel = t('phaseF.componentsVaultSwitcher.settings')

  if (presentation.kind !== 'available' && presentation.kind !== 'ready') {
    return (
      <DockButton
        data-tour="settings"
        onClick={() => openSettings()}
        aria-label={settingsLabel}
        title={settingsLabel}
      >
        <Settings aria-hidden="true" />
      </DockButton>
    )
  }

  const updateLabel = presentation.kind === 'ready' ? t('update.ready') : t('update.available')
  const label = `${settingsLabel} · ${updateLabel}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <DockButton data-tour="settings" aria-label={label} title={label} badge="tint">
          <Settings aria-hidden="true" />
        </DockButton>
      </PopoverTrigger>
      <UpdatePopover
        kind={presentation.kind}
        version={presentation.version}
        state={state}
        align="end"
        onClose={() => setOpen(false)}
        onOpenSettings={() => {
          setOpen(false)
          openSettings()
        }}
      />
    </Popover>
  )
}
