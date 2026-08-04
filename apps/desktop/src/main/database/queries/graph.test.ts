import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { getGraphData, getLocalGraph } from './graph'
import { setPropertyRefs } from './notes/property-ref-queries'

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
})
