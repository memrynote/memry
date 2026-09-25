import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The image resize grips are BlockNote's, and the two rules that keep them
 * reachable live only in base.css. jsdom has no cascade, so a source-level
 * read is the guard: it fails if either rule is deleted or loses the property
 * that makes it work.
 */
const BASE_CSS = join(dirname(fileURLToPath(import.meta.url)), 'base.css')

/** Every declaration block whose selector list includes `selector`, merged. */
function declarationsFor(selector: string): string {
  const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ')
  const css = readFileSync(BASE_CSS, 'utf8')
    // Statement at-rules before comments: `@source "…/*.js";` holds a literal `/*`.
    .replace(/^[ \t]*@[a-z-]+[^;{}\n]*;[ \t]*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const bodies: string[] = []
  for (const [, selectorList, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectorList.split(',').map(normalize).includes(selector)) bodies.push(normalize(body))
  }
  return bodies.join(' ')
}

describe('image resize grips in base.css', () => {
  it('keeps both grips visible while the image is node-selected in an editable note', () => {
    for (const selector of [
      ".bn-editor[contenteditable='true'] .bn-block-content.ProseMirror-selectednode[data-content-type='image'] .bn-resize-handle",
      ".bn-editor[contenteditable='true'] .ProseMirror-selectednode > .bn-block-content[data-content-type='image'] .bn-resize-handle"
    ]) {
      // `!important` is load-bearing: BlockNote hides the grips with an inline style.
      expect(declarationsFor(selector)).toContain('display: block !important')
    }
  })

  it('caps an image at its block width so a nested image stays inside the list indent', () => {
    expect(
      declarationsFor(
        ".bn-block-content[data-content-type='image'] > .bn-file-block-content-wrapper"
      )
    ).toContain('max-width: 100%')
  })
})
