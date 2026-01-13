/**
 * Unified Properties IPC API Contract
 *
 * Handles property operations for both notes and journal entries.
 * Uses a unified approach where entity ID works for any cached entity.
 *
 * @module contracts/properties-api
 */

import { z } from 'zod'

// Import and re-export channels from shared (single source of truth)
import { PropertiesChannels } from '../ipc-channels'
export { PropertiesChannels }

// Import and re-export PropertyType from schema (single source of truth)
import { PropertyTypes, type PropertyType } from '../db/schema/notes-cache'
export { PropertyTypes, type PropertyType }

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

// ============================================================================
// Response Types
// ============================================================================

/**
 * Response from set properties operation.
 */
export type SetPropertiesResponse = { success: true } | { success: false; error: string }

// ============================================================================
// Inferred Types
// ============================================================================

export type GetPropertiesInput = z.infer<typeof GetPropertiesSchema>
export type SetPropertiesInput = z.infer<typeof SetPropertiesSchema>
