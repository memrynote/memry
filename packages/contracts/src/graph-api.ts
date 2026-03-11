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
  type: z.enum(['wikilink', 'task-note', 'project-task', 'tag-cooccurrence']),
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
  showLabels: true,
  showEdgeLabels: false,
  animateLayout: false,
  showTagEdges: false
}
