import { describe, expect, it } from 'vitest'
import type { VectorClock } from '@memry/contracts/sync-api'
import {
  initAllFieldClocks,
  mergeFields,
  mergeTaskFields,
  mergeProjectFields,
  TASK_SYNCABLE_FIELDS,
  PROJECT_SYNCABLE_FIELDS,
  type FieldClocks
} from './field-merge'

describe('field-merge', () => {
  describe('initAllFieldClocks', () => {
    it('creates field clocks from doc-level clock for all fields', () => {
      // #given
      const docClock: VectorClock = { deviceA: 3, deviceB: 1 }
      const fields = ['title', 'description'] as const

      // #when
      const fc = initAllFieldClocks(docClock, fields)

      // #then
      expect(fc.title).toEqual({ deviceA: 3, deviceB: 1 })
      expect(fc.description).toEqual({ deviceA: 3, deviceB: 1 })
      expect(Object.keys(fc)).toHaveLength(2)
    })

    it('copies clock values not references', () => {
      const docClock: VectorClock = { deviceA: 1 }
      const fc = initAllFieldClocks(docClock, ['title', 'description'])

      fc.title.deviceA = 99
      expect(fc.description.deviceA).toBe(1)
      expect(docClock.deviceA).toBe(1)
    })

    it('handles empty clock', () => {
      const fc = initAllFieldClocks({}, ['title'])
      expect(fc.title).toEqual({})
    })

    it('handles empty fields array', () => {
      const fc = initAllFieldClocks({ deviceA: 1 }, [])
      expect(Object.keys(fc)).toHaveLength(0)
    })
  })

  describe('mergeFields', () => {
    const fields = ['title', 'dueDate', 'priority'] as const

    it('preserves both fields when different devices edit different fields', () => {
      // #given — DeviceA changed title offline, DeviceB changed dueDate online
      const local = { title: 'Local Title', dueDate: '2026-01-01', priority: 1 }
      const remote = { title: 'Old Title', dueDate: '2026-06-15', priority: 1 }
      const localFC: FieldClocks = {
        title: { deviceA: 2 },
        dueDate: { deviceA: 1 },
        priority: { deviceA: 1 }
      }
      const remoteFC: FieldClocks = {
        title: { deviceB: 1 },
        dueDate: { deviceB: 2 },
        priority: { deviceB: 1 }
      }

      // #when
      const result = mergeFields(local, remote, localFC, remoteFC, fields)

      // #then — local title wins (sum 2 > 1), remote dueDate wins (sum 2 > 1)
      expect(result.merged.title).toBe('Local Title')
      expect(result.merged.dueDate).toBe('2026-06-15')
      expect(result.hadConflicts).toBe(false)
    })

    it('remote wins on equal tick sums (consistent tiebreaker)', () => {
      // #given
      const local = { title: 'Local', dueDate: null, priority: 0 }
      const remote = { title: 'Remote', dueDate: null, priority: 0 }
      const localFC: FieldClocks = { title: { deviceA: 1 }, dueDate: {}, priority: {} }
      const remoteFC: FieldClocks = { title: { deviceB: 1 }, dueDate: {}, priority: {} }

      // #when
      const result = mergeFields(local, remote, localFC, remoteFC, fields)

      // #then
      expect(result.merged.title).toBe('Remote')
      expect(result.hadConflicts).toBe(true)
      expect(result.conflictedFields).toEqual(['title'])
    })

    it('no conflict when equal tick sums but same value', () => {
      // #given
      const local = { title: 'Same', dueDate: null, priority: 0 }
      const remote = { title: 'Same', dueDate: null, priority: 0 }
      const localFC: FieldClocks = { title: { deviceA: 1 }, dueDate: {}, priority: {} }
      const remoteFC: FieldClocks = { title: { deviceB: 1 }, dueDate: {}, priority: {} }

      // #when
      const result = mergeFields(local, remote, localFC, remoteFC, fields)

      // #then
      expect(result.hadConflicts).toBe(false)
      expect(result.conflictedFields).toEqual([])
    })

    it('does not flag conflict when clocks are identical but values differ', () => {
      const local = { title: 'Local', dueDate: null, priority: 0 }
      const remote = { title: 'Remote', dueDate: null, priority: 0 }
      const localFC: FieldClocks = { title: { deviceA: 3, deviceB: 1 }, dueDate: {}, priority: {} }
      const remoteFC: FieldClocks = { title: { deviceA: 3, deviceB: 1 }, dueDate: {}, priority: {} }

      const result = mergeFields(local, remote, localFC, remoteFC, fields)

      expect(result.merged.title).toBe('Remote')
      expect(result.hadConflicts).toBe(false)
      expect(result.conflictedFields).toEqual([])
    })

    it('higher tick sum wins regardless of device count', () => {
      // #given — local has 2 devices summing to 3, remote has 1 device with tick 5
      const local = { title: 'Local', dueDate: null, priority: 0 }
      const remote = { title: 'Remote', dueDate: null, priority: 0 }
      const localFC: FieldClocks = {
        title: { deviceA: 2, deviceB: 1 },
        dueDate: {},
        priority: {}
      }
      const remoteFC: FieldClocks = {
        title: { deviceC: 5 },
        dueDate: {},
        priority: {}
      }

      // #when
      const result = mergeFields(local, remote, localFC, remoteFC, fields)

      // #then — remote sum(5) > local sum(3)
      expect(result.merged.title).toBe('Remote')
      expect(result.hadConflicts).toBe(false)
    })

    it('merges field clocks using max per device', () => {
      // #given
      const local = { title: 'L', dueDate: null, priority: 0 }
      const remote = { title: 'R', dueDate: null, priority: 0 }
      const localFC: FieldClocks = {
        title: { deviceA: 3, deviceB: 1 },
        dueDate: { deviceA: 1 },
        priority: {}
      }
      const remoteFC: FieldClocks = {
        title: { deviceA: 1, deviceC: 2 },
        dueDate: { deviceC: 2 },
        priority: {}
      }

      // #when
      const result = mergeFields(local, remote, localFC, remoteFC, fields)

      // #then
      expect(result.mergedFieldClocks.title).toEqual({ deviceA: 3, deviceB: 1, deviceC: 2 })
      expect(result.mergedFieldClocks.dueDate).toEqual({ deviceA: 1, deviceC: 2 })
    })

    it('handles missing field clocks for some fields', () => {
      // #given — field clocks missing for dueDate
      const local = { title: 'Local', dueDate: '2026-01-01', priority: 0 }
      const remote = { title: 'Remote', dueDate: '2026-02-01', priority: 0 }
      const localFC: FieldClocks = { title: { deviceA: 2 } }
      const remoteFC: FieldClocks = { title: { deviceB: 1 } }

      // #when
      const result = mergeFields(local, remote, localFC, remoteFC, fields)

      // #then — missing clocks = sum 0 on both sides, so equal → remote wins
      expect(result.merged.title).toBe('Local')
      expect(result.merged.dueDate).toBe('2026-02-01')
      expect(result.merged.priority).toBe(0)
    })

    it('handles empty field clocks objects', () => {
      const local = { title: 'L', dueDate: null, priority: 1 }
      const remote = { title: 'R', dueDate: null, priority: 2 }

      const result = mergeFields(local, remote, {}, {}, fields)

      // all sums are 0 → remote wins for everything
      expect(result.merged.title).toBe('R')
      expect(result.merged.priority).toBe(2)
    })

    it('tracks multiple conflicted fields', () => {
      // #given — both title and priority have concurrent edits
      const local = { title: 'Local Title', dueDate: null, priority: 5 }
      const remote = { title: 'Remote Title', dueDate: null, priority: 3 }
      const localFC: FieldClocks = {
        title: { deviceA: 1 },
        dueDate: {},
        priority: { deviceA: 1 }
      }
      const remoteFC: FieldClocks = {
        title: { deviceB: 1 },
        dueDate: {},
        priority: { deviceB: 1 }
      }

      // #when
      const result = mergeFields(local, remote, localFC, remoteFC, fields)

      // #then
      expect(result.hadConflicts).toBe(true)
      expect(result.conflictedFields).toContain('title')
      expect(result.conflictedFields).toContain('priority')
      expect(result.conflictedFields).toHaveLength(2)
    })
  })

  describe('mergeTaskFields', () => {
    it('uses all 15 task syncable fields', () => {
      expect(TASK_SYNCABLE_FIELDS).toHaveLength(15)
    })

    it('merges task with DeviceA offline status + DeviceB online dueDate', () => {
      // #given — the canonical Phase 8 scenario
      const local = {
        title: 'Buy groceries',
        description: null,
        projectId: 'proj1',
        statusId: 'done',
        parentId: null,
        priority: 0,
        position: 0,
        dueDate: '2026-01-01',
        dueTime: null,
        startDate: null,
        repeatConfig: null,
        repeatFrom: null,
        sourceNoteId: null,
        completedAt: '2026-02-20',
        archivedAt: null
      }
      const remote = {
        title: 'Buy groceries',
        description: null,
        projectId: 'proj1',
        statusId: 'todo',
        parentId: null,
        priority: 0,
        position: 0,
        dueDate: '2026-03-15',
        dueTime: null,
        startDate: null,
        repeatConfig: null,
        repeatFrom: null,
        sourceNoteId: null,
        completedAt: null,
        archivedAt: null
      }
      const baseClock: VectorClock = { deviceA: 1, deviceB: 1 }
      const localFC = initAllFieldClocks(baseClock, TASK_SYNCABLE_FIELDS)
      const remoteFC = initAllFieldClocks(baseClock, TASK_SYNCABLE_FIELDS)

      // DeviceA incremented statusId + completedAt
      localFC.statusId = { deviceA: 2, deviceB: 1 }
      localFC.completedAt = { deviceA: 2, deviceB: 1 }

      // DeviceB incremented dueDate
      remoteFC.dueDate = { deviceA: 1, deviceB: 2 }

      // #when
      const result = mergeTaskFields(local, remote, localFC, remoteFC)

      // #then — local statusId/completedAt preserved, remote dueDate preserved
      expect(result.merged.statusId).toBe('done')
      expect(result.merged.completedAt).toBe('2026-02-20')
      expect(result.merged.dueDate).toBe('2026-03-15')
      expect(result.hadConflicts).toBe(false)
    })
  })

  describe('mergeProjectFields', () => {
    it('uses all 8 project syncable fields', () => {
      expect(PROJECT_SYNCABLE_FIELDS).toHaveLength(8)
    })

    it('merges project name vs color changes from different devices', () => {
      // #given
      const local = {
        name: 'Renamed Project',
        description: null,
        color: '#6366f1',
        icon: null,
        position: 0,
        isInbox: false,
        archivedAt: null,
        modifiedAt: '2026-02-20T10:00:00Z'
      }
      const remote = {
        name: 'Old Name',
        description: null,
        color: '#ef4444',
        icon: null,
        position: 0,
        isInbox: false,
        archivedAt: null,
        modifiedAt: '2026-02-20T11:00:00Z'
      }
      const baseClock: VectorClock = { deviceA: 1 }
      const localFC = initAllFieldClocks(baseClock, PROJECT_SYNCABLE_FIELDS)
      const remoteFC = initAllFieldClocks(baseClock, PROJECT_SYNCABLE_FIELDS)

      localFC.name = { deviceA: 2 }
      remoteFC.color = { deviceA: 1, deviceB: 1 }
      remoteFC.modifiedAt = { deviceA: 1, deviceB: 1 }

      // #when
      const result = mergeProjectFields(local, remote, localFC, remoteFC)

      // #then — local name wins (sum 2 > 1), remote color wins (sum 2 > 1)
      expect(result.merged.name).toBe('Renamed Project')
      expect(result.merged.color).toBe('#ef4444')
      expect(result.hadConflicts).toBe(false)
    })
  })
})
