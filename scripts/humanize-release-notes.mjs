#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'

import {
  buildDateReleaseVersion,
  getReleaseListFields,
  selectDraftRelease
} from './release-utils.mjs'
import {
  buildCompareUrl,
  buildClaudeExecArgs,
  buildHumanizedReleaseBody,
  buildReleaseNotesPrompt,
  extractCompareBaseFromReleaseBody,
  extractPreviousTagFromReleaseBody,
  extractPullRequestNumbers,
  normalizePullRequest,
  parseHumanizeReleaseArgs
} from './release-notes-utils.mjs'

const releaseTimeZone = process.env.RELEASE_TIME_ZONE || 'Europe/Istanbul'

async function runCli() {
  const options = parseHumanizeReleaseArgs(process.argv.slice(2))

  if (options.help) {
    printHelp()
    return
  }

  runGh(['auth', 'status'], { stdio: 'inherit' })

  const releases = readGhJson([
    'release',
    'list',
    '--limit',
    '100',
    '--json',
    getReleaseListFields().join(',')
  ])
  const draft = selectDraftRelease(releases, options.tag)
  const draftDetails = readGhJson([
    'release',
    'view',
    draft.tagName,
    '--json',
    'tagName,name,isDraft,targetCommitish,body,url'
  ])
  const preview = buildDateReleaseVersion({
    date: new Date(),
    existingTags: releases.map((release) => release.tagName),
    ignoreTag: draftDetails.tagName,
    timeZone: releaseTimeZone
  })
  const pullRequestNumbers = extractPullRequestNumbers(draftDetails.body ?? '')

  if (pullRequestNumbers.length === 0) {
    throw new Error(`No PR numbers found in draft release ${draftDetails.tagName}`)
  }

  const pullRequests = pullRequestNumbers.map((number) =>
    normalizePullRequest(
      readGhJson(['pr', 'view', String(number), '--json', 'number,title,author,labels,body,url'])
    )
  )
  const previousTag = selectPreviousTag({
    draftBody: draftDetails.body ?? '',
    draftTag: draftDetails.tagName,
    releases
  })
  const compareBaseUrl =
    extractCompareBaseFromReleaseBody(draftDetails.body ?? '') ?? resolveCompareBaseUrl()
  const compareUrl = buildCompareUrl({
    compareBaseUrl,
    finalTag: preview.tag,
    previousTag
  })

  printPlan({
    compareUrl,
    draft: draftDetails,
    dryRun: options.dryRun,
    preview,
    pullRequests
  })

  const prompt = buildReleaseNotesPrompt({
    finalTag: preview.tag,
    pullRequests
  })
  const humanizedMarkdown = runClaude(prompt, options)
  const finalBody = buildHumanizedReleaseBody({
    compareUrl,
    finalTag: preview.tag,
    humanizedMarkdown,
    pullRequests
  })

  if (options.dryRun) {
    console.log('')
    console.log(finalBody.trim())
    return
  }

  writeCuratedReleaseNotes({ appVersion: preview.appVersion, markdown: humanizedMarkdown })

  if (!options.yes) {
    const confirmed = await confirmEdit()
    if (!confirmed) {
      console.log('Release notes update cancelled')
      process.exitCode = 1
      return
    }
  }

  const notesFile = writeTempNotes(finalBody)
  try {
    runGh(['release', 'edit', draftDetails.tagName, '--notes-file', notesFile], {
      stdio: 'inherit'
    })
  } finally {
    rmSync(path.dirname(notesFile), { force: true, recursive: true })
  }

  console.log(`Updated draft release notes: ${draftDetails.url}`)
}

function printPlan({ compareUrl, draft, dryRun, preview, pullRequests }) {
  console.log('')
  console.log('Humanize release notes')
  console.log(`  Draft: ${draft.tagName}`)
  console.log(`  URL: ${draft.url}`)
  console.log(`  Mode: ${dryRun ? 'dry run' : 'edit draft'}`)
  console.log(`  Resolved publish tag: ${preview.tag}`)
  console.log(`  PRs: ${pullRequests.map((pullRequest) => `#${pullRequest.number}`).join(', ')}`)
  console.log(`  Changelog: ${compareUrl}`)
  console.log('')
}

function runClaude(prompt, options) {
  const args = buildClaudeExecArgs({ model: options.model })

  const result = spawnSync('claude', args, {
    encoding: 'utf8',
    input: prompt
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(
      [`claude ${args.join(' ')} failed`, result.stdout?.trim(), result.stderr?.trim()]
        .filter(Boolean)
        .join('\n')
    )
  }

  const output = result.stdout?.trim()
  if (!output) {
    throw new Error('claude returned no release notes output')
  }

  return output
}

function selectPreviousTag({ draftBody, draftTag, releases }) {
  const tagFromBody = extractPreviousTagFromReleaseBody(draftBody)
  if (tagFromBody) {
    return tagFromBody
  }

  const previousRelease = releases
    .filter((release) => !release.isDraft && release.tagName !== draftTag)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .at(0)

  if (!previousRelease) {
    throw new Error('Could not resolve previous release tag for the changelog')
  }

  return previousRelease.tagName
}

function resolveCompareBaseUrl() {
  const nameWithOwner = runGh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  if (!nameWithOwner) {
    throw new Error('Could not resolve GitHub repository for changelog URL')
  }

  return `https://github.com/${nameWithOwner}/compare/`
}

async function confirmEdit() {
  if (!input.isTTY) {
    throw new Error('Use --yes to update release notes from a non-interactive shell')
  }

  const reader = createInterface({ input, output })
  try {
    const answer = await reader.question('Update draft release notes? [y/N] ')
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    reader.close()
  }
}

function writeCuratedReleaseNotes({ appVersion, markdown }) {
  const dir = path.resolve(process.cwd(), 'release-notes')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${appVersion}.md`)
  writeFileSync(file, `${markdown.trim()}\n`)
  execFileSync('git', ['add', file], { stdio: 'inherit' })
  console.log(
    `Wrote curated release notes: ${path.relative(process.cwd(), file)} (staged; commit with your release)`
  )
}

function writeTempNotes(body) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'memry-release-notes-'))
  const notesFile = path.join(tempDir, 'release-notes.md')
  writeFileSync(notesFile, body)
  return notesFile
}

function readGhJson(args) {
  return JSON.parse(runGh(args, { encoding: 'utf8' }))
}

function runGh(args, options = {}) {
  if (options.stdio === 'inherit') {
    const result = spawnSync('gh', args, { stdio: 'inherit' })
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      throw new Error(`gh ${args.join(' ')} failed`)
    }
    return ''
  }

  return execFileSync('gh', args, { encoding: options.encoding ?? 'utf8' }).trim()
}

function printHelp() {
  console.log(`Usage: pnpm release:humanize -- [options]

Options:
  --tag <tag>    Draft release tag to humanize. Defaults to the newest draft.
  --dry-run      Generate notes and print them without editing GitHub.
  --model <id>   Claude model override.
  --yes, -y      Skip the interactive confirmation prompt.
  --help, -h     Show this help.
`)
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
