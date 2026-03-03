/**
 * Unified Properties Service
 *
 * Provides a unified API for property operations that works with
 * both notes and journal entries via entity ID.
 *
 * @module services/properties-service
 */

export interface PropertyValue {
  name: string
  value: unknown
  type: string
}

export interface SetPropertiesResponse {
  success: boolean
  error?: string
}

export interface RenamePropertyResponse {
  success: boolean
  error?: string
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
  get: (entityId: string): Promise<PropertyValue[]> => {
    return window.api.properties.get(entityId)
  },

  /**
   * Set properties for an entity.
   * @param entityId - Note ID or journal entry ID
   * @param properties - Properties record to set
   * @returns Response with success status
   */
  set: (entityId: string, properties: Record<string, unknown>): Promise<SetPropertiesResponse> => {
    return window.api.properties.set(entityId, properties)
  },

  /**
   * Rename a property for an entity.
   * Note-only scope: rename only affects this entity's frontmatter.
   * @param entityId - Note ID or journal entry ID
   * @param oldName - Current property name
   * @param newName - New property name
   * @returns Response with success status
   */
  rename: (entityId: string, oldName: string, newName: string): Promise<RenamePropertyResponse> => {
    return window.api.properties.rename(entityId, oldName, newName)
  }
}
