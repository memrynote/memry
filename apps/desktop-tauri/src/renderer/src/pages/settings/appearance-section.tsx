import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Picker, usePickerContext, usePickerSearch } from '@/components/ui/picker'
import { Minus, Plus, Undo } from '@/lib/icons'
import { useTheme } from 'next-themes'
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
  resolveFontSizePx,
  stepFontSizePx,
  toLegacyFontSize,
  FONT_SIZE_PX_MIN,
  FONT_SIZE_PX_MAX,
  FONT_SIZE_PX_DEFAULT
} from '@memry/contracts/font-size'
import {
  clampZoomFactor,
  stepZoomFactor,
  zoomPercent,
  ZOOM_FACTOR_MIN,
  ZOOM_FACTOR_MAX,
  ZOOM_FACTOR_DEFAULT
} from '@memry/contracts/app-zoom'
import {
  applyColorTheme,
  storedLightMode,
  type PaletteMode,
  type ThemeCustomization
} from '@memry/contracts/color-themes'
import { GENERAL_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'
import type { GeneralSettingsDTO } from '../../../../preload/index.d'
import {
  AccentPicker,
  AdvancedDisclosure,
  ColorOverrideInput,
  ColorThemePicker,
  ModePreviewPicker,
  ThemeClipboardButtons,
  type ColorMode
} from './appearance-theme-controls'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH,
  COMPACT_SELECT,
  SEGMENTED,
  SEGMENT_ITEM,
  SETTINGS_CARD
} from '@/components/settings/settings-primitives'

const STEP_BUTTON =
  'flex items-center justify-center size-6 rounded-md shrink-0 text-muted-foreground transition-colors cursor-pointer hover:text-foreground disabled:cursor-default disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

function setRootFontSize(px: number): void {
  document.documentElement.style.fontSize = `${px}px`
}

function setAppZoomFactor(factor: number): void {
  window.api.setZoomFactor(factor)
}

/**
 * How long a settings row settles before its value is written.
 *
 * A burst of stepper clicks, or one button held until it repeats, turns an
 * unthrottled row into a dozen IPC round trips, a dozen config.json rewrites
 * and a dozen encrypted settings uploads. Long enough to coalesce a burst or a
 * key repeat into one write, short enough that letting go feels like it saved
 * instantly.
 */
const COMMIT_DELAY_MS = 150

interface SteppedDraft {
  value: number
  preview: (value: number) => void
}

/**
 * A settings row whose value is applied to the live interface immediately and
 * written to disk once the user stops changing it.
 *
 * `apply` changes what the user sees, `save` persists it, and `onSaveFailed`
 * reports a rejected write. Because `apply` has already taken effect, a failed
 * save has to put the interface back itself: the settings hook that normally
 * drives it never re-runs, its effect deps never having changed.
 */
function useSteppedDraft(
  saved: number,
  apply: (value: number) => void,
  save: (value: number) => Promise<boolean>,
  onSaveFailed: () => void
): SteppedDraft {
  const [draft, setDraft] = useState<number | null>(null)
  const pendingRef = useRef<{
    commit: () => void
    timer: ReturnType<typeof setTimeout>
  } | null>(null)

  // The pending write outlives any number of re-renders, so what it will do is
  // read from a ref at commit time rather than captured when it was scheduled.
  // Capturing would make every render cancel and reschedule the timer, and
  // would pin the unmount flush to a stale `saved`.
  const latestRef = useRef({ saved, apply, save, onSaveFailed })
  useEffect(() => {
    latestRef.current = { saved, apply, save, onSaveFailed }
  })

  const preview = useCallback((value: number) => {
    setDraft(value)
    latestRef.current.apply(value)
    if (pendingRef.current) clearTimeout(pendingRef.current.timer)

    const commit = (): void => {
      pendingRef.current = null
      const latest = latestRef.current

      // Only ever release a draft that is still the one this call owns. A held
      // arrow key otherwise makes the displayed value jump backwards whenever a
      // slow write lands after a newer preview.
      const releaseDraft = (): void => setDraft((cur) => (cur === value ? null : cur))

      // A step out and back onto the saved value writes nothing. Re-saving it
      // would cost an IPC round trip, a config.json rewrite and an encrypted
      // settings upload for a change that is not one.
      if (value === latest.saved) {
        releaseDraft()
        return
      }

      void latest.save(value).then((success) => {
        releaseDraft()
        if (success) return
        latest.apply(latest.saved)
        latest.onSaveFailed()
      })
    }

    pendingRef.current = { commit, timer: setTimeout(commit, COMMIT_DELAY_MS) }
  }, [])

  // Flushed, not dropped: the preview already changed the live interface, so an
  // unmount that discarded the pending write would leave the app looking one
  // way and the file on disk saying another, until the next restart.
  useEffect(
    () => () => {
      const pending = pendingRef.current
      if (!pending) return
      clearTimeout(pending.timer)
      pending.commit()
    },
    []
  )

  return { value: draft ?? saved, preview }
}

