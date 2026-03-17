import { useCallback } from 'react'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Info } from '@/lib/icons'
import { useTabPreferences } from '@/hooks/use-tab-preferences'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useTabs } from '@/contexts/tabs'
import { toast } from 'sonner'

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
        toast.success(enabled ? 'Preview mode enabled' : 'Preview mode disabled')
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
        toast.success(enabled ? 'Session will be restored on start' : 'Session restore disabled')
      } else {
        toast.error('Failed to update setting')
      }
    },
    [updateTabSettings, updateContextSettings]
  )

  const handleCloseButtonChange = useCallback(
    async (value: 'always' | 'hover' | 'active') => {
      const success = await updateTabSettings({ tabCloseButton: value })
      if (success) {
        updateContextSettings({ tabCloseButton: value })
        toast.success('Close button visibility updated')
      } else {
        toast.error('Failed to update setting')
      }
    },
    [updateTabSettings, updateContextSettings]
  )

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">General</h3>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">General</h3>
        <p className="text-sm text-muted-foreground">General application settings</p>
      </div>

      <Separator />

      {/* Startup */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Startup
        </h4>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="start-on-boot">Launch at Login</Label>
            <p className="text-sm text-muted-foreground">
              Automatically start Memry when you log in to your computer
            </p>
          </div>
          <Switch
            id="start-on-boot"
            checked={generalSettings.startOnBoot}
            onCheckedChange={handleStartOnBootChange}
          />
        </div>
      </div>

      <Separator />

      {/* Tab Behavior */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Tab Behavior
        </h4>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="preview-mode">Preview Mode</Label>
            <p className="text-sm text-muted-foreground">
              Single-click opens a preview tab, double-click opens permanently
            </p>
          </div>
          <Switch
            id="preview-mode"
            checked={tabSettings.previewMode}
            onCheckedChange={handlePreviewModeChange}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="restore-session">Restore Session on Start</Label>
            <p className="text-sm text-muted-foreground">
              Reopen your tabs from your last session when the app starts
            </p>
          </div>
          <Switch
            id="restore-session"
            checked={tabSettings.restoreSessionOnStart}
            onCheckedChange={handleRestoreSessionChange}
          />
        </div>

        <div className="space-y-2">
          <Label>Tab Close Button</Label>
          <p className="text-sm text-muted-foreground">When to show the close button on tabs</p>
          <Select value={tabSettings.tabCloseButton} onValueChange={handleCloseButtonChange}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">Always visible</SelectItem>
              <SelectItem value="hover">Show on hover</SelectItem>
              <SelectItem value="active">Only on active tab</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-muted-foreground">
            Tab settings take effect immediately. Preview mode is useful for quickly browsing items
            - single-click to preview, double-click to keep open.
          </p>
        </div>
      </div>
    </div>
  )
}
