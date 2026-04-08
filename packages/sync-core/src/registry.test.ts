import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createCrdtSyncAdapter } from './crdt-sync'
import { createSyncAdapterRegistry } from './registry'

describe('SyncAdapterRegistry', () => {
  it('stores record and CRDT adapters by sync item type', () => {
    const taskLocal = {
      enqueueCreate() {},
      enqueueUpdate() {},
      enqueueDelete() {}
    }
    const noteRemote = {
      type: 'note' as const,
      schema: z.object({ title: z.string() }),
      applyRemoteMutation() {
        return 'applied' as const
      }
    }

    const registry = createSyncAdapterRegistry([
      { type: 'task', kind: 'record', local: taskLocal },
      {
        type: 'note',
        kind: 'crdt',
        remote: noteRemote,
        local: undefined,
        crdt: createCrdtSyncAdapter('note', { documentContentOnly: true })
      }
    ])

    expect(registry.getLocal('task')).toBe(taskLocal)
    expect(registry.getRemote('note')).toBe(noteRemote)
    expect(registry.get('note')?.kind).toBe('crdt')
  })
})
