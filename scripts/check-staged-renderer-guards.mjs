#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

const rendererSourcePattern = /^apps\/desktop\/src\/renderer\/src\/.*\.[cm]?[jt]sx?$/
const ignoredTestPattern = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/
const rawConsolePattern = /\bconsole\.(?:debug|error|info|log|trace|warn)\s*\(/g
const physicalTailwindPattern =
  /(?:^|[\s"'`])((?:[a-z0-9-]+:)*-?(?:(?:ml|mr|pl|pr|left|right)-[^\s"'`]+|text-(?:left|right)\b|border-(?:l|r)(?:-[^\s"'`]+)?\b|rounded-(?:l|r)(?:-[^\s"'`]+)?\b))/gi

function shouldScanPath(filePath) {
  return rendererSourcePattern.test(filePath) && !ignoredTestPattern.test(filePath)
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length
}

export function scanRendererText(filePath, text) {
  if (!shouldScanPath(filePath)) {
    return []
  }

  const findings = []
  const physicalClassLines = new Set()

  for (const match of text.matchAll(physicalTailwindPattern)) {
    const line = lineNumberAt(text, match.index ?? 0)

    if (physicalClassLines.has(line)) {
      continue
    }

    physicalClassLines.add(line)
    findings.push({
      filePath,
      line,
      rule: 'physical-tailwind-class',
      message: match[1]
    })
  }

  for (const match of text.matchAll(rawConsolePattern)) {
    findings.push({
      filePath,
      line: lineNumberAt(text, match.index ?? 0),
      rule: 'raw-console',
      message: match[0]
    })
  }

  return findings
}

function getStagedFiles() {
  return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8'
  })
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)
}

function readStagedFile(filePath) {
  return execFileSync('git', ['show', `:${filePath}`], { encoding: 'utf8' })
}

function runCli() {
  const findings = []

  for (const filePath of getStagedFiles()) {
    if (!shouldScanPath(filePath)) {
      continue
    }

    findings.push(...scanRendererText(filePath, readStagedFile(filePath)))
  }

  if (findings.length === 0) {
    return
  }

  console.error('\npre-commit: renderer guardrails failed:\n')
  for (const finding of findings) {
    console.error(`  ${finding.filePath}:${finding.line} ${finding.rule} - ${finding.message}`)
  }
  console.error('\nUse createLogger in app code and logical Tailwind direction classes.\n')
  process.exit(1)
}

if (process.argv[1]?.endsWith('/check-staged-renderer-guards.mjs')) {
  runCli()
}
