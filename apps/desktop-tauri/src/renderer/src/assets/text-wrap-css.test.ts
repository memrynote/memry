import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * WebKit (macOS, Linux) applies `text-wrap: pretty` to every line and wraps earlier than the
 * Chromium of Electron and WebView2 (Windows). jsdom has no layout, so a source-level read of
 * the cascade is the guard.
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'base.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

describe('text wrapping in base.css', () => {
  it('wraps plainly by default and uses pretty only on Windows', () => {
    const body = css.match(/\n {2}body \{([\s\S]*?)\n {2}\}/)?.[1] ?? ''
    expect(body).toContain('text-wrap: wrap')
    expect(body).not.toContain('pretty')
    const win = css.match(/:root\[data-platform='win32'\] body \{([\s\S]*?)\}/)?.[1] ?? ''
    expect(win).toContain('text-wrap: pretty')
  })

  it('sets pretty nowhere else', () => {
    expect(css.match(/text-wrap: pretty/g)).toHaveLength(1)
  })
})
