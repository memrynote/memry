/**
 * Tab Bar Components - Barrel Export
 */

// Main tab bar components
export { TabBar } from './tab-bar'
export { TabBarWithDrag } from './tab-bar-with-drag'
export { TabBarWithOverflow } from './tab-bar-with-overflow'
export { TabDragProvider } from './tab-drag-provider'

// Individual tab components
export { RegularTab } from './regular-tab'
export { PinnedTab } from './pinned-tab'
export { SortableTab } from './sortable-tab'
export { AccessibleTab } from './accessible-tab'
export { AccessibleTabPanel } from './accessible-tab-panel'

// Supporting components
export { TabIcon } from './tab-icon'
export { TabBarAction } from './tab-bar-action'
export { TabDragOverlay } from './tab-drag-overlay'
export { TruncatedTabTitle } from './truncated-tab-title'

// Context menus
export { TabContextMenu } from './tab-context-menu'
export { TabBarContextMenu } from './tab-bar-context-menu'

// Accessibility
export { LiveAnnouncer } from './live-announcer'
export { SkipToContent } from './skip-to-content'

// Edge cases & polish
export { UnsavedChangesDialog, useUnsavedChangesGuard } from './unsaved-changes-dialog'
export { TabErrorBoundary } from './tab-error-boundary'

// Animations
export * from './animations'
