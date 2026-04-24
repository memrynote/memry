/**
 * Unified Properties Service
 *
 * Provides a unified API for property operations that works with
 * both notes and journal entries via entity ID.
 *
 * @module services/properties-service
 */

import { createInvokeForwarder } from '@/lib/ipc/forwarder'

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

interface PropertiesClientAPI {
  get(entityId: string): Promise<PropertyValue[]>
  set(entityId: string, properties: Record<string, unknown>): Promise<SetPropertiesResponse>
  rename(
    entityId: string,
    oldName: string,
    newName: string
  ): Promise<RenamePropertyResponse>
}

/**
 * Unified properties service.
 * Works with any entity ID (note or journal entry).
 */
export const propertiesService: PropertiesClientAPI =
  createInvokeForwarder<PropertiesClientAPI>('properties')
