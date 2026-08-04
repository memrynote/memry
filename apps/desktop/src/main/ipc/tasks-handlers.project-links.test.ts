import { describe, it, expect, vi, beforeEach } from 'vitest'
import { linkProjectItem, unlinkProjectItem } from './project-item-links'

const isMarkdownNote = vi.fn()
const getProjectById = vi.fn()
const setEntityProperties = vi.fn()
const getEntityPropertiesRecord = vi.fn()
const domainLink = vi.fn()
const domainUnlink = vi.fn()

vi.mock('../database/queries/projects', () => ({
  isMarkdownNote: (...a: unknown[]) => isMarkdownNote(...a),
  getProjectById: (...a: unknown[]) => getProjectById(...a)
}))
vi.mock('../notes/entity-properties', () => ({
  setEntityProperties: (...a: unknown[]) => setEntityProperties(...a),
  getEntityPropertiesRecord: (...a: unknown[]) => getEntityPropertiesRecord(...a)
}))

const domain = { linkItemToProject: domainLink, unlinkItemFromProject: domainUnlink }

describe('project item link reroute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setEntityProperties.mockResolvedValue({ success: true })
    getProjectById.mockReturnValue({ id: 'p1', name: 'Alpha' })
  })

  it('writes frontmatter for a markdown note instead of a link row', async () => {
    isMarkdownNote.mockReturnValue(true)
    getEntityPropertiesRecord.mockReturnValue({ project: ['Beta'] })

    const result = await linkProjectItem({} as never, domain as never, {
      projectId: 'p1',
      itemType: 'note',
      itemId: 'n1'
    })

    expect(result).toEqual({ success: true })
    expect(setEntityProperties).toHaveBeenCalledWith('n1', { project: ['Beta', 'Alpha'] })
    expect(domainLink).not.toHaveBeenCalled()
  })

  it('is a no-op when the note already names the project', async () => {
    isMarkdownNote.mockReturnValue(true)
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha'] })

    await linkProjectItem({} as never, domain as never, {
      projectId: 'p1',
      itemType: 'note',
      itemId: 'n1'
    })

    expect(setEntityProperties).toHaveBeenCalledWith('n1', { project: ['Alpha'] })
  })

  it('falls through to the domain for a file', async () => {
    isMarkdownNote.mockReturnValue(false)
    domainLink.mockResolvedValue({ success: true })

    await linkProjectItem({} as never, domain as never, {
      projectId: 'p1',
      itemType: 'file',
      itemId: 'f1'
    })

    expect(domainLink).toHaveBeenCalled()
    expect(setEntityProperties).not.toHaveBeenCalled()
  })

  it('removes the name from frontmatter on unlink', async () => {
    isMarkdownNote.mockReturnValue(true)
    getEntityPropertiesRecord.mockReturnValue({ project: ['Alpha', 'Beta'] })

    await unlinkProjectItem({} as never, domain as never, {
      projectId: 'p1',
      itemType: 'note',
      itemId: 'n1'
    })

    expect(setEntityProperties).toHaveBeenCalledWith('n1', { project: ['Beta'] })
  })

  it('errors when the project does not exist', async () => {
    isMarkdownNote.mockReturnValue(true)
    getProjectById.mockReturnValue(undefined)

    expect(
      await linkProjectItem({} as never, domain as never, {
        projectId: 'gone',
        itemType: 'note',
        itemId: 'n1'
      })
    ).toEqual({ success: false, error: 'Project not found' })
  })

  // The project-hub file-import closure always passes itemType: 'file', even
  // when the imported file is a markdown note — it has no way to know before
  // asking. These pin that `linkProjectItem` still keys off `isMarkdownNote`,
  // not the itemType it was called with, so an imported .md target gets
  // frontmatter instead of a link row the projector would delete right back.
  describe('an item linked with itemType "file" (the import-files closure)', () => {
    it('writes frontmatter when the imported file is actually a markdown note', async () => {
      isMarkdownNote.mockReturnValue(true)
      getEntityPropertiesRecord.mockReturnValue({ project: [] })

      const result = await linkProjectItem({} as never, domain as never, {
        projectId: 'p1',
        itemType: 'file',
        itemId: 'n1'
      })

      expect(result).toEqual({ success: true })
      expect(setEntityProperties).toHaveBeenCalledWith('n1', { project: ['Alpha'] })
      expect(domainLink).not.toHaveBeenCalled()
    })

    it('still writes the project_links row when the imported file is binary', async () => {
      isMarkdownNote.mockReturnValue(false)
      domainLink.mockResolvedValue({ success: true })

      const result = await linkProjectItem({} as never, domain as never, {
        projectId: 'p1',
        itemType: 'file',
        itemId: 'f1'
      })

      expect(result).toEqual({ success: true })
      expect(domainLink).toHaveBeenCalledWith({ projectId: 'p1', itemType: 'file', itemId: 'f1' })
      expect(setEntityProperties).not.toHaveBeenCalled()
    })
  })
})
