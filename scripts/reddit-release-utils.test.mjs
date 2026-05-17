import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildRedditReleasePost,
  extractRedditReleaseMarkdown,
  formatRedditCopyPastePost,
  resolveReleaseAppVersion
} from './reddit-release-utils.mjs'

describe('reddit release helpers', () => {
  const releaseBody = [
    '<!-- memry-humanized-release-notes tag=v2026-05-08 -->',
    '',
    '## New Features',
    '- 📑 Table of Contents Shortcut — Open note outlines faster. (#124)',
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
        body: releaseBody,
        tagName: 'v2026-05-08',
        url: 'https://github.com/memrynote/memry/releases/tag/v2026-05-08'
      },
      timeZone: 'Europe/Istanbul'
    })

    assert.equal(post.subreddit, 'MemryNote')
    assert.equal(post.title, 'Memry Update - 2026.508.1 (v2026-05-08)')
    assert.match(post.text, /🗞️ Release Notes/)
    assert.match(post.text, /📆 May 8, 2026 at 01:00:00 PM/)
    assert.match(post.text, /## New Features/)
    assert.match(post.text, /- 📑 Table of Contents Shortcut — Open note outlines faster\./)
    assert.match(post.text, /## Bug Fixes/)
    assert.doesNotMatch(post.text, /## Documentation/)
    assert.doesNotMatch(post.text, /#124/)
    assert.doesNotMatch(post.text, /Changelog/)
    assert.match(
      post.text,
      /Release notes and downloads: https:\/\/github\.com\/memrynote\/memry\/releases\/tag\/v2026-05-08/
    )
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
        title: 'Memry Update - 2026.508.1 (v2026-05-08)'
      }),
      [
        'Subreddit:',
        'r/MemryNote',
        '',
        'Title:',
        'Memry Update - 2026.508.1 (v2026-05-08)',
        '',
        'Body:',
        'Release body'
      ].join('\n')
    )
  })

  it('rejects release bodies without humanized notes', () => {
    assert.throws(
      () =>
        extractRedditReleaseMarkdown(
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
