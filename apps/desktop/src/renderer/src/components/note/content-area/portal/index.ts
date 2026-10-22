/**
 * The portal block's renderer core. The insert flows import from here.
 *
 * @module note/content-area/portal
 */

export { PortalBlockRenderer, createPortalBlockSpec } from './portal-block'
export { PortalAncestryContext, usePortalAncestry } from './portal-context'
export {
  portalBlockInput,
  portalBlockText,
  portalFenceText,
  updatePortalDefinition,
  usePortalDefinition,
  type PortalDefinitionPatch,
  type PortalEditorLike
} from './portal-definition'
export {
  listPortalWindowBlocks,
  readPortalWindowBlocks,
  togglePortalBlockHidden,
  type PortalWindowBlock,
  type TogglePortalHiddenInput
} from './portal-hidden-blocks'
export {
  getPortalActionHandlers,
  registerPortalActionHandlers,
  registerPortalHiddenBlocksSlot,
  registerPortalSearchQuerySlot,
  type PortalActionHandlers,
  type PortalHandle,
  type PortalHiddenBlocksSlotProps,
  type PortalSearchQuerySlotProps
} from './portal-slots'
export {
  ROOT_PORTAL_ANCESTRY,
  isPortalCycle,
  portalWindowDepth,
  resolvePortalStatus,
  withHostFrame,
  type PortalAncestry,
  type PortalFrame,
  type PortalStatusInput,
  type PortalViewStatus,
  type PortalWindowTarget
} from './portal-state'
export { PortalStateCard, type PortalCardStatus } from './portal-state-card'
export { getPortalWindow, usePortalWindow, type PortalWindowEntry } from './portal-window-registry'
export type { PortalWindowSpec } from './portal-window-plugin'
