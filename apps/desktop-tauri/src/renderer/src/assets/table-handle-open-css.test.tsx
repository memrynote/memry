import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, fireEvent, render } from '@testing-library/react'
import { components, ShadCNComponentsContext, ShadCNDefaultComponents } from '@blocknote/shadcn'

/**
 * A table border nub keeps Notion's 14x22 box while its own menu is open, or the pointer moving
 * onto the menu shrinks it to a hairline under the menu (#4200). The open state is whatever
 * BlockNote's menu trigger puts on the button, so this opens the real trigger and matches it
 * against base.css's own open-state selectors. jsdom has no cascade; `matches` is the check.
 */
const BASE_CSS = join(dirname(fileURLToPath(import.meta.url)), 'base.css')

/** Every selector in base.css that sizes or paints the nub from an attribute on the button. */
function openStateSelectors(): string[] {
  const css = readFileSync(BASE_CSS, 'utf8')
    .replace(/^[ \t]*@[a-z-]+[^;{}\n]*;[ \t]*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors: string[] = []
  for (const [, selectorList] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of selectorList.split(',')) {
      const normalized = selector.trim().replace(/\s+/g, ' ')
      if (/\.memry-table-handle-control\[[^\]]+\] \.memry-table-handle-pill$/.test(normalized)) {
        selectors.push(normalized)
      }
    }
  }
  return selectors
}

describe('table border nub open state in base.css', () => {
  it.each(['vertical', 'horizontal'])(
    'holds the %s nub open while its menu is open, and only then',
    async (orientation) => {
      const selectors = openStateSelectors().filter(
        (selector) =>
          !selector.includes('[data-orientation') ||
          selector.includes(`[data-orientation='${orientation}']`)
      )
      // The orientation's 14x22 box and the shared paint.
      expect(selectors.length).toBeGreaterThanOrEqual(2)

      const { Root, Trigger } = components.Generic.Menu
      const { container } = render(
        <ShadCNComponentsContext.Provider value={ShadCNDefaultComponents}>
          <div className="memry-table-handle" data-orientation={orientation}>
            <Root>
              <Trigger>
                <button type="button" className="memry-table-handle-control" aria-label="Row">
                  <span className="memry-table-handle-pill" />
                </button>
              </Trigger>
            </Root>
          </div>
        </ShadCNComponentsContext.Provider>
      )
      const button = container.querySelector('button.memry-table-handle-control')
      const pill = container.querySelector('.memry-table-handle-pill')
      if (!button || !pill) throw new Error('nub not rendered')

      for (const selector of selectors) expect(pill.matches(selector), selector).toBe(false)

      await act(async () => {
        fireEvent.click(button)
      })
      expect(button.getAttribute('aria-expanded')).toBe('true')
      for (const selector of selectors) expect(pill.matches(selector), selector).toBe(true)
    }
  )
})
