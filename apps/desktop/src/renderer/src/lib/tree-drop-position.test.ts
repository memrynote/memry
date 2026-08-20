import { describe, expect, it } from 'vitest'

import { resolveDropPosition } from './tree-drop-position'

const HEIGHT = 28

describe('resolveDropPosition', () => {
  it('drops inside a row that takes children, whether or not it has any', () => {
    // The empty case is the regression: the virtualized tree used to read
    // "has children" as "takes children", so a folder created a moment ago
    // could not receive a drop until something else was put in it first.
    expect(resolveDropPosition(HEIGHT / 2, HEIGHT, true)).toBe('inside')
    expect(resolveDropPosition(HEIGHT / 2 + 1, HEIGHT, true)).toBe('inside')
  })

  it('keeps a narrow reorder band at each edge of a row that takes children', () => {
    expect(resolveDropPosition(1, HEIGHT, true)).toBe('before')
    expect(resolveDropPosition(HEIGHT - 1, HEIGHT, true)).toBe('after')
    // Just inside the quarter bands, so still a drop into the row.
    expect(resolveDropPosition(HEIGHT / 4 + 1, HEIGHT, true)).toBe('inside')
    expect(resolveDropPosition((HEIGHT * 3) / 4 - 1, HEIGHT, true)).toBe('inside')
  })

  it('splits a row that takes no children in half, never offering inside', () => {
    expect(resolveDropPosition(1, HEIGHT, false)).toBe('before')
    expect(resolveDropPosition(HEIGHT / 2 - 1, HEIGHT, false)).toBe('before')
    expect(resolveDropPosition(HEIGHT / 2, HEIGHT, false)).toBe('after')
    expect(resolveDropPosition(HEIGHT - 1, HEIGHT, false)).toBe('after')
  })
})
