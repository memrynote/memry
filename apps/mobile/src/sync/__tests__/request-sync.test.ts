import { describe, expect, it } from 'vitest'
import { requestSync, type SyncReason, type SyncTriggerDeps } from '../request-sync'

function trigger(overrides: Partial<SyncTriggerDeps> = {}) {
  const calls: string[] = []
  const deps: SyncTriggerDeps = {
    drain: async () => {
      calls.push('drain')
    },
    sync: async () => {
      calls.push('sync')
    },
    isReadOnly: () => false,
    ...overrides
  }
  return { deps, calls }
}

describe('requestSync', () => {
  it('drives BOTH a push and a pull for a socket broadcast', async () => {
    const t = trigger()
    await requestSync(t.deps, 'vault-1', 'socket')
    // The bug this collapses: the app could sit in the foreground with eight
    // queued rows at attempt_count 0 while nothing pushed and nothing pulled.
    expect(t.calls).toEqual(['drain', 'sync'])
  })

  it('pushes before it pulls', async () => {
    const order: string[] = []
    const t = trigger({
      drain: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('drain')
      },
      sync: async () => {
        order.push('sync')
      }
    })
    await requestSync(t.deps, 'vault-1', 'app-foreground')
    // An edit made offline should leave the device before a pull can hand the
    // user a stale-looking screen.
    expect(order).toEqual(['drain', 'sync'])
  })

  it('keeps each reason doing what its old call site did', async () => {
    const expected: Record<SyncReason, string[]> = {
      'app-foreground': ['drain', 'sync'],
      'background-task': ['drain', 'sync'],
      'app-background': ['drain'],
      online: ['drain'],
      socket: ['drain', 'sync']
    }
    for (const [reason, calls] of Object.entries(expected)) {
      const t = trigger()
      await requestSync(t.deps, 'vault-1', reason as SyncReason)
      expect(t.calls, reason).toEqual(calls)
    }
  })

  it('passes the vault id through', async () => {
    const seen: string[] = []
    const t = trigger({
      drain: async (vaultId) => {
        seen.push(vaultId)
      },
      sync: async (vaultId) => {
        seen.push(vaultId)
      }
    })
    await requestSync(t.deps, 'vault-9', 'socket')
    expect(seen).toEqual(['vault-9', 'vault-9'])
  })
})

describe('read-only mode', () => {
  it('skips the socket drain while the outbox is parked', async () => {
    const t = trigger({ isReadOnly: () => true })
    await requestSync(t.deps, 'vault-1', 'socket')
    // The drain parks itself and logs one line per pass, which is one line per
    // broadcast once a socket is driving it.
    expect(t.calls).toEqual(['sync'])
  })

  it('still drains on the app-state edges, which are rare', async () => {
    const t = trigger({ isReadOnly: () => true })
    await requestSync(t.deps, 'vault-1', 'app-background')
    expect(t.calls).toEqual(['drain'])
  })
})

describe('failures', () => {
  it('still pulls when the push fails', async () => {
    const t = trigger({
      drain: async () => {
        throw new Error('offline')
      }
    })
    await expect(requestSync(t.deps, 'vault-1', 'socket')).resolves.toBeUndefined()
    expect(t.calls).toEqual(['sync'])
  })

  it('swallows a failing pull rather than rejecting into a listener', async () => {
    const t = trigger({
      sync: async () => {
        throw new Error('server down')
      }
    })
    // These run inside AppState listeners and socket handlers, where a
    // rejection is an unhandled rejection.
    await expect(requestSync(t.deps, 'vault-1', 'app-foreground')).resolves.toBeUndefined()
    expect(t.calls).toEqual(['drain'])
  })
})
