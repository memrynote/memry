#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const releaseDatePattern = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/
const isoReleaseDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const releaseTagPattern = /^v(\d{4})-(\d{2})-(\d{2})$/
const legacyStableTagPattern = /^stable-v(\d{4})\.(\d{1,2})\.(\d{1,2})$/
const appVersionPattern = /^(\d{4})\.(\d{3,4})\.(\d+)$/

export function validateReleaseDate(input) {
  const isoMatch = isoReleaseDatePattern.exec(input)
  if (isoMatch) {
    const [, yearText, monthText, dayText] = isoMatch
    return validateCalendarDate(yearText, monthText, dayText)
  }

  const match = releaseDatePattern.exec(input)
  if (!match) {
    throw new Error('Release date must match YYYY.M.D or YYYY-MM-DD')
  }

  const [, yearText, monthText, dayText] = match
  if (hasLeadingZero(monthText) || hasLeadingZero(dayText)) {
    throw new Error('Release date month and day must not be zero-padded')
  }

  return validateCalendarDate(yearText, monthText, dayText)
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
  const stableMatch = releaseTagPattern.exec(tag)
  if (stableMatch) {
    const [, yearText, monthText, dayText] = stableMatch
    const date = validateCalendarDate(yearText, monthText, dayText)
    return { date, displayVersion: tag, index: 1, tag }
  }

  const legacyMatch = legacyStableTagPattern.exec(tag)
  if (legacyMatch) {
    const [, yearText, monthText, dayText] = legacyMatch
    const date = validateReleaseDate(`${yearText}.${monthText}.${dayText}`)
    return { date, displayVersion: date, index: 1, tag }
  }

  throw new Error(`Invalid desktop release tag: ${tag}`)
}

export function resolveReleaseMetadata({ date }) {
  const releaseDate = validateReleaseDate(date)
  const releaseTag = formatReleaseTag(releaseDate)
  return buildMetadata({
    displayVersion: releaseTag,
    releaseDate,
    releaseTag
  })
}

export function resolveReleaseMetadataFromTag(tag) {
  const parsed = parseReleaseTag(tag)
  return buildMetadata({
    displayVersion: parsed.displayVersion,
    releaseDate: parsed.date,
    releaseTag: parsed.tag
  })
}

function buildMetadata({ displayVersion, releaseDate, releaseTag }) {
  const releaseIndex = 1
  const appVersion = formatAppVersion(releaseDate, releaseIndex)

  return {
    appVersion,
    displayVersion,
    releaseDate,
    releaseIndex,
    releaseName: `Memry ${displayVersion}`,
    releaseTag
  }
}

function validateCalendarDate(yearText, monthText, dayText) {
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

function formatReleaseTag(date) {
  const [year, month, day] = date.split('.').map(Number)
  return `v${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function formatAppVersion(date, index) {
  const [year, month, day] = date.split('.').map(Number)
  return validateAppVersion(`${year}.${Number(`${month}${String(day).padStart(2, '0')}`)}.${index}`)
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
    `display_version=${metadata.displayVersion}`,
    `release_date=${metadata.releaseDate}`,
    `release_index=${metadata.releaseIndex}`,
    `release_name=${metadata.releaseName}`,
    `release_tag=${metadata.releaseTag}`,
    `tag=${metadata.releaseTag}`,
    `version=${metadata.appVersion}`
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
    'Usage: node scripts/desktop-release-metadata.mjs --resolve --date <YYYY.M.D|YYYY-MM-DD> [--github-output path] OR --from-tag --tag <vYYYY-MM-DD|stable-vYYYY.M.D>'
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
