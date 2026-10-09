import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Conversation } from './conversation'

describe('Conversation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows a row that grows without new children while pinned to the bottom', () => {
    const observers: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback)
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    const children = <div>Partial answer</div>
    render(<Conversation>{children}</Conversation>)
    const log = screen.getByRole('log')
    let height = 400
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => height })

    height = 520
    act(() => {
      for (const callback of observers) callback([], {} as ResizeObserver)
    })

    expect(log.scrollTop).toBe(520)
  })
})
