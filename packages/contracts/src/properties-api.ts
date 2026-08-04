/**
 * Unified Properties IPC API Contract
 *
 * Handles property operations for both notes and journal entries.
 * Uses a unified approach where entity ID works for any cached entity.
 *
 * @module contracts/properties-api
 */

import { z } from 'zod'

// Import and re-export channels from the contract-local surface.
import { PropertiesChannels } from './ipc-channels'
export { PropertiesChannels }

// Import and re-export canonical persisted property types.
import { PropertyTypes, type PropertyType } from './property-types'
export { PropertyTypes, type PropertyType }

// Import and re-export relation URI types for the resolveRefs response shape.
import type { RelationKind } from './relation-uri'
export type { RelationKind }

// ============================================================================
// Property Types
// ============================================================================

/**
 * Property value as stored and returned from the database.
 */
export interface PropertyValue {
  name: string
  value: unknown
  type: PropertyType
}

// ============================================================================
// Request Schemas
// ============================================================================

/**
 * Schema for getting properties by entity ID.
 */
export const GetPropertiesSchema = z.object({
  entityId: z.string().min(1, 'Entity ID is required')
})

/**
 * Schema for setting properties on an entity.
 */
export const SetPropertiesSchema = z.object({
  entityId: z.string().min(1, 'Entity ID is required'),
  properties: z.record(z.string(), z.unknown())
})

/**
 * Schema for renaming a property on an entity.
 * Note-only scope: rename only affects the current entity's frontmatter.
 */
export const RenamePropertySchema = z.object({
  entityId: z.string().min(1, 'Entity ID is required'),
  oldName: z.string().min(1, 'Old property name is required'),
  newName: z.string().min(1, 'New property name is required')
})

/**
 * Schema for resolving relation property URIs to display data.
 */
export const ResolveRefsSchema = z.object({
  uris: z.array(z.string())
})

// ============================================================================
// Response Types
// ============================================================================

/**
 * Response from set properties operation.
 */
export type SetPropertiesResponse = { success: true } | { success: false; error: string }

/**
 * Response from rename property operation.
 */
export type RenamePropertyResponse = { success: true } | { success: false; error: string }

/**
 * A relation property URI resolved to display data for a chip: a title to
 * render, and whether the target still exists. Order matches the input URI
 * array 1:1 so callers can zip the two together.
 */
export interface ResolvedRelationRef {
  uri: string
  targetType: RelationKind
  targetId: string
  title: string
  subtitle?: string
  exists: boolean
  fileType?: string
  /** Note targets only, and only markdown ones — chips show it instead of the kind icon. */
  emoji?: string
  /** Task targets only. Scopes the tasks list when a chip navigates. */
  projectId?: string
  /** Event targets only. The calendar needs the date to move its range before it can focus the event. */
  startAt?: string
}

// ============================================================================
// Inferred Types
// ============================================================================

export type GetPropertiesInput = z.infer<typeof GetPropertiesSchema>
export type SetPropertiesInput = z.infer<typeof SetPropertiesSchema>
export type RenamePropertyInput = z.infer<typeof RenamePropertySchema>
export type ResolveRefsInput = z.infer<typeof ResolveRefsSchema>
