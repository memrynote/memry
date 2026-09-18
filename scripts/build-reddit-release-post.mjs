#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import { buildRedditReleasePost, formatRedditCopyPastePost } from './reddit-release-utils.mjs'

function runCli() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    printHelp()
    return
  }

  const release = options.releaseFile
    ? parseJson(readFileSync(options.releaseFile, 'utf8'), options.releaseFile)
    : readGitHubRelease(options.tag)
  const post = buildRedditReleasePost({
    appVersion: options.appVersion,
    date: new Date(),
    intro: options.intro,
    release: {
      ...release,
      tagName: options.tag ?? release.tagName
    },
    subreddit: options.subreddit,
    timeZone: process.env.RELEASE_TIME_ZONE || 'Europe/Istanbul'
  })
  const output = formatRedditCopyPastePost(post)

  if (options.output) {
    writeFileSync(options.output, `${output}\n`)
  }

  console.log(output)
}

function readGitHubRelease(tag) {
  const args = ['release', 'view']

  if (tag) {
    args.push(tag)
  }

  args.push('--json', 'tagName,body,url,assets')
  return parseJson(execFileSync('gh', args, { encoding: 'utf8' }), 'gh release view')
}

function parseJson(raw, source) {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Could not parse release JSON from ${source}: ${error.message}`)
  }
}

function parseArgs(argv) {
  const options = {
    appVersion: undefined,
    help: false,
    intro: undefined,
    output: undefined,
    releaseFile: undefined,
    subreddit: 'MemryNote',
    tag: undefined
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--') {
      continue
    }

    if (arg === '--release-file') {
      options.releaseFile = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('--release-file=')) {
      options.releaseFile = arg.slice('--release-file='.length)
      continue
    }

    if (arg === '--app-version') {
      options.appVersion = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('--app-version=')) {
      options.appVersion = arg.slice('--app-version='.length)
      continue
    }

    if (arg === '--intro') {
      options.intro = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('--intro=')) {
      options.intro = arg.slice('--intro='.length)
      continue
    }

    if (arg === '--tag') {
      options.tag = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }

    if (arg === '--subreddit') {
      options.subreddit = normalizeSubreddit(readRequiredValue(argv, index, arg))
      index += 1
      continue
    }

    if (arg.startsWith('--subreddit=')) {
      options.subreddit = normalizeSubreddit(arg.slice('--subreddit='.length))
      continue
    }

    if (arg === '--output') {
      options.output = readRequiredValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length)
      continue
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function normalizeSubreddit(value) {
  return value.replace(/^r\//i, '')
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function printHelp() {
  console.log(`Usage: pnpm release:reddit -- [options]

Print a copy/paste Reddit post from a GitHub release. Defaults to the latest release.

Options:
  --tag <tag>            Release tag to read with gh release view.
  --release-file <path>  Local release JSON with tagName, body, and url.
  --app-version <value>  App version shown in the Reddit title.
  --intro <text>         Custom opening line. Defaults to a generated summary.
  --subreddit <name>     Target subreddit. Defaults to MemryNote.
  --output <path>        Also write the copy/paste output to a file.
  --help, -h             Show this help.
`)
}

try {
  runCli()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
