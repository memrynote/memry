#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  analyzeDocsImpact,
  buildDocsUpdatePrompt,
  getChangedFiles,
  resolveBaseRef
} from './docs-impact.mjs'

function parseArgs(argv) {
  const options = {
    dryRun: false,
    force: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--base') {
      options.baseRef = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (arg === '--force') {
      options.force = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function getRepoRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Unable to resolve git repository root')
  }

  return result.stdout.trim()
}

function buildCodexArgs(repoRoot) {
  const args = [
    'exec',
    '--cd',
    repoRoot,
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'never'
  ]
  const model = process.env.DOCS_AI_MODEL?.trim()

  if (model) {
    args.push('--model', model)
  }

  args.push('-')
  return args
}

function runCodex(prompt) {
  const command = process.env.DOCS_AI_CLI?.trim() || 'codex'
  const repoRoot = getRepoRoot()
  const result = spawnSync(command, buildCodexArgs(repoRoot), {
    encoding: 'utf8',
    input: prompt,
    stdio: ['pipe', 'inherit', 'inherit']
  })

  if (result.error?.code === 'ENOENT') {
    throw new Error(
      `Docs AI updater could not find \`${command}\`. Install Codex CLI or set DOCS_AI_CLI.`
    )
  }

  if (result.error) {
    throw result.error
  }

  return result.status ?? 1
}

function runCli() {
  const options = parseArgs(process.argv.slice(2))
  const baseRef = options.baseRef ?? resolveBaseRef()
  const changedFiles = getChangedFiles({ baseRef })
  const impact = analyzeDocsImpact(changedFiles)

  if (!options.force && !impact.docsRelevantChanged) {
    console.log('docs ai update: no desktop/sync-server docs-relevant changes detected')
    return
  }

  const prompt = buildDocsUpdatePrompt({ baseRef, relevantFiles: impact.relevantFiles })

  if (options.dryRun) {
    console.log(prompt)
    return
  }

  process.exit(runCodex(prompt))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
