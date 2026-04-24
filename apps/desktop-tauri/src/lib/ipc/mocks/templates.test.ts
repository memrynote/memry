import { describe, it, expect } from 'vitest'

import { templatesRoutes } from './templates'

describe('templatesRoutes', () => {
  it('templates_list returns at least 5 fixture templates', async () => {
    const list = (await templatesRoutes.templates_list!(undefined)) as Array<{ id: string }>
    expect(list.length).toBeGreaterThanOrEqual(5)
  })

  it('templates_get returns template by id', async () => {
    const tpl = (await templatesRoutes.templates_get!({ id: 'template-1' })) as { id: string }
    expect(tpl.id).toBe('template-1')
  })

  it('templates_get rejects unknown id', async () => {
    await expect(templatesRoutes.templates_get!({ id: 'missing' })).rejects.toThrow(/not found/i)
  })

  it('templates_create adds a new template', async () => {
    const created = (await templatesRoutes.templates_create!({
      name: 'New template',
      body: 'Template body'
    })) as { id: string; name: string }
    expect(created.id).toMatch(/^template-\d+/)
    expect(created.name).toBe('New template')
  })

  it('templates_update mutates the template', async () => {
    const updated = (await templatesRoutes.templates_update!({
      id: 'template-2',
      name: 'Renamed'
    })) as { name: string }
    expect(updated.name).toBe('Renamed')
  })

  it('templates_delete removes the template', async () => {
    const created = (await templatesRoutes.templates_create!({
      name: 'Doomed',
      body: 'x'
    })) as { id: string }
    const result = (await templatesRoutes.templates_delete!({ id: created.id })) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
  })

  it('templates_apply returns a synthesized note payload from the template', async () => {
    const applied = (await templatesRoutes.templates_apply!({
      id: 'template-1',
      variables: { project: 'Memry' }
    })) as { title: string; body: string }
    expect(typeof applied.title).toBe('string')
    expect(typeof applied.body).toBe('string')
  })
})
