#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ignoredPathPatterns = [
  /^node_modules\//,
  /\/node_modules\//,
  /^pnpm-lock\.yaml$/,
  /(^|\/)(dist|out|coverage|build)\//
]

const binaryPathPattern =
  /\.(?:avif|br|dmg|eot|flac|gif|gz|icns|ico|jpe?g|m4v|mov|mp3|mp4|ogg|otf|pdf|png|tgz|ttf|wav|webm|webp|woff2?|zip)$/i

const markdownPathPattern = /\.md$/i

const secretAssignmentPattern =
  /^\s*(?:export\s+)?([A-Z0-9_]*(?:SECRET|TOKEN|PRIVATE_KEY|API_KEY|PASSWORD|HMAC_KEY|CSC_LINK|KEY_PASSWORD)[A-Z0-9_]*)\s*[:=]\s*["']?([^"'\s#][^#\n]*)/i

const tokenPatterns = [
  {
    rule: 'private-key-block',
    pattern: new RegExp('-----BEGIN (?:[A-Z0-9 ]+ )?' + 'PRIVATE KEY-----', 'i'),
    message: 'private key block'
  },
  {
    rule: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
    message: 'GitHub token'
  },
  {
    rule: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    message: 'Slack token'
  },
  {
    rule: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    message: 'AWS access key'
  },
  {
    rule: 'openai-key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
    message: 'OpenAI-style API key'
  }
]

function normalizeValue(value) {
  return value
    .trim()
    .replace(/,$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim()
}

function isCodeDeclarationValue(value) {
  const normalized = normalizeValue(value)

  return normalized.startsWith('() =>') || /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/i.test(normalized)
}

function isPlaceholderValue(value) {
  const normalized = normalizeValue(value).toLowerCase()

  return (
    normalized.length === 0 ||
    normalized === 'test' ||
    normalized === 'todo' ||
    normalized === 'unused' ||
    normalized === 'changeme' ||
    normalized === 'change-me' ||
    normalized === 'replace-me' ||
    normalized === 'not-a-secret' ||
    normalized.includes('placeholder') ||
    normalized.includes('example') ||
    normalized.includes('dummy') ||
    normalized.startsWith('your-') ||
    normalized.startsWith('replace-me') ||
    normalized.startsWith('local-') ||
    normalized.startsWith('dev-') ||
    (normalized.startsWith('<') && normalized.endsWith('>')) ||
    (normalized.startsWith('${') && normalized.endsWith('}'))
  )
}

function shouldScanPath(filePath) {
  return (
    !ignoredPathPatterns.some((pattern) => pattern.test(filePath)) &&
    !binaryPathPattern.test(filePath) &&
    !markdownPathPattern.test(filePath)
  )
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length
}

export function scanTextForSecrets(filePath, text) {
  if (!shouldScanPath(filePath)) {
    return []
  }

  const findings = []
  const tokenLines = new Set()

  for (const rule of tokenPatterns) {
    for (const match of text.matchAll(new RegExp(rule.pattern, 'gi'))) {
      const line = lineNumberAt(text, match.index ?? 0)
      tokenLines.add(line)
      findings.push({
        filePath,
        line,
        rule: rule.rule,
        message: rule.message
      })
    }
  }

  const lines = text.split('\n')
  lines.forEach((lineText, index) => {
    const match = lineText.match(secretAssignmentPattern)

    if (!match) {
      return
    }

    const [, key, value] = match

    if (
      tokenLines.has(index + 1) ||
      key.toUpperCase().includes('PUBLIC_KEY') ||
      isCodeDeclarationValue(value) ||
      isPlaceholderValue(value)
    ) {
      return
    }

    findings.push({
      filePath,
      line: index + 1,
      rule: 'high-risk-secret-assignment',
      message: `${key} assignment`
    })
  })

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

function getChangedFiles(baseRef) {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', baseRef], {
    encoding: 'utf8'
  })
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean)
}

function readStagedFile(filePath) {
  const buffer = execFileSync('git', ['show', `:${filePath}`])

  if (buffer.includes(0)) {
    return null
  }

  return buffer.toString('utf8')
}

function readWorkingTreeFile(filePath) {
  const buffer = readFileSync(filePath)

  if (buffer.includes(0)) {
    return null
  }

  return buffer.toString('utf8')
}

function scanFiles(files, readFile) {
  const findings = []

  for (const filePath of files) {
    if (!shouldScanPath(filePath)) {
      continue
    }

    const text = readFile(filePath)

    if (text === null) {
      continue
    }

    findings.push(...scanTextForSecrets(filePath, text))
  }

  return findings
}

function runCli() {
  const changedIndex = process.argv.indexOf('--changed')
  const changedBaseRef = changedIndex === -1 ? null : process.argv[changedIndex + 1]

  if (changedIndex !== -1 && !changedBaseRef) {
    console.error('Usage: node scripts/check-staged-secrets.mjs --changed <base-ref>')
    process.exit(2)
  }

  const findings = changedBaseRef
    ? scanFiles(getChangedFiles(changedBaseRef), readWorkingTreeFile)
    : scanFiles(getStagedFiles(), readStagedFile)

  if (findings.length === 0) {
    return
  }

  const scope = changedBaseRef ? 'changed files' : 'staged files'
  console.error(`\nsecret scan: potential secrets detected in ${scope}:\n`)
  for (const finding of findings) {
    console.error(`  ${finding.filePath}:${finding.line} ${finding.rule} - ${finding.message}`)
  }
  console.error('\nUse placeholders in examples and keep real secrets in ignored local files.\n')
  process.exit(1)
}

if (process.argv[1]?.endsWith('/check-staged-secrets.mjs')) {
  runCli()
}
