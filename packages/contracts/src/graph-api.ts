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

// ============================================================================
// Graph view state and saved graph views (#2486)
// ============================================================================
//
// BACKWARD COMPATIBILITY: everything below is read from places older builds
// either never wrote (the `graphViews` settings group, the graph tab's
// `viewState`) or a newer build may have written with more fields. Every
// schema is total: a missing or malformed field falls back to its default via
// `.catch`, so a partial or foreign record restores as much as it can instead
// of resetting the whole view.

export const GRAPH_FOCUS_DEPTH_MAX = 5

export const GraphViewFiltersSchema = z.object({
  showNotes: z.boolean().catch(true),
  showTasks: z.boolean().catch(true),
  showJournals: z.boolean().catch(true),
  showProjects: z.boolean().catch(true),
  showTags: z.boolean().catch(true),
  showOrphans: z.boolean().catch(true),
  /** Edges drawn as arrows between cards on a canvas. */
  showCanvasEdges: z.boolean().catch(true),
  selectedTags: z.array(z.string()).catch([]),
  focusNodeId: z.string().min(1).nullable().catch(null),
  focusDepth: z.number().int().min(1).max(GRAPH_FOCUS_DEPTH_MAX).catch(2),
  searchQuery: z.string().catch('')
})

export type GraphViewFilters = z.infer<typeof GraphViewFiltersSchema>

export const GRAPH_VIEW_FILTER_DEFAULTS: GraphViewFilters = {
  showNotes: true,
  showTasks: true,
  showJournals: true,
  showProjects: true,
  showTags: true,
  showOrphans: true,
  showCanvasEdges: true,
  selectedTags: [],
  focusNodeId: null,
  focusDepth: 2,
  searchQuery: ''
}

/** `type` is the entity-type palette the graph always had; `tag-category` groups by tag category. */
export const GraphColorBySchema = z.enum(['type', 'tag-category'])

export type GraphColorBy = z.infer<typeof GraphColorBySchema>

/** What one graph tab is looking at: filters, colouring, and which tag categories are collapsed. */
export const GraphViewStateSchema = z.object({
  filters: GraphViewFiltersSchema.catch(GRAPH_VIEW_FILTER_DEFAULTS),
  colorBy: GraphColorBySchema.catch('type'),
  /** Tag category ids shown as one super-node each. Unknown ids are ignored at render time. */
  collapsedCategoryIds: z.array(z.string()).catch([])
})

export type GraphViewState = z.infer<typeof GraphViewStateSchema>

export const GRAPH_VIEW_STATE_DEFAULTS: GraphViewState = {
  filters: GRAPH_VIEW_FILTER_DEFAULTS,
  colorBy: 'type',
  collapsedCategoryIds: []
}

/** Total reader: anything that is not an object restores as the default view. */
export function parseGraphViewState(raw: unknown): GraphViewState {
  if (raw === null || typeof raw !== 'object') return GRAPH_VIEW_STATE_DEFAULTS
  return GraphViewStateSchema.parse(raw)
}

/** A named graph view: filters, colouring, collapsed categories, and the layout algorithm. */
export const SavedGraphViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  state: GraphViewStateSchema.catch(GRAPH_VIEW_STATE_DEFAULTS),
  layout: GraphSettingsSchema.shape.layout.optional().catch(undefined),
  createdAt: z.string(),
  updatedAt: z.string()
})

export type SavedGraphView = z.infer<typeof SavedGraphViewSchema>

/**
 * The `graphViews` settings group. Device-local like the rest of the graph
 * settings (not part of `synced_settings`), so there is nothing to sync and
 * nothing for an older peer to reject.
 */
export interface GraphViewsSettings {
  views: SavedGraphView[]
  /** The last view state any graph tab used; seeds a freshly opened graph tab. */
  lastState: GraphViewState | null
}

export const GRAPH_VIEWS_SETTINGS_DEFAULTS: GraphViewsSettings = {
  views: [],
  lastState: null
}

export const MAX_SAVED_GRAPH_VIEWS = 50

/**
 * Total reader for the persisted blob. Malformed entries are dropped one by
 * one rather than failing the whole list.
 */
export function parseGraphViewsSettings(raw: unknown): GraphViewsSettings {
  if (raw === null || typeof raw !== 'object') return { ...GRAPH_VIEWS_SETTINGS_DEFAULTS }
  const record = raw as { views?: unknown; lastState?: unknown }
  const views: SavedGraphView[] = []
  if (Array.isArray(record.views)) {
    for (const entry of record.views) {
      const result = SavedGraphViewSchema.safeParse(entry)
      if (result.success) views.push(result.data)
    }
  }
  const lastState =
    record.lastState !== null && typeof record.lastState === 'object'
      ? parseGraphViewState(record.lastState)
      : null
  return { views: views.slice(0, MAX_SAVED_GRAPH_VIEWS), lastState }
}

/** A partial update: only the fields present are replaced. */
export interface GraphViewsSettingsPatch {
  views?: SavedGraphView[]
  lastState?: GraphViewState | null
}
