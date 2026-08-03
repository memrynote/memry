import { describe, it, expect, vi, beforeEach } from 'vitest'

const listProjectsByNames = vi.fn()
const listNoteProjectLinkIds = vi.fn()
const linkRows: { projectId: string; itemId: string }[] = []
const insertProjectLink = vi.fn((_db, row) => linkRows.push(row))
const deleteProjectLink = vi.fn((_db, projectId: string, _itemType: string, itemId: string) => {
  const index = linkRows.findIndex((row) => row.projectId === projectId && row.itemId === itemId)
  if (index >= 0) linkRows.splice(index, 1)
})
const syncProjectUpdate = vi.fn()

vi.mock('../../database', () => ({ getDatabase: () => ({}) }))
vi.mock('../../database/queries/projects', () => ({
  listProjectsByNames: (...a: unknown[]) => listProjectsByNames(...a),
  listNoteProjectLinkIds: (...a: unknown[]) => listNoteProjectLinkIds(...a),
  insertProjectLink: (...a: unknown[]) => insertProjectLink(...a),
  deleteProjectLink: (...a: unknown[]) => deleteProjectLink(...a)
}))
vi.mock('../../tasks/runtime-effects', () => ({
  syncProjectUpdate: (...a: unknown[]) => syncProjectUpdate(...a)
}))

const markdownEvent = (properties: Record<string, unknown>) => ({
  type: 'note.upserted' as const,
  note: {
    kind: 'markdown' as const,
    noteId: 'n1',
    properties
  } as never
})

describe('note-project-links projector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    linkRows.length = 0
  })

  it('inserts a link for a newly named project', async () => {
    listProjectsByNames.mockReturnValue([{ id: 'p1', name: 'Alpha', createdAt: '2026-01-01' }])
    listNoteProjectLinkIds.mockReturnValue([])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Alpha'] }))

    expect(linkRows).toEqual([expect.objectContaining({ projectId: 'p1', itemId: 'n1' })])
    expect(syncProjectUpdate).toHaveBeenCalledWith('p1', ['links'])
  })

  it('deletes a link whose project is no longer named', async () => {
    listProjectsByNames.mockReturnValue([])
    listNoteProjectLinkIds.mockReturnValue([{ id: 'l1', projectId: 'p1' }])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: [] }))

    expect(deleteProjectLink).toHaveBeenCalledWith({}, 'p1', 'note', 'n1')
    expect(syncProjectUpdate).toHaveBeenCalledWith('p1', ['links'])
  })

  it('leaves an unchanged link untouched so position and pinned survive', async () => {
    listProjectsByNames.mockReturnValue([{ id: 'p1', name: 'Alpha', createdAt: '2026-01-01' }])
    listNoteProjectLinkIds.mockReturnValue([{ id: 'l1', projectId: 'p1' }])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Alpha'] }))

    expect(insertProjectLink).not.toHaveBeenCalled()
    expect(deleteProjectLink).not.toHaveBeenCalled()
    expect(syncProjectUpdate).not.toHaveBeenCalled()
  })

  it('drops a name that resolves to no project without touching links', async () => {
    listProjectsByNames.mockReturnValue([])
    listNoteProjectLinkIds.mockReturnValue([])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Ghost'] }))

    expect(insertProjectLink).not.toHaveBeenCalled()
    expect(deleteProjectLink).not.toHaveBeenCalled()
    expect(syncProjectUpdate).not.toHaveBeenCalled()
  })

  it('resolves a duplicate name to the oldest project', async () => {
    listProjectsByNames.mockReturnValue([
      { id: 'old', name: 'Alpha', createdAt: '2026-01-01' },
      { id: 'new', name: 'alpha', createdAt: '2026-05-01' }
    ])
    listNoteProjectLinkIds.mockReturnValue([])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Alpha'] }))

    expect(linkRows).toEqual([expect.objectContaining({ projectId: 'old' })])
  })

  it('ignores a file note', async () => {
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project({
      type: 'note.upserted',
      note: { kind: 'file', noteId: 'f1' } as never
    })

    expect(listNoteProjectLinkIds).not.toHaveBeenCalled()
  })

  it('ignores a non-note.upserted event', async () => {
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project({ type: 'note.deleted', noteId: 'n1' })

    expect(listNoteProjectLinkIds).not.toHaveBeenCalled()
  })

  it('does not stall on a reconcile failure', async () => {
    listProjectsByNames.mockImplementation(() => {
      throw new Error('db exploded')
    })
    listNoteProjectLinkIds.mockReturnValue([])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await expect(
      createNoteProjectLinksProjector().project(markdownEvent({ project: ['Alpha'] }))
    ).resolves.toBeUndefined()
  })

  // Diffing (not delete-all-then-reinsert) is what preserves project_links'
  // position/pinned columns, which are hub state unrelated to the note's
  // frontmatter. A delete-and-reinsert implementation would call
  // deleteProjectLink + insertProjectLink here even though the desired set is
  // unchanged, which this assertion catches.
  it('does not delete and reinsert a link that is already correct', async () => {
    listProjectsByNames.mockReturnValue([
      { id: 'p1', name: 'Alpha', createdAt: '2026-01-01' },
      { id: 'p2', name: 'Beta', createdAt: '2026-01-01' }
    ])
    listNoteProjectLinkIds.mockReturnValue([
      { id: 'l1', projectId: 'p1' },
      { id: 'l2', projectId: 'p2' }
    ])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Alpha', 'Beta'] }))

    expect(insertProjectLink).not.toHaveBeenCalled()
    expect(deleteProjectLink).not.toHaveBeenCalled()
  })

  it('handles a mixed diff: keeps one link, drops one, adds one, in a single reconcile', async () => {
    listProjectsByNames.mockReturnValue([
      { id: 'p1', name: 'Alpha', createdAt: '2026-01-01' },
      { id: 'p3', name: 'Gamma', createdAt: '2026-01-01' }
    ])
    listNoteProjectLinkIds.mockReturnValue([
      { id: 'l1', projectId: 'p1' },
      { id: 'l2', projectId: 'p2' }
    ])
    const { createNoteProjectLinksProjector } = await import('./note-project-links-projector')

    await createNoteProjectLinksProjector().project(markdownEvent({ project: ['Alpha', 'Gamma'] }))

    expect(insertProjectLink).toHaveBeenCalledTimes(1)
    expect(insertProjectLink).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ projectId: 'p3', itemType: 'note', itemId: 'n1' })
    )
    expect(deleteProjectLink).toHaveBeenCalledTimes(1)
    expect(deleteProjectLink).toHaveBeenCalledWith({}, 'p2', 'note', 'n1')
    expect(syncProjectUpdate).toHaveBeenCalledWith('p3', ['links'])
    expect(syncProjectUpdate).toHaveBeenCalledWith('p2', ['links'])
    expect(syncProjectUpdate).not.toHaveBeenCalledWith('p1', ['links'])
  })
})
