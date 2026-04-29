#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultWorkspaceRoot, loadLocaleResources } from './resources.mjs'
import { resolveSourceFiles, scanFile } from './scan-source.mjs'

const DEFAULT_CODEMOD_PATHS = ['apps/desktop/src/renderer/src']

function quoteString(value) {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}'`
}

function linePrefix(sourceText, position) {
  const lineStart = sourceText.lastIndexOf('\n', position - 1) + 1
  return sourceText.slice(lineStart, position)
}

function textTodoInsertion(sourceText, position) {
  const prefix = linePrefix(sourceText, position)
  if (prefix.trim() === '') {
    return `{/* TODO(i18n): wrap in t() */}\n${prefix}`
  }
  return '{/* TODO(i18n): wrap in t() */}'
}

function buildEdits(sourceText, findings) {
  const edits = []

  for (const finding of findings) {
    if (finding.insert?.kind === 'jsx-text') {
      edits.push({
        start: finding.insert.position,
        end: finding.insert.position,
        text: textTodoInsertion(sourceText, finding.insert.position)
      })
      continue
    }

    if (finding.insert?.kind === 'jsx-attribute') {
      edits.push({
        start: finding.insert.start,
        end: finding.insert.end,
        text: `{${quoteString(finding.text)} /* TODO(i18n): wrap ${finding.attributeName} in t() */}`
      })
    }
  }

  return edits.sort((a, b) => b.start - a.start)
}

function applyEdits(sourceText, edits) {
  let nextText = sourceText
  for (const edit of edits) {
    nextText = `${nextText.slice(0, edit.start)}${edit.text}${nextText.slice(edit.end)}`
  }
  return nextText
}

export function runCodemod(options = {}) {
  const workspaceRoot = options.workspaceRoot ?? defaultWorkspaceRoot()
  const paths = options.paths ?? DEFAULT_CODEMOD_PATHS
  const resources = loadLocaleResources(workspaceRoot)
  const files = resolveSourceFiles(paths, workspaceRoot).filter((file) => file.endsWith('.tsx'))
  const changedFiles = []
  const results = []

  for (const filePath of files) {
    const scanResult = scanFile(filePath, { workspaceRoot, resources })
    if (scanResult.untranslated.length === 0) continue

    const sourceText = fs.readFileSync(filePath, 'utf8')
    const edits = buildEdits(sourceText, scanResult.untranslated)
    const nextText = applyEdits(sourceText, edits)

    if (nextText === sourceText) continue

    changedFiles.push(filePath)
    results.push({
      file: filePath,
      findingCount: scanResult.untranslated.length
    })

    if (options.write) {
      fs.writeFileSync(filePath, nextText)
    }
  }

  return {
    changedFiles,
    results
  }
}

function parseArgs(argv, cwd = process.cwd()) {
  const options = {
    paths: null,
    dryRun: false,
    write: false,
    check: false
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

    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (arg === '--write') {
      options.write = true
      continue
    }

    if (arg === '--check') {
      options.check = true
      continue
    }

    throw new Error(`Unknown option: ${arg}`)
  }

  if (!options.dryRun && !options.write && !options.check) {
    options.dryRun = true
  }

  return options
}

function formatResult(result, options, workspaceRoot) {
  const mode = options.write ? 'write' : options.check ? 'check' : 'dry-run'
  const lines = [`i18n TODO codemod ${mode}: ${result.changedFiles.length} file(s) need updates`]

  for (const filePath of result.changedFiles) {
    lines.push(`  ${path.relative(workspaceRoot, filePath).split(path.sep).join('/')}`)
  }

  return `${lines.join('\n')}\n`
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    const workspaceRoot = defaultWorkspaceRoot()
    const result = runCodemod({
      paths: options.paths ?? undefined,
      dryRun: options.dryRun,
      write: options.write,
      check: options.check,
      workspaceRoot
    })
    process.stdout.write(formatResult(result, options, workspaceRoot))
    process.exitCode = options.check && result.changedFiles.length > 0 ? 1 : 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
