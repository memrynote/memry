import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { EDITOR_WEB_HTML_GZ_B64 } from '@/editor/generated/editor-web-asset'
import { white } from '@/theme/colors/white'

/**
 * The paper the app is drawn on (#2033, epic #2025).
 *
 * A note screen is two renderers stacked edge to edge: RN paints the nav bar,
 * the title and the metadata rows, and a WKWebView paints the body directly
 * under them. There is no border between the two, so any difference in their
 * background is a hard horizontal seam across the width of the screen — which
 * is exactly what shipped, RN on `#ffffff` and the guest on `#fdfcfb`.
 *
 * The value therefore has to be written three times, in three languages, across
 * two build systems that share no imports: a TypeScript token Metro bundles, a
 * CSS custom property vite bundles, and a literal in the guest's `<head>` that
 * neither of them can reach. Nothing links them, they have already drifted
 * once, and the symptom is only visible on a device. So the link is this file.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const cssSource = read('../../../editor-web/src/styles.css')
const htmlSource = read('../../../editor-web/index.html')

/** `--memry-paper` from the light `:root`, not the `[data-theme='dark']` one. */
function stylesheetPaper(css: string): string | undefined {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  return /--memry-paper:\s*(#[0-9a-f]{6})/.exec(root)?.[1]
}

function headStyle(html: string): string {
  return /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''
}

describe('one paper', () => {
  it('gives the RN chrome, the guest stylesheet and the guest head the same literal', () => {
    expect(stylesheetPaper(cssSource)).toBe(white.canvas.background)
    expect(/background:\s*(#[0-9a-f]{6})/.exec(headStyle(htmlSource))?.[1]).toBe(
      white.canvas.background
    )
  })

  it('pins the guest to a light rendering of the form controls it draws', () => {
    expect(headStyle(htmlSource)).toMatch(/color-scheme:\s*light/)
  })

  it('declares the paper before the bundle in the shipped document', () => {
    // The stylesheet vite injects lands AFTER the inlined module script, and
    // that script is 1.1 MB. A paper declared only there does not exist until
    // the parser has tokenized the whole bundle, so the document is white
    // until then. The literal in `<head>` is what makes the first paint right,
    // and it only works while it stays in front of the script.
    const document = gunzipSync(Buffer.from(EDITOR_WEB_HTML_GZ_B64, 'base64')).toString('utf8')
    const bundleAt = document.indexOf('<script')
    expect(bundleAt).toBeGreaterThan(0)

    const paperAt = document.indexOf(white.canvas.background)
    expect(paperAt).toBeGreaterThan(0)
    expect(paperAt).toBeLessThan(bundleAt)
  })
})
