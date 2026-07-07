/**
 * Read-only accessors for a vault's `.obsidian/` configuration.
 *
 * Memry treats `.obsidian/` as strictly read-only: these helpers surface the
 * user's Obsidian settings (daily notes, attachment/link preferences, property
 * types) so Memry can behave consistently with them. Every reader is
 * best-effort — a missing folder, missing file, or malformed JSON yields
 * `null`, never a throw. `workspace.json` is intentionally never read (it
 * churns constantly). No write API exists in this module by design.
 *
 * Only the default `.obsidian` folder name is supported; vaults using
 * Obsidian's "Override config folder" setting simply get no seeding.
 */

import fs from 'fs'
import path from 'path'
import type { PropertyType } from '@memry/contracts/property-types'
import { createLogger } from '../lib/logger'

const logger = createLogger('ObsidianConfig')

export interface ObsidianDailyNotesConfig {
  folder?: string // relative to vault root
  format?: string // Moment tokens; may contain '/' → subfolders
  template?: string // ignored in v1 — Memry has its own template system
}

export interface ObsidianAppConfig {
  attachmentFolderPath?: string // '' | 'folder' | './' | './sub' (note-relative)
  newLinkFormat?: 'shortest' | 'relative' | 'absolute'
  useMarkdownLinks?: boolean
}

const OBSIDIAN_PROPERTY_TYPES = [
  'text',
  'multitext',
  'number',
  'checkbox',
  'date',
  'datetime',
  'tags'
] as const

export type ObsidianPropertyType = (typeof OBSIDIAN_PROPERTY_TYPES)[number]

function readObsidianJson(vaultPath: string, file: string): Record<string, unknown> | null {
  const filePath = path.join(vaultPath, '.obsidian', file)
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug(`Ignoring unreadable .obsidian/${file}:`, error)
    }
    return null
  }
}

export function hasObsidianDir(vaultPath: string): boolean {
  try {
    return fs.statSync(path.join(vaultPath, '.obsidian')).isDirectory()
  } catch {
    return false
  }
}

export function readDailyNotesConfig(vaultPath: string): ObsidianDailyNotesConfig | null {
  const raw = readObsidianJson(vaultPath, 'daily-notes.json')
  if (!raw) return null
  const config: ObsidianDailyNotesConfig = {}
  if (typeof raw.folder === 'string') config.folder = raw.folder
  if (typeof raw.format === 'string') config.format = raw.format
  if (typeof raw.template === 'string') config.template = raw.template
  return config
}

export function readAppConfig(vaultPath: string): ObsidianAppConfig | null {
  const raw = readObsidianJson(vaultPath, 'app.json')
  if (!raw) return null
  const config: ObsidianAppConfig = {}
  if (typeof raw.attachmentFolderPath === 'string') {
    config.attachmentFolderPath = raw.attachmentFolderPath
  }
  if (
    raw.newLinkFormat === 'shortest' ||
    raw.newLinkFormat === 'relative' ||
    raw.newLinkFormat === 'absolute'
  ) {
    config.newLinkFormat = raw.newLinkFormat
  }
  if (typeof raw.useMarkdownLinks === 'boolean') config.useMarkdownLinks = raw.useMarkdownLinks
  return config
}

export function readPropertyTypes(vaultPath: string): Record<string, ObsidianPropertyType> | null {
  const raw = readObsidianJson(vaultPath, 'types.json')
  const types = raw?.types
  if (!types || typeof types !== 'object' || Array.isArray(types)) return null
  const result: Record<string, ObsidianPropertyType> = {}
  for (const [name, value] of Object.entries(types)) {
    if ((OBSIDIAN_PROPERTY_TYPES as readonly unknown[]).includes(value)) {
      result[name.toLowerCase()] = value as ObsidianPropertyType
    }
  }
  return result
}

const OBSIDIAN_TO_MEMRY: Record<ObsidianPropertyType, PropertyType | null> = {
  text: 'text',
  multitext: 'multiselect',
  number: 'number',
  checkbox: 'checkbox',
  date: 'date',
  datetime: 'date',
  tags: null // reserved key — tag handling is owned by the tags pipeline, not properties
}

export function mapObsidianType(t: ObsidianPropertyType): PropertyType | null {
  return OBSIDIAN_TO_MEMRY[t] ?? null
}

// ============================================================================
// Property-type holder
//
// Same pattern as journal-config: inferPropertyType call sites don't have the
// vault path in scope, so the mapped types.json content is held process-wide.
// Loaded on vault open and refreshed on reindex.
// ============================================================================

let propertyTypesByName: Record<string, PropertyType> = {}

export function loadObsidianPropertyTypes(vaultPath: string): void {
  const next: Record<string, PropertyType> = {}
  for (const [name, obsidianType] of Object.entries(readPropertyTypes(vaultPath) ?? {})) {
    const mapped = mapObsidianType(obsidianType)
    if (mapped) next[name] = mapped
  }
  propertyTypesByName = next
}

export function getObsidianPropertyType(name: string): PropertyType | null {
  return propertyTypesByName[name.toLowerCase()] ?? null
}
