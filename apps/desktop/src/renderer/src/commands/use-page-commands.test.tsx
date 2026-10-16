import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureKey } from '@memry/contracts/feature-flags'
import { runCommand } from './run-command'
import { isCommandAvailable, resetCommandStoreForTests } from './store'
import { usePageCommands } from './use-page-commands'

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), disabled: new Set<string>() }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('@/hooks/use-navigate-to-page', () => ({ useNavigateToPage: () => mocks.navigate }))
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({ isEnabled: (feature: FeatureKey) => !mocks.disabled.has(feature) })
}))

beforeEach(() => {
  resetCommandStoreForTests()
  vi.clearAllMocks()
  mocks.disabled.clear()
})

describe('page commands', () => {
  it.each([
    ['go.home', 'home'],
    ['go.inbox', 'inbox'],
    ['go.journal', 'journal'],
    ['go.calendar', 'calendar'],
    ['go.tasks', 'tasks'],
    ['go.graph', 'graph'],
    ['go.tags', 'tags']
  ] as const)('%s opens the %s page', async (command, page) => {
    renderHook(usePageCommands)

    await expect(runCommand(command, 'palette')).resolves.toBe('ran')

    expect(mocks.navigate).toHaveBeenCalledWith(page)
  })

  it.each([
    ['create.task', 'tasks', { activeInternalTab: 'all', focusQuickAddAt: expect.any(Number) }],
    ['create.inboxItem', 'inbox', { focusCaptureAt: expect.any(Number) }],
    ['create.calendarEvent', 'calendar', { createEventAt: expect.any(Number) }]
  ] as const)('%s opens %s with the New menu create intent', async (command, page, viewState) => {
    renderHook(usePageCommands)

    await expect(runCommand(command, 'palette')).resolves.toBe('ran')

    expect(mocks.navigate).toHaveBeenLastCalledWith(page, { viewState })
  })

  it('asks Calendar for a new event only from the create command, not a plain visit', async () => {
    renderHook(usePageCommands)

    await runCommand('go.calendar', 'palette')
    expect(mocks.navigate).toHaveBeenLastCalledWith('calendar')
  })

  it('offers no way to a page whose feature is switched off', async () => {
    mocks.disabled.add('graph').add('calendar')
    renderHook(usePageCommands)

    expect(isCommandAvailable('go.graph')).toBe(false)
    expect(isCommandAvailable('go.calendar')).toBe(false)
    expect(isCommandAvailable('create.calendarEvent')).toBe(false)
    expect(isCommandAvailable('go.tasks')).toBe(true)
    await expect(runCommand('go.graph', 'palette')).resolves.toBe('unavailable')
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})
