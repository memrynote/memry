#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const releaseTagPattern = /^v(\d{4}\.\d{1,2}\.\d{1,2})(?:-(\d{3}))?$/
const releaseDatePattern = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/
const appVersionPattern = /^(\d{4})\.(\d{3,4})\.(\d+)$/

export function validateReleaseDate(input) {
  const match = releaseDatePattern.exec(input)
  if (!match) {
    throw new Error('Release date must match YYYY.M.D')
  }

  const [, yearText, monthText, dayText] = match
  if (hasLeadingZero(monthText) || hasLeadingZero(dayText)) {
    throw new Error('Release date month and day must not be zero-padded')
  }

  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)

  if (month < 1 || month > 12) {
    throw new Error('Release date month must be between 1 and 12')
  }

  const candidate = new Date(Date.UTC(year, month - 1, day))
  const isValidDate =
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day

  if (!isValidDate) {
    throw new Error('Release date day is not valid for the given month/year')
  }

  return `${year}.${month}.${day}`
}

export function validateAppVersion(input) {
  const match = appVersionPattern.exec(input)
  if (!match) {
    throw new Error('Desktop app version must match semver-safe YYYY.MDD.N')
  }

  const releaseIndex = Number(match[3])
  if (releaseIndex < 1) {
    throw new Error('Desktop app version release index must be at least 1')
  }

  return input
}

export function parseReleaseTag(tag) {
  const match = releaseTagPattern.exec(tag)
  if (!match) {
    throw new Error(`Invalid desktop release tag: ${tag}`)
  }

  const date = validateReleaseDate(match[1])
  const index = match[2] ? Number(match[2]) : 1
  if (index < 2 && match[2]) {
    throw new Error(`Invalid desktop release tag suffix: ${tag}`)
  }

  return { date, index, tag }
}

export function resolveReleaseMetadata({ date, existingTags }) {
  const releaseDate = validateReleaseDate(date)
  const sameDayIndexes = existingTags.flatMap((tag) => {
    try {
      const parsed = parseReleaseTag(tag)
      return parsed.date === releaseDate ? [parsed.index] : []
    } catch {
      return []
    }
  })

  const releaseIndex = sameDayIndexes.length === 0 ? 1 : Math.max(...sameDayIndexes) + 1
  const releaseTag = formatReleaseTag(releaseDate, releaseIndex)
  const appVersion = formatAppVersion(releaseDate, releaseIndex)

  return {
    appVersion,
    releaseDate,
    releaseIndex,
    releaseName: `Memry ${releaseTag}`,
    releaseTag
  }
}

export function resolveReleaseMetadataFromTag(tag) {
  const parsed = parseReleaseTag(tag)
  const appVersion = formatAppVersion(parsed.date, parsed.index)

  return {
    appVersion,
    releaseDate: parsed.date,
    releaseIndex: parsed.index,
    releaseName: `Memry ${parsed.tag}`,
    releaseTag: parsed.tag
  }
}

function formatReleaseTag(date, index) {
  if (index === 1) {
    return `v${date}`
  }

  return `v${date}-${String(index).padStart(3, '0')}`
}

function formatAppVersion(date, index) {
  const [year, month, day] = date.split('.').map(Number)
  return `${year}.${Number(`${month}${String(day).padStart(2, '0')}`)}.${index}`
}

function hasLeadingZero(value) {
  return value.length > 1 && value.startsWith('0')
}

function parseArgs(argv) {
  const options = {
    existingTags: []
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--validate-date') {
      options.mode = 'validate-date'
      options.date = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--validate-app-version') {
      options.mode = 'validate-app-version'
      options.appVersion = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--resolve') {
      options.mode = 'resolve'
      continue
    }

    if (arg === '--from-tag') {
      options.mode = 'from-tag'
      continue
    }

    if (arg === '--tag') {
      options.tag = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--date') {
      options.date = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--existing-tag') {
      options.existingTags.push(readRequiredValue(argv, index, arg))
      index += 1
      continue
    }

    if (arg === '--existing-tags-file') {
      const tagsPath = readRequiredValue(argv, index, arg)
      options.existingTags.push(...readTagsFile(tagsPath))
      index += 1
      continue
    }

    if (arg === '--github-output') {
      options.githubOutput = readRequiredValue(argv, index, arg)
      index += 1
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

function readTagsFile(tagsPath) {
  return readFileSync(tagsPath, 'utf8')
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function writeGitHubOutputs(outputPath, metadata) {
  const lines = [
    `app_version=${metadata.appVersion}`,
    `release_date=${metadata.releaseDate}`,
    `release_index=${metadata.releaseIndex}`,
    `release_name=${metadata.releaseName}`,
    `release_tag=${metadata.releaseTag}`
  ]

  appendFileSync(outputPath, `${lines.join('\n')}\n`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.mode === 'validate-date') {
    console.log(validateReleaseDate(options.date))
    return
  }

  if (options.mode === 'validate-app-version') {
    console.log(validateAppVersion(options.appVersion))
    return
  }

  if (options.mode === 'resolve') {
    const metadata = resolveReleaseMetadata({
      date: options.date,
      existingTags: options.existingTags
    })

    if (options.githubOutput) {
      writeGitHubOutputs(options.githubOutput, metadata)
    }

    console.log(JSON.stringify(metadata, null, 2))
    return
  }

  if (options.mode === 'from-tag') {
    const metadata = resolveReleaseMetadataFromTag(options.tag)

    if (options.githubOutput) {
      writeGitHubOutputs(options.githubOutput, metadata)
    }

    console.log(JSON.stringify(metadata, null, 2))
    return
  }

  throw new Error(
    'Usage: node scripts/desktop-release-metadata.mjs --resolve --date <YYYY.M.D> [--existing-tags-file path] [--github-output path] OR --from-tag --tag <vYYYY.M.D[-NNN]>'
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
