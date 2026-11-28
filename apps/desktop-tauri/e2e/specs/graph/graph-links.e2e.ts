// Graph nodes and wikilink edges come from notes, and a backlink survives a rename of its target,
// ported from Electron's `graph-links.e2e.ts` (Step 30g, #3547). The graph commands answer raw
// JSON bytes (`commands/graph.rs`), decoded in the page as `services/graph-service.ts` does.
import { createNote, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

interface GraphNode {
  id: string
  label: string
}

interface GraphEdge {
  source: string
  target: string
  type: string
}

interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

interface NoteLinks {
  outgoing: { targetId: string | null; targetTitle: string }[]
  incoming: { sourceId: string }[]
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function readGraph(page: Page, command: string, args: Record<string, unknown> = {}) {
  return page.evaluate(
    async ([name, params]: [string, Record<string, unknown>]) => {
      const raw = await window.__TAURI__.core.invoke(name, params)
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : (raw as Uint8Array)
      return JSON.parse(new TextDecoder().decode(bytes)) as Graph
    },
    [command, args]
  )
}

const linked = (graph: Graph, a: string, b: string): boolean =>
  graph.edges.some(
    (edge) =>
      edge.type === 'wikilink' &&
      ((edge.source === a && edge.target === b) || (edge.source === b && edge.target === a))
  )

test('builds graph nodes and wikilink edges from notes', async ({ page }) => {
  await vaultOpen(page)
  const target = await createNote(page, {
    title: `Graph Target ${stamp()}`,
    content: 'Target body for graph coverage.\n',
    tags: ['e2e-graph']
  })
  const source = await createNote(page, {
    title: `Graph Source ${stamp()}`,
    content: `This note links to [[${target.title}]].\n`,
    tags: ['e2e-graph']
  })

  await expect
    .poll(
      async () => {
        const graph = await readGraph(page, 'graph_get_graph_data')
        const labels = new Set(graph.nodes.map((node) => node.label))
        return {
          source: labels.has(source.title),
          target: labels.has(target.title),
          edge: linked(graph, source.id, target.id)
        }
      },
      { timeout: 20_000 }
    )
    .toEqual({ source: true, target: true, edge: true })

  const local = await readGraph(page, 'graph_get_local_graph', { noteId: source.id, depth: 1 })
  expect(local.nodes.map((node) => node.id).toSorted()).toEqual([source.id, target.id].toSorted())
  expect(linked(local, source.id, target.id)).toBe(true)
})

test('preserves backlinks after renaming a wikilink target note', async ({ page }) => {
  await vaultOpen(page)
  const target = await createNote(page, {
    title: `Backlink Target ${stamp()}`,
    content: 'Target body for backlink rename coverage.\n'
  })
  const source = await createNote(page, {
    title: `Backlink Source ${stamp()}`,
    content: `This source keeps a wikilink to [[${target.title}]].\n`
  })
  const links = async () => {
    const [outgoing, incoming] = await Promise.all([
      invoke<NoteLinks>(page, 'notes_get_links', { id: source.id }),
      invoke<NoteLinks>(page, 'notes_get_links', { id: target.id })
    ])
    return { outgoing: outgoing.outgoing, incoming: incoming.incoming }
  }

  await expect
    .poll(
      async () => {
        const { outgoing, incoming } = await links()
        return {
          outgoing: outgoing.some((link) => link.targetId === target.id),
          incoming: incoming.some((link) => link.sourceId === source.id)
        }
      },
      { timeout: 20_000 }
    )
    .toEqual({ outgoing: true, incoming: true })

  const renamed = `Backlink Renamed ${stamp()}`
  await invoke(page, 'notes_rename', { id: target.id, newTitle: renamed })

  // The rename rewrites the source's `[[Old]]` to `[[New]]` vault-wide (#1711), so the backlink
  // survives in the content, not only as a lingering `target_id` in the index.
  await expect
    .poll(
      async () => {
        const [sourceNote, targetNote] = await Promise.all([
          invoke<{ content: string } | null>(page, 'notes_get', { id: source.id }),
          invoke<{ title: string } | null>(page, 'notes_get', { id: target.id })
        ])
        const { outgoing, incoming } = await links()
        return {
          title: targetNote?.title ?? null,
          newLink: sourceNote?.content.includes(`[[${renamed}]]`) ?? false,
          oldLink: sourceNote?.content.includes(`[[${target.title}]]`) ?? true,
          outgoing: outgoing.some(
            (link) => link.targetId === target.id && link.targetTitle === renamed
          ),
          incoming: incoming.some((link) => link.sourceId === source.id)
        }
      },
      { timeout: 20_000 }
    )
    .toEqual({ title: renamed, newLink: true, oldLink: false, outgoing: true, incoming: true })

  const graph = await readGraph(page, 'graph_get_graph_data')
  expect(graph.nodes.find((node) => node.id === target.id)?.label).toBe(renamed)
  expect(linked(graph, source.id, target.id)).toBe(true)
})