interface StepperProps {
  value: number
  min: number
  max: number
  onStep: (direction: 1 | -1) => void
  onReset: () => void
  format: (value: number) => string
  labels: { decrease: string; increase: string; reset: string }
}

function Stepper({
  value,
  min,
  max,
  onStep,
  onReset,
  format,
  labels
}: StepperProps): React.JSX.Element {
  return (
    <div className="flex items-center shrink-0 gap-2">
      <button
        type="button"
        aria-label={labels.reset}
        onClick={onReset}
        className="flex items-center justify-center size-6 rounded-md shrink-0 text-muted-foreground transition-colors cursor-pointer hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Undo className="size-3" />
      </button>
      <div className="flex items-center rounded-md border border-input">
        <button
          type="button"
          aria-label={labels.decrease}
          disabled={value <= min}
          onClick={() => onStep(-1)}
          className={STEP_BUTTON}
        >
          <Minus className="size-3" />
        </button>
        <span
          aria-live="polite"
          className="w-10 text-center text-xs tabular-nums text-muted-foreground"
        >
          {format(value)}
        </span>
        <button
          type="button"
          aria-label={labels.increase}
          disabled={value >= max}
          onClick={() => onStep(1)}
          className={STEP_BUTTON}
        >
          <Plus className="size-3" />
        </button>
      </div>
    </div>
  )
}

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
    // Radix bounds the popover to the room it measured, which is several
    // hundred pixels and grows with the window. Cap the list instead so the
    // picker is the same readable height everywhere.
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
    <Picker modal value={fontChoiceKey(choice)} onValueChange={onSelect}>
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

const REDUCE_MOTION_OPTIONS = ['system', 'on'] as const

