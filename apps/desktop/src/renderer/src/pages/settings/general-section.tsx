import { useCallback } from 'react'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useTabPreferences } from '@/hooks/use-tab-preferences'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useTabs } from '@/contexts/tabs'
import { toast } from 'sonner'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  SettingRowTall,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

export function GeneralSettings() {
  const {
    settings: tabSettings,
    isLoading: tabLoading,
    updateSettings: updateTabSettings
  } = useTabPreferences()
  const {
    settings: generalSettings,
    isLoading: generalLoading,
    updateSettings: updateGeneralSettings
  } = useGeneralSettings()
  const {
    state: updateState,
    isLoading: updaterLoading,
    error: updaterError,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall
  } = useAppUpdater()
  const { updateSettings: updateContextSettings } = useTabs()

  const isLoading = tabLoading || generalLoading

  const handleStartOnBootChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateGeneralSettings({ startOnBoot: enabled })
      if (!success) toast.error('Failed to update start on boot')
    },
    [updateGeneralSettings]
  )

  const handlePreviewModeChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateTabSettings({ previewMode: enabled })
      if (success) {
        updateContextSettings({ previewMode: enabled })
      } else {
        toast.error('Failed to update setting')
      }
    },
    [updateTabSettings, updateContextSettings]
  )

  const handleRestoreSessionChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateTabSettings({ restoreSessionOnStart: enabled })
      if (success) {
        updateContextSettings({ restoreSessionOnStart: enabled })
      } else {
        toast.error('Failed to update setting')
      }
    },
    [updateTabSettings, updateContextSettings]
  )

  const handleCreateInSelectedFolderChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateGeneralSettings({ createInSelectedFolder: enabled })
      if (!success) toast.error('Failed to update setting')
    },
    [updateGeneralSettings]
  )

  const handleClockFormatChange = useCallback(
    async (value: '12h' | '24h') => {
      const success = await updateGeneralSettings({ clockFormat: value })
      if (!success) toast.error('Failed to update time format')
    },
    [updateGeneralSettings]
  )

  const handleCloseButtonChange = useCallback(
    async (value: 'always' | 'hover' | 'active') => {
      const success = await updateTabSettings({ tabCloseButton: value })
      if (success) {
        updateContextSettings({ tabCloseButton: value })
      } else {
        toast.error('Failed to update setting')
      }
    },
    [updateTabSettings, updateContextSettings]
  )

  const handleUpdateAction = useCallback(async () => {
    try {
      if (!updateState.updateSupported) {
        toast.info('Auto-updates are available in packaged releases only')
        return
      }

      if (updateState.status === 'available') {
        await downloadUpdate()
        return
      }

      if (updateState.status === 'downloaded') {
        await quitAndInstall()
        return
      }

      const nextState = await checkForUpdates()
      if (nextState.status === 'up-to-date') {
        toast.success(`Memry ${nextState.currentVersion} is up to date`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Update action failed')
    }
  }, [
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    updateState.status,
    updateState.updateSupported
  ])

  const updateDescription = getUpdateDescription(updateState, updaterError)
  const updateActionLabel = getUpdateActionLabel(updateState)
  const isUpdateActionDisabled =
    updaterLoading || updateState.status === 'checking' || updateState.status === 'downloading'

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title="General" subtitle="Loading settings..." />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title="General" subtitle="Application startup and tab behavior" />

      <SettingsGroup label="Startup">
        <SettingRow label="Launch at Login" description="Start Memry when you log in">
          <Switch
            checked={generalSettings.startOnBoot}
            onCheckedChange={handleStartOnBootChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Updates">
        <SettingRowTall label="App Updates" description={updateDescription}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1 text-xs/4 text-muted-foreground">
              <span>Installed version {updateState.currentVersion}</span>
              {updateState.availableVersion && (
                <span>Available version {updateState.availableVersion}</span>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant={updateState.status === 'downloaded' ? 'default' : 'outline'}
              disabled={isUpdateActionDisabled}
              onClick={() => void handleUpdateAction()}
            >
              {updateActionLabel}
            </Button>
          </div>
        </SettingRowTall>
      </SettingsGroup>

      <SettingsGroup label="Date &amp; Time">
        <SettingRow label="Time Format" description="12-hour or 24-hour clock">
          <Select value={generalSettings.clockFormat} onValueChange={handleClockFormatChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="12h">12-hour</SelectItem>
              <SelectItem value="24h">24-hour</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Tab Behavior">
        <SettingRow
          label="Preview Mode"
          description="Single-click opens preview, double-click keeps open"
        >
          <Switch
            checked={tabSettings.previewMode}
            onCheckedChange={handlePreviewModeChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow
          label="Restore Session on Start"
          description="Reopen tabs from your last session"
        >
          <Switch
            checked={tabSettings.restoreSessionOnStart}
            onCheckedChange={handleRestoreSessionChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        <SettingRow label="Tab Close Button" description="When to show the close button">
          <Select value={tabSettings.tabCloseButton} onValueChange={handleCloseButtonChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">Always visible</SelectItem>
              <SelectItem value="hover">Show on hover</SelectItem>
              <SelectItem value="active">Only on active tab</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="File Creation">
        <SettingRow
          label="Create in Selected Folder"
          description="New notes and folders are created inside the currently selected folder. When off, items are always created at root."
        >
          <Switch
            checked={generalSettings.createInSelectedFolder}
            onCheckedChange={handleCreateInSelectedFolderChange}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}

function getUpdateActionLabel(state: AppUpdateState): string {
  switch (state.status) {
    case 'checking':
      return 'Checking...'
    case 'available':
      return 'Download Update'
    case 'downloading':
      return state.downloadProgressPercent == null
        ? 'Downloading...'
        : `Downloading ${state.downloadProgressPercent}%`
    case 'downloaded':
      return 'Restart to Install'
    default:
      return 'Check for Updates'
  }
}

function getUpdateDescription(state: AppUpdateState, updaterError: string | null): string {
  if (!state.updateSupported) {
    return 'Packaged builds can check, download, and install updates from GitHub Releases'
  }

  if (updaterError) {
    return updaterError
  }

  if (state.error) {
    return state.error
  }

  switch (state.status) {
    case 'available':
      return `Memry ${state.availableVersion ?? ''} is available to download`
    case 'downloading':
      return state.downloadProgressPercent == null
        ? 'Downloading the latest release'
        : `Downloading the latest release (${state.downloadProgressPercent}%)`
    case 'downloaded':
      return `Memry ${state.availableVersion ?? ''} is ready to install`
    case 'up-to-date':
      return 'This installation is on the latest published release'
    case 'checking':
      return 'Checking GitHub Releases for a newer version'
    default:
      return 'Check for new releases and install them without leaving the app'
  }
}
