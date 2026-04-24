import { describe, it, expect } from 'vitest'

import { foldersRoutes } from './folders'

describe('foldersRoutes', () => {
  it('folders_list returns the three fixture folders matching notes data', async () => {
    const list = (await foldersRoutes.folders_list!(undefined)) as Array<{ id: string }>
    expect(list).toHaveLength(3)
    const ids = list.map((f) => f.id).sort()
    expect(ids).toEqual(['folder-1', 'folder-2', 'folder-3'])
  })

  it('folders_get returns the folder by id', async () => {
    const folder = (await foldersRoutes.folders_get!({ id: 'folder-1' })) as {
      id: string
      name: string
    }
    expect(folder.id).toBe('folder-1')
    expect(folder.name).toBe('Inbox')
  })

  it('folders_get rejects for unknown id', async () => {
    await expect(foldersRoutes.folders_get!({ id: 'folder-missing' })).rejects.toThrow(
      /not found/i
    )
  })

  it('folders_create adds a folder with generated id', async () => {
    const created = (await foldersRoutes.folders_create!({ name: 'New folder' })) as {
      id: string
      name: string
      createdAt: number
      updatedAt: number
    }
    expect(created.id).toMatch(/^folder-\d+/)
    expect(created.name).toBe('New folder')
    expect(created.createdAt).toBeGreaterThan(0)
  })

  it('folders_update mutates the folder in place', async () => {
    const updated = (await foldersRoutes.folders_update!({
      id: 'folder-2',
      name: 'Projects (renamed)'
    })) as { id: string; name: string; updatedAt: number }
    expect(updated.id).toBe('folder-2')
    expect(updated.name).toBe('Projects (renamed)')
    expect(updated.updatedAt).toBeGreaterThan(0)
  })

  it('folders_update rejects for unknown id', async () => {
    await expect(
      foldersRoutes.folders_update!({ id: 'folder-missing', name: 'x' })
    ).rejects.toThrow(/not found/i)
  })

  it('folders_delete removes the folder and returns ok', async () => {
    const created = (await foldersRoutes.folders_create!({ name: 'Doomed' })) as { id: string }
    const result = (await foldersRoutes.folders_delete!({ id: created.id })) as { ok: boolean }
    expect(result.ok).toBe(true)
    await expect(foldersRoutes.folders_get!({ id: created.id })).rejects.toThrow(/not found/i)
  })
})
