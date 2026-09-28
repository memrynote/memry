import type Graph from 'graphology'
import { formatRelationUri, isRelationValue } from '@memry/contracts/relation-uri'

/**
 * The relation property a graph-created link is written to.
 *
 * Relation properties carry no persisted definition (their `memry://` values
 * type them), so "creating the definition on first use" is just writing the
 * key. It is a fixed name so the user always knows where graph links land.
 */
export const GRAPH_LINK_PROPERTY = 'related'

/**
 * Only markdown notes are editable from the graph. Journals write properties
 * through a separate writer that emits no `notes:updated` event, and tasks and
 * projects are not relation sources at all.
 */
export function isEditableGraphNode(graph: Graph, nodeId: string): boolean {
  if (!graph.hasNode(nodeId)) return false
  const attrs = graph.getNodeAttributes(nodeId)
  return attrs.nodeType === 'note' && attrs.isUnresolved !== true
}

export function noteRelationUri(noteId: string): string {
  return formatRelationUri('note', noteId)
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
}

export type AddRelationResult =
  | { status: 'added'; properties: Record<string, unknown> }
  | { status: 'already-linked' }
  | { status: 'property-conflict' }

/**
 * Add `uri` to `propertyName`. Already present under any relation property is
 * a no-op: the edge already exists. A non-relation value under the name is
 * left alone rather than overwritten.
 */
export function addRelationTarget(
  properties: Record<string, unknown>,
  propertyName: string,
  uri: string
): AddRelationResult {
  for (const value of Object.values(properties)) {
    if (isRelationValue(value) && value.includes(uri)) return { status: 'already-linked' }
  }

  const current = properties[propertyName]
  if (isEmptyValue(current)) {
    return { status: 'added', properties: { ...properties, [propertyName]: [uri] } }
  }
  if (!isRelationValue(current)) return { status: 'property-conflict' }
  return { status: 'added', properties: { ...properties, [propertyName]: [...current, uri] } }
}

/**
 * Remove `uri` from every relation property that holds it, and report which
 * properties changed so an undo can put it back in the same place. An emptied
 * property stays as `[]`, the same as removing the last chip in the editor.
 */
export function removeRelationTarget(
  properties: Record<string, unknown>,
  uri: string
): { properties: Record<string, unknown>; removedFrom: string[] } {
  const next: Record<string, unknown> = { ...properties }
  const removedFrom: string[] = []
  for (const [name, value] of Object.entries(properties)) {
    if (!isRelationValue(value) || !value.includes(uri)) continue
    next[name] = value.filter((v) => v !== uri)
    removedFrom.push(name)
  }
  return { properties: next, removedFrom }
}

/** Put `uri` back into each named property, skipping any that no longer takes it. */
export function restoreRelationTarget(
  properties: Record<string, unknown>,
  propertyNames: string[],
  uri: string
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...properties }
  for (const name of propertyNames) {
    const current = next[name]
    if (isEmptyValue(current)) next[name] = [uri]
    else if (isRelationValue(current) && !current.includes(uri)) next[name] = [...current, uri]
  }
  return next
}

export interface GraphRelationLink {
  /** The note whose property holds the link. */
  sourceId: string
  targetId: string
  /** The node at the other end, from the menu node's point of view. */
  otherId: string
  otherLabel: string
}

/**
 * Relation edges touching `nodeId`, either direction. Wiki-link edges are not
 * listed: they live in the note body, so removing one means editing the note.
 */
export function relationLinksOf(graph: Graph, nodeId: string): GraphRelationLink[] {
  if (!graph.hasNode(nodeId)) return []
  const links: GraphRelationLink[] = []
  graph.forEachEdge(nodeId, (_edge, attrs, source, target) => {
    if (attrs.edgeType !== 'relation') return
    const otherId = source === nodeId ? target : source
    links.push({
      sourceId: source,
      targetId: target,
      otherId,
      otherLabel: (graph.getNodeAttribute(otherId, 'label') as string) ?? ''
    })
  })
  return links
}

/** Case-insensitive tag membership, matching how tags are compared on disk. */
export function hasTag(tags: string[], tag: string): boolean {
  const needle = tag.toLowerCase()
  return tags.some((t) => t.toLowerCase() === needle)
}
