import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { graphLayouts } from '@memry/db-schema/schema/graph-layouts'
import type { GraphLayout } from '@memry/contracts/graph-api'
import type { TestDatabaseResult } from '@tests/utils/test-db'
import { createTestIndexDb } from '@tests/utils/test-db'
import type { IndexDb } from '../types'
import { clearGraphLayout, getGraphLayout, saveGraphLayout } from './graph-layouts'

const layout: GraphLayout = {
  version: 1,
  nodes: {
    'note-a': { x: 10, y: -20, pinned: true },
    'note-b': { x: 0.5, y: 3 }
  }
}

describe('graph layout queries', () => {
  let index: TestDatabaseResult
  let db: IndexDb

  beforeEach(() => {
    index = createTestIndexDb()
    db = index.db as unknown as IndexDb
  })

  afterEach(() => {
    index.close()
  })

  it('returns null when a view has no saved layout', () => {
    expect(getGraphLayout(db, 'global')).toBeNull()
  })

  it('round-trips a layout and replaces it on the next save', () => {
    saveGraphLayout(db, 'global', layout)
    expect(getGraphLayout(db, 'global')).toEqual(layout)

    const moved: GraphLayout = { version: 1, nodes: { 'note-a': { x: 1, y: 2 } } }
    saveGraphLayout(db, 'global', moved)
    expect(getGraphLayout(db, 'global')).toEqual(moved)
    expect(index.db.select().from(graphLayouts).all()).toHaveLength(1)
  })

  it('keeps views apart and clears only the one asked for', () => {
    saveGraphLayout(db, 'global', layout)
    saveGraphLayout(db, 'view:tag-work', layout)

    clearGraphLayout(db, 'global')

    expect(getGraphLayout(db, 'global')).toBeNull()
    expect(getGraphLayout(db, 'view:tag-work')).toEqual(layout)
  })

  it('treats an unreadable or unknown-version blob as no layout', () => {
    index.db.insert(graphLayouts).values({ viewKey: 'broken', positions: '{not json' }).run()
    index.db
      .insert(graphLayouts)
      .values({ viewKey: 'future', positions: JSON.stringify({ version: 2, nodes: {} }) })
      .run()

    expect(getGraphLayout(db, 'broken')).toBeNull()
    expect(getGraphLayout(db, 'future')).toBeNull()
  })
})
