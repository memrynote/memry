import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from './run-command'
import { isCommandAvailable, resetCommandStoreForTests } from './store'
import { useSyncCommands } from './use-sync-commands'

const mocks = vi.hoisted(() => ({
  auth: { status: 'authenticated' },
  sync: {
    state: { status: 'idle' },
    triggerSync: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  } as {
    state: { status: string }
    triggerSync: () => void
    pause: () => void
    resume: () => void
  } | null
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ state: mocks.auth }) }))
vi.mock('@/contexts/sync-context', () => ({ useSyncOptional: () => mocks.sync }))

const available = (): string[] =>
  (['sync.syncNow', 'sync.pause', 'sync.resume'] as const).filter(isCommandAvailable)

function mount(status: string, auth = 'authenticated'): void {
  mocks.auth.status = auth
  if (mocks.sync) mocks.sync.state.status = status
  renderHook(useSyncCommands)
}

beforeEach(() => {
  resetCommandStoreForTests()
  vi.clearAllMocks()
  mocks.sync = {
    state: { status: 'idle' },
    triggerSync: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
})

describe('sync commands', () => {
  it('offers sync now and pause while synced, and resume only while paused', () => {
    mount('idle')
    expect(available()).toEqual(['sync.syncNow', 'sync.pause'])
  })

  it('offers sync now and resume while paused', () => {
    mount('paused')
    expect(available()).toEqual(['sync.syncNow', 'sync.resume'])
  })

  it.each(['offline', 'local_only'])('offers nothing while %s', (status) => {
    mount(status)
    expect(available()).toEqual([])
  })

  it('does not offer sync now mid-sync', () => {
    mount('syncing')
    expect(available()).toEqual(['sync.pause'])
  })

  it('offers nothing while signed out', () => {
    mount('idle', 'unauthenticated')
    expect(available()).toEqual([])
  })

  it('runs the sync the popover buttons run', async () => {
    mount('idle')
    await runCommand('sync.syncNow', 'palette')
    await runCommand('sync.pause', 'palette')
    expect(mocks.sync?.triggerSync).toHaveBeenCalledTimes(1)
    expect(mocks.sync?.pause).toHaveBeenCalledTimes(1)
  })
})
