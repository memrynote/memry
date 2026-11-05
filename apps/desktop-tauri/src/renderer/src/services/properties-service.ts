/**
 * Unified Properties Service
 *
 * Provides a unified API for property operations that works with
 * both notes and journal entries via entity ID. Values are read and written
 * through the `properties_*` commands (#3530 13k-3); relation chips are not
 * ported yet.
 *
 * @module services/properties-service
 */

import type { ResolvedRelationRef } from '@memry/contracts/properties-api'
import { commands, type Value } from '../../../generated/bindings'
import { commandErrorCode, extractErrorMessage } from '../lib/ipc-error'

export type { ResolvedRelationRef }

export interface PropertyValue {
  name: string
  value: unknown
  type: string
}

export interface SetPropertiesResponse {
  success: boolean
  error?: string
  /** On success: the record as stored. */
  properties?: Record<string, unknown>
  /** On success: the names the set deleted because the call left them out. */
  removed?: string[]
}

export interface RenamePropertyResponse {
  success: boolean
  error?: string
}

/** Property values are the JSON the commands carry as is. */
function values(record: Record<string, unknown>): Record<string, Value> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- property values are the JSON the command carries as is
  return record as Record<string, Value>
}

/** A write's failure answered as Electron's `withErrorHandler` answers it. */
function failure(
  error: unknown,
  placeholders?: Record<string, string>
): { success: false; error?: string } {
  const message = extractErrorMessage(error, '', placeholders)
  return message ? { success: false, error: message } : { success: false }
}

/**
 * Unified properties service.
 * Works with any entity ID (note or journal entry).
 */
export const propertiesService = {
  /**
   * Get properties for an entity.
   * @param entityId - Note ID or journal entry ID
   * @returns Array of property values
   */
  get: (entityId: string): Promise<PropertyValue[]> => commands.propertiesGet(entityId),

  /**
   * Set properties for an entity.
   * @param entityId - Note ID or journal entry ID
   * @param properties - Properties record to set
   * @param base - The record `properties` was made from: only the changes
   *   between the two are written, so a value another surface wrote since the
   *   record was read is kept
   * @returns Response with success status
   */
  set: async (
    entityId: string,
    properties: Record<string, unknown>,
    base: Record<string, unknown>
  ): Promise<SetPropertiesResponse> => {
    try {
      const set = await commands.propertiesSet(entityId, values(properties), values(base))
      return { success: true, ...set }
    } catch (error) {
      return failure(error)
    }
  },

  merge: async (
    entityId: string,
    patch: Record<string, unknown>
  ): Promise<SetPropertiesResponse> => {
    try {
      return { success: true, ...(await commands.propertiesMerge(entityId, values(patch))) }
    } catch (error) {
      return failure(error)
    }
  },

  /**
   * Rename a property for an entity.
   * Note-only scope: rename only affects this entity's frontmatter.
   * @param entityId - Note ID or journal entry ID
   * @param oldName - Current property name
   * @param newName - New property name
   * @returns Response with success status
   */
  rename: async (
    entityId: string,
    oldName: string,
    newName: string
  ): Promise<RenamePropertyResponse> => {
    try {
      await commands.propertiesRename(entityId, oldName, newName)
      return { success: true }
    } catch (error) {
      // Electron names the taken new name, or the missing old one.
      const name = commandErrorCode(error) === 'property_exists' ? newName : oldName
      return failure(error, { name })
    }
  },

  /**
   * Resolve relation property URIs (memry://<kind>/<id>) to display data, 1:1 and in order. A
   * malformed or missing ref is `exists: false`; only a failed read rejects.
   */
  resolveRefs: (uris: string[]): Promise<ResolvedRelationRef[]> =>
    commands.propertiesResolveRefs(uris)
}
