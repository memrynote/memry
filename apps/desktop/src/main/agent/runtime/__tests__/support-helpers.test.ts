import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  storeGet: vi.fn(),
  storeSet: vi.fn()
}))

vi.mock('../../../store', () => ({
  store: {
    get: mocks.storeGet,
    set: mocks.storeSet
  }
}))

import { snapshotAttachments } from '../attachment-snapshotter'
import { acceptDisclosure, getDisclosureState } from '../disclosure-state'

describe('agent runtime support helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.setSystemTime(new Date('2026-05-12T12:00:00.000Z'))
    mocks.storeGet.mockReturnValue({})
  })

  it('snapshots attachment references with stable metadata', async () => {
    await expect(
      snapshotAttachments([
        { kind: 'note', ref_id: 'note-1', label: 'Daily note' },
        { kind: 'folder', ref_id: 'notes/projects', label: 'Projects' },
        { kind: 'inbox', ref_id: 'inbox-1', label: 'Read later' },
        { kind: 'calendar_event', ref_id: 'event-1', label: 'Planning sync' }
      ])
    ).resolves.toEqual([
      {
        kind: 'note',
        refId: 'note-1',
        label: 'Daily note',
        snapshotAt: Date.parse('2026-05-12T12:00:00.000Z'),
        snapshot: { mode: 'reference_only', id: 'note-1' }
      },
      {
        kind: 'folder',
        refId: 'notes/projects',
        label: 'Projects',
        snapshotAt: Date.parse('2026-05-12T12:00:00.000Z'),
        snapshot: { mode: 'reference_only', path: 'notes/projects' }
      },
      {
        kind: 'inbox',
        refId: 'inbox-1',
        label: 'Read later',
        snapshotAt: Date.parse('2026-05-12T12:00:00.000Z'),
        snapshot: { mode: 'reference_only', id: 'inbox-1' }
      },
      {
        kind: 'calendar_event',
        refId: 'event-1',
        label: 'Planning sync',
        snapshotAt: Date.parse('2026-05-12T12:00:00.000Z'),
        snapshot: { mode: 'reference_only', id: 'event-1' }
      }
    ])
  })

  it('reads and accepts the agent disclosure flag', () => {
    expect(getDisclosureState()).toEqual({ accepted: false })

    mocks.storeGet.mockReturnValue({
      disclosureAccepted: false,
      localProvider: { model: 'llama3' }
    })
    expect(acceptDisclosure()).toEqual({ accepted: true })
    expect(mocks.storeSet).toHaveBeenCalledWith('agent', {
      disclosureAccepted: true,
      localProvider: { model: 'llama3' }
    })

    mocks.storeGet.mockReturnValue({ disclosureAccepted: true })
    expect(getDisclosureState()).toEqual({ accepted: true })
  })
})
