import { ipcMain } from 'electron'
import { z } from 'zod'
import { NotesChannels } from '@memry/contracts/notes-api'
import { CreatePropertyDefinitionSchema, UpdatePropertyDefinitionSchema } from './notes-schemas'
import { createValidatedHandler, createHandler } from './validate'
import {
  getAllPropertyDefinitions,
  insertPropertyDefinition,
  updatePropertyDefinition
} from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { extractError } from './handler-utils'

const SELECT_TYPES = new Set(['status', 'select', 'multiselect'])

export function registerPropertyDefinitionHandlers(): void {
  ipcMain.handle(
    NotesChannels.invoke.GET_PROPERTY_DEFINITIONS,
    createHandler(() => {
      const db = getIndexDatabase()
      return getAllPropertyDefinitions(db)
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.CREATE_PROPERTY_DEFINITION,
    createValidatedHandler(CreatePropertyDefinitionSchema, async (input) => {
      try {
        if (SELECT_TYPES.has(input.type)) {
          const { PropertyDefinitionsService } = await import('../vault/property-definitions')
          const service = PropertyDefinitionsService.get()
          await service.upsert({
            name: input.name,
            type: input.type,
            options: input.type !== 'status' ? input.options : undefined,
            defaultValue: input.defaultValue != null ? String(input.defaultValue) : undefined
          })
          return { success: true, definition: service.get(input.name) }
        }

        const db = getIndexDatabase()
        const definition = insertPropertyDefinition(db, {
          name: input.name,
          type: input.type,
          options: input.options ? JSON.stringify(input.options) : null,
          defaultValue: input.defaultValue ? JSON.stringify(input.defaultValue) : null,
          color: input.color ?? null
        })
        return { success: true, definition }
      } catch (error) {
        return {
          success: false,
          definition: null,
          error: extractError(error, 'Failed to create property definition')
        }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION,
    createValidatedHandler(UpdatePropertyDefinitionSchema, async (input) => {
      try {
        const isSelectType =
          input.type === 'status' || input.type === 'select' || input.type === 'multiselect'

        if (isSelectType) {
          const { PropertyDefinitionsService } = await import('../vault/property-definitions')
          const service = PropertyDefinitionsService.get()
          await service.upsert({
            name: input.name,
            type: input.type,
            options: input.options,
            defaultValue: input.defaultValue != null ? String(input.defaultValue) : undefined
          })
          return { success: true, definition: service.get(input.name) }
        }

        const db = getIndexDatabase()
        const { name, ...updates } = input
        const definition = updatePropertyDefinition(db, name, {
          type: updates.type,
          options: updates.options ? JSON.stringify(updates.options) : undefined,
          defaultValue: updates.defaultValue ? JSON.stringify(updates.defaultValue) : undefined,
          color: updates.color
        })
        return { success: true, definition }
      } catch (error) {
        return {
          success: false,
          definition: null,
          error: extractError(error, 'Failed to update property definition')
        }
      }
    })
  )

  // Property option CRUD handlers (select/status/multiselect)
  ipcMain.handle(
    NotesChannels.invoke.ENSURE_PROPERTY_DEFINITION,
    createValidatedHandler(
      z.object({ name: z.string().min(1), type: z.string().min(1) }),
      async (input) => {
        try {
          if (SELECT_TYPES.has(input.type)) {
            const { PropertyDefinitionsService, DEFAULT_STATUS_DEFINITION } =
              await import('../vault/property-definitions')
            const service = PropertyDefinitionsService.get()
            const existing = service.get(input.name)
            if (!existing) {
              await service.upsert({ ...DEFAULT_STATUS_DEFINITION, name: input.name })
            }
            return { success: true, definition: service.get(input.name) }
          }

          const db = getIndexDatabase()
          const definition = insertPropertyDefinition(db, {
            name: input.name,
            type: input.type,
            options: null,
            defaultValue: null,
            color: null
          })
          return { success: true, definition }
        } catch (error) {
          return {
            success: false,
            definition: null,
            error: extractError(error, 'Failed to ensure property definition')
          }
        }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.ADD_STATUS_OPTION,
    createValidatedHandler(
      z.object({
        propertyName: z.string().min(1),
        categoryKey: z.string().min(1),
        option: z.object({ value: z.string(), color: z.string() })
      }),
      async (input) => {
        const { PropertyDefinitionsService, DEFAULT_STATUS_DEFINITION } =
          await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        const existing = service.get(input.propertyName)
        if (!existing) {
          await service.upsert({ ...DEFAULT_STATUS_DEFINITION, name: input.propertyName })
        }
        await service.addStatusOption(input.propertyName, input.categoryKey, input.option)
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.REMOVE_PROPERTY_OPTION,
    createValidatedHandler(
      z.object({ propertyName: z.string().min(1), optionValue: z.string().min(1) }),
      async (input) => {
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        await service.removeOption(input.propertyName, input.optionValue)
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.RENAME_PROPERTY_OPTION,
    createValidatedHandler(
      z.object({
        propertyName: z.string().min(1),
        oldValue: z.string().min(1),
        newValue: z.string().min(1)
      }),
      async (input) => {
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        await service.renameOption(input.propertyName, input.oldValue, input.newValue)
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.UPDATE_OPTION_COLOR,
    createValidatedHandler(
      z.object({
        propertyName: z.string().min(1),
        optionValue: z.string().min(1),
        newColor: z.string().min(1)
      }),
      async (input) => {
        const { PropertyDefinitionsService } = await import('../vault/property-definitions')
        const service = PropertyDefinitionsService.get()
        await service.updateOptionColor(input.propertyName, input.optionValue, input.newColor)
        return { success: true }
      }
    )
  )

  ipcMain.handle(
    NotesChannels.invoke.DELETE_PROPERTY_DEFINITION,
    createValidatedHandler(z.object({ name: z.string().min(1) }), async (input) => {
      const { PropertyDefinitionsService } = await import('../vault/property-definitions')
      const service = PropertyDefinitionsService.get()
      await service.remove(input.name)
      return { success: true }
    })
  )
}

export function unregisterPropertyDefinitionHandlers(): void {
  ipcMain.removeHandler(NotesChannels.invoke.GET_PROPERTY_DEFINITIONS)
  ipcMain.removeHandler(NotesChannels.invoke.CREATE_PROPERTY_DEFINITION)
  ipcMain.removeHandler(NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION)
  ipcMain.removeHandler(NotesChannels.invoke.ENSURE_PROPERTY_DEFINITION)
  ipcMain.removeHandler(NotesChannels.invoke.ADD_STATUS_OPTION)
  ipcMain.removeHandler(NotesChannels.invoke.REMOVE_PROPERTY_OPTION)
  ipcMain.removeHandler(NotesChannels.invoke.RENAME_PROPERTY_OPTION)
  ipcMain.removeHandler(NotesChannels.invoke.UPDATE_OPTION_COLOR)
  ipcMain.removeHandler(NotesChannels.invoke.DELETE_PROPERTY_DEFINITION)
}
