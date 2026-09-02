import { type ComponentType, Fragment, useCallback, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Picker, usePickerContext, usePickerSearch } from '@/components/ui/picker'
import { Sun, Moon, Monitor, FileText } from '@/lib/icons'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useSystemFonts, type SystemFontsState } from '@/hooks/use-system-fonts'
import {
  BUILT_IN_FONT_FAMILIES,
  FONT_FAMILY_MAP,
  fontChoiceFromSettings,
  fontChoiceKey,
  fontChoiceToSettings,
  isFontInstalled,
  parseFontChoiceKey,
  type BuiltInFontFamily,
  type FontChoice
} from '@/lib/interface-font'
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

const BUILT_IN_FONT_LABEL_KEYS: Record<BuiltInFontFamily, string> = {
  system: 'system',
  'sans-serif': 'sansSerif',
  serif: 'serif',
  gelasio: 'gelasio',
  geist: 'geist',
  inter: 'inter',
  monospace: 'monospace'
}

const systemFontStack = (family: string): string => `"${family}"`

interface FontPickerItem {
  key: string
  label: string
  stack: string
  notInstalled?: boolean
}

// Rendered inside <Picker> so it can read the search query from context.
function FontFamilyPickerList({
  choice,
  systemFonts
}: {
  choice: FontChoice
  systemFonts: SystemFontsState
}): React.JSX.Element {
  const { t } = useT('settings')
  const { searchQuery } = usePickerContext()

  const builtInItems = useMemo<FontPickerItem[]>(
    () =>
      BUILT_IN_FONT_FAMILIES.map((family) => ({
        key: fontChoiceKey({ kind: 'builtin', family }),
        label: t(`appearance.typography.fontFamily.options.${BUILT_IN_FONT_LABEL_KEYS[family]}`),
        stack: FONT_FAMILY_MAP[family]
      })),
    [t]
  )

  const systemItems = useMemo<FontPickerItem[]>(() => {
    const families = systemFonts.status === 'ready' ? systemFonts.families : []
    const items: FontPickerItem[] = families.map((family) => ({
      key: fontChoiceKey({ kind: 'system', family }),
      label: family,
      stack: systemFontStack(family)
    }))

    // A family saved before this picker shipped, or uninstalled since, is in no
    // enumeration. List it anyway so the saved selection stays visible, and only
    // this row needs the installed check — everything else was just enumerated.
    const selected = choice.kind === 'system' ? choice.family : null
    if (selected && !families.includes(selected)) {
      items.unshift({
        key: fontChoiceKey({ kind: 'system', family: selected }),
        label: selected,
        stack: systemFontStack(selected),
        notInstalled: !isFontInstalled(selected)
      })
    }

    return items
  }, [choice, systemFonts])

  const filteredBuiltIn = usePickerSearch(builtInItems, ['label'], searchQuery)
  const filteredSystem = usePickerSearch(systemItems, ['label'], searchQuery)

  const systemStatus =
    systemFonts.status === 'loading'
      ? t('appearance.typography.fontFamily.loading')
      : systemFonts.status === 'unavailable'
        ? t('appearance.typography.fontFamily.unavailable')
        : null

  if (filteredBuiltIn.length === 0 && filteredSystem.length === 0 && !systemStatus) {
    return <Picker.Empty message={t('appearance.typography.fontFamily.empty')} />
  }

  return (
    // The popover's own max-height is not enough to make a 200-row list
    // scrollable, so the list carries its own bound. It also stops the picker
    // from stretching to fill a tall window.
    <Picker.List className="max-h-72 overflow-y-auto">
      {filteredBuiltIn.length > 0 && (
        <Picker.Section label={t('appearance.typography.fontFamily.sections.builtin')}>
          {filteredBuiltIn.map((item) => (
            <Picker.Item
              key={item.key}
              value={item.key}
              label={item.label}
              indicator="check"
              className="w-full"
              style={item.stack ? { fontFamily: item.stack } : undefined}
            />
          ))}
        </Picker.Section>
      )}

      {(filteredSystem.length > 0 || systemStatus) && (
        <>
          <Picker.Separator />
          <Picker.Section label={t('appearance.typography.fontFamily.sections.system')}>
            {systemStatus && <p className="py-1.5 px-2 text-muted-foreground">{systemStatus}</p>}
            {filteredSystem.map((item) => (
              <Picker.Item
                key={item.key}
                value={item.key}
                label={item.label}
                description={
                  item.notInstalled ? t('appearance.typography.fontFamily.notInstalled') : undefined
                }
                indicator="check"
                className="w-full"
                style={{ fontFamily: item.stack }}
              />
            ))}
          </Picker.Section>
        </>
      )}
    </Picker.List>
  )
}

function FontFamilyPicker({
  choice,
  systemFonts,
  onSelect
}: {
  choice: FontChoice
  systemFonts: SystemFontsState
  onSelect: (key: string) => void
}): React.JSX.Element {
  const { t } = useT('settings')

  const label =
    choice.kind === 'builtin'
      ? t(`appearance.typography.fontFamily.options.${BUILT_IN_FONT_LABEL_KEYS[choice.family]}`)
      : choice.family
  const stack =
    choice.kind === 'builtin' ? FONT_FAMILY_MAP[choice.family] : systemFontStack(choice.family)

  return (
    <Picker value={fontChoiceKey(choice)} onValueChange={onSelect}>
      <Picker.Trigger
        variant="button"
        chevron
        className={cn(COMPACT_SELECT, 'max-w-56')}
        aria-label={t('appearance.typography.fontFamily.label')}
      >
        <span className="truncate" style={stack ? { fontFamily: stack } : undefined}>
          {label}
        </span>
      </Picker.Trigger>
      <Picker.Content width={264} align="end">
        <Picker.Search placeholder={t('appearance.typography.fontFamily.searchPlaceholder')} />
        <FontFamilyPickerList choice={choice} systemFonts={systemFonts} />
      </Picker.Content>
    </Picker>
  )
}

const FONT_SIZE_OPTIONS: SegmentOption[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' }
]

export function AppearanceSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useGeneralSettings()
  const [customHex, setCustomHex] = useState('')
  // Enumeration takes seconds on a cold OS font cache but never blocks the main
  // thread, so it starts with the page rather than with the picker: by the time
  // the row is clicked the list is already there.
  const systemFonts = useSystemFonts(!isLoading)

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

  const handleFontChoiceChange = useCallback(
    async (key: string) => {
      const choice = parseFontChoiceKey(key)
      if (!choice) return
      const success = await updateSettings(fontChoiceToSettings(choice))
      if (!success) toast.error(t('appearance.typography.fontFamilyError'))
    },
    [t, updateSettings]
  )

  const fontChoice = fontChoiceFromSettings(settings.fontFamily, settings.customFontFamily)

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
          <FontFamilyPicker
            choice={fontChoice}
            systemFonts={systemFonts}
            onSelect={(...args) => void handleFontChoiceChange(...args)}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
