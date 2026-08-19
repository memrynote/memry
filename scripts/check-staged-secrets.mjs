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
const sourceCodePathPattern = /\.[cm]?[jt]sx?$/i

const testPathPattern = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/

const markdownPathPattern = /\.md$/i

const secretKeywords = [
  'SECRET',
  'TOKEN',
  'PRIVATE_KEY',
  'API_KEY',
  'PASSWORD',
  'HMAC_KEY',
  'CSC_LINK',
  'KEY_PASSWORD'
]

const secretAssignmentPattern = new RegExp(
  `^\\s*(?:export\\s+)?([A-Z0-9_]*(?:${secretKeywords.join('|')})[A-Z0-9_]*)\\s*[:=]\\s*["']?([^"'\\s#][^#\\n]*)`,
  'i'
)

const secretKeywordWordPattern = new RegExp(`(?:^|_)(?:${secretKeywords.join('|')})(?:_|$)`)

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

function isQuotedValue(value) {
  const trimmed = value.trim()
  return trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith('`')
}

function isTypeScriptTypeValue(value) {
  const typeAtom =
    '(?:string|number|boolean|bigint|symbol|unknown|never|void|object|null|undefined|Uint8Array|ArrayBuffer|Buffer|Date|Promise<[^>]+>|Record<[^>]+>|Array<[^>]+>|[A-Z][A-Za-z0-9_$]*(?:<[^>]+>)?)'
  return new RegExp(`^${typeAtom}(?:\\s*\\|\\s*${typeAtom})*$`).test(value)
}

function isChainedCodeCallValue(value) {
  const parts = value.split(/\./)

  return (
    parts.length > 1 &&
    /^[A-Za-z_$][\w$]*\??$/.test(parts[0]) &&
    parts.slice(1).every((part) => /^[A-Za-z_$][\w$]*(?:\([^;\n]*\))?$/.test(part))
  )
}

function isSourceCodeReferenceValue(filePath, value) {
  if (!sourceCodePathPattern.test(filePath) || isQuotedValue(value)) {
    return false
  }

  const normalized = normalizeValue(value)

  // JSX expression container / object shorthand: `{ident}` wraps a code
  // reference, not a secret literal. Unwrap one layer and re-check the inner
  // expression. A quoted string inside stays flagged (isQuotedValue guard),
  // and real secret formats are caught by tokenPatterns regardless.
  const jsxInner = normalized.match(/^\{\s*(.+?)\s*\}$/)
  if (jsxInner && !isQuotedValue(jsxInner[1])) {
    return isSourceCodeReferenceValue(filePath, jsxInner[1])
  }

  // Fallback chain over code references (`tokens.refreshToken ?? refreshToken`).
  // Every operand must itself be a code reference, so a quoted literal on
  // either side stays flagged.
  const operands = normalized.split(/\s*(?:\?\?|\|\|)\s*/)
  if (operands.length > 1) {
    return operands.every(
      (operand) => operand.length > 0 && isSourceCodeReferenceValue(filePath, operand)
    )
  }

  return (
    isTypeScriptTypeValue(normalized) ||
    /^[A-Za-z_$][\w$]*$/.test(normalized) ||
    // Member path, optionally closed by a TypeScript non-null assertion
    // (`process.env.GOOGLE_CALENDAR_E2E_REFRESH_TOKEN!`). The trailing `!` is
    // only tolerated here, not on a bare identifier, so a lone `hunter2!`
    // stays flagged rather than reading as a code reference.
    /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+!?$/.test(normalized) ||
    isChainedCodeCallValue(normalized) ||
    /^[A-Za-z_$][\w$]*(?:\[[^\]]+\])+$/.test(normalized) ||
    /^[A-Za-z_$][\w$]*\([^;]*\)$/.test(normalized) ||
    // constructor call wrapping a code reference (`new Uint8Array(key)`);
    // quote characters in the args keep string literals flagged
    /^new\s+[A-Za-z_$][\w$]*\([^;"'`]*\)$/.test(normalized)
  )
}

function isCodeDeclarationValue(filePath, value) {
  const normalized = normalizeValue(value)

  return (
    // numeric literals (`tokenIssuedAt = 0`) carry no secret material
    /^-?\d+(?:\.\d+)?$/.test(normalized) ||
    normalized.startsWith('() =>') ||
    // arrow function taking parameters (`getAccessToken: (force) => mint(force)`):
    // the value is a function, not a literal. Quote characters anywhere in it
    // keep an embedded string literal flagged.
    /^\([^)'"`]*\)\s*=>[^'"`]*$/.test(normalized) ||
    /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/i.test(normalized) ||
    isSourceCodeReferenceValue(filePath, value)
  )
}

function isSecretKeywordKey(key) {
  // Only treat the key as credential-shaped when a sensitive keyword stands as
  // its own word (`ACCESS_TOKEN`, `refreshToken`, `token`). Identifiers that
  // merely contain one inside a longer word are ordinary SQL or config syntax
  // — fts5's `tokenize='porter unicode61'` is not a leaked token.
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase()

  return secretKeywordWordPattern.test(words)
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
    normalized.startsWith('test-') ||
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

function isTestPath(filePath) {
  return testPathPattern.test(filePath)
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

  if (isTestPath(filePath)) {
    return findings
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
      !isSecretKeywordKey(key) ||
      key.toUpperCase().includes('PUBLIC_KEY') ||
      isCodeDeclarationValue(filePath, value) ||
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
