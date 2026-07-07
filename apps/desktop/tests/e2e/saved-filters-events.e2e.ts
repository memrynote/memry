import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'

// CRUD for saved filters is covered by tasks-kanban.e2e. This covers the untested
// half: the main->renderer IPC event fan-out (onSavedFilterCreated/Updated/Deleted)
// that renderer subscribers rely on, exercised end-to-end through real electron.
test.describe('Saved filter IPC events E2E', () => {
  test('create/update/delete emit their events to renderer subscribers', async ({ page }) => {
    await ready(page)

    const filterName = `Events ${Date.now()}`

    const result = await page.evaluate(async (name) => {
      const api = window.api
      const tick = () => new Promise((resolve) => setTimeout(resolve, 150))

      const created: Array<{ savedFilter: { id: string; name: string } }> = []
      const updated: Array<{ id: string; savedFilter: { name: string } }> = []
      const deleted: Array<{ id: string }> = []

      const offCreated = api.onSavedFilterCreated((e) => created.push(e as never))
      const offUpdated = api.onSavedFilterUpdated((e) => updated.push(e as never))
      const offDeleted = api.onSavedFilterDeleted((e) => deleted.push(e as never))

      const createRes = await api.savedFilters.create({
        name,
        config: {
          filters: {
            search: '',
            projectIds: [],
            priorities: [],
            dueDate: { type: 'any', customStart: null, customEnd: null },
            statusIds: [],
            completion: 'all',
            repeatType: 'all',
            hasTime: 'all'
          },
          sort: { field: 'priority', direction: 'desc' },
          starred: false
        }
      })
      if (!createRes.success || !createRes.savedFilter) {
        throw new Error(createRes.error ?? 'create failed')
      }
      const id = createRes.savedFilter.id
      await tick()

      await api.savedFilters.update({ id, name: `${name} Updated` })
      await tick()

      await api.savedFilters.delete(id)
      await tick()

      offCreated()
      offUpdated()
      offDeleted()

      return { id, created, updated, deleted }
    }, filterName)

    // created event carries the new filter
    expect(result.created.map((e) => e.savedFilter.name)).toContain(filterName)

    // updated event carries the id and new name
    expect(result.updated).toContainEqual(
      expect.objectContaining({
        id: result.id,
        savedFilter: expect.objectContaining({ name: `${filterName} Updated` })
      })
    )

    // deleted event carries the id
    expect(result.deleted).toContainEqual(expect.objectContaining({ id: result.id }))
  })
})
