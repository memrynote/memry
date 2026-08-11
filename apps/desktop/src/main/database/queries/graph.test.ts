import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import type { GraphDataResponse } from '@memry/contracts/graph-api'
import { getGraphData, getLocalGraph } from './graph'
import { setPropertyRefs } from './notes/property-ref-queries'

/**
 * The implementation `getLocalGraph` replaced: build the entire vault graph, then BFS over it
 * and throw everything outside `depth` away. Kept here as the oracle the bounded traversal is
 * measured against — it is the behaviour real vaults have been running on.
 */
function referenceLocalGraph(
  indexDb: TestDb,
  dataDb: TestDb,
  noteId: string,
  depth: number
): GraphDataResponse {
  const fullGraph = getGraphData(indexDb, dataDb)

  const adjacency = new Map<string, Set<string>>()
  for (const edge of fullGraph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set())
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set())
    adjacency.get(edge.source)!.add(edge.target)
    adjacency.get(edge.target)!.add(edge.source)
  }

  const visited = new Set<string>([noteId])
  const queue: Array<{ id: string; level: number }> = [{ id: noteId, level: 0 }]

  while (queue.length > 0) {
    const { id, level } = queue.shift()!
    if (level >= depth) continue
    const neighbors = adjacency.get(id)
    if (!neighbors) continue
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue
      visited.add(neighbor)
      queue.push({ id: neighbor, level: level + 1 })
    }
  }

  return {
    nodes: fullGraph.nodes.filter((node) => visited.has(node.id)),
    edges: fullGraph.edges.filter((edge) => visited.has(edge.source) && visited.has(edge.target))
  }
}

/**
 * Node and edge arrays are consumed keyed by id (graphology), so array order carries no
 * meaning — but every node object, every edge object and their multiplicities must match.
 */
