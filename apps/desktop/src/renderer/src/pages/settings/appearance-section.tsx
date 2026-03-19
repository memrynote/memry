import { useCallback, useState } from 'react'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Sun, Moon, Monitor, Check, ALargeSmall, FileText } from '@/lib/icons'
import { useGeneralSettings } from '@/hooks/use-general-settings'
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

export function AppearanceSettings() {
  const { settings, isLoading, updateSettings } = useGeneralSettings()
  const [customHex, setCustomHex] = useState('')

  const handleThemeChange = useCallback(
    async (value: string) => {
      if (!value) return
      const theme = value as 'light' | 'dark' | 'white' | 'system'
      const success = await updateSettings({ theme })
      if (!success) toast.error('Failed to update theme')
    },
    [updateSettings]
  )

  const handleAccentChange = useCallback(
    async (hex: string) => {
      const success = await updateSettings({ accentColor: hex })
      if (!success) toast.error('Failed to update accent color')
    },
    [updateSettings]
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
      const success = await updateSettings({ fontSize })
      if (!success) toast.error('Failed to update font size')
    },
    [updateSettings]
  )

  const handleFontFamilyChange = useCallback(
    async (value: string) => {
      const fontFamily = value as 'system' | 'serif' | 'sans-serif' | 'monospace'
      const success = await updateSettings({ fontFamily })
      if (!success) toast.error('Failed to update font family')
    },
    [updateSettings]
  )

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Appearance</h3>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Appearance</h3>
        <p className="text-sm text-muted-foreground">Customize the look and feel</p>
      </div>

      <Separator />

      {/* Theme */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Theme
        </h4>

        <div className="space-y-2">
          <Label>Color Mode</Label>
          <p className="text-sm text-muted-foreground">
            Choose a color mode or follow your system preference
          </p>
          <ToggleGroup
            type="single"
            value={settings.theme}
            onValueChange={handleThemeChange}
            className="justify-start"
          >
            <ToggleGroupItem value="light" aria-label="Light theme" className="gap-2 px-4">
              <Sun className="w-4 h-4" />
              Warm
            </ToggleGroupItem>
            <ToggleGroupItem value="white" aria-label="White theme" className="gap-2 px-4">
              <FileText className="w-4 h-4" />
              White
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

      {/* Accent Color */}
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
                  'hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  settings.accentColor === preset.value &&
                    'ring-2 ring-offset-2 ring-offset-background ring-foreground/50'
                )}
                style={{ backgroundColor: preset.value }}
                title={preset.label}
              >
                {settings.accentColor === preset.value && (
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
            {settings.accentColor &&
              !ACCENT_PRESETS.some((p) => p.value === settings.accentColor) && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <div
                    className="w-4 h-4 rounded-full ring-1 ring-border"
                    style={{ backgroundColor: settings.accentColor }}
                  />
                  <span className="font-mono">{settings.accentColor}</span>
                </div>
              )}
          </div>
        </div>
      </div>

      <Separator />

      {/* Typography */}
      <div className="space-y-6">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Typography
        </h4>

        <div className="space-y-2">
          <Label>Font Size</Label>
          <p className="text-sm text-muted-foreground">Adjust the base text size across the app</p>
          <ToggleGroup
            type="single"
            value={settings.fontSize}
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
          <Select value={settings.fontFamily} onValueChange={handleFontFamilyChange}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System Default</SelectItem>
              <SelectItem value="sans-serif">Sans-serif (System)</SelectItem>
              <SelectItem value="serif">Serif (Crimson Pro)</SelectItem>
              <SelectItem value="monospace">Monospace</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}
