import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dataSqlite = new Database(':memory:')
const indexSqlite = new Database(':memory:')

vi.mock('./database', () => ({
  getRawDataDatabase: () => dataSqlite,
  getRawIndexDatabase: () => indexSqlite
}))
vi.mock('./store', () => ({ store: {} }))
vi.mock('./sync/crdt-provider', () => ({ getCrdtProvider: vi.fn() }))
vi.mock('./sync/runtime', () => ({ getSyncEngine: vi.fn(() => null) }))

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

describe('registerAgentDebugHandles', () => {
  beforeEach(() => {
    globalThis.__memryDebug = undefined
    dataSqlite.exec('DROP TABLE IF EXISTS tasks; CREATE TABLE tasks (id TEXT, title TEXT)')
    dataSqlite.prepare('INSERT INTO tasks VALUES (?, ?)').run('t1', 'Write tests')
    indexSqlite.exec('DROP TABLE IF EXISTS edges; CREATE TABLE edges (source TEXT)')
    indexSqlite.prepare('INSERT INTO edges VALUES (?)').run('n1')
  })

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    globalThis.__memryDebug = undefined
  })

  it('stays unregistered outside test mode', async () => {
    process.env.NODE_ENV = 'production'
    const { registerAgentDebugHandles } = await import('./agent-debug')

    registerAgentDebugHandles()

    expect(globalThis.__memryDebug).toBeUndefined()
  })

  it('runs parameterized reads against data.db and index.db', async () => {
    process.env.NODE_ENV = 'test'
    const { registerAgentDebugHandles } = await import('./agent-debug')

    registerAgentDebugHandles()

    expect(globalThis.__memryDebug?.query('SELECT title FROM tasks WHERE id = ?', 't1')).toEqual([
      { title: 'Write tests' }
    ])
    expect(globalThis.__memryDebug?.indexQuery('SELECT source FROM edges')).toEqual([
      { source: 'n1' }
    ])
  })

  it('rejects writes and leaves the rows untouched', async () => {
    process.env.NODE_ENV = 'test'
    const { registerAgentDebugHandles } = await import('./agent-debug')

    registerAgentDebugHandles()

    expect(() => globalThis.__memryDebug?.query("UPDATE tasks SET title = 'x'")).toThrow(
      /read-only/
    )
    expect(() => globalThis.__memryDebug?.query('DELETE FROM tasks RETURNING id')).toThrow(
      /read-only/
    )
    expect(() => globalThis.__memryDebug?.indexQuery('DELETE FROM edges')).toThrow(/read-only/)
    expect(dataSqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    expect(indexSqlite.prepare('SELECT COUNT(*) AS n FROM edges').get()).toEqual({ n: 1 })
  })
})
