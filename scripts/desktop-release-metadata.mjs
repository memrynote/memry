#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const releaseDatePattern = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/
const isoReleaseDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/
const releaseTagPattern = /^v(\d{4})-(\d{2})-(\d{2})(?:\.([2-9]\d*))?$/
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
  const match = releaseTagPattern.exec(tag)
  if (!match) {
    throw new Error(`Invalid desktop release tag: ${tag}`)
  }

  const [, yearText, monthText, dayText, releaseIndexText] = match
  const date = validateCalendarDate(yearText, monthText, dayText)
  const index = releaseIndexText ? Number(releaseIndexText) : 1
  return { date, displayVersion: tag, index, tag }
}

export function resolveDraftReleaseMetadata({ date, draftTags = [], existingTags = [] }) {
  const currentDraft = resolveCurrentDraft(draftTags)
  if (currentDraft) {
    return buildMetadata({
      displayVersion: currentDraft.displayVersion,
      releaseDate: currentDraft.date,
      releaseIndex: currentDraft.index,
      releaseTag: currentDraft.tag
    })
  }

  const releaseDate = validateReleaseDate(date)
  const releaseIndex = resolveNextReleaseIndex(releaseDate, existingTags)
  const releaseTag = formatReleaseTag(releaseDate, releaseIndex)
  return buildMetadata({
    displayVersion: releaseTag,
    releaseDate,
    releaseIndex,
    releaseTag
  })
}

export function resolveReleaseMetadataFromTag(tag) {
  const parsed = parseReleaseTag(tag)
  return buildMetadata({
    displayVersion: parsed.displayVersion,
    releaseDate: parsed.date,
    releaseIndex: parsed.index,
    releaseTag: parsed.tag
  })
}

function buildMetadata({ displayVersion, releaseDate, releaseIndex, releaseTag }) {
  const appVersion = formatAppVersion(releaseDate, releaseIndex)
  const releaseAssetVersion = releaseTag.slice(1)

  return {
    appVersion,
    displayVersion,
    releaseAssetVersion,
    releaseDate,
    releaseIndex,
    releaseName: `Memry ${displayVersion}`,
    releaseTag
  }
}

function resolveCurrentDraft(draftTags) {
  const releases = draftTags.map(parseReleaseTagOrNull).filter(Boolean)
  if (releases.length === 0) {
    return null
  }

  return releases.sort(compareReleaseTags).at(-1)
}

function resolveNextReleaseIndex(releaseDate, existingTags) {
  const indexes = existingTags
    .map(parseReleaseTagOrNull)
    .filter((release) => release?.date === releaseDate)
    .map((release) => release.index)

  return indexes.length === 0 ? 1 : Math.max(...indexes) + 1
}

function parseReleaseTagOrNull(tag) {
  try {
    return parseReleaseTag(tag)
  } catch {
    return null
  }
}

function compareReleaseTags(left, right) {
  return (
    compareDate(left.date, right.date) ||
    left.index - right.index ||
    left.tag.localeCompare(right.tag)
  )
}

function compareDate(left, right) {
  const [leftYear, leftMonth, leftDay] = left.split('.').map(Number)
  const [rightYear, rightMonth, rightDay] = right.split('.').map(Number)
  return leftYear - rightYear || leftMonth - rightMonth || leftDay - rightDay
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

function formatReleaseTag(date, index) {
  const [year, month, day] = date.split('.').map(Number)
  const suffix = index === 1 ? '' : `.${index}`
  return `v${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}${suffix}`
}

function formatAppVersion(date, index) {
  const [year, month, day] = date.split('.').map(Number)
  const monthDay = Number(`${month}${String(day).padStart(2, '0')}`)
  return validateAppVersion(`${year}.${monthDay}.${index}`)
}

function hasLeadingZero(value) {
  return value.length > 1 && value.startsWith('0')
}

function parseArgs(argv) {
  const options = {
    draftTags: [],
    existingTags: []
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--resolve-draft') {
      options.mode = 'resolve-draft'
      continue
    }

    if (arg === '--from-tag') {
      options.mode = 'from-tag'
      continue
    }

    if (arg === '--validate-app-version') {
      options.mode = 'validate-app-version'
      options.appVersion = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--date') {
      options.date = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--tag') {
      options.tag = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--existing-tag') {
      options.existingTags.push(readRequiredValue(argv, index, arg))
      index += 1
      continue
    }

    if (arg === '--existing-tags-file') {
      options.existingTags.push(...readTagsFile(readRequiredValue(argv, index, arg)))
      index += 1
      continue
    }

    if (arg === '--draft-tag') {
      options.draftTags.push(readRequiredValue(argv, index, arg))
      index += 1
      continue
    }

    if (arg === '--draft-tags-file') {
      options.draftTags.push(...readTagsFile(readRequiredValue(argv, index, arg)))
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
    `release_asset_version=${metadata.releaseAssetVersion}`,
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

  if (options.mode === 'validate-app-version') {
    console.log(validateAppVersion(options.appVersion))
    return
  }

  if (options.mode === 'resolve-draft') {
    const metadata = resolveDraftReleaseMetadata({
      date: options.date,
      draftTags: options.draftTags,
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

  throw new Error('Usage: desktop-release-metadata.mjs --resolve-draft|--from-tag|--validate-app-version')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
