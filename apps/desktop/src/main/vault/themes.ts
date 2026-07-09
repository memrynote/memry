import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  CustomThemeSchema,
  sanitizeThemeVariables,
  type CustomTheme
} from '@memry/contracts/themes-api'
import { createLogger } from '../lib/logger'

const log = createLogger('Themes')

const THEMES_DIR = 'themes'

export interface ThemeFileEntry {
  slug: string
  theme: CustomTheme
}

export function getThemesDirPath(vaultPath: string): string {
  return path.join(vaultPath, '.memry', THEMES_DIR)
}

export function slugifyThemeName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'theme'
}

export function uniqueThemeSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugifyThemeName(name)
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

function themeFilePath(vaultPath: string, slug: string): string {
  return path.join(getThemesDirPath(vaultPath), `${slug}.json`)
}

export function readThemeFile(vaultPath: string, slug: string): CustomTheme | null {
  const filePath = themeFilePath(vaultPath, slug)
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const parsed = CustomThemeSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn('Ignoring invalid theme file', { slug, issues: parsed.error.issues.length })
      return null
    }
    return { ...parsed.data, variables: sanitizeThemeVariables(parsed.data.variables) }
  } catch (error) {
    log.warn('Failed to read theme file', { slug, error: String(error) })
    return null
  }
}

export function listThemeFiles(vaultPath: string): ThemeFileEntry[] {
  const dir = getThemesDirPath(vaultPath)
  if (!fs.existsSync(dir)) return []

  const entries: ThemeFileEntry[] = []
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const slug = file.slice(0, -'.json'.length)
    const theme = readThemeFile(vaultPath, slug)
    if (theme) entries.push({ slug, theme })
  }
  return entries
}

export function writeThemeFile(vaultPath: string, slug: string, theme: CustomTheme): void {
  const dir = getThemesDirPath(vaultPath)
  fs.mkdirSync(dir, { recursive: true })

  const filePath = themeFilePath(vaultPath, slug)
  // Atomic write: exclusive temp file, then rename over the target (same
  // pattern as vault-preferences.ts) so a crash never leaves a torn file.
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  const fd = fs.openSync(tempPath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(theme, null, 2), 'utf-8')
    fs.closeSync(fd)
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try {
      fs.closeSync(fd)
    } catch {
      // already closed
    }
    fs.rmSync(tempPath, { force: true })
    throw error
  }
}

export function renameThemeFile(vaultPath: string, oldSlug: string, newSlug: string): void {
  if (oldSlug === newSlug) return
  const oldPath = themeFilePath(vaultPath, oldSlug)
  if (!fs.existsSync(oldPath)) return
  fs.mkdirSync(getThemesDirPath(vaultPath), { recursive: true })
  fs.renameSync(oldPath, themeFilePath(vaultPath, newSlug))
}

export function deleteThemeFile(vaultPath: string, slug: string): void {
  fs.rmSync(themeFilePath(vaultPath, slug), { force: true })
}
