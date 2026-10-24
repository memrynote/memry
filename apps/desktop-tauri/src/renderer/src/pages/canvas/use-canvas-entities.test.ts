import { renderHook, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasEntities, entityKey } from './use-canvas-entities'
import type { CanvasCardRef } from './canvas-cards'
import type { CanvasEntityType } from '@memry/contracts/canvas-api'

const mocks = vi.hoisted(() => ({
  notesGet: vi.fn(),
  tasksGet: vi.fn(),
  calGet: vi.fn(),
  fileGet: vi.fn(),
  listProjects: vi.fn(),
  cb: {
    noteUpdated: null as ((e: { id: string }) => void) | null,
    noteRenamed: null as ((e: { id: string }) => void) | null,
    noteDeleted: null as ((e: { id: string }) => void) | null,
    noteMoved: null as ((e: { id: string }) => void) | null,
    taskCreated: null as (() => void) | null,
    taskMoved: null as (() => void) | null,
    projectUpdated: null as ((e: { id: string }) => void) | null,
    projectDeleted: null as ((e: { id: string }) => void) | null,
    taskUpdated: null as ((e: { id: string }) => void) | null,
    taskCompleted: null as ((e: { id: string }) => void) | null,
    taskDeleted: null as ((e: { id: string }) => void) | null,
    calChanged: null as ((e: { entityType: string; id: string }) => void) | null
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    get: (id: string) => mocks.notesGet(id),
    getFile: (id: string) => mocks.fileGet(id)
  },
  onNoteMoved: (cb: (e: { id: string }) => void) => {
    mocks.cb.noteMoved = cb
    return () => {}
  },
  onNoteUpdated: (cb: (e: { id: string }) => void) => {
    mocks.cb.noteUpdated = cb
    return () => {}
  },
  onNoteRenamed: (cb: (e: { id: string }) => void) => {
    mocks.cb.noteRenamed = cb
    return () => {}
  },
  onNoteDeleted: (cb: (e: { id: string }) => void) => {
    mocks.cb.noteDeleted = cb
    return () => {}
  }
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    get: (id: string) => mocks.tasksGet(id),
    listProjects: () => mocks.listProjects()
  },
  onTaskCreated: (cb: () => void) => {
    mocks.cb.taskCreated = cb
    return () => {}
  },
  onTaskMoved: (cb: () => void) => {
    mocks.cb.taskMoved = cb
    return () => {}
  },
  onProjectUpdated: (cb: (e: { id: string }) => void) => {
    mocks.cb.projectUpdated = cb
    return () => {}
  },
  onProjectDeleted: (cb: (e: { id: string }) => void) => {
    mocks.cb.projectDeleted = cb
    return () => {}
  },
  onTaskUpdated: (cb: (e: { id: string }) => void) => {
    mocks.cb.taskUpdated = cb
    return () => {}
  },
  onTaskCompleted: (cb: (e: { id: string }) => void) => {
    mocks.cb.taskCompleted = cb
    return () => {}
  },
  onTaskDeleted: (cb: (e: { id: string }) => void) => {
    mocks.cb.taskDeleted = cb
    return () => {}
  }
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: { getEvent: (id: string) => mocks.calGet(id) },
  onCalendarChanged: (cb: (e: { entityType: string; id: string }) => void) => {
    mocks.cb.calChanged = cb
    return () => {}
  }
}))

function ref(entityType: CanvasEntityType, entityId: string): CanvasCardRef {
  return {
    elementId: `${entityType}-${entityId}`,
    entityType,
    entityId,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    angle: 0
  }
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Launch',
    color: '#3366ff',
    description: 'Ship v2',
    archivedAt: null,
    taskCount: 4,
    completedCount: 1,
    overdueCount: 0,
    ...overrides
  }
}

function file(overrides: { id: string; title: string; path: string }) {
  return {
    ...overrides,
    absolutePath: `/vault/${overrides.path}`,
    fileType: 'pdf',
    mimeType: 'application/pdf',
    fileSize: 2048
  }
}

