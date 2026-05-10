import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUPPORTED_LOCALES = [
  'ar',
  'cs',
  'da',
  'en',
  'de',
  'el',
  'es',
  'fi',
  'fil',
  'fr',
  'he',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh-CN',
  'zh-TW'
]
export const FALLBACK_LOCALE = 'en'

const CONFIG_ARRAY_RE = /I18N_NAMESPACES\s*=\s*\[([\s\S]*?)\]\s+as const/m
const STRING_RE = /'([^']+)'|"([^"]+)"/g

export function defaultWorkspaceRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw)
}

export function loadNamespaces(workspaceRoot = defaultWorkspaceRoot()) {
  const configPath = path.join(workspaceRoot, 'packages/i18n/src/shared/config.ts')
  const configText = fs.readFileSync(configPath, 'utf8')
  const match = configText.match(CONFIG_ARRAY_RE)

  if (!match) {
    throw new Error(
      `Could not read I18N_NAMESPACES from ${path.relative(workspaceRoot, configPath)}`
    )
  }

  const namespaces = []
  for (const stringMatch of match[1].matchAll(STRING_RE)) {
    namespaces.push(stringMatch[1] ?? stringMatch[2])
  }

  if (namespaces.length === 0) {
    throw new Error('I18N_NAMESPACES is empty')
  }

  return namespaces
}

export function loadLocaleResources(workspaceRoot = defaultWorkspaceRoot()) {
  const namespaces = loadNamespaces(workspaceRoot)
  const resources = {}
  const errors = []

  for (const locale of SUPPORTED_LOCALES) {
    resources[locale] = {}

    for (const namespace of namespaces) {
      const jsonPath = path.join(
        workspaceRoot,
        'packages/i18n/src/locales',
        locale,
        `${namespace}.json`
      )

      try {
        resources[locale][namespace] = readJson(jsonPath)
      } catch (error) {
        errors.push({
          locale,
          namespace,
          file: path.relative(workspaceRoot, jsonPath),
          message: error instanceof Error ? error.message : String(error)
        })
        resources[locale][namespace] = {}
      }
    }
  }

  return {
    workspaceRoot,
    locales: SUPPORTED_LOCALES,
    fallbackLocale: FALLBACK_LOCALE,
    namespaces,
    resources,
    errors
  }
}

export function flattenKeys(namespace, value, prefix = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []

  const keys = []

  for (const [childKey, childValue] of Object.entries(value)) {
    const nextPrefix = [...prefix, childKey]

    if (typeof childValue === 'string') {
      keys.push(`${namespace}:${nextPrefix.join('.')}`)
    } else if (childValue && typeof childValue === 'object' && !Array.isArray(childValue)) {
      keys.push(...flattenKeys(namespace, childValue, nextPrefix))
    }
  }

  return keys
}

export function flattenLocale(localeResources) {
  const keys = new Set()

  for (const [namespace, namespaceResources] of Object.entries(localeResources)) {
    for (const key of flattenKeys(namespace, namespaceResources)) {
      keys.add(key)
    }
  }

  return keys
}

export function hasEnglishKey(key, englishKeys) {
  return englishKeys.has(key)
}

export function compareLocaleCompleteness({ englishKeys, localeKeys }) {
  const missing = []
  const orphan = []

  for (const key of englishKeys) {
    if (!localeKeys.has(key)) missing.push(key)
  }

  for (const key of localeKeys) {
    if (!englishKeys.has(key)) orphan.push(key)
  }

  return {
    missing: missing.sort(),
    orphan: orphan.sort()
  }
}
