import { describe, expect, it, vi } from 'vitest'

import { watchAltMenu, type AltMenuHost } from './alt-menu'

function host() {
  const listeners = new Map<string, EventListener>()
  const target: AltMenuHost = {
    addEventListener: (type, listener) => void listeners.set(type, listener),
    removeEventListener: (type) => void listeners.delete(type)
  }
  const fire = (type: string, event: Record<string, unknown> = {}): void =>
    listeners.get(type)?.(new KeyboardEvent(type, event))
  return { target, fire, listeners }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('watchAltMenu', () => {
  it('reports a bare Alt press and release once', async () => {
    const { target, fire } = host()
    const toggle = vi.fn(() => Promise.resolve(true))
    watchAltMenu(target, { toggle, hide: vi.fn(() => Promise.resolve()) })
    fire('keydown', { key: 'Alt' })
    fire('keydown', { key: 'Alt', repeat: true })
    fire('keyup', { key: 'Alt' })
    await settle()
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('ignores Alt held with another key or a click', () => {
    const { target, fire } = host()
    const toggle = vi.fn(() => Promise.resolve(true))
    watchAltMenu(target, { toggle, hide: vi.fn(() => Promise.resolve()) })
    fire('keydown', { key: 'Alt' })
    fire('keydown', { key: 'f' })
    fire('keyup', { key: 'Alt' })
    fire('keydown', { key: 'Alt' })
    fire('mousedown')
    fire('keyup', { key: 'Alt' })
    expect(toggle).not.toHaveBeenCalled()
  })

  it('hides a shown menu bar on Escape, once, and not after a blur', async () => {
    const { target, fire } = host()
    const hide = vi.fn(() => Promise.resolve())
    watchAltMenu(target, { toggle: () => Promise.resolve(true), hide })
    fire('keydown', { key: 'Alt' })
    fire('keyup', { key: 'Alt' })
    await settle()
    fire('keydown', { key: 'Escape' })
    fire('keydown', { key: 'Escape' })
    expect(hide).toHaveBeenCalledTimes(1)

    fire('keydown', { key: 'Alt' })
    fire('keyup', { key: 'Alt' })
    await settle()
    fire('blur')
    fire('keydown', { key: 'Escape' })
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('removes its listeners', () => {
    const { target, listeners } = host()
    const stop = watchAltMenu(target, {
      toggle: () => Promise.resolve(false),
      hide: () => Promise.resolve()
    })
    expect(listeners.size).toBe(4)
    stop()
    expect(listeners.size).toBe(0)
  })
})
