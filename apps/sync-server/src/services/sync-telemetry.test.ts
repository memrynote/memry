import { beforeEach, describe, expect, it, vi } from 'vitest'

import { logCrdtTraffic, logRecordPushBatch, logRecordQueryBatch } from './sync-telemetry'

describe('sync telemetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('logs record push metrics with transport-separated domain type counts', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    logRecordPushBatch({
      endpoint: '/sync/records/push',
      latencyMs: 80,
      outcomes: [
        { id: 'note-1', type: 'note', accepted: true, serverCursor: 10 },
        { id: 'task-1', type: 'task', accepted: false, reason: 'SYNC_REPLAY_DETECTED' }
      ]
    })

    expect(infoSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(infoSpy.mock.calls[0][0])) as Record<string, unknown>
    expect(payload.transport).toBe('record')
    expect(payload.domainTypes).toEqual({
      note: {
        accepted: 1,
        rejected: 0,
        replayRejected: 0,
        conflictRejected: 0,
        quotaRejected: 0,
        otherRejected: 0
      },
      task: {
        accepted: 0,
        rejected: 1,
        replayRejected: 1,
        conflictRejected: 0,
        quotaRejected: 0,
        otherRejected: 0
      }
    })
  })

  it('logs record query metrics with exact record domain types', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    logRecordQueryBatch({
      endpoint: '/sync/records/changes',
      operation: 'changes',
      latencyMs: 35,
      itemTypes: ['task', 'task', 'journal'],
      deletedCount: 1
    })

    expect(infoSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(infoSpy.mock.calls[0][0])) as Record<string, unknown>
    expect(payload.transport).toBe('record')
    expect(payload.domainTypes).toEqual({
      task: 2,
      journal: 1
    })
  })

  it('logs CRDT traffic with explicit CRDT domain type metadata', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    logCrdtTraffic({
      endpoint: '/sync/crdt/updates',
      event: 'updates_stored',
      noteId: 'note-1',
      updateCount: 3,
      totalBytes: 128,
      latencyMs: 20
    })

    expect(infoSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(infoSpy.mock.calls[0][0])) as Record<string, unknown>
    expect(payload.transport).toBe('crdt')
    expect(payload.domainType).toBe('note')
  })
})
