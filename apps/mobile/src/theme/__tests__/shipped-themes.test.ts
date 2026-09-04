import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { themes } from '@/theme/colors'

/**
 * The themes the app actually ships (#2033, epic #2025).
 *
 * `useColors()` returns the white palette unconditionally and there is no
 * second one, so every RN surface in the app is light on any device. The
 * WebView guest, meanwhile, has a real dark palette and was being told to use
 * it whenever the device was in dark mode — a near-black page inside white app
 * chrome, with dark native text over it.
 *
 * The honest fix is not a dark palette, which is a design-system job. It is to
 * stop claiming one. That claim is made in two places nothing links, so this
 * file reads both. A real dark theme re-wires exactly what is asserted here.
 *
 * These are source-text assertions on purpose: `cfg` is built inline inside a
 * screen component, and rendering one needs React Native, which this node-only
 * suite does not have. A refactor that moves the literal fails here with an
 * undefined match, which is the right signal to come and re-point it.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const noteScreen = read('../../app/(vault)/(tabs)/notes/[id].tsx')
const rootLayout = read('../../app/_layout.tsx')

/** The `theme` the note screen puts in the `cfg` message the guest receives. */
function bridgeTheme(source: string): string | undefined {
  const cfg = /const cfg: BridgeCfg = useMemo\(\s*\(\) => \(\{([\s\S]*?)\}\),/.exec(source)?.[1]
  return /theme:\s*([^,\n]+)/.exec(cfg ?? '')?.[1]
}

describe('the themes the app ships', () => {
  it('has exactly one palette, so there is exactly one theme to name', () => {
    expect(Object.keys(themes)).toEqual(['white'])
  })

  it('names that palette to the guest instead of the device scheme', () => {
    expect(bridgeTheme(noteScreen)).toBe("'light'")
    expect(noteScreen).not.toMatch(/useColorScheme/)
  })

  it('does not hand the navigator a dark container the palette cannot match', () => {
    expect(rootLayout).not.toMatch(/DarkTheme/)
  })
})
