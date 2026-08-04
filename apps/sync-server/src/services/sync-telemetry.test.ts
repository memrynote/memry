import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  logCrdtTraffic,
  logRecordPushBatch,
  logRecordQueryBatch,
  logSyncValidationFailure
} from './sync-telemetry'

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
        { id: 'task-1', type: 'task', accepted: false, reason: 'SYNC_REPLAY_DETECTED' },
        { id: 'calendar-event-1', type: 'calendar_event', accepted: true, serverCursor: 11 }
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
      },
      calendar_event: {
        accepted: 1,
        rejected: 0,
        replayRejected: 0,
        conflictRejected: 0,
        quotaRejected: 0,
        otherRejected: 0
      }
    })
  })

  it('logs every record domain and rejection reason bucket', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    logRecordPushBatch({
      endpoint: '/sync/records/push',
      latencyMs: 1_500,
      outcomes: [
        { id: 'project-1', type: 'project', accepted: true },
        { id: 'settings-1', type: 'settings', accepted: true },
        { id: 'inbox-1', type: 'inbox', accepted: true },
        { id: 'filter-1', type: 'filter', accepted: true },
        { id: 'attachment-1', type: 'attachment', accepted: true },
        { id: 'tag-1', type: 'tag_definition', accepted: true },
        { id: 'folder-1', type: 'folder_config', accepted: true },
        { id: 'calendar-source-1', type: 'calendar_source', accepted: true },
        { id: 'calendar-binding-1', type: 'calendar_binding', accepted: true },
        { id: 'project-2', type: 'project', accepted: false, reason: 'SYNC_VERSION_CONFLICT' },
        {
          id: 'attachment-2',
          type: 'attachment',
          accepted: false,
          reason: 'STORAGE_QUOTA_EXCEEDED'
        },
        { id: 'filter-2', type: 'filter', accepted: false, reason: undefined }
      ]
    })

    const payload = JSON.parse(String(infoSpy.mock.calls[0][0])) as Record<string, unknown>
    expect(payload.latencyBucket).toBe('1s_plus')
    expect(payload.domains).toMatchObject({
      projects: { accepted: 1, rejected: 1, conflictRejected: 1 },
      settings: { accepted: 1 },
      inbox: { accepted: 1 },
      filters: { accepted: 1, rejected: 1, otherRejected: 1 },
      attachments: { accepted: 1, rejected: 1, quotaRejected: 1 },
      tags: { accepted: 1 },
      folders: { accepted: 1 },
      calendar: { accepted: 2 }
    })
  })

  it('logs record query metrics with exact record domain types', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    logRecordQueryBatch({
      endpoint: '/sync/records/changes',
      operation: 'changes',
      latencyMs: 35,
      itemTypes: ['task', 'task', 'journal', 'calendar_external_event', 'agent_message'],
      deletedCount: 1
    })

    expect(infoSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(infoSpy.mock.calls[0][0])) as Record<string, unknown>
    expect(payload.transport).toBe('record')
    expect(payload.domainTypes).toEqual({
      task: 2,
      journal: 1,
      calendar_external_event: 1,
      agent_message: 1
    })
    expect(payload.domains).toEqual({
      tasks: 2,
      notes: 1,
      calendar: 1,
      agent_chat: 1
    })
  })

  it('maps template items to the templates domain', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    logRecordQueryBatch({
      endpoint: '/sync/records/changes',
      operation: 'changes',
      latencyMs: 12,
      itemTypes: ['template', 'template'],
      deletedCount: 0
    })

    const payload = JSON.parse(String(infoSpy.mock.calls[0][0])) as Record<string, unknown>
    expect(payload.domainTypes).toEqual({ template: 2 })
    expect(payload.domains).toEqual({ templates: 2 })
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

  it('logs validation failures through the warning logger', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    logSyncValidationFailure({
      transport: 'record',
      endpoint: '/sync/push',
      issue: 'bad payload'
    })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(warnSpy.mock.calls[0][0])) as Record<string, unknown>
    expect(payload.issue).toBe('bad payload')
  })
})
