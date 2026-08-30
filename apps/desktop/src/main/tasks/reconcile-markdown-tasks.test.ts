import { describe, expect, it, vi } from 'vitest'
import {
  reconcileTaskCheckboxesFromMarkdown,
  type ReconcileTaskCheckboxesDeps
} from './reconcile-markdown-tasks'

type Row = { completedAt: string | null }

function makeDeps(rows: Record<string, Row | undefined>) {
  const complete = vi.fn(async () => ({ success: true }))
  const uncomplete = vi.fn(async () => ({ success: true }))
  const deps: ReconcileTaskCheckboxesDeps = {
    db: {} as ReconcileTaskCheckboxesDeps['db'],
    getTask: (_db, id) => rows[id],
    complete: (_db, id) => complete(id),
    uncomplete: (_db, id) => uncomplete(id)
  }
  return { deps, complete, uncomplete }
}

describe('reconcileTaskCheckboxesFromMarkdown', () => {
  it('completes a task the markdown marks as [x]', async () => {
    const { deps, complete, uncomplete } = makeDeps({ a1: { completedAt: null } })

    const changed = await reconcileTaskCheckboxesFromMarkdown('- [x] Buy milk {task:a1}', deps)

    expect(changed).toBe(1)
    expect(complete).toHaveBeenCalledWith('a1')
    expect(uncomplete).not.toHaveBeenCalled()
  })

  it('reopens a task the markdown marks as [ ]', async () => {
    const { deps, complete, uncomplete } = makeDeps({ a1: { completedAt: '2026-08-01T00:00:00Z' } })

    const changed = await reconcileTaskCheckboxesFromMarkdown('- [ ] Buy milk {task:a1}', deps)

    expect(changed).toBe(1)
    expect(uncomplete).toHaveBeenCalledWith('a1')
    expect(complete).not.toHaveBeenCalled()
  })

  it('is a no-op when markdown and database already agree', async () => {
    const { deps, complete, uncomplete } = makeDeps({
      a1: { completedAt: null },
      b2: { completedAt: '2026-08-01T00:00:00Z' }
    })

    const changed = await reconcileTaskCheckboxesFromMarkdown(
      ['- [ ] Open {task:a1}', '- [x] Done {task:b2}'].join('\n'),
      deps
    )

    expect(changed).toBe(0)
    expect(complete).not.toHaveBeenCalled()
    expect(uncomplete).not.toHaveBeenCalled()
  })

  it('skips task ids with no row (deleted or foreign task)', async () => {
    const { deps, complete } = makeDeps({})

    expect(await reconcileTaskCheckboxesFromMarkdown('- [x] Ghost {task:gone}', deps)).toBe(0)
    expect(complete).not.toHaveBeenCalled()
  })

  it('keeps going when one task fails to update', async () => {
    const { deps } = makeDeps({ a1: { completedAt: null }, b2: { completedAt: null } })
    deps.complete = vi.fn(async (_db, id) => {
      if (id === 'a1') throw new Error('locked')
      return { success: true }
    })

    const changed = await reconcileTaskCheckboxesFromMarkdown(
      ['- [x] First {task:a1}', '- [x] Second {task:b2}'].join('\n'),
      deps
    )

    expect(changed).toBe(1)
  })

  // #1907 — the two shapes an imported Obsidian vault produces.
  it('ignores checkbox lines that carry no {task:} suffix', async () => {
    const { deps, complete, uncomplete } = makeDeps({})
    const getTask = vi.fn(deps.getTask)
    deps.getTask = getTask

    const changed = await reconcileTaskCheckboxesFromMarkdown(
      [
        '## Groceries',
        '- [ ] Buy milk 2026-09-01',
        '- [x] Call the plumber',
        '* [ ] Renew passport',
        '+ [X] Book the flights'
      ].join('\n'),
      deps
    )

    // Nothing here names a task, so nothing is looked up and nothing is written.
    expect(changed).toBe(0)
    expect(getTask).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(uncomplete).not.toHaveBeenCalled()
  })

  it('leaves a task row untouched when the suffix resolves to no row', async () => {
    // A vault copied between installs: the id is well-formed but local to the
    // install that wrote it.
    const { deps, complete, uncomplete } = makeDeps({ a1: { completedAt: null } })

    const changed = await reconcileTaskCheckboxesFromMarkdown(
      ['- [x] Buy milk {task:from-another-install}', '- [x] Call the plumber {task:a1}'].join('\n'),
      deps
    )

    // The resolvable line still reconciles; the unresolvable one is skipped
    // without touching any row. The renderer is what stops it presenting as a
    // task (see unresolved-task-affordances.test.tsx).
    expect(changed).toBe(1)
    expect(complete).toHaveBeenCalledWith('a1')
    expect(complete).not.toHaveBeenCalledWith('from-another-install')
    expect(uncomplete).not.toHaveBeenCalled()
  })

  it('does nothing without a database', async () => {
    expect(await reconcileTaskCheckboxesFromMarkdown('- [x] Buy milk {task:a1}', null)).toBe(0)
  })
})
