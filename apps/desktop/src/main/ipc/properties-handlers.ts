/**
 * Unified Properties IPC Handlers
 *
 * Handles property get/set operations for both notes and journal entries.
 * Routes to appropriate update logic based on entity type (determined by
 * checking if the entity has a date field in the cache).
 *
 * @module ipc/properties-handlers
 */

import { ipcMain } from 'electron'
import {
  PropertiesChannels,
  GetPropertiesSchema,
  SetPropertiesSchema,
  RenamePropertySchema,
  type SetPropertiesResponse,
  type RenamePropertyResponse
} from '@memry/contracts/properties-api'
import type { PropertyValue } from '../notes/store'
import { createValidatedHandler, withErrorHandler } from './validate'
import { getNoteCacheById, getNoteProperties } from '../notes/store'
import { getIndexDatabase } from '../database'
import { setEntityProperties } from '../notes/entity-properties'
import { getMainI18n } from '../lib/main-i18n'

// ============================================================================
// Handler Registration
// ============================================================================

/**
 * Register all properties-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerPropertiesHandlers(): void {
  // -------------------------------------------------------------------------
  // properties:get - Get properties for any entity by ID
  // -------------------------------------------------------------------------
  ipcMain.handle(
    PropertiesChannels.invoke.GET,
    createValidatedHandler(GetPropertiesSchema, async (input): Promise<PropertyValue[]> => {
      const db = getIndexDatabase()
      return getNoteProperties(db, input.entityId)
    })
  )

  // -------------------------------------------------------------------------
  // properties:set - Set properties for any entity by ID
  // -------------------------------------------------------------------------
  ipcMain.handle(
    PropertiesChannels.invoke.SET,
    createValidatedHandler(
      SetPropertiesSchema,
      withErrorHandler(async (input): Promise<SetPropertiesResponse> => {
        return setEntityProperties(input.entityId, input.properties)
      }, 'errors:property.setFailed')
    )
  )

  // -------------------------------------------------------------------------
  // properties:rename - Rename a property for any entity by ID (note-only scope)
  // -------------------------------------------------------------------------
  ipcMain.handle(
    PropertiesChannels.invoke.RENAME,
    createValidatedHandler(
      RenamePropertySchema,
      withErrorHandler(async (input): Promise<RenamePropertyResponse> => {
        const db = getIndexDatabase()
        const entity = getNoteCacheById(db, input.entityId)

        if (!entity) {
          return { success: false, error: getMainI18n().t('errors:property.entityNotFound') }
        }

        const existingProps = getNoteProperties(db, input.entityId)
        const propToRename = existingProps.find((p) => p.name === input.oldName)

        if (!propToRename) {
          return {
            success: false,
            error: getMainI18n().t('errors:property.notFound', { name: input.oldName })
          }
        }

        if (existingProps.some((p) => p.name === input.newName)) {
          return {
            success: false,
            error: getMainI18n().t('errors:property.alreadyExists', { name: input.newName })
          }
        }

        const newProperties: Record<string, unknown> = {}
        for (const prop of existingProps) {
          if (prop.name === input.oldName) {
            newProperties[input.newName] = prop.value
          } else {
            newProperties[prop.name] = prop.value
          }
        }

        return setEntityProperties(input.entityId, newProperties)
      }, 'errors:property.renameFailed')
    )
  )
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Unregister all properties-related IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterPropertiesHandlers(): void {
  ipcMain.removeHandler(PropertiesChannels.invoke.GET)
  ipcMain.removeHandler(PropertiesChannels.invoke.SET)
  ipcMain.removeHandler(PropertiesChannels.invoke.RENAME)
}
