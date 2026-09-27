import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME_ID,
  THEME_CUSTOMIZATION_DEFAULTS,
  findColorTheme,
  isHexColor,
  parseThemeCustomization,
  resolveModePalettes,
  type ColorThemePalette,
  storedLightMode,
  WARM_COLOR_THEME_ID,
  type PaletteMode,
  type ThemeCustomization
} from '@memry/contracts/color-themes'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { COMPACT_SELECT } from '@/components/settings/settings-primitives'
import { Check, ChevronDown, Copy, Import, Undo } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

export type ColorMode = 'light' | 'dark' | 'white' | 'system'

type ModeCard = 'system' | 'light' | 'dark'

const MODE_CARDS: readonly ModeCard[] = ['system', 'light', 'dark']

const MODE_LABEL_KEYS: Record<ModeCard, string> = {
  system: 'appearance.theme.options.system',
  light: 'appearance.theme.options.light',
  dark: 'appearance.theme.options.dark'
}

export const ACCENT_PRESETS = [
  { value: '#6366f1', labelKey: 'appearance.accent.presets.indigo' },
  { value: '#f59e0b', labelKey: 'appearance.accent.presets.amber' },
  { value: '#10b981', labelKey: 'appearance.accent.presets.emerald' },
  { value: '#ef4444', labelKey: 'appearance.accent.presets.red' },
  { value: '#8b5cf6', labelKey: 'appearance.accent.presets.violet' },
  { value: '#06b6d4', labelKey: 'appearance.accent.presets.cyan' },
  { value: '#ec4899', labelKey: 'appearance.accent.presets.pink' },
  { value: '#f97316', labelKey: 'appearance.accent.presets.orange' }
] as const

const ICON_BUTTON =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-active hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

const TRIGGER = cn(
  COMPACT_SELECT,
  'flex cursor-pointer items-center border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
)

