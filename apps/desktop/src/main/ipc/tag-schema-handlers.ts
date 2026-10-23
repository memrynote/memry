/**
 * Tag schema IPC: the snapshot, the schema command and impact counts. Thin:
 * every decision lives in `tags/schema/`.
 */
import { ipcMain } from 'electron'
import { TagSchemaChannels } from '@memry/contracts/ipc-channels'
import { ImpactQuerySchema, TagSchemaCommandSchema } from '@memry/contracts/tag-schema-api'
import { getIndexDatabase, requireDatabase } from '../database'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getTagSchemaSnapshot, runTagSchemaCommand } from '../tags/schema/commands'
import { previewTagImpact } from '../tags/schema/impact'
import { createHandler, createValidatedHandler } from './validate'

export function registerTagSchemaHandlers(): void {
  ipcMain.handle(
    TagSchemaChannels.invoke.GET_SCHEMA_SNAPSHOT,
    createHandler(() => getTagSchemaSnapshot(requireDatabase(), getIndexDatabase()))
  )

  ipcMain.handle(
    TagSchemaChannels.invoke.EDIT_SCHEMA,
    createValidatedHandler(TagSchemaCommandSchema, (command) =>
      runTagSchemaCommand(requireDatabase(), getIndexDatabase(), command, (event) =>
        broadcastToAllWindows(TagSchemaChannels.events.PROGRESS, event)
      )
    )
  )

  ipcMain.handle(
    TagSchemaChannels.invoke.PREVIEW_IMPACT,
    createValidatedHandler(ImpactQuerySchema, (query) =>
      previewTagImpact(requireDatabase(), getIndexDatabase(), query)
    )
  )
}

export function unregisterTagSchemaHandlers(): void {
  ipcMain.removeHandler(TagSchemaChannels.invoke.GET_SCHEMA_SNAPSHOT)
  ipcMain.removeHandler(TagSchemaChannels.invoke.EDIT_SCHEMA)
  ipcMain.removeHandler(TagSchemaChannels.invoke.PREVIEW_IMPACT)
}
