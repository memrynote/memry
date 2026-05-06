#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const defaultFragmentsDir = 'docs/releases/unreleased'
const frontmatterPattern = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/
const emojiPattern = /\p{Extended_Pictographic}/gu

const categoryConfig = {
  new: {
    aliases: ['add', 'added', 'feature', 'new'],
    heading: 'New Features',
    order: 1
  },
  improvement: {
    aliases: ['change', 'changed', 'improve', 'improved', 'improvement'],
    heading: 'Improvements',
    order: 2
  },
  fix: {
    aliases: ['fix', 'fixed', 'stability'],
    heading: 'Stability and Fixes',
    order: 3
  },
  security: {
    aliases: ['security'],
    heading: 'Security',
    order: 4
  },
  maintenance: {
    aliases: ['build', 'chore', 'maintenance', 'release'],
    heading: 'Maintenance',
    order: 5
  }
}

export function parseReleaseNoteFragment(filePath, text) {
  const match = frontmatterPattern.exec(text)
  if (!match) {
    throw new Error(`${filePath}: release-note fragments must start with YAML frontmatter`)
  }

  const [, frontmatter, rawBody] = match
  const metadata = parseFrontmatter(frontmatter, filePath)
  const fragment = {
    body: rawBody.trim(),
    category: normalizeCategory(metadata.category, filePath),
    emoji: metadata.emoji ?? '',
    path: filePath,
    title: metadata.title ?? ''
  }

  validateReleaseNoteFragment(fragment)
  return fragment
}

export function validateReleaseNoteFragment(fragment) {
  if (!fragment.path) {
    throw new Error('release-note fragment path is required')
  }

  if (!fragment.title.trim()) {
    throw new Error(`${fragment.path}: title is required`)
  }

  if (!fragment.body.trim()) {
    throw new Error(`${fragment.path}: body is required`)
  }

  if (!fragment.body.trim().endsWith('.')) {
    throw new Error(`${fragment.path}: body must be a user-facing sentence ending with a period`)
  }

  if (!fragment.emoji.trim()) {
    throw new Error(`${fragment.path}: emoji is required`)
  }

  const emojis = [...fragment.emoji.matchAll(emojiPattern)]
  if (
    emojis.length !== 1 ||
    fragment.emoji.replace(emojiPattern, '').replace(/\uFE0F/g, '') !== ''
  ) {
    throw new Error(`${fragment.path}: emoji must contain exactly one emoji`)
  }

  if (!categoryConfig[fragment.category]) {
    throw new Error(`${fragment.path}: unsupported category "${fragment.category}"`)
  }
}

export function renderReleaseNotes({ fragments, tag }) {
  const validFragments = fragments.map((fragment) => {
    validateReleaseNoteFragment(fragment)
    return fragment
  })

  if (validFragments.length === 0) {
    validFragments.push({
      body: 'This release includes internal improvements and maintenance updates.',
      category: 'maintenance',
      emoji: '📦',
      path: 'generated',
      title: 'Maintenance Release'
    })
  }

  const sections = Object.entries(categoryConfig)
    .map(([category, config]) => ({
      category,
      fragments: validFragments.filter((fragment) => fragment.category === category),
      heading: config.heading,
      order: config.order
    }))
    .filter((section) => section.fragments.length > 0)
    .sort((left, right) => left.order - right.order)

  const lines = [`# Memry ${tag}`, '']

  for (const section of sections) {
    lines.push(`## ${section.heading}`, '')

    for (const fragment of section.fragments) {
      lines.push(`${fragment.emoji} **${fragment.title}** — ${fragment.body}`)
    }

    lines.push('')
  }

  return lines.join('\n')
}

function parseFrontmatter(frontmatter, filePath) {
  const metadata = {}

  for (const line of frontmatter.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const separatorIndex = trimmed.indexOf(':')
    if (separatorIndex === -1) {
      throw new Error(`${filePath}: invalid frontmatter line "${trimmed}"`)
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    metadata[key] = stripYamlStringQuotes(value)
  }

  return metadata
}

function stripYamlStringQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}

function normalizeCategory(category, filePath) {
  const normalized = category?.trim().toLowerCase()
  if (!normalized) {
    throw new Error(`${filePath}: category is required`)
  }

  for (const [key, config] of Object.entries(categoryConfig)) {
    if (config.aliases.includes(normalized)) {
      return key
    }
  }

  throw new Error(`${filePath}: unsupported category "${category}"`)
}

function readFragment(filePath) {
  return parseReleaseNoteFragment(filePath, readFileSync(filePath, 'utf8'))
}

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) {
    return []
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(dir, entry.name))
    .sort()
}

function listChangedFragmentFiles({ baseRef, fragmentsDir, headRef }) {
  if (!baseRef) {
    return listMarkdownFiles(fragmentsDir)
  }

  const output = execFileSync('git', ['diff', '--name-only', `${baseRef}..${headRef}`], {
    encoding: 'utf8'
  })

  return output
    .split('\n')
    .map((file) => file.trim())
    .filter(
      (file) => file.startsWith(`${fragmentsDir}/`) && file.endsWith('.md') && existsSync(file)
    )
    .sort()
}

function parseArgs(argv) {
  const options = {
    fragmentsDir: defaultFragmentsDir,
    headRef: 'HEAD'
  }

  const [command, ...rest] = argv
  options.command = command

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]

    if (arg === '--base-ref') {
      options.baseRef = readRequiredValue(rest, index, arg)
      index += 1
      continue
    }

    if (arg === '--fragments-dir') {
      options.fragmentsDir = readRequiredValue(rest, index, arg)
      index += 1
      continue
    }

    if (arg === '--head-ref') {
      options.headRef = readRequiredValue(rest, index, arg)
      index += 1
      continue
    }

    if (arg === '--output') {
      options.output = readRequiredValue(rest, index, arg)
      index += 1
      continue
    }

    if (arg === '--tag') {
      options.tag = readRequiredValue(rest, index, arg)
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function readRequiredValue(argv, index, arg) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`)
  }

  return value
}

function runCli() {
  const options = parseArgs(process.argv.slice(2))

  if (options.command === 'check') {
    const files = listMarkdownFiles(options.fragmentsDir)
    files.forEach(readFragment)
    console.log(`Checked ${files.length} release-note fragment(s).`)
    return
  }

  if (options.command === 'generate') {
    if (!options.tag) {
      throw new Error('generate requires --tag')
    }

    const files = listChangedFragmentFiles(options)
    const fragments = files.map(readFragment)
    const output = renderReleaseNotes({ fragments, tag: options.tag })

    if (options.output) {
      writeFileSync(options.output, output, 'utf8')
    } else {
      process.stdout.write(output)
    }
    return
  }

  throw new Error('Usage: release-notes.mjs check|generate [--tag <tag>] [--output <file>]')
}

if (process.argv[1]?.endsWith('/release-notes.mjs')) {
  runCli()
}
