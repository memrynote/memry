// Dumps what Electron's graph queries (`apps/desktop/src/main/database/queries/graph.ts`)
// return for the graph seed vault, as the golden `crates/memry-core` `graph_parity` compares
// with. The seed here and `seed` in `crates/memry-core/src/domain/graph/tests.rs` describe the
// same vault; change both together.
//
// Run from apps/desktop, with better-sqlite3 built for node:
//   bash scripts/ensure-native.sh node
//   pnpm exec tsx ../../scripts/dump-graph-fixture.ts           # writes the fixture
//   pnpm exec tsx ../../scripts/dump-graph-fixture.ts --check   # fails when it differs
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import type { GraphDataResponse } from '@memry/contracts/graph-api'
import {
  createTestDataDb,
  createTestIndexDb,
  type TestDb
} from '../apps/desktop/tests/utils/test-db'
import { getGraphData, getLocalGraph } from '../apps/desktop/src/main/database/queries/graph'

const OUT = resolve(__dirname, '../crates/memry-core/src/domain/graph/graph_parity.json')

/** Local graph seeds: notes, a journal day, tasks, a live and an archived project, an id that
 * is no node, and a ghost. */
const LOCAL_SEEDS = [
  'n1',
  'n5',
  'n6',
  'j1',
  't1',
  't2',
  'p1',
  'p-arch',
  'nte_gone',
  'ghost:Missing'
]
const DEPTHS = [1, 2, 3]

function note(
  db: TestDb,
  id: string,
  title: string,
  opts: { date?: string; emoji?: string; words?: number } = {}
): void {
  db.run(sql`
    INSERT INTO note_cache (id, path, title, file_type, emoji, content_hash, word_count, character_count, date, created_at, modified_at)
    VALUES (${id}, ${`notes/${id}.md`}, ${title}, 'markdown', ${opts.emoji ?? null}, ${`hash-${id}`},
      ${opts.words ?? 10}, 100, ${opts.date ?? null}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `)
}

