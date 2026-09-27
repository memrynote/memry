/**
 * Color Themes
 *
 * Community editor themes the interface can be painted in, on top of the
 * built-in memrynote palette, plus the user's own accent, background and text
 * color overrides. A palette is four colors per mode; every other token
 * (borders, muted text, hover fills, the sidebar) is derived from them in CSS,
 * so adding a theme is data only.
 *
 * The stored setting is the theme id as a plain string. An id this build does
 * not know (written by a newer build, or a theme later removed) resolves to
 * the default rather than failing, so a synced or hand-edited value can never
 * leave the interface unpainted.
 *
 * @module contracts/color-themes
 */

export interface ColorThemePalette {
  /** Editor/canvas background. */
  background: string
  /** Primary text. */
  foreground: string
  /** Sidebar and panel surface, one step off the background. */
  surface: string
  /** Selection, focus and highlight color. Replaces the user accent. */
  accent: string
}

export interface ColorTheme {
  id: string
  name: string
  light: ColorThemePalette
  dark: ColorThemePalette
}

export const DEFAULT_COLOR_THEME_ID = 'memrynote'

export const COLOR_THEME_STORAGE_KEY = 'memry-color-theme'

/** Palettes are the upstream themes' own editor colors, light variant first. */
export const COLOR_THEMES: readonly ColorTheme[] = [
  {
    id: 'ayu',
    name: 'Ayu',
    light: { background: '#fcfcfc', foreground: '#5c6166', surface: '#f3f4f5', accent: '#fa8d3e' },
    dark: { background: '#0b0e14', foreground: '#bfbdb6', surface: '#0d1017', accent: '#e6b450' }
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    light: { background: '#eff1f5', foreground: '#4c4f69', surface: '#e6e9ef', accent: '#8839ef' },
    dark: { background: '#1e1e2e', foreground: '#cdd6f4', surface: '#181825', accent: '#cba6f7' }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    light: { background: '#fffbeb', foreground: '#1f1f1f', surface: '#f5f0dc', accent: '#644ac9' },
    dark: { background: '#282a36', foreground: '#f8f8f2', surface: '#21222c', accent: '#bd93f9' }
  },
  {
    id: 'everforest',
    name: 'Everforest',
    light: { background: '#fdf6e3', foreground: '#5c6a72', surface: '#efebd4', accent: '#8da101' },
    dark: { background: '#2d353b', foreground: '#d3c6aa', surface: '#232a2e', accent: '#a7c080' }
  },
  {
    id: 'github',
    name: 'GitHub',
    light: { background: '#ffffff', foreground: '#1f2328', surface: '#f6f8fa', accent: '#0969da' },
    dark: { background: '#0d1117', foreground: '#e6edf3', surface: '#010409', accent: '#4493f8' }
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    light: { background: '#fbf1c7', foreground: '#3c3836', surface: '#f2e5bc', accent: '#d65d0e' },
    dark: { background: '#282828', foreground: '#ebdbb2', surface: '#1d2021', accent: '#fe8019' }
  },
  {
    id: 'kanagawa',
    name: 'Kanagawa',
    light: { background: '#f2ecbc', foreground: '#545464', surface: '#e7dba0', accent: '#4d699b' },
    dark: { background: '#1f1f28', foreground: '#dcd7ba', surface: '#16161d', accent: '#7e9cd8' }
  },
  {
    id: 'material',
    name: 'Material',
    light: { background: '#fafafa', foreground: '#546e7a', surface: '#eeeeee', accent: '#39adb5' },
    dark: { background: '#263238', foreground: '#eeffff', surface: '#1e272c', accent: '#80cbc4' }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    light: { background: '#faf4f2', foreground: '#29242a', surface: '#ede7e5', accent: '#e14775' },
    dark: { background: '#272822', foreground: '#f8f8f2', surface: '#1e1f1c', accent: '#f92672' }
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    light: { background: '#fbfbfb', foreground: '#403f53', surface: '#f0f0f0', accent: '#4876d6' },
    dark: { background: '#011627', foreground: '#d6deeb', surface: '#01111d', accent: '#82aaff' }
  },
  {
    id: 'nord',
    name: 'Nord',
    light: { background: '#eceff4', foreground: '#2e3440', surface: '#e5e9f0', accent: '#5e81ac' },
    dark: { background: '#2e3440', foreground: '#d8dee9', surface: '#292e39', accent: '#88c0d0' }
  },
  {
    id: 'one',
    name: 'One',
    light: { background: '#fafafa', foreground: '#383a42', surface: '#eaeaeb', accent: '#4078f2' },
    dark: { background: '#282c34', foreground: '#abb2bf', surface: '#21252b', accent: '#61afef' }
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    light: { background: '#faf4ed', foreground: '#575279', surface: '#f2e9e1', accent: '#907aa9' },
    dark: { background: '#191724', foreground: '#e0def4', surface: '#1f1d2e', accent: '#c4a7e7' }
  },
  {
    id: 'solarized',
    name: 'Solarized',
    light: { background: '#fdf6e3', foreground: '#586e75', surface: '#eee8d5', accent: '#268bd2' },
    dark: { background: '#002b36', foreground: '#93a1a1', surface: '#073642', accent: '#268bd2' }
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    light: { background: '#e1e2e7', foreground: '#3760bf', surface: '#d0d5e3', accent: '#2e7de9' },
    dark: { background: '#1a1b26', foreground: '#c0caf5', surface: '#16161e', accent: '#7aa2f7' }
  }
]

