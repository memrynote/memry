import { describe, expect, it } from 'vitest'

import { seedDateOnly } from './date'
import { NOTE_IDS } from './notes'
import { PROJECT_IDS, PROJECTS, STATUSES, TASK_NOTES, TASK_TAGS, TASKS } from './tasks'

describe('tasks seed data', () => {
  it('includes a consumer-facing Istanbul project that showcases task features', () => {
    const today = seedDateOnly(0)
    const project = PROJECTS.find((candidate) => candidate.name === 'Istanbul Weekend')

    expect(project).toBeDefined()
    expect(project?.id).toBe(PROJECT_IDS.istanbulWeekend)
    expect(project?.description).toContain('three-day Istanbul weekend')
    expect(project?.icon).toBe('🌉')

    const statuses = STATUSES.filter((status) => status.projectId === project?.id)
    expect(statuses.map((status) => status.name)).toEqual(['Plan', 'Booked', 'Today', 'Done'])
    expect(statuses.some((status) => status.isDefault)).toBe(true)
    expect(statuses.some((status) => status.isDone)).toBe(true)

    const tasks = TASKS.filter((task) => task.projectId === project?.id)
    expect(tasks).toHaveLength(9)
    expect(tasks.some((task) => task.dueDate === today && task.dueTime)).toBe(true)
    expect(tasks.some((task) => task.priority === 3)).toBe(true)
    expect(tasks.some((task) => task.completedAt)).toBe(true)
    expect(tasks.some((task) => task.repeatConfig)).toBe(true)

    const parent = tasks.find((task) => task.title === 'Plan Istanbul weekend')
    expect(parent).toBeDefined()
    expect(tasks.filter((task) => task.parentId === parent?.id)).toHaveLength(3)

    const taskIds = new Set(tasks.map((task) => task.id))
    const linkedNoteIds = TASK_NOTES.filter((link) => taskIds.has(link.taskId)).map(
      (link) => link.noteId
    )
    expect(linkedNoteIds).toEqual(
      expect.arrayContaining([
        NOTE_IDS.travelIstanbul,
        NOTE_IDS.travelPackingList,
        NOTE_IDS.weightFoodDiary
      ])
    )

    const tags = TASK_TAGS.filter((tag) => taskIds.has(tag.taskId)).map((tag) => tag.tag)
    expect(tags).toEqual(expect.arrayContaining(['travel', 'istanbul', 'planning']))

    const text = tasks.flatMap((task) => [task.title, task.description ?? '']).join(' ')
    for (const technicalTerm of [
      'CRDT',
      'IPC',
      'PR',
      'Memry',
      'Drizzle',
      'seed data',
      'renderer',
      'database'
    ]) {
      expect(text).not.toContain(technicalTerm)
    }
  })
})
