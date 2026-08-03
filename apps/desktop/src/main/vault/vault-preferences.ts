import fs from 'fs'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { getConfigPath } from './init'
import {
  GENERAL_SETTINGS_DEFAULTS,
  EDITOR_SETTINGS_DEFAULTS
} from '@memry/contracts/settings-schemas'
import { LocaleSchema } from '@memry/contracts/locale-api'

const EditorPreferencesSchema = z.object({
  // Legacy widths (narrow/medium/wide) from older config.json coerce to 'normal'.
  width: z.preprocess((v) => (v === 'full' ? 'full' : 'normal'), z.enum(['normal', 'full'])),
  toolbarMode: z.enum(['floating', 'sticky']),
  spellCheck: z.boolean()
})

export const VaultPreferencesSchema = z.object({
  theme: z.enum(['light', 'dark', 'white', 'system']),
  fontSize: z.enum(['small', 'medium', 'large']),
  fontFamily: z.enum(['system', 'serif', 'sans-serif', 'monospace', 'gelasio', 'geist', 'inter']),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  // The supported-locale enum, not a loose length-bounded string. min(2).max(5)
  // rejected nothing the app actually ships — every SUPPORTED_LOCALES entry is
  // 2–5 characters ('fil', 'zh-CN') — while happily accepting values that are
  // not locales at all ('xx', 'zzz', 'en-XX'). Declaration only — readPreferences
  // below stays tolerant on purpose (see its comment).
  language: LocaleSchema,
  createInSelectedFolder: z.boolean(),
  editor: EditorPreferencesSchema
})

export type VaultPreferences = z.infer<typeof VaultPreferencesSchema>
export type EditorPreferences = z.infer<typeof EditorPreferencesSchema>

export const EDITOR_PREFERENCES_DEFAULTS: EditorPreferences = {
  width: EDITOR_SETTINGS_DEFAULTS.width,
  toolbarMode: EDITOR_SETTINGS_DEFAULTS.toolbarMode,
  spellCheck: EDITOR_SETTINGS_DEFAULTS.spellCheck
}

export const VAULT_PREFERENCES_DEFAULTS: VaultPreferences = {
  theme: GENERAL_SETTINGS_DEFAULTS.theme,
  fontSize: GENERAL_SETTINGS_DEFAULTS.fontSize,
  fontFamily: GENERAL_SETTINGS_DEFAULTS.fontFamily,
  accentColor: GENERAL_SETTINGS_DEFAULTS.accentColor,
  language: GENERAL_SETTINGS_DEFAULTS.language,
  createInSelectedFolder: GENERAL_SETTINGS_DEFAULTS.createInSelectedFolder,
  editor: EDITOR_PREFERENCES_DEFAULTS
}

export const PORTABLE_GENERAL_FIELDS = [
  'theme',
  'fontSize',
  'fontFamily',
  'accentColor',
  'language',
  'createInSelectedFolder'
] as const satisfies readonly (keyof VaultPreferences)[]

// Deliberately hand-rolled instead of VaultPreferencesSchema.parse(): config.json
// is written by older (and newer) app versions, so an unrecognised value must
// degrade to the default rather than throw, and an unknown-but-valid-looking
// language must survive the read/merge/write round trip instead of being
// clobbered back to 'en'. Both language consumers (main/index.ts and
// settings-cache.writeCacheFromPreferences) re-validate with LocaleSchema.
export function readPreferences(vaultPath: string): VaultPreferences {
  const configPath = getConfigPath(vaultPath)

  if (!fs.existsSync(configPath)) {
    return { ...VAULT_PREFERENCES_DEFAULTS }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    if (!raw.preferences) {
      return { ...VAULT_PREFERENCES_DEFAULTS }
    }

    const prefs = raw.preferences
    return {
      theme: prefs.theme ?? VAULT_PREFERENCES_DEFAULTS.theme,
      fontSize: prefs.fontSize ?? VAULT_PREFERENCES_DEFAULTS.fontSize,
      fontFamily: prefs.fontFamily ?? VAULT_PREFERENCES_DEFAULTS.fontFamily,
      accentColor: prefs.accentColor ?? VAULT_PREFERENCES_DEFAULTS.accentColor,
      language: prefs.language ?? VAULT_PREFERENCES_DEFAULTS.language,
      createInSelectedFolder:
        prefs.createInSelectedFolder ?? VAULT_PREFERENCES_DEFAULTS.createInSelectedFolder,
      editor: {
        ...EDITOR_PREFERENCES_DEFAULTS,
        ...(prefs.editor ?? {})
      }
    }
  } catch {
    return { ...VAULT_PREFERENCES_DEFAULTS }
  }
}

export function writePreferences(
  vaultPath: string,
  updates: DeepPartial<VaultPreferences>
): VaultPreferences {
  const configPath = getConfigPath(vaultPath)

  let existingConfig: Record<string, unknown> = {}
  try {
    existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }

  const currentPrefs = readPreferences(vaultPath)

  const merged: VaultPreferences = {
    ...currentPrefs,
    ...omitUndefined(updates),
    editor: {
      ...currentPrefs.editor,
      ...(updates.editor ? omitUndefined(updates.editor) : {})
    }
  }

  const newConfig = {
    ...existingConfig,
    preferences: merged
  }

  // Atomic write: create a uniquely-named temp file exclusively (wx) with
  // owner-only permissions, then rename it over the config. This avoids
  // following a shared-dir symlink and never leaves a half-written config.
  const tempPath = `${configPath}.${randomUUID()}.tmp`
  const fd = fs.openSync(tempPath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(newConfig, null, 2), 'utf-8')
    fs.closeSync(fd)
    fs.renameSync(tempPath, configPath)
  } catch (error) {
    try {
      fs.closeSync(fd)
    } catch {
      // already closed
    }
    fs.rmSync(tempPath, { force: true })
    throw error
  }

  return merged
}

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {}
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key]
    }
  }
  return result
}
