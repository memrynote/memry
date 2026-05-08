#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const docsPathPattern = /^apps\/docs\//

const docsRelevantPatterns = [
  /^apps\/desktop\/(?:src|config|scripts)\//,
  /^apps\/desktop\/package\.json$/,
  /^apps\/sync-server\/(?:src|schema)\//,
  /^apps\/sync-server\/(?:package\.json|wrangler\.toml)$/,
  /^packages\/(?:contracts|db-schema|rpc|shared|sync-core)\//,
  /^\.github\/workflows\/release.*\.ya?ml$/,
  /^scripts\/(?:desktop-release-metadata|set-desktop-version)\.mjs$/
]

const ignoredRelevantPatterns = [
  /^apps\/desktop\/tests\//,
  /(?:^|\/)(?:__fixtures__|fixtures|mocks)\//,
  /(?:\.test|\.spec)\.[cm]?[jt]sx?$/
]

function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/').replaceAll(path.sep, '/').replace(/^\.\//, '').trim()
}

function uniqueFiles(files) {
  return [...new Set(files.map(normalizePath).filter(Boolean))]
}

export function isDocsPath(filePath) {
  return docsPathPattern.test(normalizePath(filePath))
}

export function isDocsRelevantPath(filePath) {
  const normalized = normalizePath(filePath)

  return (
    !isDocsPath(normalized) &&
    !ignoredRelevantPatterns.some((pattern) => pattern.test(normalized)) &&
    docsRelevantPatterns.some((pattern) => pattern.test(normalized))
  )
}

export function analyzeDocsImpact(files) {
  const normalizedFiles = uniqueFiles(files)
  const docsChanged = normalizedFiles.some(isDocsPath)
  const relevantFiles = normalizedFiles.filter(isDocsRelevantPath)
  const docsRelevantChanged = relevantFiles.length > 0

  return {
    docsChanged,
    docsRelevantChanged,
    relevantFiles,
    status: !docsRelevantChanged ? 'not-needed' : docsChanged ? 'covered' : 'missing-docs'
  }
}

export function buildDocsUpdatePrompt({ baseRef, relevantFiles }) {
  const fileList =
    relevantFiles.length === 0
      ? '- No docs-relevant files were detected.'
      : relevantFiles.map((filePath) => `- ${filePath}`).join('\n')

  return `Update Memry docs for the current branch diff against ${baseRef}.

Scope:
- Inspect the current repository and \`git diff ${baseRef}...HEAD\`.
- Focus on docs impact from Electron desktop, sync-server, contracts, sync protocol, storage schema, and release workflow changes.
- Update only files under apps/docs/src/**.
- Do not edit application code, tests, hooks, package metadata, or generated files.
- If the diff does not require documentation changes, make no edits and say why.
- Keep docs factual, concise, and aligned with shipped code. Do not invent unreleased behavior.
- Run \`pnpm docs:build\` after any docs edit and report the result.

Docs-relevant changed files:
${fileList}
`
}

export function resolveBaseRef() {
  const upstreamRef = runGitOrNull(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstreamRef) {
    return upstreamRef
  }

  if (runGitOrNull(['rev-parse', '--verify', 'origin/main'])) {
    return 'origin/main'
  }

  return runGit(['rev-list', '--max-parents=0', 'HEAD']).split('\n').at(-1)
}

export function getChangedFiles({ baseRef = resolveBaseRef(), staged = false } = {}) {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['diff', '--name-only', '--diff-filter=ACMR', `${baseRef}...HEAD`]

  return runGit(args)
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function runGitOrNull(args) {
  try {
    return runGit(args)
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const options = {
    json: false,
    printPrompt: false,
    staged: false,
    strict: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--base') {
      options.baseRef = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--staged') {
      options.staged = true
      continue
    }

    if (arg === '--strict') {
      options.strict = true
      continue
    }

    if (arg === '--json') {
      options.json = true
      continue
    }

    if (arg === '--print-prompt') {
      options.printPrompt = true
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

function printHumanResult(result, baseRef) {
  if (result.status === 'not-needed') {
    console.log('docs impact: no desktop/sync-server docs-relevant changes detected')
    return
  }

  console.log(`docs impact: ${result.status} against ${baseRef}`)
  console.log('docs-relevant files:')
  for (const filePath of result.relevantFiles) {
    console.log(`  ${filePath}`)
  }

  if (result.status === 'covered') {
    console.log('docs impact: docs changed on this branch')
  }
}

function runCli() {
  const options = parseArgs(process.argv.slice(2))
  const baseRef = options.baseRef ?? resolveBaseRef()
  const changedFiles = getChangedFiles({ baseRef, staged: options.staged })
  const result = analyzeDocsImpact(changedFiles)

  if (options.json) {
    console.log(JSON.stringify({ ...result, baseRef }, null, 2))
  } else if (options.printPrompt) {
    console.log(buildDocsUpdatePrompt({ baseRef, relevantFiles: result.relevantFiles }))
  } else {
    printHumanResult(result, baseRef)
  }

  if (options.strict && result.status === 'missing-docs') {
    console.error(
      '\ndocs impact: desktop/sync-server changes need docs review. Run `pnpm docs:ai-update` or update apps/docs/src, then commit the docs changes.\n'
    )
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
