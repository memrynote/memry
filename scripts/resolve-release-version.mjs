#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildDateReleaseVersion } from './release-utils.mjs'

function parseArgs(argv) {
  const options = {
    date: undefined,
    ignoreTag: undefined,
    releasesFile: undefined,
    timeZone: process.env.RELEASE_TIME_ZONE || 'Europe/Istanbul'
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--releases-file') {
      options.releasesFile = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--ignore-tag') {
      options.ignoreTag = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--time-zone') {
      options.timeZone = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--date') {
      options.date = new Date(readRequiredValue(argv, index, arg))
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!options.releasesFile) {
    throw new Error('--releases-file is required')
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

function readReleaseTags(filePath) {
  const releases = JSON.parse(readFileSync(filePath, 'utf8'))
  if (!Array.isArray(releases)) {
    throw new Error('Release list JSON must be an array')
  }

  return releases.map((release) => release.tagName).filter(Boolean)
}

function writeGithubOutput(result) {
  const githubOutput = process.env.GITHUB_OUTPUT
  if (!githubOutput) {
    return
  }

  appendFileSync(
    githubOutput,
    [
      `tag=${result.tag}`,
      `app_version=${result.appVersion}`,
      `release_name=${result.releaseName}`,
      `release_index=${result.releaseIndex}`
    ].join('\n') + '\n'
  )
}

function runCli() {
  const options = parseArgs(process.argv.slice(2))
  const result = buildDateReleaseVersion({
    date: options.date ?? new Date(),
    existingTags: readReleaseTags(options.releasesFile),
    ignoreTag: options.ignoreTag,
    timeZone: options.timeZone
  })

  writeGithubOutput(result)
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
