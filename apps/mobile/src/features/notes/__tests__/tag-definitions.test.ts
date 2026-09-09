import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readTagColors, writeTagColorRow } from '@/features/notes/tag-definitions'

import { openTestVault, type TestVault } from './vault-db-harness'

interface StoredRow {
  id: string
  payload: string
}

function seedTagDefinition(vault: TestVault, id: string, payload: Record<string, unknown>): void {
  void vault.db.runAsync(
    `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload)
     VALUES (?, 'tag_definition', 'vault-1', ?, 'full', ?)`,
    [id, 1_700_000_000_000, JSON.stringify(payload)]
  )
}

function tagRows(vault: TestVault): Promise<StoredRow[]> {
  return vault.db.getAllAsync<StoredRow>(
    `SELECT id, payload FROM sync_items WHERE type = 'tag_definition' ORDER BY id ASC`
  )
}

describe('writeTagColorRow', () => {
  let vault: TestVault

  beforeEach(() => {
    vault = openTestVault()
  })

  afterEach(() => {
    vault.close()
  })

  it('stores the colour as authored and queues the row', async () => {
    await writeTagColorRow(vault.ctx, 'roadmap', 'indigo')

    const rows = await tagRows(vault)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      name: 'roadmap',
      color: 'indigo',
      colorAuthored: true
    })

    const queued = vault.outboxRows()
    expect(queued).toHaveLength(1)
    expect(queued[0].itemType).toBe('tag_definition:update')
    expect(queued[0].itemId).toBe('roadmap')
    expect(queued[0].payload).toMatchObject({
      color: 'indigo',
      colorAuthored: true,
      clock: { 'device-a': 1 }
    })
  })

  it('writes under the casing it was given when no row exists', async () => {
    await writeTagColorRow(vault.ctx, 'Roadmap', '#ff8800')

    const rows = await tagRows(vault)
    expect(rows.map((row) => row.id)).toEqual(['Roadmap'])
  })

  it('reuses the stored casing instead of forking the tag into two rows', async () => {
    seedTagDefinition(vault, 'Roadmap', { name: 'Roadmap', color: 'sage' })

    await writeTagColorRow(vault.ctx, 'roadmap', 'indigo')

    const rows = await tagRows(vault)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('Roadmap')
    expect(vault.outboxRows().map((row) => row.itemId)).toEqual(['Roadmap'])
  })

  it('keeps fields it does not own, including ones from a newer client', async () => {
    seedTagDefinition(vault, 'roadmap', {
      name: 'roadmap',
      color: 'sage',
      categoryId: 'work',
      somethingNewerClientsWrote: { keep: true }
    })

    await writeTagColorRow(vault.ctx, 'roadmap', 'indigo')

    const rows = await tagRows(vault)
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      color: 'indigo',
      categoryId: 'work',
      somethingNewerClientsWrote: { keep: true }
    })
  })

  it('is read back by readTagColors', async () => {
    await writeTagColorRow(vault.ctx, 'Roadmap', '#ff8800')

    const colors = await readTagColors(vault.db)
    expect(colors.get('roadmap')).toBe('#ff8800')
  })
})
