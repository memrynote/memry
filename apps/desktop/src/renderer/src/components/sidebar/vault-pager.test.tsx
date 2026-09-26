import { act, cleanup, render, screen } from '@testing-library/react'
import { Activity } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultInfo } from '../../../../preload/index.d'
import { VaultPager } from './vault-pager'
import { VAULT_SWIPE } from '@/lib/vault-swipe'
import {
  beginVaultSwitch,
  endVaultSwitch,
  getVaultSwitchFrame,
  isVaultRevealHeld,
  requestVaultPage,
  resetVaultSwitchState
} from '@/lib/vault-switch-state'
import {
  captureVaultSidebarSnapshot,
  getVaultSidebarSnapshot,
  resetVaultSidebarSnapshots
} from '@/lib/vault-sidebar-snapshot'

const WIDTH = 250

function vault(name: string): VaultInfo {
  return {
    path: `/vaults/${name.toLowerCase()}`,
    name,
    noteCount: 0,
    taskCount: 0,
    lastOpened: '2026-01-01T00:00:00.000Z',
    isDefault: false,
    accentColor: '#2f6fed'
  }
}

const vaults = [vault('Personal'), vault('Work'), vault('Research')]

function renderPager(onSwitch = vi.fn().mockResolvedValue(true), list = 'list') {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <div data-sidebar="sidebar">
        <VaultPager vaults={vaults} activePath="/vaults/work" activeName="Work" onSwitch={onSwitch}>
          <div>{list}</div>
        </VaultPager>
      </div>
    </QueryClientProvider>
  )
  const viewport = view.container.firstElementChild!.firstElementChild as HTMLElement
  return { onSwitch, viewport }
}

/** A page for `path` as the pager would have captured it. */
function seedSnapshot(path: string, text: string): void {
  const page = document.createElement('div')
  page.innerHTML = `<div>${text}</div>`
  captureVaultSidebarSnapshot(path, page)
}

function wheel(target: HTMLElement, deltaX: number, deltaY = 0): WheelEvent {
  const event = new WheelEvent('wheel', { deltaX, deltaY, cancelable: true, bubbles: true })
  target.dispatchEvent(event)
  return event
}

