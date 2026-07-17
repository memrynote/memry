import { Hono } from 'hono'
import { describe, it, expect } from 'vitest'
import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import type { AppContext } from '../types'
import { syncTypesMiddleware } from './sync-types'

const createApp = () => {
  const app = new Hono<AppContext>()
  app.use('*', syncTypesMiddleware)
  app.get('/probe', (c) => c.json({ syncTypes: c.get('syncTypes') }))
  return app
}

describe('syncTypesMiddleware', () => {
  it('sets the frozen legacy list when no header is sent', async () => {
    // #when
    const res = await createApp().request('/probe', { method: 'GET' })

    // #then
    const json = (await res.json()) as { syncTypes: string[] }
    expect(json.syncTypes).toEqual([...LEGACY_RECORD_SYNC_ITEM_TYPES])
  })

  it('sets the declared types when the header is sent', async () => {
    // #when
    const res = await createApp().request('/probe', {
      method: 'GET',
      headers: { 'X-Memry-Sync-Types': 'note,task' }
    })

    // #then
    const json = (await res.json()) as { syncTypes: string[] }
    expect(json.syncTypes).toEqual(['note', 'task'])
  })
})
