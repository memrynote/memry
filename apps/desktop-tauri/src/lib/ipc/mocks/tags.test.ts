import { describe, it, expect } from 'vitest'

import { tagsRoutes } from './tags'

describe('tagsRoutes', () => {
  it('tags_list returns at least 8 fixture tags', async () => {
    const list = (await tagsRoutes.tags_list!(undefined)) as Array<{ id: string; name: string }>
    expect(list.length).toBeGreaterThanOrEqual(8)
  })

  it('tags_get returns tag by id', async () => {
    const tag = (await tagsRoutes.tags_get!({ id: 'tag-1' })) as { id: string }
    expect(tag.id).toBe('tag-1')
  })

  it('tags_get rejects unknown id', async () => {
    await expect(tagsRoutes.tags_get!({ id: 'missing' })).rejects.toThrow(/not found/i)
  })

  it('tags_create adds a new tag', async () => {
    const created = (await tagsRoutes.tags_create!({ name: 'new-tag' })) as {
      id: string
      name: string
    }
    expect(created.id).toMatch(/^tag-\d+/)
    expect(created.name).toBe('new-tag')
  })

  it('tags_update renames the tag', async () => {
    const updated = (await tagsRoutes.tags_update!({
      id: 'tag-2',
      name: 'renamed'
    })) as { id: string; name: string }
    expect(updated.name).toBe('renamed')
  })

  it('tags_delete removes the tag', async () => {
    const created = (await tagsRoutes.tags_create!({ name: 'doomed' })) as { id: string }
    const result = (await tagsRoutes.tags_delete!({ id: created.id })) as { ok: boolean }
    expect(result.ok).toBe(true)
  })

  it('tags_by_note returns tags attached to a note', async () => {
    const list = (await tagsRoutes.tags_by_note!({ noteId: 'note-1' })) as Array<{ id: string }>
    expect(Array.isArray(list)).toBe(true)
  })
})
