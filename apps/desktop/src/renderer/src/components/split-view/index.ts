/**
 * Split View Components - Barrel Export
 */

// Main container
export { SplitViewContainer } from './split-view-container'

// Layout renderer
export { SplitLayoutRenderer } from './split-layout-renderer'

// Pane components
export { SplitPane } from './split-pane'
export { TabPane } from './tab-pane'
export { TabPaneWithDropZones } from './tab-pane-with-drop-zones'
export { TabContent } from './tab-content'
export { EmptyPaneState } from './empty-pane-state'

// UI components
export { ResizeHandle } from './resize-handle'

// Drop zones (drag-to-split)
export { DropZone, getDropZoneLabel, type DropZonePosition } from './drop-zone'
export { SplitDropZones } from './split-drop-zones'
export { SplitPreview } from './split-preview'

// Layout presets
export { LayoutPicker } from './layout-picker'
export {
  layoutPresets,
  applyLayoutPreset,
  type LayoutPreset,
  type LayoutPresetConfig
} from './layout-presets'

// Helper functions
export {
  updateRatioAtPath,
  getGroupIdsFromLayout,
  findGroupPath,
  removeGroupFromLayout,
  insertSplitAtGroup,
  countPanes,
  hasGroupInLayout,
  getSiblingGroupId
} from './layout-helpers'
