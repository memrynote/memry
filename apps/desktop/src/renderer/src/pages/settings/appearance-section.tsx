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
import { isFontInstalled, sanitizeCustomFontName, MAX_FONT_NAME_LENGTH } from '@/lib/custom-font'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'

const ACCENT_PRESETS = [
  { value: '#6366f1', labelKey: 'appearance.accent.presets.indigo' },
  { value: '#f59e0b', labelKey: 'appearance.accent.presets.amber' },
  { value: '#10b981', labelKey: 'appearance.accent.presets.emerald' },
  { value: '#ef4444', labelKey: 'appearance.accent.presets.red' },
  { value: '#8b5cf6', labelKey: 'appearance.accent.presets.violet' },
  { value: '#06b6d4', labelKey: 'appearance.accent.presets.cyan' },
  { value: '#ec4899', labelKey: 'appearance.accent.presets.pink' },
  { value: '#f97316', labelKey: 'appearance.accent.presets.orange' }
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

const THEME_OPTIONS = [
  { value: 'light', labelKey: 'appearance.theme.options.light', icon: Sun },
  { value: 'white', labelKey: 'appearance.theme.options.white', icon: FileText },
  { value: 'dark', labelKey: 'appearance.theme.options.dark', icon: Moon },
  { value: 'system', labelKey: 'appearance.theme.options.system', icon: Monitor }
]

const FONT_SIZE_OPTIONS: SegmentOption[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' }
]

export function AppearanceSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useGeneralSettings()
  const [customHex, setCustomHex] = useState('')
  // null means "not editing" — the row then shows the saved value, including one
  // that arrived from another device.
  const [customFontDraft, setCustomFontDraft] = useState<string | null>(null)

  const themeOptions: SegmentOption[] = THEME_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
    icon: option.icon
  }))

  const handleThemeChange = useCallback(
    async (value: string) => {
      if (!value) return
      const theme = value as 'light' | 'dark' | 'white' | 'system'
      const success = await updateSettings({ theme })
      if (!success) toast.error(t('appearance.theme.error'))
    },
    [t, updateSettings]
  )

  const handleAccentChange = useCallback(
    async (hex: string) => {
      const success = await updateSettings({ accentColor: hex })
      if (!success) toast.error(t('appearance.accent.error'))
    },
    [t, updateSettings]
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
      if (!success) toast.error(t('appearance.typography.fontSizeError'))
    },
    [t, updateSettings]
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
      if (!success) toast.error(t('appearance.typography.fontFamilyError'))
    },
    [t, updateSettings]
  )

  const customFontValue = customFontDraft ?? settings.customFontFamily ?? ''
  const customFontName = sanitizeCustomFontName(customFontValue)
  const customFontMissing = customFontName.length > 0 && !isFontInstalled(customFontName)

  const commitCustomFont = useCallback(async () => {
    const next = sanitizeCustomFontName(customFontDraft ?? '')
    setCustomFontDraft(null)
    if (customFontDraft === null || next === (settings.customFontFamily ?? '')) return
    const success = await updateSettings({ customFontFamily: next })
    if (!success) toast.error(t('appearance.typography.customFontError'))
  }, [customFontDraft, settings.customFontFamily, t, updateSettings])

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader
          title={t('appearance.header.title')}
          subtitle={t('appearance.header.loading')}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader
        title={t('appearance.header.title')}
        subtitle={t('appearance.header.subtitle')}
      />

      <SettingsGroup label={t('appearance.groups.theme')}>
        <SettingRow
          label={t('appearance.theme.colorMode.label')}
          description={t('appearance.theme.colorMode.description')}
        >
          <SegmentedControl
            options={themeOptions}
            value={settings.theme}
            onValueChange={(...args) => void handleThemeChange(...args)}
            ariaLabel={t('appearance.theme.colorMode.aria')}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('appearance.groups.accentColor')}>
        <div className="flex items-center justify-between py-3.5 px-4">
          <span className="font-medium text-[13px]/4 text-foreground">
            {t('appearance.accent.pick')}
          </span>
          <div className="flex items-center shrink-0 gap-2">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                aria-label={t(preset.labelKey)}
                onClick={() => void handleAccentChange(preset.value)}
                className="size-6 rounded-xl shrink-0 transition-all duration-150 cursor-pointer hover:scale-110 focus-visible:outline-none"
                style={{
                  backgroundColor: preset.value,
                  boxShadow:
                    settings.accentColor === preset.value
                      ? `var(--background) 0px 0px 0px 2px, ${preset.value}80 0px 0px 0px 3.5px`
                      : 'none'
                }}
                title={t(preset.labelKey)}
              />
            ))}
          </div>
        </div>

        <SettingRow
          label={t('appearance.accent.custom.label')}
          description={t('appearance.accent.custom.description')}
        >
          <div className="flex items-center shrink-0 gap-2">
            <Input
              placeholder={t('appearance.accent.custom.placeholder')}
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

      <SettingsGroup label={t('appearance.groups.typography')}>
        <SettingRow
          label={t('appearance.typography.fontSize.label')}
          description={t('appearance.typography.fontSize.description')}
        >
          <SegmentedControl
            options={FONT_SIZE_OPTIONS}
            value={settings.fontSize}
            onValueChange={(...args) => void handleFontSizeChange(...args)}
            ariaLabel={t('appearance.typography.fontSize.aria')}
          />
        </SettingRow>

        <SettingRow
          label={t('appearance.typography.fontFamily.label')}
          description={t('appearance.typography.fontFamily.description')}
        >
          <Select
            value={settings.fontFamily}
            onValueChange={(...args) => void handleFontFamilyChange(...args)}
          >
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">
                {t('appearance.typography.fontFamily.options.system')}
              </SelectItem>
              <SelectItem value="sans-serif">
                {t('appearance.typography.fontFamily.options.sansSerif')}
              </SelectItem>
              <SelectItem value="serif">
                {t('appearance.typography.fontFamily.options.serif')}
              </SelectItem>
              <SelectItem value="gelasio">
                {t('appearance.typography.fontFamily.options.gelasio')}
              </SelectItem>
              <SelectItem value="geist">
                {t('appearance.typography.fontFamily.options.geist')}
              </SelectItem>
              <SelectItem value="inter">
                {t('appearance.typography.fontFamily.options.inter')}
              </SelectItem>
              <SelectItem value="monospace">
                {t('appearance.typography.fontFamily.options.monospace')}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label={t('appearance.typography.customFont.label')}
          description={t('appearance.typography.customFont.description')}
        >
          <div className="flex flex-col items-end shrink-0 gap-1">
            <Input
              placeholder={t('appearance.typography.customFont.placeholder')}
              value={customFontValue}
              onChange={(e) => setCustomFontDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitCustomFont()
              }}
              onBlur={() => void commitCustomFont()}
              maxLength={MAX_FONT_NAME_LENGTH}
              aria-label={t('appearance.typography.customFont.label')}
              aria-describedby={customFontMissing ? 'custom-font-missing' : undefined}
              className="w-48 h-7 text-xs bg-muted/50 border-border"
              style={customFontName ? { fontFamily: `'${customFontName}'` } : undefined}
            />
            {customFontMissing && (
              <span id="custom-font-missing" className="text-[11px]/4 text-muted-foreground">
                {t('appearance.typography.customFont.notInstalled')}
              </span>
            )}
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
