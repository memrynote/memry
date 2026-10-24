import { describe, it, expect, vi } from 'vitest'
import { linkSidebarItemToProject } from './link-sidebar-item-to-project'
import { MEMRY_NOTE_DRAG_MIME } from './drag-mime'

const dt = (mime: string | null, id: string): Pick<DataTransfer, 'getData' | 'types'> => ({
  types: mime ? [mime] : [],
  getData: (type: string) => (type === mime ? id : '')
})

describe('linkSidebarItemToProject', () => {
  it('#then links a markdown note as itemType note', async () => {
    const getFile = vi.fn().mockResolvedValue(null)
    const link = vi.fn().mockResolvedValue({ success: true })

    const result = await linkSidebarItemToProject(dt(MEMRY_NOTE_DRAG_MIME, 'n1'), 'p1', {
      getFile,
      link
    })

    expect(link).toHaveBeenCalledWith({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(result).toEqual({ itemType: 'note', itemId: 'n1' })
  })

  it('#then links a file (getFile non-null) as itemType file', async () => {
    const getFile = vi.fn().mockResolvedValue({ id: 'f1' })
    const link = vi.fn().mockResolvedValue({ success: true })

    const result = await linkSidebarItemToProject(dt(MEMRY_NOTE_DRAG_MIME, 'f1'), 'p1', {
      getFile,
      link
    })

    expect(link).toHaveBeenCalledWith({ projectId: 'p1', itemType: 'file', itemId: 'f1' })
    expect(result).toEqual({ itemType: 'file', itemId: 'f1' })
  })

  it('#then no-ops when the drag carries no note MIME', async () => {
    const getFile = vi.fn()
    const link = vi.fn()

    const result = await linkSidebarItemToProject(dt(null, ''), 'p1', { getFile, link })

    expect(result).toBeNull()
    expect(getFile).not.toHaveBeenCalled()
    expect(link).not.toHaveBeenCalled()
  })

  it('#then throws when link fails', async () => {
    const getFile = vi.fn().mockResolvedValue(null)
    const link = vi.fn().mockResolvedValue({ success: false, error: 'boom' })

    await expect(
      linkSidebarItemToProject(dt(MEMRY_NOTE_DRAG_MIME, 'n1'), 'p1', { getFile, link })
    ).rejects.toThrow('boom')
  })
})
