import { describe, expect, it } from 'vitest'
import { computePosition, type Platform } from '@floating-ui/react'
import { MENTION_MENU_FLOATING_OPTIONS } from './mention-menu-placement'

const VIEWPORT = { x: 0, y: 0, width: 1000, height: 800 }
const MENU_HEIGHT = 600

async function placeBelowCaretAt(caretY: number): Promise<string> {
  const reference = document.createElement('span')
  const floating = document.createElement('div')
  const platform: Platform = {
    getElementRects: () => ({
      reference: { x: 100, y: caretY, width: 1, height: 20 },
      floating: { x: 0, y: 0, width: 300, height: MENU_HEIGHT }
    }),
    getDimensions: () => ({ width: 300, height: MENU_HEIGHT }),
    getClippingRect: () => VIEWPORT
  }
  const { placement } = await computePosition(reference, floating, {
    ...MENTION_MENU_FLOATING_OPTIONS.useFloatingOptions,
    platform
  })
  return placement
}

describe('@ menu placement', () => {
  it('opens below the caret when there is usable room below, even if above has more', async () => {
    expect(await placeBelowCaretAt(450)).toBe('bottom-start')
  })

  it('flips above when the room below is too short', async () => {
    expect(await placeBelowCaretAt(700)).toBe('top-start')
  })

  it('stays below near the top of the viewport', async () => {
    expect(await placeBelowCaretAt(40)).toBe('bottom-start')
  })
})