export function findColorTheme(id: unknown): ColorTheme | undefined {
  if (typeof id !== 'string') return undefined
  return COLOR_THEMES.find((theme) => theme.id === id)
}

/** The built-in accent. Lives here, not in settings-schemas, to avoid an import cycle. */
export const DEFAULT_ACCENT_COLOR = '#f97316'

/**
 * The paper-toned built-in theme. Built in rather than in COLOR_THEMES: its
 * light mode is the hand-tuned :root palette in base.css, not a derived one.
 * Before it was a theme it was the `light` color mode.
 */
export const WARM_COLOR_THEME_ID = 'warm'

export type BuiltInColorThemeId = typeof DEFAULT_COLOR_THEME_ID | typeof WARM_COLOR_THEME_ID

type BasePalette = Omit<ColorThemePalette, 'accent'>

const BUILT_IN_DARK: BasePalette = {
  background: '#181818',
  foreground: '#dedede',
  surface: '#212121'
}

/** The built-in palettes, mirroring the white, warm (:root) and .dark blocks in base.css. */
const BUILT_IN_BASE: Record<BuiltInColorThemeId, Record<PaletteMode, BasePalette>> = {
  memrynote: {
    light: { background: '#ffffff', foreground: '#37352f', surface: '#f7f6f3' },
    dark: BUILT_IN_DARK
  },
  warm: {
    light: { background: '#f6f5f0', foreground: '#1a1a1a', surface: '#efefe9' },
    dark: BUILT_IN_DARK
  }
}

/**
 * The stored `theme` setting keeps four values for older builds, but only two
 * palettes render: `light` and `white` are both the light mode.
 */
export type PaletteMode = 'light' | 'dark'
export type ModePalettes = Record<PaletteMode, ColorThemePalette>

/**
 * The color theme for settings written before color themes shipped. Those
 * installs picked warm or white through the color mode alone: `light` was the
 * warm palette, and so was `system` on a light OS.
 */
export function legacyColorTheme(theme: unknown): BuiltInColorThemeId {
  return theme === 'light' || theme === 'system' ? WARM_COLOR_THEME_ID : DEFAULT_COLOR_THEME_ID
}

/**
 * The stored color mode for "light" under a given theme. Only older builds
 * tell `light` from `white`, and they render them as warm and white, so each
 * theme stores the one that looks closest on such a device.
 */
export function storedLightMode(colorTheme: string): 'light' | 'white' {
  return colorTheme === WARM_COLOR_THEME_ID ? 'light' : 'white'
}

/**
 * Everything that decides the interface colors. Mirrors the general-settings
 * fields of the same names. Color overrides are per mode because a background
 * picked for dark mode would be unreadable under a light theme's text; an
 * empty string means "the theme's own color".
 */
export interface ThemeCustomization {
  colorTheme: string
  accentColor: string
  /** With a color theme on: use the theme's accent instead of `accentColor`. */
  useThemeAccent: boolean
  backgroundLight: string
  foregroundLight: string
  backgroundDark: string
  foregroundDark: string
}

export const THEME_CUSTOMIZATION_DEFAULTS: ThemeCustomization = {
  colorTheme: DEFAULT_COLOR_THEME_ID,
  accentColor: DEFAULT_ACCENT_COLOR,
  useThemeAccent: true,
  backgroundLight: '',
  foregroundLight: '',
  backgroundDark: '',
  foregroundDark: ''
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value)
}

const OVERRIDE_FIELDS = [
  'backgroundLight',
  'foregroundLight',
  'backgroundDark',
  'foregroundDark'
] as const

/**
 * Validates an untrusted customization (the startup cache, a pasted theme)
 * field by field: a bad field is dropped, never the whole value. Null when
 * nothing usable is left.
 */
