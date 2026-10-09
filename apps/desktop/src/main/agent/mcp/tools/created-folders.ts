import { access } from 'node:fs/promises'
import path from 'node:path'

import type { AgentMcpDesktopWriteOperation } from '@memry/contracts/agent-mcp-channels'

import { getConfig, getStatus } from '../../../vault'
import { normalizeFolderPath } from './folder-paths'
import type { CreatedFoldersReply } from './handles'

async function folderExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * The folders, shallowest first, that a write into the vault-relative
 * `folder` creates. Read before the write, since the write creates them.
 */
export async function foldersToCreate(folder: string): Promise<string[]> {
  const vaultPath = getStatus().path
  if (!vaultPath) return []
  const segments = folder.split('/').filter(Boolean)
  const missing: string[] = []
  for (let depth = 1; depth <= segments.length; depth++) {
    const relative = segments.slice(0, depth).join('/')
    if (missing.length > 0 || !(await folderExists(path.join(vaultPath, relative)))) {
      missing.push(relative)
    }
  }
  return missing
}

export function createdFoldersReply(folders: string[]): CreatedFoldersReply {
  return folders.length > 0 ? { created_folders: folders } : {}
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
}

const stringOr = (value: unknown, fallback: string) =>
  typeof value === 'string' && value ? value : fallback

/**
 * The vault-relative folder a desktop API write lands in, when the write
 * creates it. A note or import without a folder goes to the default note
 * folder; a move to '' goes to the vault root. An inbox filing without a path
 * routes by item type, so only a named path is predicted.
 */
const WRITE_FOLDERS: Partial<Record<AgentMcpDesktopWriteOperation, (args: unknown[]) => string>> = {
  'notes.create': ([input]) => stringOr(field(input, 'folder'), getConfig().defaultNoteFolder),
  'notes.importFiles': ([, targetFolder]) => stringOr(targetFolder, getConfig().defaultNoteFolder),
  'notes.move': ([, newFolder]) => stringOr(newFolder, ''),
  'inbox.file': ([input]) => stringOr(field(field(input, 'destination'), 'path'), '')
}

/** Read before a desktop API write: the folders, shallowest first, it would create. */
export async function desktopWriteFoldersToCreate(request: {
  operation: AgentMcpDesktopWriteOperation
  args: unknown[]
}): Promise<string[]> {
  const folder = WRITE_FOLDERS[request.operation]?.(request.args)
  return folder ? foldersToCreate(normalizeFolderPath(folder)) : []
}

/**
 * Add `created_folders` to a desktop API reply once the write has landed.
 * Keeps only the predicted folders that now exist: a new-note filing ignores
 * its destination path, so a prediction can name a folder the write never made.
 */
export async function withCreatedFolders(reply: unknown, predicted: string[]): Promise<unknown> {
  if (predicted.length === 0 || field(reply, 'success') === false) return reply
  const vaultPath = getStatus().path
  if (!vaultPath) return reply
  const folders: string[] = []
  for (const folder of predicted) {
    if (await folderExists(path.join(vaultPath, folder))) folders.push(folder)
  }
  if (folders.length === 0) return reply
  const base =
    reply && typeof reply === 'object' && !Array.isArray(reply) ? reply : { result: reply }
  return { ...base, ...createdFoldersReply(folders) }
}
