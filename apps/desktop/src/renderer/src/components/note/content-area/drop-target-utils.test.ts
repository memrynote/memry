import type { RefObject } from 'react'
import { describe, expect, it } from 'vitest'

import { calculateIndicatorPosition, findDropTarget } from './drop-target-utils'

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

function createBlock(id: string | null, top: number, bottom: number): HTMLElement {
  const element = document.createElement('div')
  if (id) element.setAttribute('data-id', id)
  element.getBoundingClientRect = () => rect(top, bottom)
  return element
}

function createContainer(): {
  container: HTMLElement
  ref: RefObject<HTMLElement | null>
} {
  const container = document.createElement('div')
  container.getBoundingClientRect = () => rect(100, 300)
  return {
    container,
    ref: { current: container }
  }
}

describe('drop target utils', () => {
  it('returns null when there is no container or no block', () => {
    expect(findDropTarget(10, { current: null })).toBeNull()

    const { ref } = createContainer()
    expect(findDropTarget(10, ref)).toBeNull()
  })

  it('finds before, after, and trailing block drop positions', () => {
    const { container, ref } = createContainer()
    container.append(createBlock('first', 120, 160), createBlock('second', 180, 220))

    expect(findDropTarget(130, ref)).toEqual({ blockId: 'first', position: 'before' })
    expect(findDropTarget(150, ref)).toEqual({ blockId: 'first', position: 'after' })
    expect(findDropTarget(200, ref)).toEqual({ blockId: 'second', position: 'after' })
    expect(findDropTarget(500, ref)).toEqual({ blockId: 'second', position: 'after' })
  })

  it('skips blocks without ids and calculates indicator positions', () => {
    const { container, ref } = createContainer()
    container.append(createBlock(null, 120, 160), createBlock('target', 180, 220))

    expect(findDropTarget(130, ref)).toEqual({ blockId: 'target', position: 'before' })
    expect(calculateIndicatorPosition({ blockId: 'target', position: 'before' }, ref)).toEqual({
      top: '78px',
      left: '0',
      right: '0'
    })
    expect(calculateIndicatorPosition({ blockId: 'target', position: 'after' }, ref)).toEqual({
      top: '122px',
      left: '0',
      right: '0'
    })
    expect(calculateIndicatorPosition({ blockId: 'missing', position: 'after' }, ref)).toBeNull()
    expect(
      calculateIndicatorPosition({ blockId: 'target', position: 'after' }, { current: null })
    ).toBeNull()
  })
})