function mix(color: string, base: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${base})`
}

/** A miniature window: sidebar, a few lines of text, and an input pill. */
function MiniWindow({
  palette,
  style
}: {
  palette: ColorThemePalette
  style?: CSSProperties
}): React.JSX.Element {
  const { background, foreground, surface, accent } = palette
  const line = mix(foreground, background, 22)

  return (
    <div className="absolute inset-0 flex" style={{ backgroundColor: background, ...style }}>
      <div
        className="flex w-[22%] shrink-0 flex-col gap-1 p-1.5"
        style={{ backgroundColor: surface }}
      >
        <span className="size-1.5 rounded-full" style={{ backgroundColor: line }} />
      </div>
      <div className="flex flex-1 flex-col gap-[3px] py-2 ps-2 pe-1.5">
        <span
          className="h-[2px] w-[45%] self-end rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span className="h-[2px] w-[60%] rounded-full" style={{ backgroundColor: line }} />
        <span className="h-[2px] w-[40%] rounded-full" style={{ backgroundColor: line }} />
        <span
          className="h-[2px] w-[55%] self-end rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span
          className="mt-auto flex h-[7px] items-center justify-end rounded-full pe-[2px]"
          style={{ border: `1px solid ${mix(foreground, background, 18)}` }}
        >
          <span className="size-[3px] rounded-full" style={{ backgroundColor: accent }} />
        </span>
      </div>
    </div>
  )
}

interface ModePreviewPickerProps {
  value: ColorMode
  custom: ThemeCustomization
  onChange: (mode: ColorMode) => void
}

/**
 * Color mode as window previews painted in the active theme and overrides.
 * Warm is a theme, not a mode, so there are three: `light` and `white` are the
 * same light card, and picking it stores whichever of the two an older build
 * renders closest to the chosen theme.
 */
export function ModePreviewPicker({
  value,
  custom,
  onChange
}: ModePreviewPickerProps): React.JSX.Element {
  const { t } = useT('settings')
  const selected: ModeCard = value === 'white' ? 'light' : value
  const palettes = resolveModePalettes(custom)

  return (
    <div role="group" aria-label={t('appearance.theme.colorMode.aria')} className="flex gap-2">
      {MODE_CARDS.map((mode) => {
        const label = t(MODE_LABEL_KEYS[mode])
        const isActive = selected === mode
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={isActive}
            aria-label={label}
            title={label}
            onClick={() => onChange(mode === 'light' ? storedLightMode(custom.colorTheme) : mode)}
            className={cn(
              'relative h-11 w-[72px] shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border transition-shadow duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive && 'border-transparent shadow-[0_0_0_2px_var(--tint)]'
            )}
          >
            {mode === 'system' ? (
              <>
                <MiniWindow palette={palettes.light} />
                {/* Right half dark in both directions: it is the OS switch, not reading order. */}
                <MiniWindow palette={palettes.dark} style={{ clipPath: 'inset(0 0 0 50%)' }} />
              </>
            ) : (
              <MiniWindow palette={palettes[mode]} />
            )}
          </button>
        )
      })}
    </div>
  )
}

/** A type specimen, not copy: the same glyphs in every locale. */
const TYPE_SPECIMEN = 'Aa'

function ThemeSwatch({ palette }: { palette: ColorThemePalette }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-full text-[9px]/none font-semibold"
      style={{
        backgroundColor: palette.background,
        color: palette.accent,
        boxShadow: `inset 0 0 0 1px ${mix(palette.foreground, palette.background, 20)}`
      }}
    >
      {TYPE_SPECIMEN}
    </span>
  )
}

interface ThemeRowProps {
  custom: ThemeCustomization
  mode: PaletteMode
  onChange: (updates: Partial<ThemeCustomization>) => void
}

interface ColorRowProps extends ThemeRowProps {
  /** Paint a color on the live interface without saving it; null ends the preview. */
  onPreview: (patch: Partial<ThemeCustomization> | null) => void
}

/** Picking a theme takes its whole look: overrides from the old one are dropped. */
const CLEARED_OVERRIDES = {
  useThemeAccent: true,
  backgroundLight: '',
  foregroundLight: '',
  backgroundDark: '',
  foregroundDark: ''
} satisfies Partial<ThemeCustomization>

export function ColorThemePicker({ custom, mode, onChange }: ThemeRowProps): React.JSX.Element {
  const { t } = useT('settings')
  const active = findColorTheme(custom.colorTheme)
  const defaultName = t('appearance.colorTheme.default')
  const warmName = t('appearance.colorTheme.warm')
  const isWarm = custom.colorTheme === WARM_COLOR_THEME_ID
  const swatchFor = (id: string): ColorThemePalette =>
    resolveModePalettes({ colorTheme: id, accentColor: custom.accentColor })[mode]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(TRIGGER, 'max-w-56 py-0.5 ps-1')}
        aria-label={t('appearance.v2.colorTheme')}
      >
        <ThemeSwatch palette={resolveModePalettes(custom)[mode]} />
        <span className="truncate">{active?.name ?? (isWarm ? warmName : defaultName)}</span>
        <ChevronDown className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          onSelect={() => onChange({ colorTheme: DEFAULT_COLOR_THEME_ID, ...CLEARED_OVERRIDES })}
        >
          <ThemeSwatch palette={swatchFor(DEFAULT_COLOR_THEME_ID)} />
          <span className="flex-1 text-foreground">{defaultName}</span>
          {!active && !isWarm && <Check className="size-3.5 text-foreground" />}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ThemeSwatch palette={swatchFor(active?.id ?? COLOR_THEMES[0].id)} />
            <span className="flex-1 text-foreground">{t('appearance.colorTheme.themes')}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            {COLOR_THEMES.map((theme) => (
              <DropdownMenuItem
                key={theme.id}
                onSelect={() => onChange({ colorTheme: theme.id, ...CLEARED_OVERRIDES })}
              >
                <ThemeSwatch palette={swatchFor(theme.id)} />
                <span className="flex-1 text-foreground">{theme.name}</span>
                {active?.id === theme.id && <Check className="size-3.5 text-foreground" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => onChange({ colorTheme: WARM_COLOR_THEME_ID, ...CLEARED_OVERRIDES })}
        >
          <ThemeSwatch palette={swatchFor(WARM_COLOR_THEME_ID)} />
          <span className="flex-1 text-foreground">{warmName}</span>
          {isWarm && <Check className="size-3.5 text-foreground" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Copy the current look as JSON, or paste one back. Plain text on the
 * clipboard, so a theme can be shared in a message; an import is validated
 * field by field and replaces the whole look.
 */
export function ThemeClipboardButtons({
  custom,
  onChange
}: {
  custom: ThemeCustomization
  onChange: (updates: Partial<ThemeCustomization>) => void
}): React.JSX.Element {
  const { t } = useT('settings')

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(custom, null, 2))
      toast.success(t('appearance.colorTheme.copied'))
    } catch (err) {
      toast.error(extractErrorMessage(err, t('appearance.colorTheme.copyError')))
    }
  }

  const paste = async (): Promise<void> => {
    let parsed: Partial<ThemeCustomization> | null = null
    try {
      parsed = parseThemeCustomization(JSON.parse(await navigator.clipboard.readText()))
    } catch {
      parsed = null
    }
    if (!parsed) {
      toast.error(t('appearance.colorTheme.importInvalid'))
      return
    }
    onChange({ ...THEME_CUSTOMIZATION_DEFAULTS, ...parsed })
  }

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        className={ICON_BUTTON}
        aria-label={t('appearance.colorTheme.import')}
        title={t('appearance.colorTheme.import')}
        onClick={() => void paste()}
      >
        <Import className="size-4" />
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        aria-label={t('appearance.colorTheme.copy')}
        title={t('appearance.colorTheme.copy')}
        onClick={() => void copy()}
      >
        <Copy className="size-4" />
      </button>
    </div>
  )
}

interface HexColorInputProps {
  value: string
  onCommit: (hex: string) => void
  ariaLabel: string
  pickerLabel: string
  /** A valid color being tried out, not yet committed; null ends the try-out. */
  onPreview: (hex: string | null) => void
}

/**
 * A color dot and a hex field. The dot opens the system color picker; the
 * field takes a typed hex and commits on Enter or blur, Escape reverts.
 */
export function HexColorInput({
  value,
  onCommit,
  ariaLabel,
  pickerLabel,
  onPreview
}: HexColorInputProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const normalized = draft === null ? null : draft.startsWith('#') ? draft : `#${draft}`
  const preview = normalized && isHexColor(normalized) ? normalized : value
  const pickerRef = useRef<HTMLInputElement>(null)

  const commitHex = (hex: string | null): void => {
    if (hex && isHexColor(hex) && hex.toLowerCase() !== value.toLowerCase()) {
      // The caller ends the preview once the save lands, so nothing flashes.
      onCommit(hex.toLowerCase())
    } else {
      onPreview(null)
    }
    setDraft(null)
  }

  // React's onChange on a color input is the native `input` event, which fires
  // on every drag step in the picker. Previewing on it is free; saving is an
  // IPC round trip, a config.json write and a sync upload, so saving waits for
  // the native `change`, sent once the picker settles on a color.
  const commitRef = useRef(commitHex)
  useEffect(() => {
    commitRef.current = commitHex
  })
  useEffect(() => {
    const picker = pickerRef.current
    if (!picker) return
    const onChange = (): void => commitRef.current(picker.value)
    picker.addEventListener('change', onChange)
    return () => picker.removeEventListener('change', onChange)
  }, [])

  return (
    <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-border py-1 ps-1.5 pe-2.5 focus-within:ring-1 focus-within:ring-ring">
      <span
        className="relative size-3.5 shrink-0 cursor-pointer rounded-full"
        style={{ backgroundColor: preview, boxShadow: 'inset 0 0 0 1px rgb(128 128 128 / 0.35)' }}
      >
        <input
          ref={pickerRef}
          type="color"
          aria-label={pickerLabel}
          title={pickerLabel}
          value={preview.toLowerCase()}
          onChange={(e) => {
            setDraft(e.target.value)
            onPreview(e.target.value.toLowerCase())
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </span>
      <input
        aria-label={ariaLabel}
        value={draft ?? value.toUpperCase()}
        maxLength={7}
        spellCheck={false}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          const hex = next.startsWith('#') ? next : `#${next}`
          if (isHexColor(hex)) onPreview(hex.toLowerCase())
        }}
        onBlur={() => commitHex(normalized)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.stopPropagation()
            setDraft(null)
            onPreview(null)
          }
        }}
        className="w-[4.25rem] bg-transparent font-mono text-xs/4 uppercase text-foreground outline-none"
      />
    </div>
  )
}

