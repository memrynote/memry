import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMarkdownNoteIdsForProject = vi.fn()
const getEntityPropertiesRecord = vi.fn()
const setEntityProperties = vi.fn()

vi.mock('../database/queries/projects', () => ({
  listMarkdownNoteIdsForProject: (...a: unknown[]) => listMarkdownNoteIdsForProject(...a)
}))
vi.mock('../notes/entity-properties', () => ({
  getEntityPropertiesRecord: (...a: unknown[]) => getEntityPropertiesRecord(...a),
  setEntityProperties: (...a: unknown[]) => setEntityProperties(...a)
}))

describe('project name propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setEntityProperties.mockResolvedValue({ success: true })
  })

  it('rewrites the old name in every linked note', async () => {
    listMarkdownNoteIdsForProject.mockReturnValue(['n1', 'n2'])
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha', 'Beta'], status: 'Done' })
    const { propagateProjectRename } = await import('./project-name-propagation')

    await propagateProjectRename({} as never, 'p1', 'Alpha', 'Alpha v2')

    expect(setEntityProperties).toHaveBeenCalledTimes(2)
    expect(setEntityProperties).toHaveBeenCalledWith('n1', {
      project: ['Alpha v2', 'Beta'],
      status: 'Done'
    })
  })

  it('does nothing when the name has not actually changed', async () => {
    const { propagateProjectRename } = await import('./project-name-propagation')

    await propagateProjectRename({} as never, 'p1', 'Alpha', 'Alpha')

    expect(listMarkdownNoteIdsForProject).not.toHaveBeenCalled()
    expect(setEntityProperties).not.toHaveBeenCalled()
  })

  it('removes the name on delete and keeps the others', async () => {
    listMarkdownNoteIdsForProject.mockReturnValue(['n1'])
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha', 'Beta'] })
    const { propagateProjectDelete } = await import('./project-name-propagation')

    await propagateProjectDelete({} as never, 'p1', 'Alpha')

    expect(setEntityProperties).toHaveBeenCalledWith('n1', { project: ['Beta'] })
  })

  it('uses explicit note ids when given, without looking them up', async () => {
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha'] })
    const { propagateProjectDelete } = await import('./project-name-propagation')

    await propagateProjectDelete({} as never, 'p1', 'Alpha', ['explicit-1'])

    expect(listMarkdownNoteIdsForProject).not.toHaveBeenCalled()
    expect(getEntityPropertiesRecord).toHaveBeenCalledWith('explicit-1')
    expect(setEntityProperties).toHaveBeenCalledWith('explicit-1', { project: [] })
  })

  it('skips a note whose frontmatter never named the project', async () => {
    listMarkdownNoteIdsForProject.mockReturnValue(['n1'])
    getEntityPropertiesRecord.mockReturnValue({ project: ['Beta'] })
    const { propagateProjectRename } = await import('./project-name-propagation')

    await propagateProjectRename({} as never, 'p1', 'Alpha', 'Alpha v2')

    expect(setEntityProperties).not.toHaveBeenCalled()
  })

  it('skips a note that no longer exists rather than throwing', async () => {
    listMarkdownNoteIdsForProject.mockReturnValue(['gone'])
    getEntityPropertiesRecord.mockReturnValue(null)
    const { propagateProjectDelete } = await import('./project-name-propagation')

    await propagateProjectDelete({} as never, 'p1', 'Alpha')

    expect(setEntityProperties).not.toHaveBeenCalled()
  })

  it('keeps going when one note fails to write', async () => {
    listMarkdownNoteIdsForProject.mockReturnValue(['n1', 'n2'])
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha'] })
    setEntityProperties.mockRejectedValueOnce(new Error('locked'))
    const { propagateProjectDelete } = await import('./project-name-propagation')

    await propagateProjectDelete({} as never, 'p1', 'Alpha')

    expect(setEntityProperties).toHaveBeenCalledTimes(2)
  })
})
