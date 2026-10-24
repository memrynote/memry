/**
 * What the portal flows offer to menus that live outside the layer: the block
 * side menu's items and the `/` menu's rows. The layer registers its handlers
 * for an editor when it mounts; callers look them up by editor, the same way
 * `getCheckboxTaskActions` and the marquee registry work.
 *
 * @module note/content-area/portal-flows/portal-flows-api
 */

export interface PortalFlowsApi {
  /** The note this editor edits; blocks can only be portaled from a saved note. */
  noteId: string
  /**
   * Remove blocks, asking first when another note shows one of them through a
   * portal. Resolves once the blocks are gone or the user cancelled.
   */
  requestBlockRemoval: (blockIds: readonly string[]) => Promise<void>
  /** Put a portal to the block on the clipboard as a `memry-portal` fence. */
  copyPortalToBlock: (blockId: string) => Promise<void>
  /** Open the search portal query popover at the caret. */
  openSearchCreate: () => void
  /** Let the user pick a new target for a portal whose block is gone. */
  pickAnotherBlock: (portalBlockId: string) => void
}

const registry = new WeakMap<WeakKey, PortalFlowsApi>()

/** Returns the unregister function. */
export function registerPortalFlowsApi(editor: WeakKey, api: PortalFlowsApi): () => void {
  registry.set(editor, api)
  return () => {
    if (registry.get(editor) === api) registry.delete(editor)
  }
}

export function getPortalFlowsApi(editor: WeakKey): PortalFlowsApi | undefined {
  return registry.get(editor)
}
