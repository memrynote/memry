import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'

import { SidebarSection } from './sidebar-section'
import { SidebarProvider } from '@/components/ui/sidebar'

// The section heading renders at 11px, which WCAG AA treats as small text and
// holds to 4.5:1. jsdom has no cascade and no layout, so a render can never
// prove a ratio — but the colours are literal hex in base.css, so read them from
// source and do the arithmetic. Vitest's cwd is apps/desktop.
const BASE_CSS = join(process.cwd(), 'src/renderer/src/assets/base.css')

const AA_SMALL_TEXT = 4.5

/** Selector of every theme block that carries a full sidebar palette. */
const THEMES = [':root', '.white', '.dark'] as const

interface ThemeBlock {
  selector: string
  declarations: Map<string, string>
}

/**
 * Flat `selector { … }` blocks that declare --sidebar-section-heading. base.css
 * has several `:root` blocks; only the sidebar palette one defines this token.
 */
function sidebarThemeBlocks(): ThemeBlock[] {
  const css = readFileSync(BASE_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: ThemeBlock[] = []

  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!body.includes('--sidebar-section-heading:')) continue
    const declarations = new Map<string, string>()
    for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      declarations.set(name, value.trim())
    }
    blocks.push({ selector: selector.trim(), declarations })
  }

  return blocks
}

const blocks = sidebarThemeBlocks()

function blockFor(selector: string): ThemeBlock {
  const block = blocks.find((candidate) => candidate.selector === selector)
  if (!block) throw new Error(`no sidebar theme block for ${selector}`)
  return block
}

/** Resolve a token to a hex literal, following `var(--x)` within the same block. */
function resolveColor(block: ThemeBlock, name: string): string {
  let value = block.declarations.get(name)
  for (let hops = 0; value?.startsWith('var(') && hops < 3; hops++) {
    value = block.declarations.get(value.slice(4, -1).trim())
  }
  expect(value, `${block.selector} ${name} should resolve to a hex colour`).toMatch(
    /^#[0-9a-f]{6}$/i
  )
  return value as string
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

function renderHeaderButton(): HTMLElement {
  render(
    <SidebarProvider>
      <SidebarSection id="contrast" label="Notes">
        <div>child</div>
      </SidebarSection>
    </SidebarProvider>
  )
  return screen.getByRole('button', { name: /^Notes section/ })
}

describe('sidebar section heading contrast', () => {
  it('defines the heading token in every sidebar theme', () => {
    expect(blocks.map((block) => block.selector)).toEqual([...THEMES])
  })

  it.each(THEMES)('clears WCAG AA for small text in %s', (selector) => {
    const block = blockFor(selector)
    const heading = resolveColor(block, '--sidebar-section-heading')
    const background = resolveColor(block, '--sidebar')

    expect(contrastRatio(heading, background)).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })

  it('paints the header with the heading token', () => {
    expect(renderHeaderButton().className.split(/\s+/)).toContain('text-sidebar-section-heading')
  })

  it('never swaps the header to a colour below AA on hover', () => {
    const hoverClasses = renderHeaderButton()
      .className.split(/\s+/)
      .filter((className) => className.startsWith('hover:text-'))

    for (const hoverClass of hoverClasses) {
      const token = /^hover:text-(sidebar[a-z0-9-]*)$/.exec(hoverClass)?.[1]
      expect(token, `${hoverClass} is not a sidebar token, so AA cannot be proven`).toBeDefined()

      for (const selector of THEMES) {
        const block = blockFor(selector)
        const hover = resolveColor(block, `--${token}`)
        const background = resolveColor(block, '--sidebar')

        expect(
          contrastRatio(hover, background),
          `${hoverClass} on ${selector}`
        ).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }
    }
  })
})
