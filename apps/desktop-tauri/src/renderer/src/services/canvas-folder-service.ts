/**
 * Canvas Folder Service
 *
 * The canvas folder commands of Step 30e1 (`commands/canvas_folders.rs`) in the shapes of
 * Electron's `canvasFolder:*` channels. A refusal rejects with its `errors:canvasFolder.*` key
 * as the message, which `extractErrorMessage` translates, as Electron's handler did.
 */

import type {
  CanvasFolder,
  CanvasFolderClientAPI,
  CanvasFolderCreatedEvent,
  CanvasFolderUpdatedEvent,
  CanvasFolderDeletedEvent
} from '@memry/rpc/canvas-folder'
import { commands, events } from '../../../generated/bindings'
import { subscribeToEvent } from './tauri-event'

export type { CanvasFolder }

export const canvasFolderService: CanvasFolderClientAPI = {
  list: () => commands.canvasFolderList(),
  create: ({ parent, name }) => commands.canvasFolderCreate(parent ?? null, name),
  rename: ({ path, name }) => commands.canvasFolderRename(path, name),
  move: ({ path, parent }) => commands.canvasFolderMove(path, parent),
  setIcon: ({ path, icon }) => commands.canvasFolderSetIcon(path, icon),
  delete: ({ path }) => commands.canvasFolderDelete(path)
}

export function onCanvasFolderCreated(
  callback: (event: CanvasFolderCreatedEvent) => void
): () => void {
  return subscribeToEvent(events.canvasFolderCreatedEvent, callback)
}

export function onCanvasFolderUpdated(
  callback: (event: CanvasFolderUpdatedEvent) => void
): () => void {
  return subscribeToEvent(events.canvasFolderUpdatedEvent, ({ folder, previousPath }) =>
    callback(previousPath ? { folder, previousPath } : { folder })
  )
}

export function onCanvasFolderDeleted(
  callback: (event: CanvasFolderDeletedEvent) => void
): () => void {
  return subscribeToEvent(events.canvasFolderDeletedEvent, callback)
}