function seed(index: TestDb, data: TestDb): void {
  note(index, 'n1', 'Alpha', { emoji: 'A', words: 42 })
  note(index, 'n2', 'Beta')
  note(index, 'n3', 'Gamma')
  note(index, 'n4', 'Delta')
  note(index, 'n5', 'Epsilon')
  note(index, 'n6', 'Zeta')
  note(index, 'n7', 'Eta')
  note(index, 'n8', '')
  // Electron's journal cache titles a day with its date.
  note(index, 'j1', '2026-05-10', { date: '2026-05-10' })
  index.run(sql`
    INSERT INTO note_cache (id, path, title, file_type, mime_type, created_at, modified_at)
    VALUES ('pdf-1', 'files/report.pdf', 'Report', 'pdf', 'application/pdf',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `)

  for (const [noteId, tag] of [
    ['n1', 'work'],
    ['n1', 'focus'],
    ['n2', 'inbox'],
    ['j1', 'daily']
  ]) {
    index.run(sql`INSERT INTO note_tags (note_id, tag) VALUES (${noteId}, ${tag})`)
  }

  const links: Array<[string, string, string | null]> = [
    ['n1', 'Beta', 'n2'],
    ['n2', 'Gamma', 'n3'],
    ['n3', 'Alpha', 'n1'],
    ['n1', 'Delta', 'n4'],
    ['n1', 'Delta Alias', 'n4'],
    ['n4', 'Alpha', 'n1'],
    ['j1', 'Alpha', 'n1'],
    ['n2', 'Missing', null],
    ['n5', 'Missing', null],
    ['n1', 'Report', 'pdf-1'],
    ['n1', 'Deleted', 'nte_gone'],
    ['pdf-1', 'Alpha', 'n1'],
    ['n8', 'Nowhere', null]
  ]
  for (const [source, title, target] of links) {
    index.run(
      sql`INSERT INTO note_links (source_id, target_id, target_title) VALUES (${source}, ${target}, ${title})`
    )
  }

  const refs: Array<[string, string, string, string]> = [
    ['n3', 'related', 'note', 'n4'],
    ['n4', 'mirror', 'note', 'n3'],
    ['n3', 'ghosted', 'note', 'nte_gone'],
    ['n3', 'assignee', 'task', 't1']
  ]
  for (const [source, name, type, target] of refs) {
    index.run(sql`
      INSERT INTO property_refs (source_note_id, property_name, target_type, target_id)
      VALUES (${source}, ${name}, ${type}, ${target})
    `)
  }

  // Two fences of n6 show n2 (one edge), n3 shows itself, a search portal names no note,
  // n4 shows a deleted note.
  const portals: Array<[string, number, string | null, string]> = [
    ['n6', 0, 'n2', 'note'],
    ['n6', 1, 'n2', 'blocks'],
    ['n3', 0, 'n3', 'note'],
    ['n6', 2, null, 'search'],
    ['n4', 0, 'nte_gone', 'note']
  ]
  for (const [host, ordinal, source, kind] of portals) {
    index.run(sql`
      INSERT INTO portal_refs (host_note_id, ordinal, source_note_id, kind)
      VALUES (${host}, ${ordinal}, ${source}, ${kind})
    `)
  }

  for (const [id, name, archived] of [
    ['p1', 'Launch', null],
    ['p-arch', 'Archived', '2026-05-10T00:00:00.000Z']
  ]) {
    data.run(
      sql`INSERT INTO projects (id, name, icon, position, archived_at) VALUES (${id}, ${name}, 'briefcase', 0, ${archived})`
    )
  }
  data.run(
    sql`INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done) VALUES ('s1', 'p1', 'To Do', '#6b7280', 0, 1, 0)`
  )
  data.run(
    sql`INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done) VALUES ('s2', 'p-arch', 'To Do', '#6b7280', 0, 1, 0)`
  )
  const tasks: Array<[string, string, string, string | null]> = [
    ['t1', 'p1', 's1', null],
    ['t2', 'p1', 's1', null],
    ['t3', 'p-arch', 's2', null],
    ['t4', 'p-arch', 's2', null],
    ['t-arch', 'p1', 's1', '2026-05-10T00:00:00.000Z']
  ]
  for (const [id, project, status, archived] of tasks) {
    data.run(sql`
      INSERT INTO tasks (id, project_id, status_id, title, position, archived_at)
      VALUES (${id}, ${project}, ${status}, ${`Task ${id}`}, 0, ${archived})
    `)
  }
  for (const [task, noteId] of [
    ['t1', 'n1'],
    ['t2', 'n5'],
    ['t3', 'n2'],
    ['t-arch', 'n1'],
    ['t1', 'nte_gone']
  ]) {
    data.run(sql`INSERT INTO task_notes (task_id, note_id) VALUES (${task}, ${noteId})`)
  }

  for (const [id, deletedAt] of [
    ['c1', null],
    ['c2', null],
    ['c-dead', 5]
  ] as const) {
    data.run(sql`
      INSERT INTO canvases (id, vault_id, title, snapshot_ciphertext, vector_clock, created_at, updated_at, deleted_at)
      VALUES (${id}, 'vault-1', ${`Canvas ${id}`}, '', '{}', 1, 1, ${deletedAt})
    `)
  }
  const arrows: Array<[string, string, [string, string], [string, string]]> = [
    ['c1', 'a1', ['note', 'n5'], ['note', 'n7']],
    ['c1', 'a2', ['note', 'n5'], ['note', 'n7']],
    ['c2', 'a1', ['note', 'n5'], ['note', 'n7']],
    ['c1', 'a3', ['task', 't2'], ['note', 'n7']],
    ['c1', 'a4', ['note', 'n7'], ['calendar_event', 'e1']],
    ['c1', 'a5', ['project', 'p1'], ['note', 'n6']],
    ['c-dead', 'a1', ['note', 'n1'], ['note', 'n7']]
  ]
  for (const [canvas, arrow, [sourceType, sourceId], [targetType, targetId]] of arrows) {
    data.run(sql`
      INSERT INTO canvas_entity_edges (canvas_id, arrow_id, source_type, source_id, target_type, target_id)
      VALUES (${canvas}, ${arrow}, ${sourceType}, ${sourceId}, ${targetType}, ${targetId})
    `)
  }
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** Array order carries no meaning (the renderer keys by id); every object and multiplicity does. */
function normalize(graph: GraphDataResponse): GraphDataResponse {
  return {
    nodes: graph.nodes.map((node) => ({ ...node, tags: node.tags.toSorted() })).toSorted(byId),
    edges: graph.edges.toSorted(byId)
  }
}

const index = createTestIndexDb()
const data = createTestDataDb()
try {
  seed(index.db, data.db)
  const local: Record<string, Record<string, GraphDataResponse>> = {}
  for (const id of LOCAL_SEEDS) {
    local[id] = {}
    for (const depth of DEPTHS) {
      local[id][String(depth)] = normalize(getLocalGraph(index.db, data.db, id, depth))
    }
  }
  const fixture = `${JSON.stringify({ graph: normalize(getGraphData(index.db, data.db)), local }, null, 2)}\n`
  if (process.argv.includes('--check')) {
    // oxfmt rewraps the committed file, so the check compares values, not bytes.
    const committed: unknown = JSON.parse(readFileSync(OUT, 'utf8'))
    if (JSON.stringify(committed) !== JSON.stringify(JSON.parse(fixture))) {
      console.error(`${OUT} differs from what Electron returns; rerun without --check`)
      process.exit(1)
    }
  } else {
    writeFileSync(OUT, fixture)
  }
} finally {
  index.close()
  data.close()
}