describe('useCanvasEntities', () => {
  beforeEach(() => {
    mocks.notesGet.mockReset()
    mocks.tasksGet.mockReset()
    mocks.calGet.mockReset()
    mocks.fileGet.mockReset()
    mocks.listProjects.mockReset()
  })

  it('loads note, task, and event entities into a keyed map', async () => {
    mocks.notesGet.mockResolvedValue({ title: 'Note A', emoji: '📄', content: 'body' })
    mocks.tasksGet.mockResolvedValue({
      title: 'Task A',
      completedAt: null,
      dueDate: '2026-07-20',
      archivedAt: null
    })
    mocks.calGet.mockResolvedValue({
      title: 'Event A',
      startAt: '2026-07-20T10:00:00Z',
      endAt: null,
      isAllDay: false,
      archivedAt: null
    })

    const refs = [ref('note', 'n1'), ref('task', 't1'), ref('calendar_event', 'ev1')]
    const { result } = renderHook(() => useCanvasEntities(refs))

    await waitFor(() => {
      expect(result.current.get(entityKey('note', 'n1'))).toMatchObject({
        status: 'ready',
        kind: 'note',
        title: 'Note A'
      })
      expect(result.current.get(entityKey('task', 't1'))).toMatchObject({
        kind: 'task',
        completed: false,
        dueDate: '2026-07-20'
      })
      expect(result.current.get(entityKey('calendar_event', 'ev1'))).toMatchObject({
        kind: 'calendar_event',
        title: 'Event A'
      })
    })
  })

  it('marks missing or archived entities as dangling', async () => {
    mocks.notesGet.mockResolvedValue(null)
    mocks.tasksGet.mockResolvedValue({
      title: 'x',
      completedAt: null,
      dueDate: null,
      archivedAt: '2026-01-01'
    })

    const { result } = renderHook(() => useCanvasEntities([ref('note', 'n1'), ref('task', 't1')]))
    await waitFor(() => {
      expect(result.current.get(entityKey('note', 'n1'))).toEqual({ status: 'dangling' })
      expect(result.current.get(entityKey('task', 't1'))).toEqual({ status: 'dangling' })
    })
  })

  it('refetches a held entity when its update event fires', async () => {
    mocks.notesGet.mockResolvedValue({ title: 'Before', emoji: null, content: '' })
    const { result } = renderHook(() => useCanvasEntities([ref('note', 'n1')]))
    await waitFor(() => {
      expect(result.current.get(entityKey('note', 'n1'))).toMatchObject({ title: 'Before' })
    })

    mocks.notesGet.mockResolvedValue({ title: 'After', emoji: null, content: '' })
    act(() => mocks.cb.noteUpdated?.({ id: 'n1' }))
    await waitFor(() => {
      expect(result.current.get(entityKey('note', 'n1'))).toMatchObject({ title: 'After' })
    })
    // Two fetches: initial + event.
    expect(mocks.notesGet).toHaveBeenCalledTimes(2)
  })

  it('ignores events for entities it does not hold', async () => {
    mocks.notesGet.mockResolvedValue({ title: 'A', emoji: null, content: '' })
    renderHook(() => useCanvasEntities([ref('note', 'n1')]))
    await waitFor(() => expect(mocks.notesGet).toHaveBeenCalledTimes(1))

    act(() => mocks.cb.noteUpdated?.({ id: 'other' }))
    // No extra fetch for an unheld entity.
    expect(mocks.notesGet).toHaveBeenCalledTimes(1)
  })

  it('flips to dangling on a delete event', async () => {
    mocks.tasksGet.mockResolvedValue({
      title: 'A',
      completedAt: null,
      dueDate: null,
      archivedAt: null
    })
    const { result } = renderHook(() => useCanvasEntities([ref('task', 't1')]))
    await waitFor(() =>
      expect(result.current.get(entityKey('task', 't1'))).toMatchObject({ kind: 'task' })
    )

    act(() => mocks.cb.taskDeleted?.({ id: 't1' }))
    await waitFor(() =>
      expect(result.current.get(entityKey('task', 't1'))).toEqual({ status: 'dangling' })
    )
  })

  it('loads a project with its task counts and a filed file with its metadata', async () => {
    mocks.listProjects.mockResolvedValue({ projects: [project({ id: 'p1', name: 'Launch' })] })
    mocks.fileGet.mockResolvedValue(file({ id: 'f1', title: 'Brief', path: 'Docs/Brief.pdf' }))

    const { result } = renderHook(() =>
      useCanvasEntities([ref('project', 'p1'), ref('file', 'f1')])
    )

    await waitFor(() => {
      expect(result.current.get(entityKey('project', 'p1'))).toEqual({
        status: 'ready',
        kind: 'project',
        title: 'Launch',
        color: '#3366ff',
        description: 'Ship v2',
        taskCount: 4,
        completedCount: 1,
        overdueCount: 0
      })
      expect(result.current.get(entityKey('file', 'f1'))).toEqual({
        status: 'ready',
        kind: 'file',
        title: 'Brief',
        fileType: 'pdf',
        path: 'Docs/Brief.pdf',
        absolutePath: '/vault/Docs/Brief.pdf',
        fileSize: 2048
      })
    })
  })

  it('dangles a project that is gone or archived, and a file that no longer resolves', async () => {
    mocks.listProjects.mockResolvedValue({
      projects: [project({ id: 'p2', archivedAt: '2026-01-01' })]
    })
    mocks.fileGet.mockResolvedValue(null)

    const { result } = renderHook(() =>
      useCanvasEntities([ref('project', 'p1'), ref('project', 'p2'), ref('file', 'f1')])
    )

    await waitFor(() => {
      expect(result.current.get(entityKey('project', 'p1'))).toEqual({ status: 'dangling' })
      expect(result.current.get(entityKey('project', 'p2'))).toEqual({ status: 'dangling' })
      expect(result.current.get(entityKey('file', 'f1'))).toEqual({ status: 'dangling' })
    })
  })

  it('follows a file through rename and move, then dangles it on delete', async () => {
    mocks.fileGet.mockResolvedValue(file({ id: 'f1', title: 'Brief', path: 'Docs/Brief.pdf' }))
    const { result } = renderHook(() => useCanvasEntities([ref('file', 'f1')]))
    await waitFor(() =>
      expect(result.current.get(entityKey('file', 'f1'))).toMatchObject({ title: 'Brief' })
    )

    mocks.fileGet.mockResolvedValue(file({ id: 'f1', title: 'Final', path: 'Docs/Final.pdf' }))
    act(() => mocks.cb.noteRenamed?.({ id: 'f1' }))
    await waitFor(() =>
      expect(result.current.get(entityKey('file', 'f1'))).toMatchObject({ title: 'Final' })
    )

    mocks.fileGet.mockResolvedValue(file({ id: 'f1', title: 'Final', path: 'Archive/Final.pdf' }))
    act(() => mocks.cb.noteMoved?.({ id: 'f1' }))
    await waitFor(() =>
      expect(result.current.get(entityKey('file', 'f1'))).toMatchObject({
        path: 'Archive/Final.pdf'
      })
    )

    act(() => mocks.cb.noteDeleted?.({ id: 'f1' }))
    await waitFor(() =>
      expect(result.current.get(entityKey('file', 'f1'))).toEqual({ status: 'dangling' })
    )
  })

  it('rereads project counts when a task changes, and dangles the project on delete', async () => {
    mocks.listProjects.mockResolvedValue({ projects: [project({ id: 'p1' })] })
    const { result } = renderHook(() => useCanvasEntities([ref('project', 'p1')]))
    await waitFor(() =>
      expect(result.current.get(entityKey('project', 'p1'))).toMatchObject({ completedCount: 1 })
    )

    mocks.listProjects.mockResolvedValue({
      projects: [project({ id: 'p1', completedCount: 2 })]
    })
    act(() => mocks.cb.taskCompleted?.({ id: 'some-task' }))
    await waitFor(() =>
      expect(result.current.get(entityKey('project', 'p1'))).toMatchObject({ completedCount: 2 })
    )

    mocks.listProjects.mockResolvedValue({
      projects: [project({ id: 'p1', name: 'Renamed', completedCount: 2 })]
    })
    act(() => mocks.cb.projectUpdated?.({ id: 'p1' }))
    await waitFor(() =>
      expect(result.current.get(entityKey('project', 'p1'))).toMatchObject({ title: 'Renamed' })
    )

    act(() => mocks.cb.projectDeleted?.({ id: 'p1' }))
    await waitFor(() =>
      expect(result.current.get(entityKey('project', 'p1'))).toEqual({ status: 'dangling' })
    )
  })

  it('prunes entities whose cards scroll out of view', async () => {
    mocks.notesGet.mockResolvedValue({ title: 'A', emoji: null, content: '' })
    const { result, rerender } = renderHook(({ refs }) => useCanvasEntities(refs), {
      initialProps: { refs: [ref('note', 'n1')] }
    })
    await waitFor(() => expect(result.current.has(entityKey('note', 'n1'))).toBe(true))

    rerender({ refs: [] })
    await waitFor(() => expect(result.current.has(entityKey('note', 'n1'))).toBe(false))
  })
})
