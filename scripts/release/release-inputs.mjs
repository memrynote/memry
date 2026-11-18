#!/usr/bin/env node
// What every build job of publish-release.yml reads from the draft and the previous release.
// Usage:
//   node scripts/release/release-inputs.mjs previous <releases.json> --exclude-tag <draft tag>
//     prints the tag of the newest published release (`gh release list --json tagName,isDraft,createdAt`)
//   node scripts/release/release-inputs.mjs write <out-dir> --tag T --draft-tag D
//     --body <draft-body.md> --previous-tag P --previous-assets <names.json>
//     writes release-notes.md (the humanized notes of the draft, for `vpk --releaseNotes`) and
//     delta.json ({ previousTag, delta: { <pack target>: 'BestSpeed' | 'None' } })
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { extractHumanizedReleaseNotes } from '../release-notes-utils.mjs'
import { selectPreviousPublishedRelease } from '../velopack-release-utils.mjs'
import { isMain } from './is-main.mjs'
import { shouldPackDelta, TARGETS } from './vpk-args.mjs'

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** The `--delta` of each pack target: a delta only against a Tauri full package of its channel. */
export function deltaModes(previousAssetNames) {
  return Object.fromEntries(
    Object.entries(TARGETS).map(([name, { channel }]) => [
      name,
      shouldPackDelta(previousAssetNames, channel) ? 'BestSpeed' : 'None'
    ])
  )
}

export function runCli(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'exclude-tag': { type: 'string' },
      tag: { type: 'string' },
      'draft-tag': { type: 'string' },
      body: { type: 'string' },
      'previous-tag': { type: 'string', default: '' },
      'previous-assets': { type: 'string' }
    }
  })
  const [command, subject] = positionals

  if (command === 'previous' && subject && values['exclude-tag']) {
    return (
      selectPreviousPublishedRelease(readJson(subject), { excludeTag: values['exclude-tag'] }) ?? ''
    )
  }
  if (
    command === 'write' &&
    subject &&
    values.tag &&
    values['draft-tag'] &&
    values.body &&
    values['previous-assets']
  ) {
    const notes = extractHumanizedReleaseNotes(
      readFileSync(values.body, 'utf8'),
      values.tag,
      values['draft-tag']
    )
    const previousAssets = readJson(values['previous-assets'])
    if (!Array.isArray(previousAssets)) throw new Error('--previous-assets must hold a JSON array')
    mkdirSync(subject, { recursive: true })
    writeFileSync(path.join(subject, 'release-notes.md'), notes)
    const delta = { previousTag: values['previous-tag'], delta: deltaModes(previousAssets) }
    writeFileSync(path.join(subject, 'delta.json'), `${JSON.stringify(delta, null, 2)}\n`)
    return JSON.stringify(delta)
  }
  throw new Error(
    'usage: release-inputs.mjs previous <releases.json> --exclude-tag D | write <out-dir> --tag T --draft-tag D --body F --previous-tag P --previous-assets F'
  )
}

if (isMain(import.meta)) {
  try {
    console.log(runCli(process.argv.slice(2)))
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
