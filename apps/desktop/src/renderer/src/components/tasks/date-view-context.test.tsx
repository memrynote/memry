import { describe, it, expect, vi } from 'vitest'
import { render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { createDefaultTask, type Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import {
  DateViewContext,
  TaskPathTitle,
  nestUnlisted,
  useDateViewValue,
  type DateViewValue
} from './date-view-context'

const task = (id: string, parentId: string | null = null): Task => ({
  ...createDefaultTask('project-1', 'todo', id),
  id,
  title: id,
  parentId
})

const projects = [{ id: 'project-1', name: 'Website relaunch' }] as Project[]

const pathsFor = (tasks: Task[]): DateViewValue =>
  renderHook(() => useDateViewValue(tasks, projects, vi.fn())).result.current

describe('useDateViewValue', () => {
  const tasks = [
    task('Launch checklist'),
    task('Content migration', 'Launch checklist'),
    task('Case studies', 'Content migration'),
    task('Acme case study', 'Case studies')
  ]
  const byId = (id: string): Task => tasks.find((t) => t.id === id)!

  it('has no path for a top-level task', () => {
    expect(pathsFor(tasks).pathOf(byId('Launch checklist'))).toBeNull()
  })

  it('lists the project and every task above up to two levels', () => {
    expect(pathsFor(tasks).pathOf(byId('Case studies'))).toEqual([
      'Website relaunch',
      'Launch checklist',
      'Content migration'
    ])
  })

  it('folds a deeper path to the project and the direct parent', () => {
    expect(pathsFor(tasks).pathOf(byId('Acme case study'))).toEqual([
      'Website relaunch',
      '…',
      'Case studies'
    ])
  })
})

describe('TaskPathTitle', () => {
  it('opens the path without clicking the row', async () => {
    const subtask = task('Pricing page copy', 'Launch checklist')
    const openPath = vi.fn()
    const onRowClick = vi.fn()
    const value: DateViewValue = { tasks: [], pathOf: () => null, openPath }
    render(
      <DateViewContext.Provider value={value}>
        <div onClick={onRowClick}>
          <TaskPathTitle task={subtask} path={['Website relaunch', 'Launch checklist']}>
            <span>{subtask.title}</span>
          </TaskPathTitle>
        </div>
      </DateViewContext.Provider>
    )

    await userEvent.click(screen.getByTestId('task-path'))

    expect(screen.getByTestId('task-path')).toHaveTextContent('Website relaunch › Launch checklist')
    expect(openPath).toHaveBeenCalledWith(subtask)
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe('nestUnlisted', () => {
  it('drops listed rows from every branch, at any depth', () => {
    const withChildren = (t: Task, subtaskIds: string[]): Task => ({ ...t, subtaskIds })
    const nested = nestUnlisted(
      [
        withChildren(task('parent'), ['child', 'undated']),
        withChildren(task('child', 'parent'), ['grandchild']),
        withChildren(task('undated', 'parent'), ['deep']),
        task('grandchild', 'child'),
        task('deep', 'undated')
      ],
      new Set(['parent', 'child', 'grandchild', 'deep'])
    )

    expect(Object.fromEntries(nested.map((t) => [t.id, t.subtaskIds]))).toEqual({
      parent: ['undated'],
      child: [],
      undated: [],
      grandchild: [],
      deep: []
    })
  })
})
