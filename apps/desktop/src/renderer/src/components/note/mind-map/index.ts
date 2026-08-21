/**
 * Note mind map — a derived, read-only view of a note's own structure.
 *
 * `buildMindMap` is the single entry point into the pipeline: projection,
 * layout and element minting live behind it and are not separately seamed.
 */

export { buildMindMap } from './build-mind-map'
export { activateMindMapNode, nodeFromMindMapLink } from './mind-map-navigation'
export type { MindMapNodeActions, MindMapNodeActivation } from './mind-map-navigation'
export { MindMapView } from './mind-map-view'
export { MIND_MAP_VIEW_STATE_KEY, useMindMap } from './use-mind-map'
export type { UseMindMapResult } from './use-mind-map'
export { useMindMapNavigation } from './use-mind-map-navigation'
export type { UseMindMapNavigationResult } from './use-mind-map-navigation'
export type {
  MindMap,
  MindMapBounds,
  MindMapContentCount,
  MindMapContentKind,
  MindMapDirection,
  MindMapElement,
  MindMapNode,
  MindMapNodeKind,
  MindMapOptions,
  MindMapPositionedNode,
  MindMapSourceBlock
} from './mind-map-types'
