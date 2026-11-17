import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { buildHumanizedReleaseBody } from '../release-notes-utils.mjs'
import { deltaModes, runCli } from './release-inputs.mjs'

function inTemp(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-inputs-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// v2026-10-15, the last Electron release.
const ELECTRON_ASSETS = [
  'latest-mac.yml',
  'MemryNote-2026.1015.1-arm64.zip',
  'MemryNote-2026.1015.1-full.nupkg',
  'MemryNote-2026.1015.1-delta.nupkg',
  'releases.win.json',
  'RELEASES'
]

describe('deltaModes', () => {
  it('packs every target without a delta after an Electron release', () => {
    assert.deepEqual(deltaModes(ELECTRON_ASSETS), {
      'win-x64': 'None',
      'win-arm64': 'None',
      'osx-arm64': 'None',
      'osx-x64': 'None',
      'linux-x64': 'None'
    })
    assert.deepEqual(new Set(Object.values(deltaModes([]))), new Set(['None']))
  })

  it('packs a delta for each channel a Tauri release published', () => {
    const tauri = [
      'releases.win.json',
      'releases.win-arm64.json',
      'releases.osx-arm64.json',
      'releases.osx-x64.json'
    ]
    assert.deepEqual(deltaModes(tauri), {
      'win-x64': 'BestSpeed',
      'win-arm64': 'BestSpeed',
      'osx-arm64': 'BestSpeed',
      'osx-x64': 'BestSpeed',
      'linux-x64': 'None'
    })
  })
})

describe('release-inputs CLI', () => {
  it('names the newest published release, never the draft', () =>
    inTemp((dir) => {
      const releases = path.join(dir, 'releases.json')
      writeFileSync(
        releases,
        JSON.stringify([
          { tagName: 'v2026-11-18', isDraft: true, createdAt: '2026-11-18T08:00:00Z' },
          { tagName: 'v2026-11-11', isDraft: false, createdAt: '2026-11-11T08:00:00Z' },
          { tagName: 'v2026-11-08', isDraft: false, createdAt: '2026-11-08T08:00:00Z' }
        ])
      )
      const previous = (exclude) => runCli(['previous', releases, '--exclude-tag', exclude])
      assert.equal(previous('v2026-11-18'), 'v2026-11-11')
      writeFileSync(releases, '[]')
      assert.equal(previous('v2026-11-18'), '')
    }))

  it('writes the humanized notes and the delta plan', () =>
    inTemp((dir) => {
      const humanized = '## Fixes\n- 🔗 Better Media Paths — PDF links resolve more consistently.'
      const body = path.join(dir, 'body.md')
      writeFileSync(
        body,
        buildHumanizedReleaseBody({
          compareUrl: 'https://github.com/memrynote/memry/compare/v2026-11-11...v2026-11-18',
          finalTag: 'v2026-11-18',
          humanizedMarkdown: humanized,
          pullRequests: [{ author: 'kaan', number: 5000, title: 'fix: media paths' }]
        })
      )
      const assets = path.join(dir, 'assets.json')
      writeFileSync(assets, JSON.stringify(ELECTRON_ASSETS))
      const out = path.join(dir, 'out')
      assert.throws(() => runCli(['write', out, '--tag', 'v2026-11-18', '--body', body]), /usage/)

      runCli([
        'write',
        out,
        '--tag',
        'v2026-11-18',
        '--body',
        body,
        '--previous-tag',
        'v2026-11-11',
        '--previous-assets',
        assets
      ])
      assert.equal(readFileSync(path.join(out, 'release-notes.md'), 'utf8'), `${humanized}\n`)
      const plan = JSON.parse(readFileSync(path.join(out, 'delta.json'), 'utf8'))
      assert.equal(plan.previousTag, 'v2026-11-11')
      assert.equal(plan.delta['osx-arm64'], 'None')
    }))

  it('refuses a draft not humanized for the release tag', () =>
    inTemp((dir) => {
      const body = path.join(dir, 'body.md')
      writeFileSync(body, "## What's Changed\n- fix: media paths (#5000)\n")
      const assets = path.join(dir, 'assets.json')
      writeFileSync(assets, '[]')
      assert.throws(
        () =>
          runCli([
            'write',
            path.join(dir, 'out'),
            '--tag',
            'v2026-11-18',
            '--body',
            body,
            '--previous-assets',
            assets
          ]),
        /have not been humanized for v2026-11-18/
      )
    }))
})
