#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const defaultConfigPath = 'docs/doc-impact.yml'

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function escapeRegex(char) {
  return char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function globToRegExp(glob) {
  const pattern = normalizePath(glob)
  let regex = ''

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        regex += '.*'
        index += 1
      } else {
        regex += '[^/]*'
      }
      continue
    }

    if (char === '?') {
      regex += '[^/]'
      continue
    }

    regex += escapeRegex(char)
  }

  return new RegExp(`^${regex}$`)
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
}

function validateConfig(config) {
  if (!config || !Array.isArray(config.rules)) {
    throw new Error('docs impact config must have a rules array')
  }

  config.rules.forEach((rule, index) => {
    assertStringArray(rule.sources, `rules[${index}].sources`)
    assertStringArray(rule.docs, `rules[${index}].docs`)
  })
}

export function loadDocImpactConfig(configPath = defaultConfigPath) {
  const config = parse(readFileSync(configPath, 'utf8'))
  validateConfig(config)
  return config
}

export function resolveDocImpact(config, changedFiles) {
  validateConfig(config)

  const normalizedFiles = [...new Set(changedFiles.map(normalizePath).filter(Boolean))]
  const changedFileSet = new Set(normalizedFiles)
  const impactedDocsByPath = new Map()

  for (const rule of config.rules) {
    const sourcePatterns = rule.sources.map(globToRegExp)
    const sourcePaths = normalizedFiles.filter((filePath) =>
      sourcePatterns.some((pattern) => pattern.test(filePath))
    )

    if (sourcePaths.length === 0) {
      continue
    }

    for (const docPath of rule.docs) {
      const normalizedDocPath = normalizePath(docPath)
      const entry = impactedDocsByPath.get(normalizedDocPath) ?? {
        docPath: normalizedDocPath,
        isChanged: changedFileSet.has(normalizedDocPath),
        sourcePaths: []
      }

      for (const sourcePath of sourcePaths) {
        if (!entry.sourcePaths.includes(sourcePath)) {
          entry.sourcePaths.push(sourcePath)
        }
      }

      impactedDocsByPath.set(normalizedDocPath, entry)
    }
  }

  const impactedDocs = [...impactedDocsByPath.values()]

  return {
    changedFiles: normalizedFiles,
    impactedDocs,
    hasChangedImpactedDocs: impactedDocs.some((doc) => doc.isChanged),
    hasImpactedDocs: impactedDocs.length > 0,
    hasUnchangedImpactedDocs: impactedDocs.some((doc) => !doc.isChanged)
  }
}

export function formatDocImpactReport(impact) {
  if (!impact.hasImpactedDocs) {
    return 'docs impact: no mapped source changes.'
  }

  const lines = ['docs impact: mapped source changes may require docs updates:', '']

  for (const doc of impact.impactedDocs) {
    lines.push(`- ${doc.docPath}${doc.isChanged ? ' (changed)' : ''}`)
    lines.push('  sources:')

    for (const sourcePath of doc.sourcePaths) {
      lines.push(`  - ${sourcePath}`)
    }
  }

  lines.push('')
  lines.push('Read each listed page and update it if behavior, setup, contracts, or user flows changed.')
  lines.push('If no docs change is needed, state the reason in the PR or final handoff.')

  return lines.join('\n')
}

function refExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function defaultBaseRef() {
  if (refExists('origin/main')) {
    return 'origin/main'
  }

  if (refExists('main')) {
    return 'main'
  }

  return 'HEAD'
}

function getChangedFiles(baseRef) {
  const trackedFiles = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', baseRef], {
    encoding: 'utf8'
  })
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)

  const untrackedFiles = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8'
  })
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)

  return [...new Set([...trackedFiles, ...untrackedFiles])]
}

function parseArgs(argv) {
  const args = {
    baseRef: null,
    check: false,
    configPath: defaultConfigPath,
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--base') {
      args.baseRef = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--config') {
      args.configPath = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--check') {
      args.check = true
      continue
    }

    if (arg === '--help' || arg === '-h') {
      args.help = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (args.baseRef === '') {
    throw new Error('--base requires a git ref')
  }

  if (!args.configPath) {
    throw new Error('--config requires a path')
  }

  return args
}

function printHelp() {
  console.log(`Usage: node scripts/check-doc-impact.mjs [--base <ref>] [--config <path>] [--check]

Reports docs pages that may need updates based on changed source paths.

Options:
  --base <ref>      Git ref to compare against. Defaults to origin/main, then main, then HEAD.
  --config <path>   Doc impact map. Defaults to docs/doc-impact.yml.
  --check           Exit non-zero when mapped source changed but no impacted doc changed.
`)
}

function runCli() {
  try {
    const args = parseArgs(process.argv.slice(2))

    if (args.help) {
      printHelp()
      return
    }

    const baseRef = args.baseRef ?? defaultBaseRef()
    const config = loadDocImpactConfig(args.configPath)
    const impact = resolveDocImpact(config, getChangedFiles(baseRef))

    console.log(formatDocImpactReport(impact))

    if (
      args.check &&
      impact.hasImpactedDocs &&
      !impact.hasChangedImpactedDocs &&
      process.env.DOCS_IMPACT_ACK !== '1'
    ) {
      console.error('\ndocs impact check failed.')
      console.error('Update the listed docs or set DOCS_IMPACT_ACK=1 with a written no-docs rationale.')
      process.exit(1)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}

if (process.argv[1]?.endsWith('/check-doc-impact.mjs')) {
  runCli()
}
