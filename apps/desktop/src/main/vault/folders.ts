/**
 * Folder configuration operations.
 * Manages folder-level template settings stored in .folder.md files.
 *
 * @module vault/folders
 */

import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import matter from 'gray-matter'
import { getStatus } from './index'
import { VaultError, VaultErrorCode } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import type { FolderConfig } from '@memry/contracts/templates-api'

const logger = createLogger('VaultFolders')

// ============================================================================
// Constants
// ============================================================================

const FOLDER_CONFIG_FILE = '.folder.md'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the vault path, throwing if no vault is open.
 */
function getVaultPath(): string {
  const status = getStatus()
  if (!status.path) {
    throw new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
  }
  return status.path
}

/**
 * Get the absolute path for a folder config file.
 * @param folderPath - Vault-relative folder path (e.g., "projects/active")
 */
function getFolderConfigPath(folderPath: string): string {
  const notesDir = getVaultPath()
  // Handle root folder
  if (!folderPath || folderPath === '' || folderPath === '.') {
    return path.join(notesDir, FOLDER_CONFIG_FILE)
  }
  return path.join(notesDir, folderPath, FOLDER_CONFIG_FILE)
}

/**
 * Parse a folder config file.
 * Supports both template configuration and view configuration (Folder View/Bases).
 */
function parseFolderConfig(content: string): FolderConfig {
  const { data } = matter(content)

  return {
    // Icon
    icon: typeof data.icon === 'string' ? data.icon : undefined,
    // Template configuration
    template: typeof data.template === 'string' ? data.template : undefined,
    inherit: data.inherit !== false, // Default to true

    // View configuration (Folder View / Bases feature)
    views: Array.isArray(data.views) ? data.views : undefined,
    formulas:
      data.formulas && typeof data.formulas === 'object'
        ? (data.formulas as Record<string, string>)
        : undefined,
    properties:
      data.properties && typeof data.properties === 'object'
        ? (data.properties as FolderConfig['properties'])
        : undefined,
    summaries:
      data.summaries && typeof data.summaries === 'object'
        ? (data.summaries as FolderConfig['summaries'])
        : undefined
  }
}

/**
 * Serialize a folder config to file content.
 * Supports both template configuration and view configuration (Folder View/Bases).
 */
function serializeFolderConfig(config: FolderConfig): string {
  const frontmatter: Record<string, unknown> = {}

  // Icon
  if (config.icon) {
    frontmatter.icon = config.icon
  }

  // Template configuration
  if (config.template) {
    frontmatter.template = config.template
  }

  if (config.inherit === false) {
    frontmatter.inherit = false
  }

  // View configuration (Folder View / Bases feature)
  if (config.views && config.views.length > 0) {
    frontmatter.views = config.views
  }

  if (config.formulas && Object.keys(config.formulas).length > 0) {
    frontmatter.formulas = config.formulas
  }

  if (config.properties && Object.keys(config.properties).length > 0) {
    frontmatter.properties = config.properties
  }

  if (config.summaries && Object.keys(config.summaries).length > 0) {
    frontmatter.summaries = config.summaries
  }

  return matter.stringify('', frontmatter)
}

// ============================================================================
// Folder Config Operations
// ============================================================================

/**
 * Check if a folder exists in the vault.
 *
 * Vault-relative on purpose: `defaultNoteFolder` is a destination for new
 * notes, not a tree root, so it must not take part in resolving a folder the
 * sidebar handed us (#1204).
 *
 * @param folderPath - Vault-relative folder path (e.g., "projects/active")
 * @returns true if folder exists, false otherwise
 */
export function folderExists(folderPath: string): boolean {
  const notesDir = getVaultPath()
  // Handle root folder
  if (!folderPath || folderPath === '' || folderPath === '.') {
    return existsSync(notesDir)
  }
  const fullPath = path.join(notesDir, folderPath)
  return existsSync(fullPath)
}

/**
 * Read folder config from .folder.md file.
 * @param folderPath - Relative path from notes directory
 * @returns FolderConfig or null if not found
 */
export async function readFolderConfig(folderPath: string): Promise<FolderConfig | null> {
  const configPath = getFolderConfigPath(folderPath)

  try {
    if (!existsSync(configPath)) {
      return null
    }
    const content = await fs.readFile(configPath, 'utf-8')
    return parseFolderConfig(content)
  } catch (error) {
    // The file exists but could not be read/parsed. SET_FOLDER_CONFIG merges
    // views/formulas from this read before writing, so a silent null here lets
    // the next write wipe the folder's saved views (#720 clobber class).
    logger.warn('Failed to read folder config', { folderPath, error })
    trackMainError('notes', 'folder_config_read', error)
    return null
  }
}

/**
 * Write folder config to .folder.md file.
 * @param folderPath - Relative path from notes directory
 * @param config - Configuration to write
 */
export async function writeFolderConfig(folderPath: string, config: FolderConfig): Promise<void> {
  const configPath = getFolderConfigPath(folderPath)

  // Ensure the folder exists
  const folderDir = path.dirname(configPath)
  if (!existsSync(folderDir)) {
    await fs.mkdir(folderDir, { recursive: true })
  }

  // Check if config has any meaningful content
  const hasIconConfig = !!config.icon
  const hasTemplateConfig = config.template || config.inherit === false
  const hasViewConfig =
    (config.views && config.views.length > 0) ||
    (config.formulas && Object.keys(config.formulas).length > 0) ||
    (config.properties && Object.keys(config.properties).length > 0) ||
    (config.summaries && Object.keys(config.summaries).length > 0)

  // If config is empty, delete the file
  if (!hasIconConfig && !hasTemplateConfig && !hasViewConfig) {
    if (existsSync(configPath)) {
      await fs.unlink(configPath)
    }
    return
  }

  const content = serializeFolderConfig(config)
  await fs.writeFile(configPath, content, 'utf-8')
}

/**
 * Get the resolved template for a folder, following inheritance chain.
 * @param folderPath - Relative path from notes directory
 * @returns Template ID or null if no template is set
 */
export async function getFolderTemplate(folderPath: string): Promise<string | null> {
  // Normalize folder path
  let currentPath = folderPath || ''
  if (currentPath === '.') currentPath = ''

  // Walk up the folder tree
  while (true) {
    const config = await readFolderConfig(currentPath)

    if (config) {
      // If template is set, return it
      if (config.template) {
        return config.template
      }

      // If inherit is explicitly false, stop here
      if (config.inherit === false) {
        return null
      }
    }

    // If we're at the root notes folder, stop
    if (!currentPath || currentPath === '' || currentPath === '.') {
      break
    }

    // Move to parent folder
    currentPath = path.dirname(currentPath)
    if (currentPath === '.') currentPath = ''
  }

  return null
}

/**
 * Set the default template for a folder.
 * @param folderPath - Relative path from notes directory
 * @param templateId - Template ID or null to clear
 */
export async function setFolderTemplate(
  folderPath: string,
  templateId: string | null
): Promise<void> {
  const currentConfig = (await readFolderConfig(folderPath)) || {}

  await writeFolderConfig(folderPath, {
    ...currentConfig,
    template: templateId || undefined
  })
}

/**
 * Check if a path is the .folder.md config file.
 * Used by file watcher to ignore these files.
 */
export function isFolderConfigFile(filePath: string): boolean {
  return path.basename(filePath) === FOLDER_CONFIG_FILE
}