function normalizeGraph(graph: GraphDataResponse): GraphDataResponse {
  return {
    nodes: graph.nodes
      .map((node) => ({ ...node, tags: [...node.tags].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))
  }
}

/** Counts the rows every statement on this connection actually materialises. */
function trackRowsRead(sqlite: TestDatabaseResult['sqlite']): () => number {
  let rows = 0
  const originalPrepare = sqlite.prepare.bind(sqlite)
  const patched = (source: string): unknown => {
    const statement = originalPrepare(source) as unknown as {
      all: (...params: unknown[]) => unknown[]
    }
    const originalAll = statement.all.bind(statement)
    statement.all = (...params: unknown[]): unknown[] => {
      const result = originalAll(...params)
      rows += result.length
      return result
    }
    return statement
  }
  sqlite.prepare = patched as unknown as typeof sqlite.prepare
  return () => rows
}

function insertMarkdownNote(
  db: TestDb,
  id: string,
  title: string,
  options: { date?: string; emoji?: string; wordCount?: number } = {}
): void {
  db.run(sql`
    INSERT INTO note_cache (
      id, path, title, file_type, emoji, content_hash, word_count, character_count, date, created_at, modified_at
    )
    VALUES (
      ${id}, ${`notes/${id}.md`}, ${title}, 'markdown', ${options.emoji ?? null}, ${`hash-${id}`},
      ${options.wordCount ?? 10}, 100, ${options.date ?? null},
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `)
}

function insertTag(db: TestDb, noteId: string, tag: string): void {
  db.run(sql`INSERT INTO note_tags (note_id, tag) VALUES (${noteId}, ${tag})`)
}

function insertWikiLink(
  db: TestDb,
  sourceId: string,
  targetTitle: string,
  targetId: string | null = null
): void {
  db.run(sql`
    INSERT INTO note_links (source_id, target_id, target_title)
    VALUES (${sourceId}, ${targetId}, ${targetTitle})
  `)
}

function insertProject(
  db: TestDb,
  id: string,
  name: string,
  archivedAt: string | null = null
): void {
  db.run(sql`
    INSERT INTO projects (id, name, icon, position, archived_at)
    VALUES (${id}, ${name}, 'briefcase', 0, ${archivedAt})
  `)
}

function insertStatus(db: TestDb, id: string, projectId: string): void {
  db.run(sql`
    INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done)
    VALUES (${id}, ${projectId}, 'To Do', '#6b7280', 0, 1, 0)
  `)
}

function insertTask(
  db: TestDb,
  id: string,
  projectId: string,
  statusId: string,
  archivedAt: string | null = null
): void {
  db.run(sql`
    INSERT INTO tasks (id, project_id, status_id, title, position, archived_at)
    VALUES (${id}, ${projectId}, ${statusId}, ${`Task ${id}`}, 0, ${archivedAt})
  `)
}

function insertPropertyRef(
  db: TestDb,
  sourceNoteId: string,
  propertyName: string,
  targetType: 'note' | 'task' | 'event',
  targetId: string
): void {
  db.run(sql`
    INSERT INTO property_refs (source_note_id, property_name, target_type, target_id)
    VALUES (${sourceNoteId}, ${propertyName}, ${targetType}, ${targetId})
  `)
}

function insertTaskNote(db: TestDb, taskId: string, noteId: string): void {
  db.run(sql`INSERT INTO task_notes (task_id, note_id) VALUES (${taskId}, ${noteId})`)
}

/**
 * A vault with everything the traversal has to survive: a 3-note cycle, a pair of notes
 * linking at each other, two rows collapsing onto one edge id, a ghost shared by two notes
 * four hops apart, an orphan, relation refs in both directions, refs to a deleted note / a
 * task / a non-markdown file, task↔note links, an archived task, and tasks whose project has
 * been archived (which the whole-vault build leaves as a dangling edge).
 */
function seedNeighbourhood(indexDb: TestDb, dataDb: TestDb): void {
  insertMarkdownNote(indexDb, 'n1', 'Alpha', { emoji: 'A', wordCount: 42 })
  insertMarkdownNote(indexDb, 'n2', 'Beta')
  insertMarkdownNote(indexDb, 'n3', 'Gamma')
  insertMarkdownNote(indexDb, 'n4', 'Delta')
  insertMarkdownNote(indexDb, 'n5', 'Epsilon')
  insertMarkdownNote(indexDb, 'n6', 'Zeta')
  insertMarkdownNote(indexDb, 'j1', 'Daily', { date: '2026-05-10' })
  indexDb.run(sql`
    INSERT INTO note_cache (id, path, title, file_type, mime_type, created_at, modified_at)
    VALUES ('pdf-1', 'files/report.pdf', 'Report', 'pdf', 'application/pdf',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `)

  insertTag(indexDb, 'n1', 'work')
  insertTag(indexDb, 'n1', 'focus')
  insertTag(indexDb, 'n2', 'inbox')

  insertWikiLink(indexDb, 'n1', 'Beta', 'n2')
  insertWikiLink(indexDb, 'n2', 'Gamma', 'n3')
  insertWikiLink(indexDb, 'n3', 'Alpha', 'n1')
  insertWikiLink(indexDb, 'n1', 'Delta', 'n4')
  insertWikiLink(indexDb, 'n1', 'Delta Alias', 'n4')
  insertWikiLink(indexDb, 'n4', 'Alpha', 'n1')
  insertWikiLink(indexDb, 'j1', 'Alpha', 'n1')
  insertWikiLink(indexDb, 'n2', 'Missing')
  insertWikiLink(indexDb, 'n5', 'Missing')
  insertWikiLink(indexDb, 'n1', 'Report', 'pdf-1')
  insertWikiLink(indexDb, 'n1', 'Deleted', 'nte_gone')

  insertPropertyRef(indexDb, 'n3', 'related', 'note', 'n4')
  insertPropertyRef(indexDb, 'n4', 'mirror', 'note', 'n3')
  insertPropertyRef(indexDb, 'n3', 'ghosted', 'note', 'nte_gone')
  insertPropertyRef(indexDb, 'n3', 'assignee', 'task', 't1')

  insertProject(dataDb, 'p1', 'Launch')
  insertProject(dataDb, 'p-arch', 'Archived', '2026-05-10T00:00:00.000Z')
  insertStatus(dataDb, 's1', 'p1')
  insertStatus(dataDb, 's2', 'p-arch')
  insertTask(dataDb, 't1', 'p1', 's1')
  insertTask(dataDb, 't2', 'p1', 's1')
  insertTask(dataDb, 't3', 'p-arch', 's2')
  insertTask(dataDb, 't4', 'p-arch', 's2')
  insertTask(dataDb, 't-arch', 'p1', 's1', '2026-05-10T00:00:00.000Z')

  insertTaskNote(dataDb, 't1', 'n1')
  insertTaskNote(dataDb, 't2', 'n5')
  insertTaskNote(dataDb, 't3', 'n2')
  insertTaskNote(dataDb, 't-arch', 'n1')
}

describe('graph queries', () => {
  let indexResult: TestDatabaseResult
  let dataResult: TestDatabaseResult
  let indexDb: TestDb
  let dataDb: TestDb

  beforeEach(() => {
    indexResult = createTestIndexDb()
    dataResult = createTestDataDb()
    indexDb = indexResult.db
    dataDb = dataResult.db
  })

  afterEach(() => {
    indexResult.close()
    dataResult.close()
  })

  it('builds note, journal, task, project, wikilink, ghost, and task-note graph data', () => {
    insertMarkdownNote(indexDb, 'note-1', 'Alpha', { emoji: 'A', wordCount: 42 })
    insertMarkdownNote(indexDb, 'note-2', 'Beta')
    insertMarkdownNote(indexDb, 'journal-1', 'Daily', { date: '2026-05-10' })
    insertTag(indexDb, 'note-1', 'work')
    insertTag(indexDb, 'note-1', 'focus')
    insertWikiLink(indexDb, 'note-1', 'Beta', 'note-2')
    insertWikiLink(indexDb, 'note-2', 'Missing')

    insertProject(dataDb, 'project-1', 'Launch')
    insertProject(dataDb, 'archived-project', 'Archived', '2026-05-10T00:00:00.000Z')
    insertStatus(dataDb, 'status-1', 'project-1')
    insertTask(dataDb, 'task-1', 'project-1', 'status-1')
    insertTask(dataDb, 'archived-task', 'project-1', 'status-1', '2026-05-10T00:00:00.000Z')
    dataDb.run(sql`
      INSERT INTO task_notes (task_id, note_id)
      VALUES ('task-1', 'note-1')
    `)

    const graph = getGraphData(indexDb, dataDb)
    const ids = graph.nodes.map((node) => node.id)

    expect(ids).toEqual(
      expect.arrayContaining([
        'note-1',
        'note-2',
        'journal-1',
        'task-1',
        'project-1',
        'ghost:Missing'
      ])
    )
    expect(ids).not.toContain('archived-project')
    expect(ids).not.toContain('archived-task')
    const alpha = graph.nodes.find((node) => node.id === 'note-1')
    expect(alpha).toMatchObject({
      type: 'note',
      label: 'Alpha',
      wordCount: 42,
      emoji: 'A',
      isOrphan: false
    })
    expect(alpha?.tags.sort()).toEqual(['focus', 'work'])
    expect(graph.nodes.find((node) => node.id === 'journal-1')).toMatchObject({
      type: 'journal',
      label: 'Daily'
    })
    expect(graph.nodes.find((node) => node.id === 'ghost:Missing')).toMatchObject({
      label: 'Missing',
      isUnresolved: true
    })
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'note-1', target: 'note-2', type: 'wikilink' }),
        expect.objectContaining({ source: 'note-2', target: 'ghost:Missing', type: 'wikilink' }),
        expect.objectContaining({ source: 'task-1', target: 'project-1', type: 'project-task' }),
        expect.objectContaining({ source: 'task-1', target: 'note-1', type: 'task-note' })
      ])
    )
    expect(graph.nodes.find((node) => node.id === 'project-1')?.connectionCount).toBe(1)
  })

  it('emits a relation edge between two notes', () => {
    insertMarkdownNote(indexDb, 'note-1', 'Alpha')
    insertMarkdownNote(indexDb, 'note-2', 'Beta')
    setPropertyRefs(indexDb, 'note-1', { father: ['memry://note/note-2'] })

    const { edges } = getGraphData(indexDb, dataDb)
    expect(edges).toContainEqual(
      expect.objectContaining({ source: 'note-1', target: 'note-2', type: 'relation' })
    )
  })

  it('skips relation refs to tasks and events but keeps the note ref', () => {
    insertMarkdownNote(indexDb, 'note-1', 'Alpha')
    insertMarkdownNote(indexDb, 'note-2', 'Beta')
    setPropertyRefs(indexDb, 'note-1', {
      father: ['memry://note/note-2'],
      attendees: ['memry://task/tsk_1', 'memry://event/evt_1']
    })

    const { edges } = getGraphData(indexDb, dataDb)
    const relationEdges = edges.filter((e) => e.type === 'relation')
    expect(relationEdges).toHaveLength(1)
    expect(relationEdges[0]).toMatchObject({ source: 'note-1', target: 'note-2' })
  })

  it('skips a relation ref whose target note does not exist but keeps the valid one', () => {
    insertMarkdownNote(indexDb, 'note-1', 'Alpha')
    insertMarkdownNote(indexDb, 'note-2', 'Beta')
    setPropertyRefs(indexDb, 'note-1', {
      father: ['memry://note/note-2', 'memry://note/nte_gone']
    })

    const { edges } = getGraphData(indexDb, dataDb)
    const relationEdges = edges.filter((e) => e.type === 'relation')
    expect(relationEdges).toHaveLength(1)
    expect(relationEdges[0]).toMatchObject({ source: 'note-1', target: 'note-2' })
  })

  it('filters local graph by depth from the selected note', () => {
    insertMarkdownNote(indexDb, 'a', 'A')
    insertMarkdownNote(indexDb, 'b', 'B')
    insertMarkdownNote(indexDb, 'c', 'C')
    insertWikiLink(indexDb, 'a', 'B', 'b')
    insertWikiLink(indexDb, 'b', 'C', 'c')

    expect(getLocalGraph(indexDb, dataDb, 'a', 0).nodes.map((node) => node.id)).toEqual(['a'])
    expect(
      getLocalGraph(indexDb, dataDb, 'a', 1)
        .nodes.map((node) => node.id)
        .sort()
    ).toEqual(['a', 'b'])
    expect(
      getLocalGraph(indexDb, dataDb, 'a', 2)
        .nodes.map((node) => node.id)
        .sort()
    ).toEqual(['a', 'b', 'c'])
    expect(getLocalGraph(indexDb, dataDb, 'missing', 2)).toEqual({ nodes: [], edges: [] })
  })

  describe('local graph traversal', () => {
    it.each(['n1', 'n5', 'n6', 't1', 'p1', 'p-arch', 'nte_gone'])(
      'returns exactly what the whole-vault build then filter returned, from %s',
      (seed) => {
        seedNeighbourhood(indexDb, dataDb)

        for (const depth of [0, 1, 2, 3, 4]) {
          const actual = normalizeGraph(getLocalGraph(indexDb, dataDb, seed, depth))
          const expected = normalizeGraph(referenceLocalGraph(indexDb, dataDb, seed, depth))
          expect(actual, `seed ${seed} at depth ${depth}`).toEqual(expected)
        }
      }
    )

    it('keeps whole-vault connection counts on the outermost ring', () => {
      seedNeighbourhood(indexDb, dataDb)

      const graph = getLocalGraph(indexDb, dataDb, 'n1', 2)
      const byId = new Map(graph.nodes.map((node) => [node.id, node]))

      // Reached at depth 2 and never expanded, yet still carries both of the links that
      // point at it — the second one comes from n5, which is two hops further out.
      expect(byId.get('ghost:Missing')?.connectionCount).toBe(2)
      expect(graph.nodes.some((node) => node.id === 'n5')).toBe(false)
      // Both rows that collapse onto the same n1→n4 edge id survive as separate edges.
      expect(graph.edges.filter((edge) => edge.id === 'n1-n4-wikilink')).toHaveLength(2)
      expect(byId.get('n1')?.tags.sort()).toEqual(['focus', 'work'])
    })

    it('reads a neighbourhood-sized number of rows no matter how big the vault is', () => {
      seedNeighbourhood(indexDb, dataDb)
      const smallIndexRows = trackRowsRead(indexResult.sqlite)
      const smallDataRows = trackRowsRead(dataResult.sqlite)
      const smallGraph = getLocalGraph(indexDb, dataDb, 'n1', 2)
      const smallRows = smallIndexRows() + smallDataRows()

      const bigIndex = createTestIndexDb()
      const bigData = createTestDataDb()
      try {
        const bigIndexDb = bigIndex.db
        const bigDataDb = bigData.db
        // Same neighbourhood, 400 notes / 400 links / 200 tasks of unrelated vault around it.
        seedNeighbourhood(bigIndexDb, bigDataDb)
        insertProject(bigDataDb, 'p-far', 'Far')
        insertStatus(bigDataDb, 's-far', 'p-far')
        for (let i = 0; i < 400; i++) {
          insertMarkdownNote(bigIndexDb, `far-${i}`, `Far ${i}`)
          insertWikiLink(bigIndexDb, `far-${i}`, `Far ${i + 1}`, `far-${i + 1}`)
          if (i < 200) insertTask(bigDataDb, `t-far-${i}`, 'p-far', 's-far')
        }

        const bigIndexRows = trackRowsRead(bigIndex.sqlite)
        const bigDataRows = trackRowsRead(bigData.sqlite)
        const bigGraph = getLocalGraph(bigIndexDb, bigDataDb, 'n1', 2)
        const bigRows = bigIndexRows() + bigDataRows()

        const referenceIndexRows = trackRowsRead(bigIndex.sqlite)
        const referenceDataRows = trackRowsRead(bigData.sqlite)
        referenceLocalGraph(bigIndexDb, bigDataDb, 'n1', 2)
        const referenceRows = referenceIndexRows() + referenceDataRows()

        expect(normalizeGraph(bigGraph)).toEqual(normalizeGraph(smallGraph))
        expect(bigRows).toBe(smallRows)
        expect(bigRows).toBeLessThan(100)
        // The build-then-filter it replaced materialised the whole vault to answer the same
        // question, and grew with every note added anywhere.
        expect(referenceRows).toBeGreaterThan(1000)
      } finally {
        bigIndex.close()
        bigData.close()
      }
    })
  })
})
