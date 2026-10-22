/**
 * The search portal's query as the user edits it: loose text fields, turned
 * into the strict `{ text?, tag?, limit }` the definition stores.
 *
 * @module note/content-area/portal-flows/portal-search-query
 */

import {
  PORTAL_SEARCH_DEFAULT_LIMIT,
  PORTAL_SEARCH_MAX_LIMIT,
  type PortalDefinition,
  type PortalTarget
} from '@memry/shared/portal-block'

export interface PortalSearchDraft {
  text: string
  tag: string
  /** As typed; empty means the default. */
  limit: string
}

export type PortalSearchTarget = Extract<PortalTarget, { kind: 'search' }>

export const EMPTY_SEARCH_DRAFT: PortalSearchDraft = {
  text: '',
  tag: '',
  limit: String(PORTAL_SEARCH_DEFAULT_LIMIT)
}

/** The draft for an existing search portal, to edit it. */
export function draftFromTarget(target: PortalSearchTarget): PortalSearchDraft {
  return {
    text: target.text ?? '',
    tag: target.tag ?? '',
    limit: String(target.limit)
  }
}

/** Null while neither text nor tag is set: a search with nothing to find is not a portal. */
export function targetFromDraft(draft: PortalSearchDraft): PortalSearchTarget | null {
  const text = draft.text.trim()
  const tag = draft.tag.trim().replace(/^#+/, '')
  if (text === '' && tag === '') return null

  const typed = Number.parseInt(draft.limit, 10)
  const limit = Number.isFinite(typed)
    ? Math.min(Math.max(typed, 1), PORTAL_SEARCH_MAX_LIMIT)
    : PORTAL_SEARCH_DEFAULT_LIMIT

  const target: PortalSearchTarget = { kind: 'search', limit }
  if (text !== '') target.text = text
  if (tag !== '') target.tag = tag
  return target
}

export function searchDefinition(target: PortalSearchTarget): PortalDefinition {
  return { target, hidden: [] }
}
