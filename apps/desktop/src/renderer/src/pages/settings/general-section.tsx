import { useCallback, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Info, Sun, Moon, Monitor, Check, ALargeSmall } from 'lucide-react'
import { useTabPreferences } from '@/hooks/use-tab-preferences'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useTabs } from '@/contexts/tabs'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const ACCENT_PRESETS = [
  { value: '#6366f1', label: 'Indigo' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#10b981', label: 'Emerald' },
  { value: '#ef4444', label: 'Red' },
  { value: '#8b5cf6', label: 'Violet' },
  { value: '#06b6d4', label: 'Cyan' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#f97316', label: 'Orange' }
] as const

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/

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
  const [customHex, setCustomHex] = useState('')

  const isLoading = tabLoading || generalLoading

  const handleThemeChange = useCallback(
    async (value: string) => {
      if (!value) return
      const theme = value as 'light' | 'dark' | 'system'
      const success = await updateGeneralSettings({ theme })
      if (!success) toast.error('Failed to update theme')
    },
    [updateGeneralSettings]
  )

  const handleAccentChange = useCallback(
    async (hex: string) => {
      const success = await updateGeneralSettings({ accentColor: hex })
      if (!success) toast.error('Failed to update accent color')
    },
    [updateGeneralSettings]
  )

  const handleCustomHexSubmit = useCallback(() => {
    if (HEX_COLOR_REGEX.test(customHex)) {
      void handleAccentChange(customHex)
      setCustomHex('')
    }
  }, [customHex, handleAccentChange])

  const handleFontSizeChange = useCallback(
    async (value: string) => {
      if (!value) return
      const fontSize = value as 'small' | 'medium' | 'large'
      const success = await updateGeneralSettings({ fontSize })
      if (!success) toast.error('Failed to update font size')
    },
    [updateGeneralSettings]
  )

  const handleFontFamilyChange = useCallback(
    async (value: string) => {
      const fontFamily = value as 'system' | 'serif' | 'sans-serif' | 'monospace'
      const success = await updateGeneralSettings({ fontFamily })
      if (!success) toast.error('Failed to update font family')
    },
    [updateGeneralSettings]
  )

  const handleReducedMotionChange = useCallback(
    async (enabled: boolean) => {
      const success = await updateGeneralSettings({ reducedMotion: enabled })
      if (!success) toast.error('Failed to update reduced motion')
    },
    [updateGeneralSettings]
  )

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

      {/* Theme Section */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Theme
        </h4>

        <div className="space-y-2">
          <Label>Color Mode</Label>
          <p className="text-sm text-muted-foreground">
            Choose between light, dark, or follow your system preference
          </p>
          <ToggleGroup
            type="single"
            value={generalSettings.theme}
            onValueChange={handleThemeChange}
            className="justify-start"
          >
            <ToggleGroupItem value="light" aria-label="Light theme" className="gap-2 px-4">
              <Sun className="w-4 h-4" />
              Light
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" aria-label="Dark theme" className="gap-2 px-4">
              <Moon className="w-4 h-4" />
              Dark
            </ToggleGroupItem>
            <ToggleGroupItem value="system" aria-label="System theme" className="gap-2 px-4">
              <Monitor className="w-4 h-4" />
              System
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <Separator />

      {/* Accent Color Section */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Accent Color
        </h4>

        <div className="space-y-3">
          <Label>Pick an accent color</Label>
          <div className="flex flex-wrap gap-2">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => void handleAccentChange(preset.value)}
                className={cn(
                  'w-8 h-8 rounded-full transition-all duration-150 relative',
                  'hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  generalSettings.accentColor === preset.value &&
                    'ring-2 ring-offset-2 ring-offset-background ring-foreground/50'
                )}
                style={{ backgroundColor: preset.value }}
                title={preset.label}
              >
                {generalSettings.accentColor === preset.value && (
                  <Check className="w-4 h-4 text-white absolute inset-0 m-auto drop-shadow-sm" />
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 max-w-xs">
            <Input
              placeholder="#hex"
              value={customHex}
              onChange={(e) => setCustomHex(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustomHexSubmit()}
              className="w-28 font-mono text-sm"
              maxLength={7}
            />
            {customHex && HEX_COLOR_REGEX.test(customHex) && (
              <button
                type="button"
                onClick={handleCustomHexSubmit}
                className="w-8 h-8 rounded-full border-2 border-border shrink-0 transition-transform hover:scale-110"
                style={{ backgroundColor: customHex }}
                title="Apply custom color"
              />
            )}
            {generalSettings.accentColor &&
              !ACCENT_PRESETS.some((p) => p.value === generalSettings.accentColor) && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <div
                    className="w-4 h-4 rounded-full ring-1 ring-border"
                    style={{ backgroundColor: generalSettings.accentColor }}
                  />
                  <span className="font-mono">{generalSettings.accentColor}</span>
                </div>
              )}
          </div>
        </div>
      </div>

      <Separator />

      {/* Typography Section */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Typography
        </h4>

        <div className="space-y-2">
          <Label>Font Size</Label>
          <p className="text-sm text-muted-foreground">Adjust the base text size across the app</p>
          <ToggleGroup
            type="single"
            value={generalSettings.fontSize}
            onValueChange={handleFontSizeChange}
            className="justify-start"
          >
            <ToggleGroupItem value="small" aria-label="Small font size" className="gap-2 px-4">
              <ALargeSmall className="w-3.5 h-3.5" />
              Small
            </ToggleGroupItem>
            <ToggleGroupItem value="medium" aria-label="Medium font size" className="gap-2 px-4">
              <ALargeSmall className="w-4 h-4" />
              Medium
            </ToggleGroupItem>
            <ToggleGroupItem value="large" aria-label="Large font size" className="gap-2 px-4">
              <ALargeSmall className="w-5 h-5" />
              Large
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="space-y-2">
          <Label>Font Family</Label>
          <p className="text-sm text-muted-foreground">
            Choose the primary typeface for the interface
          </p>
          <Select value={generalSettings.fontFamily} onValueChange={handleFontFamilyChange}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System Default</SelectItem>
              <SelectItem value="sans-serif">Sans-serif (DM Sans)</SelectItem>
              <SelectItem value="serif">Serif (Crimson Pro)</SelectItem>
              <SelectItem value="monospace">Monospace</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Separator />

      {/* Accessibility Section */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Accessibility
        </h4>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="reduced-motion">Reduced Motion</Label>
            <p className="text-sm text-muted-foreground">
              Minimize animations and transitions throughout the app
            </p>
          </div>
          <Switch
            id="reduced-motion"
            checked={generalSettings.reducedMotion}
            onCheckedChange={handleReducedMotionChange}
          />
        </div>
      </div>

      <Separator />

      {/* Startup Section */}
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

      {/* Tab Behavior Section */}
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
