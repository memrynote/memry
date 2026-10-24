import { StrictMode, type ReactNode } from 'react'
import { act, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hintModeActiveRef } from '@/contexts/hint-mode'
import { TabIdentityProvider } from '@/contexts/tabs/tab-identity'
import { beginVaultSwitch, resetVaultSwitchState } from '@/lib/vault-switch-state'
import {
  publishActiveContext,
  runCommand,
  useAppCommands,
  useAvailableCommands,
  useTabCommands
} from '.'
import { resetCommandStoreForTests } from './store'

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  toastError: vi.fn()
}))

vi.mock('@/lib/logger', () => ({ createLogger: () => mocks.logger }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

// `dayPanel` owns one command and `zoom` three: small owners to stand in for any.
const dayPanel = (
  run: () => void | Promise<void>,
  extra: { enabled?: boolean; label?: string } = {}
) => ({ 'view.toggleDayPanel': { run, ...extra } }) as const

const zoom = (run: () => void) =>
  ({
    'view.zoomIn': { run },
    'view.zoomOut': { run },
    'view.actualSize': { run }
  }) as const

function AppOwner({
  run,
  enabled,
  label
}: {
  run: () => void | Promise<void>
  enabled?: boolean
  label?: string
}): null {
  useAppCommands('dayPanel', dayPanel(run, { enabled, label }))
  return null
}

/** No tab-scoped owner exists yet, so `zoom` stands in for a page. */
function PageOwner({ run }: { run: () => void }): null {
  useTabCommands('zoom', zoom(run))
  return null
}

const inTab = (tabId: string, node: ReactNode): ReactNode => (
  <TabIdentityProvider tabId={tabId} groupId={`group-${tabId}`}>
    {node}
  </TabIdentityProvider>
)

beforeEach(() => {
  resetCommandStoreForTests()
  vi.clearAllMocks()
})

afterEach(() => {
  hintModeActiveRef.current = false
  resetVaultSwitchState()
})

describe('command registry', () => {
  it('runs an app owner while it is mounted and forgets it on unmount', async () => {
    const run = vi.fn()
    const { unmount } = render(<AppOwner run={run} />)

    await expect(runCommand('view.toggleDayPanel', 'ui')).resolves.toBe('ran')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith({ source: 'ui' })

    unmount()
    await expect(runCommand('view.toggleDayPanel', 'ui')).resolves.toBe('unavailable')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('has one registration per command under StrictMode double mounting', async () => {
    const run = vi.fn()
    const { unmount } = render(
      <StrictMode>
        <AppOwner run={run} />
      </StrictMode>
    )

    await runCommand('view.toggleDayPanel', 'ui')
    expect(run).toHaveBeenCalledTimes(1)

    unmount()
    await expect(runCommand('view.toggleDayPanel', 'ui')).resolves.toBe('unavailable')
  })

  it('runs the latest closure, not the one from the first render', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<AppOwner run={first} />)
    rerender(<AppOwner run={second} />)

    await runCommand('view.toggleDayPanel', 'ui')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('reports a disabled command as unavailable without running it', async () => {
    const run = vi.fn()
    render(<AppOwner run={run} enabled={false} />)

    await expect(runCommand('view.toggleDayPanel', 'keyboard')).resolves.toBe('unavailable')
    expect(run).not.toHaveBeenCalled()
  })

  it('reports an id nobody registered as unavailable', async () => {
    await expect(runCommand('view.zoomIn', 'menu')).resolves.toBe('unavailable')
  })

  it('lets a second registration of the same slot replace the first without throwing', async () => {
    const stale = vi.fn()
    const current = vi.fn()
    const first = render(<AppOwner run={stale} />)
    render(<AppOwner run={current} />)

    await runCommand('view.toggleDayPanel', 'ui')
    expect(current).toHaveBeenCalledTimes(1)
    expect(stale).not.toHaveBeenCalled()

    // The replaced owner unmounting late must not take its replacement with it.
    first.unmount()
    await expect(runCommand('view.toggleDayPanel', 'ui')).resolves.toBe('ran')
    expect(current).toHaveBeenCalledTimes(2)
  })
})

describe('tab-scoped owners in a split view', () => {
  it('resolves only the registration of the active tab', async () => {
    const left = vi.fn()
    const right = vi.fn()
    render(
      <>
        {inTab('tab-left', <PageOwner run={left} />)}
        {inTab('tab-right', <PageOwner run={right} />)}
      </>
    )

    await expect(runCommand('view.zoomIn', 'ui')).resolves.toBe('unavailable')

    act(() => publishActiveContext({ activeTabId: 'tab-right', activeGroupId: 'group-tab-right' }))
    await runCommand('view.zoomIn', 'ui')
    expect(right).toHaveBeenCalledTimes(1)
    expect(left).not.toHaveBeenCalled()

    act(() => publishActiveContext({ activeTabId: 'tab-left', activeGroupId: 'group-tab-left' }))
    await runCommand('view.zoomIn', 'ui')
    expect(left).toHaveBeenCalledTimes(1)
    expect(right).toHaveBeenCalledTimes(1)
  })

  it('drops a tab registration when its tab closes', async () => {
    const run = vi.fn()
    const { rerender } = render(inTab('tab-a', <PageOwner run={run} />))
    act(() => publishActiveContext({ activeTabId: 'tab-a', activeGroupId: 'g' }))
    await expect(runCommand('view.zoomIn', 'ui')).resolves.toBe('ran')

    rerender(<></>)
    await expect(runCommand('view.zoomIn', 'ui')).resolves.toBe('unavailable')
  })

  it('registers nothing outside a tab', async () => {
    render(<PageOwner run={vi.fn()} />)
    act(() => publishActiveContext({ activeTabId: 'tab-a', activeGroupId: 'g' }))
    await expect(runCommand('view.zoomIn', 'ui')).resolves.toBe('unavailable')
  })
})

describe('availability subscription', () => {
  it('notifies when ids, labels or the active tab change, and stays silent otherwise', () => {
    const { result } = renderHook(() => useAvailableCommands())
    const owner = render(<AppOwner run={vi.fn()} />)
    expect(result.current.commands.map((c) => c.id)).toEqual(['view.toggleDayPanel'])

    const before = result.current
    owner.rerender(<AppOwner run={vi.fn()} />)
    expect(result.current).toBe(before)

    owner.rerender(<AppOwner run={vi.fn()} label="Hide Day Panel" />)
    expect(result.current.commands).toEqual([
      { id: 'view.toggleDayPanel', label: 'Hide Day Panel' }
    ])

    owner.rerender(<AppOwner run={vi.fn()} label="Hide Day Panel" enabled={false} />)
    expect(result.current.commands).toEqual([])

    act(() => publishActiveContext({ activeTabId: 'tab-a', activeGroupId: 'g' }))
    expect(result.current.activeTabId).toBe('tab-a')
  })
})

describe('runCommand outcomes', () => {
  it('blocks only keystrokes while hint mode is active', async () => {
    const run = vi.fn()
    render(<AppOwner run={run} />)
    hintModeActiveRef.current = true

    await expect(runCommand('view.toggleDayPanel', 'keyboard')).resolves.toBe('blocked')
    expect(run).not.toHaveBeenCalled()

    await expect(runCommand('view.toggleDayPanel', 'menu')).resolves.toBe('ran')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('blocks keystrokes while a vault switch is pending', async () => {
    const run = vi.fn()
    render(<AppOwner run={run} />)
    beginVaultSwitch({ path: '/vault-b', name: 'B' }, 'next')

    await expect(runCommand('view.toggleDayPanel', 'keyboard')).resolves.toBe('blocked')
    await expect(runCommand('view.toggleDayPanel', 'palette')).resolves.toBe('ran')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('logs a throwing command with its id and source and tells the user', async () => {
    const boom = new Error('disk full')
    render(
      <AppOwner
        run={() => {
          throw boom
        }}
      />
    )

    await expect(runCommand('view.toggleDayPanel', 'palette')).resolves.toBe('failed')
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.any(String),
      { id: 'view.toggleDayPanel', source: 'palette' },
      boom
    )
    expect(mocks.toastError).toHaveBeenCalledWith('disk full')
  })

  it('treats a rejected promise like a throw', async () => {
    render(<AppOwner run={() => Promise.reject(new Error('nope'))} />)

    await expect(runCommand('view.toggleDayPanel', 'ui')).resolves.toBe('failed')
    expect(mocks.toastError).toHaveBeenCalledWith('nope')
  })
})
