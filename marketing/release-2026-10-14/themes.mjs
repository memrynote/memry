// Regenerates themes.js from the app's own palettes so the film never hand-copies theme colors.
// node themes.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(dir, '../../packages/contracts/src/color-themes.ts'), 'utf8')
const body = src.slice(
  src.indexOf('export const COLOR_THEMES'),
  src.indexOf('export function findColorTheme')
)
const palette = (s) => {
  const pick = (k) => s.match(new RegExp(`${k}: '(#[0-9a-fA-F]{6})'`))[1]
  return {
    bg: pick('background'),
    fg: pick('foreground'),
    surface: pick('surface'),
    accent: pick('accent')
  }
}
const themes = [
  ...body.matchAll(/id: '([^']+)',\s*name: '([^']+)',\s*light: \{([^}]+)\},\s*dark: \{([^}]+)\}/g)
].map(([, id, name, light, dark]) => ({ id, name, light: palette(light), dark: palette(dark) }))
if (themes.length < 15) throw new Error(`expected 15 themes, parsed ${themes.length}`)
const out = `// Generated from packages/contracts/src/color-themes.ts by themes.mjs. Do not hand-edit.
window.THEMES = ${JSON.stringify(themes, null, 1)};
`
writeFileSync(path.join(dir, 'themes.js'), out)
console.log('wrote themes.js,', themes.length, 'themes')
