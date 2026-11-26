/**
 * Verifier for `task-completion-spawn.json` (#3538).
 *
 * The committed JSON is the input. Each row's task is completed again through
 * the production `rollRepeatingSeries` over the domain's in-memory command
 * repository, under the UTC zone the file was generated in, and the closed
 * occurrence and the next one must equal the recorded ones. The next
 * occurrence's id is random (chapter 13 §13.7.3) and not recorded. The Rust core
 * runs the same file in `crates/memry-core/tests/task_completion_spawn_vectors.rs`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { rollRepeatingSeries } from '../../../domain-tasks/src/repeat-completion.ts'
import { createCommandRepository } from '../../../domain-tasks/src/test-fixtures.ts'
import type { Status, Task } from '../../../domain-tasks/src/types.ts'
import { loadVectorFile } from './vector-loader'

type LinkKey = 'tags' | 'linkedNoteIds' | 'linkedCanvasIds'

const vectors = loadVectorFile<{
  meta: { caseCount: number; timeZone: string }
  statuses: Status[]
  copiedFields: string[]
  cases: Array<{
    name: string
    tzSensitive: boolean
    task: Task
    completedAt: string
    expected: {
      closedRepeatConfig: unknown
      next: null | {
        dueDate: string
        statusId: string
        completedCount: number
        repeatConfig: unknown
        sourceNoteId: string | null
        copied: Record<string, unknown>
      }
    }
  }>
}>('task-completion-spawn.json')

const LINK_KEYS: LinkKey[] = ['tags', 'linkedNoteIds', 'linkedCanvasIds']

function roll(before: Task, completedAt: string, nextId: string) {
  const tasks = new Map<string, Task>([[before.id, structuredClone(before)]])
  const links = new Map<string, Record<LinkKey, string[]>>([
    [
      before.id,
      {
        tags: before.tags ?? [],
        linkedNoteIds: before.linkedNoteIds ?? [],
        linkedCanvasIds: before.linkedCanvasIds ?? []
      }
    ]
  ])
  const setLinks = (id: string, key: LinkKey, ids: string[]) => {
    const current = links.get(id)
    if (current) links.set(id, { ...current, [key]: ids })
  }
  const repository = createCommandRepository({
    listStatuses: () => vectors.statuses,
    updateTask: (id, updates) => {
      const task = tasks.get(id)
      if (!task) return undefined
      const next = { ...task, ...updates }
      tasks.set(id, next)
      return next
    },
    createTask: (task) => {
      tasks.set(task.id, task)
      links.set(task.id, { tags: [], linkedNoteIds: [], linkedCanvasIds: [] })
      return task
    },
    getTaskTags: (id) => links.get(id)?.tags ?? [],
    getTaskNoteIds: (id) => links.get(id)?.linkedNoteIds ?? [],
    getTaskCanvasIds: (id) => links.get(id)?.linkedCanvasIds ?? [],
    setTaskTags: (id, ids) => setLinks(id, 'tags', ids),
    setTaskNotes: (id, ids) => setLinks(id, 'linkedNoteIds', ids),
    setTaskCanvases: (id, ids) => setLinks(id, 'linkedCanvasIds', ids)
  })
  const result = rollRepeatingSeries(repository, () => nextId, before, completedAt)
  const next = result.nextOccurrence ? tasks.get(result.nextOccurrence.id) : undefined
  return { closed: tasks.get(before.id), result, next, links: next && links.get(next.id) }
}

describe('task-completion-spawn vectors', () => {
  let previousTz: string | undefined
  beforeAll(() => {
    previousTz = process.env.TZ
    process.env.TZ = vectors.meta.timeZone
  })
  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  })

  it('carries the recorded case count', () => {
    expect(vectors.cases.length).toBe(vectors.meta.caseCount)
  })

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { closed, result, next, links } = roll(c.task, c.completedAt, `next-${c.task.id}`)

    expect(closed?.repeatConfig ?? null).toEqual(c.expected.closedRepeatConfig)
    const stored = new Map<string, unknown>(Object.entries(next ?? {}))
    const spawned = result.nextOccurrence && {
      dueDate: result.nextOccurrence.dueDate,
      statusId: next?.statusId,
      completedCount: next?.repeatConfig?.completedCount ?? null,
      repeatConfig: next?.repeatConfig,
      sourceNoteId: next?.sourceNoteId ?? null,
      copied: Object.fromEntries(
        vectors.copiedFields.map((key) => {
          const linkKey = LINK_KEYS.find((k) => k === key)
          const value = linkKey ? links?.[linkKey] : stored.get(key)
          return [key, value ?? null]
        })
      )
    }
    expect(spawned).toEqual(c.expected.next)
  })
})
