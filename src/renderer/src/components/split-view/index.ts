/**
 * Split View Components - Barrel Export
 */

// Main container
export { SplitViewContainer } from './split-view-container';

// Layout renderer
export { SplitLayoutRenderer } from './split-layout-renderer';

// Pane components
export { SplitPane } from './split-pane';
export { TabPane } from './tab-pane';
export { TabContent } from './tab-content';
export { EmptyPaneState } from './empty-pane-state';

// UI components
export { ResizeHandle } from './resize-handle';

// Helper functions
export {
  updateRatioAtPath,
  getGroupIdsFromLayout,
  findGroupPath,
  removeGroupFromLayout,
  insertSplitAtGroup,
  countPanes,
  hasGroupInLayout,
  getSiblingGroupId,
} from './layout-helpers';
