import { useCallback } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useTabPreferences } from '@/hooks/use-tab-preferences'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useTabs } from '@/contexts/tabs'
import { toast } from 'sonner'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
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
