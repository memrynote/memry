#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

const rendererSourcePattern = /^apps\/desktop\/src\/renderer\/src\/.*\.[cm]?[jt]sx?$/
const ignoredTestPattern = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/
const rawConsolePattern = /\bconsole\.(?:debug|error|info|log|trace|warn)\s*\(/g
const physicalTailwindPattern =
  /(?:^|[\s"'`])((?:[a-z0-9-]+:)*-?(?:(?:ml|mr|pl|pr|left|right)-[^\s"'`]+|text-(?:left|right)\b|border-(?:l|r)(?:-[^\s"'`]+)?\b|rounded-(?:l|r)(?:-[^\s"'`]+)?\b))/gi
const classListCallPattern = /\b(?:cn|clsx|cva|twMerge)\s*\(/g
const classNameAttributePattern = /\bclassName\s*=/g

const CODE = 0
const COMMENT = 1
const STRING = 2

function shouldScanPath(filePath) {
  return rendererSourcePattern.test(filePath) && !ignoredTestPattern.test(filePath)
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length
}

// Splits a source file into code, comment and string regions without parsing it.
// `literalEnds` maps each opening quote or backtick to the index just past its
// closing delimiter, so a caller can take a whole literal including any `${}`.
function classifySource(text) {
  const kinds = new Uint8Array(text.length)
  const stringSpans = []
  const literalEnds = new Map()

  function fill(start, end, kind) {
    for (let index = start; index < end && index < text.length; index += 1) {
      kinds[index] = kind
    }
  }

  function scanQuoted(start) {
    const quote = text[start]
    let index = start + 1

    while (index < text.length && text[index] !== quote && text[index] !== '\n') {
      index += text[index] === '\\' ? 2 : 1
    }

    const contentEnd = Math.min(index, text.length)
    const end = Math.min(contentEnd + 1, text.length)

    fill(start, end, STRING)
    stringSpans.push({ start: start + 1, end: contentEnd })
    literalEnds.set(start, end)
    return end
  }

  function scanTemplate(start) {
    let index = start + 1
    let chunkStart = index

    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2
        continue
      }

      if (text[index] === '`') {
        fill(chunkStart, index, STRING)
        stringSpans.push({ start: chunkStart, end: index })
        fill(start, start + 1, STRING)
        fill(index, index + 1, STRING)
        literalEnds.set(start, index + 1)
        return index + 1
      }

      if (text[index] === '$' && text[index + 1] === '{') {
        fill(chunkStart, index, STRING)
        stringSpans.push({ start: chunkStart, end: index })
        index = scanCode(index + 2, true)
        chunkStart = index
        continue
      }

      index += 1
    }

    fill(chunkStart, text.length, STRING)
    stringSpans.push({ start: chunkStart, end: text.length })
    literalEnds.set(start, text.length)
    return text.length
  }

  function scanCode(from, insideInterpolation) {
    let index = from

    while (index < text.length) {
      const char = text[index]
      const nextChar = text[index + 1]

      if (char === '/' && nextChar === '/') {
        const lineEnd = text.indexOf('\n', index)
        const end = lineEnd === -1 ? text.length : lineEnd
        fill(index, end, COMMENT)
        index = end
        continue
      }

      if (char === '/' && nextChar === '*') {
        const blockEnd = text.indexOf('*/', index + 2)
        const end = blockEnd === -1 ? text.length : blockEnd + 2
        fill(index, end, COMMENT)
        index = end
        continue
      }

      if (char === '"' || char === "'") {
        index = scanQuoted(index)
        continue
      }

      if (char === '`') {
        index = scanTemplate(index)
        continue
      }

      if (insideInterpolation) {
        if (char === '{') {
          index = scanCode(index + 1, true)
          continue
        }

        if (char === '}') {
          return index + 1
        }
      }

      index += 1
    }

    return index
  }

  scanCode(0, false)
  return { kinds, stringSpans, literalEnds }
}

function findClosingDelimiter(text, kinds, openIndex) {
  const open = text[openIndex]
  const close = open === '(' ? ')' : '}'
  let depth = 0

  for (let index = openIndex; index < text.length; index += 1) {
    if (kinds[index] !== CODE) {
      continue
    }

    if (text[index] === open) {
      depth += 1
    } else if (text[index] === close) {
      depth -= 1

      if (depth === 0) {
        return index + 1
      }
    }
  }

  return text.length
}

// A class list is either an argument to cn/clsx/cva/twMerge or the value of a
// className prop. Everything else in the file is prose as far as this rule cares.
function findClassListRegions(text, kinds, literalEnds) {
  const regions = []

  for (const match of text.matchAll(classListCallPattern)) {
    const start = match.index ?? 0

    if (kinds[start] !== CODE) {
      continue
    }

    const parenIndex = start + match[0].length - 1
    regions.push({ start: parenIndex, end: findClosingDelimiter(text, kinds, parenIndex) })
  }

  for (const match of text.matchAll(classNameAttributePattern)) {
    const start = match.index ?? 0

    if (kinds[start] !== CODE) {
      continue
    }

    let valueIndex = start + match[0].length

    while (valueIndex < text.length && /\s/.test(text[valueIndex])) {
      valueIndex += 1
    }

    const valueChar = text[valueIndex]

    if (valueChar === '{') {
      regions.push({ start: valueIndex, end: findClosingDelimiter(text, kinds, valueIndex) })
    } else if (literalEnds.has(valueIndex)) {
      regions.push({ start: valueIndex, end: literalEnds.get(valueIndex) })
    }
  }

  return regions
}

function findClassListStringSpans(text) {
  const { kinds, stringSpans, literalEnds } = classifySource(text)
  const regions = findClassListRegions(text, kinds, literalEnds)

  return stringSpans.filter((span) =>
    regions.some((region) => span.start >= region.start && span.end <= region.end)
  )
}

export function scanRendererText(filePath, text) {
  if (!shouldScanPath(filePath)) {
    return []
  }

  const findings = []
  const physicalClassLines = new Set()

  for (const span of findClassListStringSpans(text)) {
    for (const match of text.slice(span.start, span.end).matchAll(physicalTailwindPattern)) {
      const line = lineNumberAt(text, span.start + (match.index ?? 0))

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