export function parseThemeCustomization(raw: unknown): Partial<ThemeCustomization> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const input = raw as Record<string, unknown>
  const out: Partial<ThemeCustomization> = {}
  if (typeof input.colorTheme === 'string' && input.colorTheme.length <= 64) {
    out.colorTheme = input.colorTheme
  }
  if (isHexColor(input.accentColor)) out.accentColor = input.accentColor
  if (typeof input.useThemeAccent === 'boolean') out.useThemeAccent = input.useThemeAccent
  for (const field of OVERRIDE_FIELDS) {
    const value = input[field]
    if (value === '' || isHexColor(value)) out[field] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The colors every mode renders in, overrides applied. Never null. */
export function resolveModePalettes(custom: Partial<ThemeCustomization>): ModePalettes {
  const theme = findColorTheme(custom.colorTheme)
  const userAccent = isHexColor(custom.accentColor) ? custom.accentColor : DEFAULT_ACCENT_COLOR
  const accentOverride = !theme || custom.useThemeAccent === false ? userAccent : null

  const builtIn = BUILT_IN_BASE[custom.colorTheme === WARM_COLOR_THEME_ID ? 'warm' : 'memrynote']
  const base: ModePalettes = theme
    ? { light: theme.light, dark: theme.dark }
    : {
        light: { ...builtIn.light, accent: userAccent },
        dark: { ...builtIn.dark, accent: userAccent }
      }

  const pick = (value: unknown, fallback: string): string =>
    isHexColor(value) ? value.toLowerCase() : fallback
  const paint = (palette: ColorThemePalette, bg: unknown, fg: unknown): ColorThemePalette => ({
    background: pick(bg, palette.background),
    foreground: pick(fg, palette.foreground),
    surface: isHexColor(bg)
      ? // An overridden canvas needs a surface to match; one step toward the text.
        `color-mix(in srgb, ${pick(fg, palette.foreground)} 5%, ${bg})`
      : palette.surface,
    accent: accentOverride ?? palette.accent
  })

  return {
    light: paint(base.light, custom.backgroundLight, custom.foregroundLight),
    dark: paint(base.dark, custom.backgroundDark, custom.foregroundDark)
  }
}

/**
 * Whether the derived palette pipeline in base.css has to run. The built-in
 * palette with no overrides keeps its hand-tuned tokens instead.
 */
export function needsDerivedPalette(custom: Partial<ThemeCustomization>): boolean {
  if (findColorTheme(custom.colorTheme)) return true
  return OVERRIDE_FIELDS.some((field) => isHexColor(custom[field]))
}

/**
 * The inline custom properties base.css derives every themed token from. All
 * modes are written at once so the mode class alone picks the palette, and a
 * system appearance flip needs no JS to follow.
 */
export function colorThemeCssVariables(palettes: ModePalettes): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const mode of ['light', 'dark'] as const) {
    const palette = palettes[mode]
    vars[`--ct-${mode}-bg`] = palette.background
    vars[`--ct-${mode}-fg`] = palette.foreground
    vars[`--ct-${mode}-surface`] = palette.surface
    vars[`--ct-${mode}-accent`] = palette.accent
  }
  return vars
}

const CSS_VARIABLE_NAMES = Object.keys(
  colorThemeCssVariables(resolveModePalettes(THEME_CUSTOMIZATION_DEFAULTS))
)

/** Structural so this module stays free of DOM lib types for the main build. */
export interface ColorThemeRoot {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  style: {
    setProperty(name: string, value: string): void
    removeProperty(name: string): string
  }
}

/**
 * Paints `root` in the customization, or restores the hand-tuned built-in
 * palette when there is nothing to derive (an unknown theme id included).
 */
export function applyColorTheme(root: ColorThemeRoot, custom: Partial<ThemeCustomization>): void {
  // Picks between the two hand-tuned light palettes in base.css; absent is white.
  if (custom.colorTheme === WARM_COLOR_THEME_ID) root.setAttribute('data-light-palette', 'warm')
  else root.removeAttribute('data-light-palette')
  // Here and not only in the renderer's settings sync, so the startup paint
  // and a live picker preview carry the accent too.
  if (isHexColor(custom.accentColor)) {
    root.style.setProperty('--user-accent-color', custom.accentColor)
  }

  if (!needsDerivedPalette(custom)) {
    root.removeAttribute('data-color-theme')
    for (const name of CSS_VARIABLE_NAMES) root.style.removeProperty(name)
    return
  }

  for (const [name, value] of Object.entries(colorThemeCssVariables(resolveModePalettes(custom)))) {
    root.style.setProperty(name, value)
  }
  root.setAttribute(
    'data-color-theme',
    findColorTheme(custom.colorTheme)?.id ??
      (custom.colorTheme === WARM_COLOR_THEME_ID ? WARM_COLOR_THEME_ID : DEFAULT_COLOR_THEME_ID)
  )
}
