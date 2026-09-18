import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildRedditReleasePost,
  extractRedditReleaseSections,
  formatRedditCopyPastePost,
  resolveReleaseAppVersion
} from './reddit-release-utils.mjs'

describe('reddit release helpers', () => {
  const releaseBody = [
    '<!-- memry-humanized-release-notes tag=v2026-05-08 -->',
    '',
    '## New Features',
    '- 📑 Table of Contents Shortcut — open note outlines faster. (#124)',
    '',
    '## Bug Fixes',
    '- 🔗 Better Media Paths — PDF links resolve more consistently. (#125)',
    '',
    '## Documentation',
    '',
    '## Chores',
    '- 🧹 Release Maintenance — Build script housekeeping. (#127)',
    '',
    '## Changelog',
    'Full Changelog: https://github.com/memrynote/memry/compare/v2026-05-01...v2026-05-08',
    '',
    '#124 feat: add table of contents shortcut @kaan'
  ].join('\n')

  it('builds a consumer-facing Reddit post from humanized release notes', () => {
    const post = buildRedditReleasePost({
      date: new Date('2026-05-08T10:00:00Z'),
      release: {
        assets: [
          {
            name: 'MemryNote-2026.508.1-arm64.dmg',
            size: 220699650,
            url: 'https://github.com/memrynote/memry/releases/download/v2026-05-08/MemryNote-2026.508.1-arm64.dmg'
          },
          {
            name: 'MemryNote-2026.508.1-setup.exe',
            size: 335441536,
            url: 'https://github.com/memrynote/memry/releases/download/v2026-05-08/MemryNote-2026.508.1-setup.exe'
          },
          {
            name: 'MemryNote-win-Setup.exe',
            size: 452781080,
            url: 'https://github.com/memrynote/memry/releases/download/v2026-05-08/MemryNote-win-Setup.exe'
          },
          {
            name: 'MemryNote-2026.508.1-x86_64.AppImage',
            size: 209451428,
            url: 'https://github.com/memrynote/memry/releases/download/v2026-05-08/MemryNote-2026.508.1-x86_64.AppImage'
          }
        ],
        body: releaseBody,
        tagName: 'v2026-05-08',
        url: 'https://github.com/memrynote/memry/releases/tag/v2026-05-08'
      },
      timeZone: 'Europe/Istanbul'
    })

    assert.equal(post.subreddit, 'MemryNote')
    assert.equal(post.title, 'MemryNote Desktop Update - 2026.508.1 (v2026-05-08)')
    assert.match(
      post.text,
      /MemryNote \*\*2026\.508\.1\*\* ships 1 new feature, 1 fix, and 1 chore\./
    )
    assert.match(post.text, /📑 \*\*Table of Contents Shortcut\*\*\. Open note outlines faster\./)
    assert.match(post.text, /🔗 \*\*Better Media Paths\*\*\. PDF links resolve more consistently\./)
    assert.match(post.text, /^## 📆 May 8, 2026 at 01:00:00 PM$/m)
    assert.match(post.text, /^\* 📑 \*\*Table of Contents Shortcut\*\*\./m)
    assert.doesNotMatch(post.text, /^## (?!📆)/m)
    assert.doesNotMatch(post.text, /#124/)
    assert.doesNotMatch(post.text, /Changelog/)
    assert.match(
      post.text,
      /\[Release Notes\]\(https:\/\/github\.com\/memrynote\/memry\/releases\/tag\/v2026-05-08\)/
    )
    // Signed Velopack installer wins over the unsigned electron-builder setup.exe.
    assert.match(post.text, /\[Windows\]\(\S+MemryNote-win-Setup\.exe\) \(431\.81 MiB\)/)
    assert.match(
      post.text,
      /\[macOS\]\(\S+-arm64\.dmg\) \(210\.48 MiB\).+\[Linux\]\(\S+\.AppImage\)/
    )
  })

  it('orders sections as features, improvements, fixes, then the rest', () => {
    const sections = extractRedditReleaseSections(
      [
        '## Chores',
        '- 🧹 Housekeeping — tidy build scripts.',
        '## Bug Fixes',
        '- 🔗 Better Media Paths — PDF links resolve.',
        '## Improvements',
        '- ⬇️ Steadier Updates — the updater retries.',
        '## New Features',
        '- 📑 Outline Shortcut — open note outlines faster.'
      ].join('\n')
    )

    assert.deepEqual(
      sections.map((section) => section.heading),
      ['New Features', 'Improvements', 'Bug Fixes', 'Chores']
    )
  })

  it('accepts a custom intro line', () => {
    const post = buildRedditReleasePost({
      date: new Date('2026-05-08T10:00:00Z'),
      intro: 'MemryNote **2026.508.1** brings calmer navigation.',
      release: {
        body: releaseBody,
        tagName: 'v2026-05-08'
      },
      timeZone: 'Europe/Istanbul'
    })

    assert.match(post.text, /MemryNote \*\*2026\.508\.1\*\* brings calmer navigation\./)
  })

  it('derives the app version from publish-date release tags', () => {
    assert.equal(resolveReleaseAppVersion('v2026-05-08'), '2026.508.1')
    assert.equal(resolveReleaseAppVersion('v2026-11-14.3'), '2026.1114.3')
    assert.equal(resolveReleaseAppVersion('vnext'), null)
  })

  it('formats a copy-paste Reddit post', () => {
    assert.equal(
      formatRedditCopyPastePost({
        subreddit: 'MemryNote',
        text: 'Release body',
        title: 'MemryNote Desktop Update - 2026.508.1 (v2026-05-08)'
      }),
      [
        'Subreddit:',
        'r/MemryNote',
        '',
        'Title:',
        'MemryNote Desktop Update - 2026.508.1 (v2026-05-08)',
        '',
        'Body:',
        'Release body'
      ].join('\n')
    )
  })

  it('rejects release bodies without humanized notes', () => {
    assert.throws(
      () =>
        extractRedditReleaseSections(
          [
            '<!-- memry-humanized-release-notes tag=v2026-05-08 -->',
            '',
            '## Changelog',
            'Full Changelog: https://github.com/memrynote/memry/compare/v2026-05-01...v2026-05-08'
          ].join('\n')
        ),
      /no humanized release notes/
    )
  })
})
