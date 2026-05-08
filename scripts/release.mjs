#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import {
  buildDateReleaseVersion,
  getReleaseListFields,
  parseReleaseArgs,
  selectDraftRelease
} from './release-utils.mjs'

const workflowFile = 'publish-release.yml'
const workflowName = 'Publish Desktop Release'
const releaseTimeZone = process.env.RELEASE_TIME_ZONE || 'Europe/Istanbul'

async function runCli() {
  const options = parseReleaseArgs(process.argv.slice(2))

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
    'tagName,name,isDraft,targetCommitish,body,assets,url'
  ])
  const preview = buildDateReleaseVersion({
    date: new Date(),
    existingTags: releases.map((release) => release.tagName),
    ignoreTag: draftDetails.tagName,
    timeZone: releaseTimeZone
  })

  printPlan({ draft: draftDetails, dryRun: options.dryRun, preview })

  if (!options.yes) {
    const confirmed = await confirmDispatch()
    if (!confirmed) {
      console.log('Release dispatch cancelled')
      return
    }
  }

  runGh(
    [
      'workflow',
      'run',
      workflowFile,
      '--ref',
      'main',
      '-f',
      `draft_tag=${draftDetails.tagName}`,
      '-f',
      `dry_run=${options.dryRun ? 'true' : 'false'}`
    ],
    { stdio: 'inherit' }
  )

  const run = await findDispatchedRun()
  if (!run) {
    console.log(`Workflow dispatched. Open GitHub Actions and check ${workflowName}.`)
    return
  }

  console.log(`Workflow: ${run.url}`)

  if (options.watch) {
    runGh(['run', 'watch', String(run.databaseId), '--exit-status'], { stdio: 'inherit' })
  }
}

function printPlan({ draft, dryRun, preview }) {
  console.log('')
  console.log('Release draft')
  console.log(`  Tag: ${draft.tagName}`)
  console.log(`  Name: ${draft.name}`)
  console.log(`  URL: ${draft.url}`)
  console.log(`  Target: ${draft.targetCommitish}`)
  console.log(`  Existing assets: ${draft.assets?.length ?? 0}`)
  console.log('')
  console.log('Publish workflow')
  console.log(`  Mode: ${dryRun ? 'dry run' : 'publish'}`)
  console.log(`  Final tag: ${preview.tag}`)
  console.log(`  App version: ${preview.appVersion}`)
  console.log(`  Release name: ${preview.releaseName}`)
  console.log('')
}

async function confirmDispatch() {
  if (!input.isTTY) {
    throw new Error('Use --yes to dispatch from a non-interactive shell')
  }

  const reader = createInterface({ input, output })
  try {
    const answer = await reader.question('Dispatch publish workflow? [y/N] ')
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    reader.close()
  }
}

async function findDispatchedRun() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) {
      await sleep(3000)
    }

    const runs = readGhJson([
      'run',
      'list',
      '--workflow',
      workflowFile,
      '--branch',
      'main',
      '--limit',
      '5',
      '--json',
      'databaseId,url,status,event,createdAt'
    ])
    const run = runs.find((candidate) => candidate.event === 'workflow_dispatch')
    if (run) {
      return run
    }
  }

  return null
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printHelp() {
  console.log(`Usage: pnpm release -- [options]

Options:
  --tag <tag>    Draft release tag to publish. Defaults to the newest draft.
  --dry-run      Build in GitHub Actions and upload workflow artifacts only.
  --no-watch     Dispatch the workflow without watching it.
  --yes, -y      Skip the interactive confirmation prompt.
  --help, -h     Show this help.
`)
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
