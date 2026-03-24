import { type ComponentType, Fragment, useCallback, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Sun, Moon, Monitor, FileText } from '@/lib/icons'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

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

interface SegmentOption {
  value: string
  label: string
  icon?: ComponentType<{ className?: string }>
}

function SegmentedControl({
  options,
  value,
  onValueChange,
  ariaLabel
}: {
  options: readonly SegmentOption[]
  value: string
  onValueChange: (v: string) => void
  ariaLabel: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex items-center shrink-0 rounded-lg overflow-hidden border border-border"
    >
      {options.map((opt, i) => {
        const isActive = value === opt.value
        const prevActive = i > 0 && value === options[i - 1].value
        const Icon = opt.icon

        return (
          <Fragment key={opt.value}>
            {i > 0 && !isActive && !prevActive && <div className="w-px h-5 bg-border shrink-0" />}
            <button
              type="button"
              aria-pressed={isActive}
              onClick={() => onValueChange(opt.value)}
              className={cn(
                'flex items-center gap-1.5 py-1.5 px-3 text-xs transition-colors cursor-pointer',
                isActive
                  ? 'bg-tint text-tint-foreground font-semibold'
                  : 'bg-foreground/[0.04] text-muted-foreground hover:text-foreground'
              )}
            >
              {Icon && <Icon className="size-3" />}
              {opt.label}
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}

const THEME_OPTIONS: SegmentOption[] = [
  { value: 'light', label: 'Warm', icon: Sun },
  { value: 'white', label: 'White', icon: FileText },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor }
]

const FONT_SIZE_OPTIONS: SegmentOption[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' }
]

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
      const fontFamily = value as
        | 'system'
        | 'serif'
        | 'sans-serif'
        | 'monospace'
        | 'gelasio'
        | 'geist'
        | 'inter'
      const success = await updateSettings({ fontFamily })
      if (!success) toast.error('Failed to update font family')
    },
    [updateSettings]
  )

  if (isLoading) {
    return (
      <div className="flex flex-col antialiased">
        <SettingsHeader title="Appearance" subtitle="Loading settings..." />
      </div>
    )
  }

  return (
    <div className="flex flex-col antialiased text-xs/4">
      <SettingsHeader title="Appearance" subtitle="Customize the look and feel" />

      <SettingsGroup label="Theme">
        <SettingRow label="Color Mode" description="Choose your preferred theme">
          <SegmentedControl
            options={THEME_OPTIONS}
            value={settings.theme}
            onValueChange={handleThemeChange}
            ariaLabel="Color mode"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Accent Color">
        <div className="flex items-center justify-between py-3.5 px-4">
          <span className="font-medium text-[13px]/4 text-foreground">Pick an accent color</span>
          <div className="flex items-center shrink-0 gap-2">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => void handleAccentChange(preset.value)}
                className="size-6 rounded-xl shrink-0 transition-all duration-150 cursor-pointer hover:scale-110 focus-visible:outline-none"
                style={{
                  backgroundColor: preset.value,
                  boxShadow:
                    settings.accentColor === preset.value
                      ? `var(--background) 0px 0px 0px 2px, ${preset.value}80 0px 0px 0px 3.5px`
                      : 'none'
                }}
                title={preset.label}
              />
            ))}
          </div>
        </div>

        <SettingRow label="Custom Color" description="Enter a hex value">
          <div className="flex items-center shrink-0 gap-2">
            <Input
              placeholder="#000000"
              value={customHex || settings.accentColor}
              onChange={(e) => setCustomHex(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustomHexSubmit()}
              onFocus={() => {
                if (!customHex) setCustomHex(settings.accentColor)
              }}
              onBlur={() => {
                if (customHex === settings.accentColor) setCustomHex('')
              }}
              className="w-24 h-7 font-mono text-xs bg-muted/50 border-border"
              maxLength={7}
            />
            <div
              className="size-5 rounded-[10px] shrink-0"
              style={{
                backgroundColor: HEX_COLOR_REGEX.test(customHex) ? customHex : settings.accentColor
              }}
            />
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label="Typography">
        <SettingRow label="Font Size" description="Adjust the base text size">
          <SegmentedControl
            options={FONT_SIZE_OPTIONS}
            value={settings.fontSize}
            onValueChange={handleFontSizeChange}
            ariaLabel="Font size"
          />
        </SettingRow>

        <SettingRow label="Font Family" description="Primary typeface for the interface">
          <Select value={settings.fontFamily} onValueChange={handleFontFamilyChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System Default</SelectItem>
              <SelectItem value="sans-serif">Sans-serif</SelectItem>
              <SelectItem value="serif">Serif (Crimson Pro)</SelectItem>
              <SelectItem value="gelasio">Gelasio</SelectItem>
              <SelectItem value="geist">Geist</SelectItem>
              <SelectItem value="inter">Inter</SelectItem>
              <SelectItem value="monospace">Monospace</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
