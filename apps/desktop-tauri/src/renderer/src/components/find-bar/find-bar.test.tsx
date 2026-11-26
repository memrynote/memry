import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { FindBar } from './find-bar'

const BASE_CSS = join(dirname(fileURLToPath(import.meta.url)), '../../assets/base.css')

/**
 * The pinned formatting toolbar sticks in the same stacking context as the find
 * bar (the note root and the journal main), at the find bar's height. jsdom has
 * no cascade, so the two owners' z-indexes are read from source.
 */
function pinnedToolbarZIndex(): number {
  const css = readFileSync(BASE_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const body = /\.sticky-toolbar-enabled \.bn-formatting-toolbar \{([^}]*)\}/.exec(css)?.[1] ?? ''
  return Number(/z-index:\s*(\d+)/.exec(body)?.[1])
}

describe('FindBar', () => {
  it('paints above the pinned formatting toolbar (#4733)', () => {
    const { container } = render(
      <FindBar
        isOpen
        query=""
        matchCount={0}
        currentIndex={0}
        inputRef={createRef<HTMLInputElement>()}
        onQueryChange={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onClose={vi.fn()}
      />
    )
    const root = container.firstElementChild as HTMLElement
    const findBarZ = Number(/(?:^|\s)z-(\d+)(?:\s|$)/.exec(root.className)?.[1])

    expect(pinnedToolbarZIndex()).toBeGreaterThan(0)
    expect(findBarZ).toBeGreaterThan(pinnedToolbarZIndex())
  })
})