export function AccentPicker({
  custom,
  mode,
  onChange,
  onPreview
}: ColorRowProps): React.JSX.Element {
  const { t } = useT('settings')
  const themed = findColorTheme(custom.colorTheme) !== undefined
  const fromTheme = themed && custom.useThemeAccent
  const effective = resolveModePalettes(custom)[mode].accent
  const preset = ACCENT_PRESETS.find((p) => p.value === custom.accentColor.toLowerCase())
  const label = fromTheme
    ? t('appearance.accent.options.theme')
    : preset
      ? t(preset.labelKey)
      : t('appearance.accent.options.custom')
  const pick = (accentColor: string): void => onChange({ accentColor, useThemeAccent: false })

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger className={TRIGGER} aria-label={t('appearance.accent.aria')}>
          <span>{label}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {themed && (
            <>
              <DropdownMenuItem onSelect={() => onChange({ useThemeAccent: true })}>
                <span
                  aria-hidden
                  className="size-3 rounded-full"
                  style={{
                    backgroundColor: findColorTheme(custom.colorTheme)?.[
                      mode === 'dark' ? 'dark' : 'light'
                    ].accent
                  }}
                />
                <span className="flex-1 text-foreground">
                  {t('appearance.accent.options.theme')}
                </span>
                {fromTheme && <Check className="size-3.5 text-foreground" />}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {ACCENT_PRESETS.map((p) => (
            <DropdownMenuItem key={p.value} onSelect={() => pick(p.value)}>
              <span
                aria-hidden
                className="size-3 rounded-full"
                style={{ backgroundColor: p.value }}
              />
              <span className="flex-1 text-foreground">{t(p.labelKey)}</span>
              {!fromTheme && preset?.value === p.value && (
                <Check className="size-3.5 text-foreground" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <HexColorInput
        value={effective}
        onCommit={pick}
        ariaLabel={t('appearance.accent.custom.label')}
        pickerLabel={t('appearance.colors.pick')}
        onPreview={(hex) => onPreview(hex ? { accentColor: hex, useThemeAccent: false } : null)}
      />
    </div>
  )
}

type OverrideKind = 'background' | 'foreground'

/**
 * Background or text color for the mode on screen. Stored per mode (`Light`
 * covers warm and white), so a dark canvas picked tonight never sits under a
 * light theme's text when the OS flips in the morning.
 */
export function ColorOverrideInput({
  kind,
  custom,
  mode,
  onChange,
  onPreview
}: ColorRowProps & { kind: OverrideKind }): React.JSX.Element {
  const { t } = useT('settings')
  const field = `${kind}${mode === 'dark' ? 'Dark' : 'Light'}` as const
  const effective = resolveModePalettes(custom)[mode][kind]
  const overridden = custom[field] !== ''

  return (
    <div className="flex items-center gap-1">
      {overridden && (
        <button
          type="button"
          className={ICON_BUTTON}
          aria-label={t('appearance.colors.reset')}
          title={t('appearance.colors.reset')}
          onClick={() => onChange({ [field]: '' })}
        >
          <Undo className="size-3" />
        </button>
      )}
      <HexColorInput
        value={effective}
        onCommit={(hex) => onChange({ [field]: hex })}
        ariaLabel={t(`appearance.colors.${kind}`)}
        pickerLabel={t('appearance.colors.pick')}
        onPreview={(hex) => onPreview(hex ? { [field]: hex } : null)}
      />
    </div>
  )
}

/**
 * A collapsed-by-default group with a reset link. The body stays mounted while
 * closed so settings search can find its rows; a search hit inside opens it.
 */
export function AdvancedDisclosure({
  onReset,
  children
}: {
  onReset: () => void
  children: ReactNode
}): React.JSX.Element {
  const { t } = useT('settings')
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // A search hit landing inside while closed: open, then scroll to it once the
  // body is visible (scrolling a hidden row goes nowhere).
  const revealRef = useRef((target: Element): void => {
    setOpen(true)
    requestAnimationFrame(() => target.scrollIntoView?.({ block: 'center' }))
  })

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const observer = new MutationObserver((records) => {
      const hit = records.find(
        (r) => r.target instanceof Element && r.target.hasAttribute('data-search-hit')
      )
      if (hit) revealRef.current(hit.target as Element)
    })
    // False positive: `open` only changes from the observer callback, not here.
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-initialize-state
    observer.observe(body, { subtree: true, attributeFilter: ['data-search-hit'] })
    return () => observer.disconnect()
  }, [])

  return (
    <section className="flex flex-col pb-9">
      <div className="flex items-center justify-between pb-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-settings-label={t('appearance.advanced.title')}
          className="flex cursor-pointer items-center gap-1 rounded-md text-[13px]/4 font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {t('appearance.advanced.title')}
          <ChevronDown
            className={cn(
              'size-3 text-muted-foreground transition-transform duration-150',
              !open && '-rotate-90 rtl:rotate-90'
            )}
          />
        </button>
        {open && (
          <button
            type="button"
            onClick={onReset}
            className="cursor-pointer rounded-md text-xs/4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {t('appearance.advanced.reset')}
          </button>
        )}
      </div>
      <div ref={bodyRef} hidden={!open} className="flex flex-col gap-4">
        {children}
      </div>
    </section>
  )
}