export function AppearanceSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useGeneralSettings()
  // Enumeration takes seconds on a cold OS font cache but never blocks the main
  // thread, so it starts with the page rather than with the picker: by the time
  // the row is clicked the list is already there.
  const systemFonts = useSystemFonts(!isLoading)

  const { resolvedTheme } = useTheme()
  const mode: PaletteMode = resolvedTheme === 'dark' ? 'dark' : 'light'
  const saved: ThemeCustomization = {
    colorTheme: settings.colorTheme,
    accentColor: settings.accentColor,
    useThemeAccent: settings.useThemeAccent,
    backgroundLight: settings.backgroundLight,
    foregroundLight: settings.foregroundLight,
    backgroundDark: settings.backgroundDark,
    foregroundDark: settings.foregroundDark
  }
  // A color being dragged in the picker: painted on the live interface at once,
  // saved only when the picker settles. The mode previews and theme swatch read
  // `custom` so they move with it; the color rows get `saved`, because a hex
  // field compares against the saved value to tell whether there is anything
  // to commit.
  const [previewPatch, setPreviewPatch] = useState<Partial<ThemeCustomization> | null>(null)
  const custom: ThemeCustomization = { ...saved, ...previewPatch }

  const previewCustomization = (patch: Partial<ThemeCustomization> | null): void => {
    setPreviewPatch(patch)
    applyColorTheme(document.documentElement, { ...saved, ...patch })
  }

  const handleThemeChange = useCallback(
    async (theme: ColorMode) => {
      const success = await updateSettings({ theme })
      if (!success) toast.error(t('appearance.theme.error'))
    },
    [t, updateSettings]
  )

  const savedRef = useRef(saved)
  const settingsThemeRef = useRef(settings.theme)
  useEffect(() => {
    savedRef.current = saved
    settingsThemeRef.current = settings.theme
  })

  const handleCustomizationChange = useCallback(
    async (updates: Partial<ThemeCustomization>) => {
      // A light mode is stored as `light` under warm and `white` otherwise (see
      // storedLightMode), so a theme switch carries the mode along with it.
      const currentTheme = settingsThemeRef.current
      const lightMode =
        updates.colorTheme !== undefined && (currentTheme === 'light' || currentTheme === 'white')
          ? storedLightMode(updates.colorTheme)
          : currentTheme
      const success = await updateSettings(
        lightMode === currentTheme ? updates : { ...updates, theme: lightMode }
      )
      // On success the preview is already what is on screen and useThemeSync
      // repaints the same colors, so the preview is dropped without a repaint
      // (repainting the pre-save values here would flash the old color).
      setPreviewPatch(null)
      if (success) return
      applyColorTheme(document.documentElement, savedRef.current)
      toast.error(t('appearance.colorTheme.error'))
    },
    [t, updateSettings]
  )
  const onCustomize = (updates: Partial<ThemeCustomization>): void =>
    void handleCustomizationChange(updates)

  const handleAdvancedChange = useCallback(
    async (updates: Partial<GeneralSettingsDTO>) => {
      const success = await updateSettings(updates)
      if (!success) toast.error(t('appearance.advanced.error'))
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

  const { value: fontSizePx, preview: previewFontSizePx } = useSteppedDraft(
    resolveFontSizePx(settings.fontSizePx, settings.fontSize),
    setRootFontSize,
    (px) => updateSettings({ fontSizePx: px, fontSize: toLegacyFontSize(px) }),
    () => toast.error(t('appearance.typography.fontSizeError'))
  )

  const { value: zoomFactor, preview: previewZoomFactor } = useSteppedDraft(
    clampZoomFactor(settings.zoomFactor),
    setAppZoomFactor,
    (factor) => updateSettings({ zoomFactor: factor }),
    () => toast.error(t('appearance.zoom.error'))
  )

  const handleAdvancedReset = (): void => {
    // Through the drafts so the live interface and the pending writes agree.
    previewFontSizePx(FONT_SIZE_PX_DEFAULT)
    previewZoomFactor(ZOOM_FACTOR_DEFAULT)
    void handleAdvancedChange({
      reduceMotion: GENERAL_SETTINGS_DEFAULTS.reduceMotion,
      pointerCursors: GENERAL_SETTINGS_DEFAULTS.pointerCursors,
      fontSmoothing: GENERAL_SETTINGS_DEFAULTS.fontSmoothing
    })
  }

  const fontChoice = fontChoiceFromSettings(settings.fontFamily, settings.customFontFamily)
  const colorModeHint = t(
    mode === 'dark' ? 'appearance.colors.forDark' : 'appearance.colors.forLight'
  )

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
        <SettingRow label={t('appearance.v2.colorMode')}>
          <ModePreviewPicker
            value={settings.theme}
            custom={custom}
            onChange={(next) => void handleThemeChange(next)}
          />
        </SettingRow>

        <SettingRow label={t('appearance.v2.colorTheme')}>
          <div className="flex items-center gap-2">
            <ThemeClipboardButtons custom={custom} onChange={onCustomize} />
            <ColorThemePicker custom={custom} mode={mode} onChange={onCustomize} />
          </div>
        </SettingRow>

        <SettingRow label={t('appearance.v2.accent')}>
          <AccentPicker
            custom={saved}
            mode={mode}
            onChange={onCustomize}
            onPreview={previewCustomization}
          />
        </SettingRow>

        <SettingRow label={t('appearance.colors.background')} description={colorModeHint}>
          <ColorOverrideInput
            kind="background"
            custom={saved}
            mode={mode}
            onChange={onCustomize}
            onPreview={previewCustomization}
          />
        </SettingRow>

        <SettingRow label={t('appearance.colors.foreground')} description={colorModeHint}>
          <ColorOverrideInput
            kind="foreground"
            custom={saved}
            mode={mode}
            onChange={onCustomize}
            onPreview={previewCustomization}
          />
        </SettingRow>

        <SettingRow label={t('appearance.v2.fontFamily')}>
          <FontFamilyPicker
            choice={fontChoice}
            systemFonts={systemFonts}
            onSelect={(...args) => void handleFontChoiceChange(...args)}
          />
        </SettingRow>
      </SettingsGroup>

      <AdvancedDisclosure onReset={handleAdvancedReset}>
        <div className={SETTINGS_CARD}>
          <SettingRow
            label={t('appearance.v2.fontSize')}
            description={t('appearance.advanced.fontSizeDescription')}
          >
            <Stepper
              value={fontSizePx}
              min={FONT_SIZE_PX_MIN}
              max={FONT_SIZE_PX_MAX}
              onStep={(direction) => previewFontSizePx(stepFontSizePx(fontSizePx, direction))}
              onReset={() => previewFontSizePx(FONT_SIZE_PX_DEFAULT)}
              format={(px) => String(px)}
              labels={{
                decrease: t('appearance.typography.fontSize.decrease'),
                increase: t('appearance.typography.fontSize.increase'),
                reset: t('appearance.typography.fontSize.reset')
              }}
            />
          </SettingRow>

          <SettingRow
            label={t('appearance.v2.zoom')}
            description={t('appearance.advanced.zoomDescription')}
          >
            <Stepper
              value={zoomFactor}
              min={ZOOM_FACTOR_MIN}
              max={ZOOM_FACTOR_MAX}
              onStep={(direction) => previewZoomFactor(stepZoomFactor(zoomFactor, direction))}
              onReset={() => previewZoomFactor(ZOOM_FACTOR_DEFAULT)}
              format={(factor) => `${zoomPercent(factor)}%`}
              labels={{
                decrease: t('appearance.zoom.decrease'),
                increase: t('appearance.zoom.increase'),
                reset: t('appearance.zoom.reset')
              }}
            />
          </SettingRow>
        </div>

        <div className={SETTINGS_CARD}>
          <SettingRow
            label={t('appearance.advanced.reduceMotion.label')}
            description={t('appearance.advanced.reduceMotion.description')}
          >
            <ToggleGroup
              type="single"
              value={settings.reduceMotion}
              onValueChange={(value) => {
                if (value === 'system' || value === 'on') {
                  void handleAdvancedChange({ reduceMotion: value })
                }
              }}
              aria-label={t('appearance.advanced.reduceMotion.label')}
              className={SEGMENTED}
            >
              {REDUCE_MOTION_OPTIONS.map((option) => (
                <ToggleGroupItem key={option} value={option} className={SEGMENT_ITEM}>
                  {t(`appearance.advanced.reduceMotion.options.${option}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </SettingRow>
        </div>

        <div className={SETTINGS_CARD}>
          <SettingRow
            label={t('appearance.advanced.pointerCursors.label')}
            description={t('appearance.advanced.pointerCursors.description')}
          >
            <Switch
              checked={settings.pointerCursors}
              onCheckedChange={(pointerCursors) => void handleAdvancedChange({ pointerCursors })}
              aria-label={t('appearance.advanced.pointerCursors.label')}
              className={ACCENT_SWITCH}
            />
          </SettingRow>

          <SettingRow
            label={t('appearance.advanced.fontSmoothing.label')}
            description={t('appearance.advanced.fontSmoothing.description')}
          >
            <Switch
              checked={settings.fontSmoothing}
              onCheckedChange={(fontSmoothing) => void handleAdvancedChange({ fontSmoothing })}
              aria-label={t('appearance.advanced.fontSmoothing.label')}
              className={ACCENT_SWITCH}
            />
          </SettingRow>
        </div>
      </AdvancedDisclosure>
    </div>
  )
}
