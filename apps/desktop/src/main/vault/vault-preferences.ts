import fs from 'fs'
import { z } from 'zod'
import { getConfigPath } from './init'
import {
  GENERAL_SETTINGS_DEFAULTS,
  EDITOR_SETTINGS_DEFAULTS
} from '@memry/contracts/settings-schemas'

const EditorPreferencesSchema = z.object({
  width: z.enum(['narrow', 'medium', 'wide']),
  spellCheck: z.boolean(),
  autoSaveDelay: z.number().int().min(0).max(30000),
  showWordCount: z.boolean(),
  toolbarMode: z.enum(['floating', 'sticky'])
})

export const VaultPreferencesSchema = z.object({
  theme: z.enum(['light', 'dark', 'white', 'system']),
  fontSize: z.enum(['small', 'medium', 'large']),
  fontFamily: z.enum(['system', 'serif', 'sans-serif', 'monospace', 'gelasio', 'geist', 'inter']),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  language: z.string().min(2).max(5),
  createInSelectedFolder: z.boolean(),
  editor: EditorPreferencesSchema
})

export type VaultPreferences = z.infer<typeof VaultPreferencesSchema>
export type EditorPreferences = z.infer<typeof EditorPreferencesSchema>

export const EDITOR_PREFERENCES_DEFAULTS: EditorPreferences = {
  width: EDITOR_SETTINGS_DEFAULTS.width,
  spellCheck: EDITOR_SETTINGS_DEFAULTS.spellCheck,
  autoSaveDelay: EDITOR_SETTINGS_DEFAULTS.autoSaveDelay,
  showWordCount: EDITOR_SETTINGS_DEFAULTS.showWordCount,
  toolbarMode: EDITOR_SETTINGS_DEFAULTS.toolbarMode
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

  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8')
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