async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(VAULT_SWIPE.idleMs + 10)
    await Promise.resolve()
  })
  // Let the (instant, animation-less) settle promises and onSwitch resolve.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('VaultPager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH)
  })

  afterEach(() => {
    // Unmount before the stores reset, so the reset does not render a live pager.
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetVaultSwitchState()
    resetVaultSidebarSnapshots()
    localStorage.clear()
  })

  it('shows the open vault name above the list', () => {
    renderPager()
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('list')).toBeInTheDocument()
  })

  it('switches to the next vault after a long horizontal swipe', async () => {
    const { onSwitch, viewport } = renderPager()

    let consumed = false
    act(() => {
      for (let i = 0; i < 10; i += 1) consumed = wheel(viewport, 12).defaultPrevented || consumed
    })
    expect(consumed).toBe(true)
    await settle()

    expect(onSwitch).toHaveBeenCalledWith(vaults[2], 'next')
  })

  it('switches to the previous vault the other way', async () => {
    const { onSwitch, viewport } = renderPager()

    act(() => {
      for (let i = 0; i < 10; i += 1) wheel(viewport, -12)
    })
    await settle()

    expect(onSwitch).toHaveBeenCalledWith(vaults[0], 'prev')
  })

  it('springs back from a short drag', async () => {
    const { onSwitch, viewport } = renderPager()

    // One event locks the axis and moves 10px: no speed recorded, well short
    // of the commit distance. (Event timestamps are not faked, so speed is
    // tested against recorded streams in `lib/vault-swipe.test.ts` instead.)
    act(() => {
      wheel(viewport, 10)
    })
    await settle()

    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('leaves vertical scrolling alone', async () => {
    const { onSwitch, viewport } = renderPager()

    let prevented = false
    act(() => {
      for (let i = 0; i < 10; i += 1)
        prevented = wheel(viewport, 1, 20).defaultPrevented || prevented
    })
    await settle()

    expect(prevented).toBe(false)
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('ignores pinch zoom', async () => {
    const { onSwitch, viewport } = renderPager()

    act(() => {
      for (let i = 0; i < 10; i += 1) {
        viewport.dispatchEvent(
          new WheelEvent('wheel', { deltaX: 12, ctrlKey: true, cancelable: true })
        )
      }
    })
    await settle()

    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('moves on an indicator request with the same transition', async () => {
    const { onSwitch } = renderPager()

    act(() => requestVaultPage({ path: '/vaults/personal' }))
    await settle()
    expect(onSwitch).toHaveBeenCalledWith(vaults[0], 'prev')
  })

  it('brings the list back when the switch fails, and accepts the next gesture', async () => {
    const onSwitch = vi.fn().mockResolvedValue(false)
    const { viewport } = renderPager(onSwitch)

    act(() => requestVaultPage({ step: 1 }))
    await settle()
    expect(onSwitch).toHaveBeenCalledTimes(1)

    act(() => requestVaultPage({ step: -1 }))
    await settle()
    expect(onSwitch).toHaveBeenLastCalledWith(vaults[0], 'prev')
    expect(viewport.firstElementChild).toHaveStyle({ transform: '' })
  })

  it("shows the neighbouring vault's last page while swiping toward it", () => {
    seedSnapshot('/vaults/research', 'Q3 planning')
    const { viewport } = renderPager()

    act(() => {
      for (let i = 0; i < 3; i += 1) wheel(viewport, 12)
    })

    expect(screen.getByTestId('vault-pager-peek')).toHaveTextContent('Q3 planning')
  })

  it('falls back to the name for a vault it has never shown', () => {
    const { viewport } = renderPager()

    act(() => {
      for (let i = 0; i < 3; i += 1) wheel(viewport, 12)
    })

    expect(screen.getByTestId('vault-pager-peek')).toHaveTextContent('Research')
  })

  it("records the open vault's page when a swipe starts", () => {
    const { viewport } = renderPager(undefined, 'Hiring loop')

    act(() => {
      for (let i = 0; i < 3; i += 1) wheel(viewport, 12)
    })

    expect(getVaultSidebarSnapshot('/vaults/work')).toContain('Hiring loop')
  })

  it('leaves a frame of the sidebar for the switch screen', async () => {
    seedSnapshot('/vaults/research', 'Q3 planning')
    let finish: (ok: boolean) => void = () => {}
    const onSwitch = vi.fn().mockImplementation((vault: VaultInfo) => {
      beginVaultSwitch({ path: vault.path, name: vault.name }, 'next')
      return new Promise<boolean>((resolve) => {
        finish = resolve
      })
    })
    renderPager(onSwitch)

    act(() => requestVaultPage({ step: 1 }))
    await settle()

    // Main is still between the two vaults once the page has landed.
    expect(getVaultSwitchFrame()).toContain('Q3 planning')
    await act(async () => finish(true))
  })

  it('starts the switch as the settle begins and holds the reveal until it lands', async () => {
    let heldAtStart = false
    const onSwitch = vi.fn().mockImplementation(async () => {
      heldAtStart = isVaultRevealHeld()
      return true
    })
    renderPager(onSwitch)

    act(() => requestVaultPage({ step: 1 }))
    // Called synchronously from the commit, before any settle frame resolved.
    expect(onSwitch).toHaveBeenCalledTimes(1)
    expect(heldAtStart).toBe(true)

    await settle()
    expect(isVaultRevealHeld()).toBe(false)
  })

  it('covers the list with its last page after a switch, then lifts the cover', async () => {
    seedSnapshot('/vaults/work', 'Launch checklist')
    beginVaultSwitch({ path: '/vaults/work', name: 'Work' }, 'next')
    endVaultSwitch(true)
    renderPager()

    expect(screen.getByTestId('vault-pager-cover')).toHaveTextContent('Launch checklist')

    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })
    expect(screen.queryByTestId('vault-pager-cover')).not.toBeInTheDocument()
  })

  it('puts the list back when its kept workspace is shown again', async () => {
    const onSwitch = vi.fn().mockResolvedValue(true)
    const client = new QueryClient()
    const tree = (mode: 'visible' | 'hidden') => (
      <QueryClientProvider client={client}>
        <Activity mode={mode}>
          <div data-sidebar="sidebar">
            <VaultPager
              vaults={vaults}
              activePath="/vaults/work"
              activeName="Work"
              onSwitch={onSwitch}
            >
              <div>list</div>
            </VaultPager>
          </div>
        </Activity>
      </QueryClientProvider>
    )
    const view = render(tree('visible'))

    act(() => requestVaultPage({ step: 1 }))
    await settle()
    expect(onSwitch).toHaveBeenCalledTimes(1)
    const track = screen.getByText('list').parentElement!
    expect(track.style.transform).not.toBe('')

    // Switched away (hidden), then back.
    view.rerender(tree('hidden'))
    view.rerender(tree('visible'))
    expect(track.style.transform).toBe('')

    act(() => requestVaultPage({ step: -1 }))
    await settle()
    expect(onSwitch).toHaveBeenLastCalledWith(vaults[0], 'prev')
  })
})
