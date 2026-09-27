import { describe, expect, it } from 'vitest'
import {
  applyColorTheme,
  COLOR_THEMES,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_COLOR_THEME_ID,
  findColorTheme,
  legacyColorTheme,
  parseThemeCustomization,
  storedLightMode,
  resolveModePalettes,
  THEME_CUSTOMIZATION_DEFAULTS,
  type ColorThemeRoot
} from './color-themes'
import { GENERAL_SETTINGS_DEFAULTS } from './settings-schemas'

const HEX = /^#[0-9a-f]{6}$/

function fakeRoot(): ColorThemeRoot & {
  attrs: Map<string, string>
  props: Map<string, string>
} {
  const attrs = new Map<string, string>()
  const props = new Map<string, string>()
  return {
    attrs,
    props,
    setAttribute: (name, value) => void attrs.set(name, value),
    removeAttribute: (name) => void attrs.delete(name),
    style: {
      setProperty: (name, value) => void props.set(name, value),
      removeProperty: (name) => {
        const previous = props.get(name) ?? ''
        props.delete(name)
        return previous
      }
    }
  }
}

describe('COLOR_THEMES', () => {
  it('ships fifteen themes with unique ids and full lowercase-hex palettes', () => {
    expect(COLOR_THEMES).toHaveLength(15)
    expect(new Set(COLOR_THEMES.map((theme) => theme.id)).size).toBe(15)
    for (const theme of COLOR_THEMES) {
      for (const palette of [theme.light, theme.dark]) {
        for (const color of Object.values(palette)) expect(color).toMatch(HEX)
      }
    }
  })

  it('never shadows the built-in palette id', () => {
    expect(findColorTheme(DEFAULT_COLOR_THEME_ID)).toBeUndefined()
    expect(GENERAL_SETTINGS_DEFAULTS.colorTheme).toBe(DEFAULT_COLOR_THEME_ID)
  })
})

describe('applyColorTheme', () => {
  it('#given a known theme #then sets the attribute and every mode of the palette', () => {
    const root = fakeRoot()
    applyColorTheme(root, { colorTheme: 'dracula' })

    expect(root.attrs.get('data-color-theme')).toBe('dracula')
    expect(root.props.get('--ct-dark-bg')).toBe('#282a36')
    expect(root.props.get('--ct-light-accent')).toBe('#644ac9')
  })

  it('#given an id from a newer build and no overrides #then restores the built-in palette', () => {
    const root = fakeRoot()
    applyColorTheme(root, { colorTheme: 'dracula' })
    applyColorTheme(root, { colorTheme: 'some-future-theme' })

    expect(root.attrs.has('data-color-theme')).toBe(false)
    expect(root.props.size).toBe(0)
  })

  it('#given the built-in palette with a dark background override #then derives from memrynote', () => {
    const root = fakeRoot()
    applyColorTheme(root, { ...THEME_CUSTOMIZATION_DEFAULTS, backgroundDark: '#111111' })

    expect(root.attrs.get('data-color-theme')).toBe('memrynote')
    expect(root.props.get('--ct-dark-bg')).toBe('#111111')
    // The light mode keeps its own colors: overrides are per mode.
    expect(root.props.get('--ct-light-bg')).toBe('#ffffff')
    expect(root.props.get('--ct-dark-accent')).toBe(DEFAULT_ACCENT_COLOR)
  })

  it('#given warm #then marks the light palette so base.css picks the paper tones', () => {
    const root = fakeRoot()
    applyColorTheme(root, { colorTheme: 'warm', accentColor: '#10b981' })

    expect(root.attrs.get('data-light-palette')).toBe('warm')
    // Hand-tuned tokens, nothing derived.
    expect(root.attrs.has('data-color-theme')).toBe(false)
    expect(root.props.get('--user-accent-color')).toBe('#10b981')

    applyColorTheme(root, { colorTheme: 'memrynote' })
    expect(root.attrs.has('data-light-palette')).toBe(false)
  })
})

describe('resolveModePalettes', () => {
  it('#given a theme #then uses its accent until the user picks one', () => {
    expect(resolveModePalettes({ colorTheme: 'nord', accentColor: '#ff0000' }).dark.accent).toBe(
      '#88c0d0'
    )
    expect(
      resolveModePalettes({ colorTheme: 'nord', accentColor: '#ff0000', useThemeAccent: false })
        .dark.accent
    ).toBe('#ff0000')
  })

  it('#given a light override #then only the light mode takes it', () => {
    const palettes = resolveModePalettes({ colorTheme: 'memrynote', foregroundLight: '#222222' })
    expect(palettes.light.foreground).toBe('#222222')
    expect(palettes.dark.foreground).toBe('#dedede')
  })

  it('#given memrynote or warm #then light is white or paper', () => {
    expect(resolveModePalettes({ colorTheme: 'memrynote' }).light.background).toBe('#ffffff')
    expect(resolveModePalettes({ colorTheme: 'warm' }).light.background).toBe('#f6f5f0')
  })
})

describe('legacy color modes', () => {
  it('maps settings from before color themes to the theme that looks the same', () => {
    expect(legacyColorTheme('light')).toBe('warm')
    expect(legacyColorTheme('system')).toBe('warm')
    expect(legacyColorTheme('white')).toBe('memrynote')
    expect(legacyColorTheme('dark')).toBe('memrynote')
    expect(legacyColorTheme(undefined)).toBe('memrynote')
  })

  it('stores the light mode an older build renders closest to the theme', () => {
    expect(storedLightMode('warm')).toBe('light')
    expect(storedLightMode('memrynote')).toBe('white')
    expect(storedLightMode('nord')).toBe('white')
  })
})

describe('parseThemeCustomization', () => {
  it('keeps valid fields and drops the rest', () => {
    expect(
      parseThemeCustomization({
        colorTheme: 'nord',
        accentColor: 'blue',
        useThemeAccent: false,
        backgroundDark: '#000000',
        foregroundDark: 'nope'
      })
    ).toEqual({ colorTheme: 'nord', useThemeAccent: false, backgroundDark: '#000000' })
  })

  it('rejects values that are not objects or carry nothing usable', () => {
    expect(parseThemeCustomization('nord')).toBeNull()
    expect(parseThemeCustomization(null)).toBeNull()
    expect(parseThemeCustomization({ accentColor: 12 })).toBeNull()
  })
})
