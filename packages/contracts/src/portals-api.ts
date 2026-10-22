/**
 * Portals IPC API Contract
 *
 * A portal is a live window onto another note, one block of it, or the blocks
 * a search finds (`@memry/shared/portal-block`). These calls cover what the
 * renderer cannot do from the source note's Y.Doc alone: who shows a source,
 * giving a block an anchor, and block-level search.
 *
 * @module contracts/portals-api
 */

import { z } from 'zod'
import { PortalChannels } from './ipc-channels'

export { PortalChannels }

/** A note that shows a source through at least one portal. */
export const PortalHostSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  path: z.string(),
  /** Portals (or links, see `kind`) in this host that point at the source (or block). */
  count: z.number().int().positive(),
  /** A portal to the source, or a `[[Note#^anchor]]` wiki link to it. Absent reads as a portal. */
  kind: z.enum(['portal', 'link']).optional()
})
export type PortalHost = z.infer<typeof PortalHostSchema>

export const PortalGetUsageSchema = z.object({
  noteId: z.string().min(1),
  /** Without it, every portal to the note counts, whole-note and block alike. */
  anchor: z.string().optional()
})
export const PortalGetUsageResultSchema = z.object({ hosts: z.array(PortalHostSchema) })
export type PortalGetUsageInput = z.infer<typeof PortalGetUsageSchema>
export type PortalGetUsageResult = z.infer<typeof PortalGetUsageResultSchema>

export const PortalStampAnchorSchema = z.object({
  noteId: z.string().min(1),
  /** The BlockNote block id inside the source note's Y.Doc. */
  blockId: z.string().min(1)
})
export const PortalStampAnchorResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), anchor: z.string() }),
  z.object({
    success: z.literal(false),
    reason: z.enum(['missing-note', 'missing-block', 'locked'])
  })
])
export type PortalStampAnchorInput = z.infer<typeof PortalStampAnchorSchema>
export type PortalStampAnchorResult = z.infer<typeof PortalStampAnchorResultSchema>

export const PortalSearchSchema = z
  .object({
    text: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    limit: z.number().int().positive().max(200)
  })
  .refine((v) => v.text !== undefined || v.tag !== undefined, {
    message: 'text or tag is required'
  })
export const PortalSearchResultItemSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  path: z.string(),
  blockId: z.string(),
  /** The block's anchor when it already has one. */
  anchor: z.string().nullable(),
  text: z.string(),
  /** The enclosing block's text, for the `Note › Parent` path in the picker. */
  parentText: z.string().nullable()
})
export const PortalSearchResultSchema = z.object({
  results: z.array(PortalSearchResultItemSchema),
  /** True when more blocks matched than `limit`. */
  truncated: z.boolean()
})
export type PortalSearchInput = z.infer<typeof PortalSearchSchema>
export type PortalSearchResultItem = z.infer<typeof PortalSearchResultItemSchema>
export type PortalSearchResult = z.infer<typeof PortalSearchResultSchema>

export const PortalUsageChangedEventSchema = z.object({ noteIds: z.array(z.string()) })
export type PortalUsageChangedEvent = z.infer<typeof PortalUsageChangedEventSchema>
