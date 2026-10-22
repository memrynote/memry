/**
 * Hand-off for "insert and choose children" (Tab in the picker): the picker
 * inserts the portal block, whose chrome mounts a moment later and opens its
 * hidden-blocks list when it finds its id waiting here.
 *
 * @module note/content-area/portal-flows/portal-choose-children
 */

const waiting = new Set<string>()

export function requestChooseChildren(portalBlockId: string): void {
  waiting.add(portalBlockId)
}

/** True once for a requested block; the caller opens its list. */
export function consumeChooseChildren(portalBlockId: string): boolean {
  return waiting.delete(portalBlockId)
}
