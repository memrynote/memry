#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FALLBACK_LOCALE,
  compareLocaleCompleteness,
  defaultWorkspaceRoot,
  flattenLocale,
  loadLocaleResources
} from './resources.mjs'
import { scanSourceFiles } from './scan-source.mjs'
import { formatJsonReport, formatTextReport } from './report.mjs'

function parseNumber(value, optionName) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer`)
  }
  return parsed
}

export function parseArgs(argv, cwd = process.cwd()) {
  const options = {
    paths: null,
    format: 'text',
    maxTodo: null,
    allowTodo: true,
    strictTodo: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--paths') {
      const paths = []
      index += 1
      while (index < argv.length && !argv[index].startsWith('--')) {
        paths.push(path.resolve(cwd, argv[index]))
        index += 1
      }
      index -= 1
      options.paths = paths
      continue
    }

    if (arg === '--format') {
      const value = argv[index + 1]
      if (value !== 'text' && value !== 'json') {
        throw new Error('--format must be text or json')
      }
      options.format = value
      index += 1
      continue
    }

    if (arg === '--max-todo') {
      options.maxTodo = parseNumber(argv[index + 1], '--max-todo')
      index += 1
      continue
    }

    if (arg === '--allow-todo') {
      options.allowTodo = true
      continue
    }

    if (arg === '--strict-todo') {
      options.strictTodo = true
      options.allowTodo = false
      continue
    }

    throw new Error(`Unknown option: ${arg}`)
  }

  return options
}

export function runCheck(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? defaultWorkspaceRoot()
  const resources = loadLocaleResources(workspaceRoot)
  const englishKeys = flattenLocale(resources.resources[FALLBACK_LOCALE])
  const scan = scanSourceFiles({
    workspaceRoot,
    resources,
    paths: options.paths ?? undefined
  })
  const localeWarnings = []

  for (const locale of resources.locales) {
    if (locale === FALLBACK_LOCALE) continue
    localeWarnings.push({
      locale,
      ...compareLocaleCompleteness({
        englishKeys,
        localeKeys: flattenLocale(resources.resources[locale])
      })
    })
  }

  const usedKeys = new Set(scan.usedKeys)
  const orphanEnglishKeys = [...englishKeys].filter((key) => !usedKeys.has(key)).sort()
  const todoCount = scan.todoCommentCount
  const todoLimitFailure =
    options.strictTodo && todoCount > 0
      ? { actual: todoCount, max: 0 }
      : options.maxTodo !== null && options.maxTodo !== undefined && todoCount > options.maxTodo
        ? { actual: todoCount, max: options.maxTodo }
        : null

  const exitCode =
    resources.errors.length > 0 ||
    scan.unknownNamespaces.length > 0 ||
    scan.missingKeys.length > 0 ||
    scan.untranslated.length > 0 ||
    todoLimitFailure
      ? 1
      : 0

  return {
    exitCode,
    resources,
    scan,
    localeWarnings,
    orphanEnglishKeys,
    todoLimitFailure
  }
}

export function formatResult(result, format) {
  return format === 'json' ? formatJsonReport(result) : formatTextReport(result)
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = runCheck(options)
    process.stdout.write(formatResult(result, options.format))
    process.exitCode = result.exitCode
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
