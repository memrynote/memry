/**
 * Custom theme IPC handlers.
 *
 * @module ipc/themes-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import { ThemesChannels } from '@memry/contracts/ipc-channels'
import {
  CreateThemeInputSchema,
  DeleteThemePayloadSchema,
  UpdateThemePayloadSchema,
  type CreateThemeInput,
  type CustomTheme,
  type DeleteThemePayload,
  type UpdateThemePayload
} from '@memry/contracts/themes-api'
import { createHandler, createValidatedHandler } from './validate'
import { requireDatabase } from '../database'
import {
  adoptThemeFiles,
  createTheme,
  deleteTheme,
  listThemes,
  updateTheme
} from '../themes/theme-store'
import type { DrizzleDb } from '../sync/item-handlers/types'

interface ThemeMutationResult {
  success: boolean
  theme?: CustomTheme
  error?: string
}

function emitThemeEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

export function makeThemesHandlers(db: DrizzleDb): {
  list: () => CustomTheme[]
  create: (input: CreateThemeInput) => ThemeMutationResult
  update: (input: UpdateThemePayload) => ThemeMutationResult
  delete: (input: DeleteThemePayload) => { success: boolean; error?: string }
} {
  return {
    list: () => {
      adoptThemeFiles(db)
      return listThemes(db)
    },
    create: (input) => {
      const theme = createTheme(db, input)
      emitThemeEvent(ThemesChannels.events.CREATED, { id: theme.id })
      return { success: true, theme }
    },
    update: ({ id, ...updates }) => {
      const theme = updateTheme(db, id, updates)
      if (!theme) {
        return { success: false, error: 'Theme not found' }
      }
      emitThemeEvent(ThemesChannels.events.UPDATED, { id })
      return { success: true, theme }
    },
    delete: ({ id }) => {
      if (!deleteTheme(db, id)) {
        return { success: false, error: 'Theme not found' }
      }
      emitThemeEvent(ThemesChannels.events.DELETED, { id })
      return { success: true }
    }
  }
}

export function registerThemesHandlers(): void {
  ipcMain.handle(
    ThemesChannels.invoke.LIST,
    createHandler(() => makeThemesHandlers(requireDatabase() as unknown as DrizzleDb).list())
  )

  ipcMain.handle(
    ThemesChannels.invoke.CREATE,
    createValidatedHandler(CreateThemeInputSchema, (input) =>
      makeThemesHandlers(requireDatabase() as unknown as DrizzleDb).create(input)
    )
  )

  ipcMain.handle(
    ThemesChannels.invoke.UPDATE,
    createValidatedHandler(UpdateThemePayloadSchema, (input) =>
      makeThemesHandlers(requireDatabase() as unknown as DrizzleDb).update(input)
    )
  )

  ipcMain.handle(
    ThemesChannels.invoke.DELETE,
    createValidatedHandler(DeleteThemePayloadSchema, (input) =>
      makeThemesHandlers(requireDatabase() as unknown as DrizzleDb).delete(input)
    )
  )
}

export function unregisterThemesHandlers(): void {
  for (const channel of Object.values(ThemesChannels.invoke)) {
    ipcMain.removeHandler(channel)
  }
}
