import type * as Y from 'yjs'

const BLOCK_CONTAINER_NODES = new Set(['blockContainer', 'columnList', 'column'])

// Repair notes already persisted with empty-string block ids: walk the CRDT
// fragment and stamp a fresh id on any block container missing one. Runs on
// note open so previously-corrupted notes heal instead of showing "Editor
// Error". Returns the number of blocks repaired.
//
// Kept apart from blocknote-converter.ts because it runs on every persisted
// doc load (including the startup seed) and needs only Yjs, not the lazily
// loaded BlockNote server editor.
export function repairEmptyBlockIds(fragment: Y.XmlFragment): number {
  let repaired = 0
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      const el = child as Y.XmlElement
      if (typeof el.nodeName !== 'string' || typeof el.getAttribute !== 'function') continue
      if (BLOCK_CONTAINER_NODES.has(el.nodeName) && !el.getAttribute('id')) {
        el.setAttribute('id', crypto.randomUUID())
        repaired++
      }
      visit(el)
    }
  }
  visit(fragment)
  return repaired
}
