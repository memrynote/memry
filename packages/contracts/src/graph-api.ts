import { z } from 'zod'

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['note', 'task', 'journal', 'project']),
  label: z.string().min(1),
  tags: z.array(z.string()),
  wordCount: z.number().int().min(0),
  connectionCount: z.number().int().min(0),
  emoji: z.string().nullable(),
  color: z.string(),
  isOrphan: z.boolean(),
  isUnresolved: z.boolean()
})

export type GraphNode = z.infer<typeof GraphNodeSchema>

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.enum(['wikilink', 'task-note', 'project-task', 'tag-cooccurrence', 'relation', 'canvas']),
  weight: z.number().default(1)
})

export type GraphEdge = z.infer<typeof GraphEdgeSchema>

export const GraphDataResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema)
})

export type GraphDataResponse = z.infer<typeof GraphDataResponseSchema>

export const LocalGraphRequestSchema = z.object({
  noteId: z.string().min(1),
  depth: z.number().int().min(1).max(3).default(2)
})

export type LocalGraphRequest = z.infer<typeof LocalGraphRequestSchema>

/**
 * Saved node position. `pinned` nodes are held in place by the simulation; the
 * rest only seed where the layout starts, so a reopen looks like the last one.
 */
export const GraphLayoutNodeSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  pinned: z.boolean().optional()
})

export type GraphLayoutNode = z.infer<typeof GraphLayoutNodeSchema>

export const GRAPH_LAYOUT_VERSION = 1

/**
 * Stored as JSON in index.db. Versioned so a future shape can be read next to
 * this one; anything that does not parse is treated as no saved layout.
 */
export const GraphLayoutSchema = z.object({
  version: z.literal(GRAPH_LAYOUT_VERSION),
  nodes: z.record(z.string(), GraphLayoutNodeSchema)
})

export type GraphLayout = z.infer<typeof GraphLayoutSchema>

/** Key for the full-vault graph. Saved graph views (#2486) will add their own keys. */
export const GRAPH_LAYOUT_GLOBAL_KEY = 'global'

export const GraphLayoutViewKeySchema = z.string().min(1).max(200)

export const SaveGraphLayoutRequestSchema = z.object({
  viewKey: GraphLayoutViewKeySchema,
  layout: GraphLayoutSchema
})

export type SaveGraphLayoutRequest = z.infer<typeof SaveGraphLayoutRequestSchema>

export const GraphSettingsSchema = z.object({
  layout: z.enum(['forceatlas2', 'circular', 'random']),
  showLabels: z.boolean(),
  showEdgeLabels: z.boolean(),
  animateLayout: z.boolean(),
  showTagEdges: z.boolean()
})

export type GraphSettings = z.infer<typeof GraphSettingsSchema>

export const GRAPH_SETTINGS_DEFAULTS: GraphSettings = {
  layout: 'forceatlas2',
  showLabels: false,
  showEdgeLabels: false,
  animateLayout: true,
  showTagEdges: false
}
