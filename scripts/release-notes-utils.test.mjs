import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildChangelogSection,
  buildHumanizedReleaseBody,
  buildHumanizedReleaseMarker,
  buildReleaseNotesPrompt,
  buildClaudeExecArgs,
  assertHumanizedReleaseNotesForPublish,
  extractPreviousTagFromReleaseBody,
  extractPullRequestNumbers,
  extractReleaseNote,
  hasCurrentHumanizedReleaseNotes,
  parseHumanizeReleaseArgs,
  validateHumanizedReleaseMarkdown
} from './release-notes-utils.mjs'

describe('release notes helpers', () => {
  it('extracts unique PR numbers from release-drafter markdown in order', () => {
    const body = [
      "## What's Changed",
      '- feat: add outline shortcut @kaan (#124)',
      '- fix: resolve media paths @kaan (#125)',
      '- docs: update setup guide @kaan (#124)'
    ].join('\n')

    assert.deepEqual(extractPullRequestNumbers(body), [124, 125])
  })

  it('extracts PR numbers from an existing deterministic changelog', () => {
    const body = [
      '## Changelog',
      '#124 feat: add outline shortcut @kaan',
      '#125 fix media @kaan'
    ].join('\n')

    assert.deepEqual(extractPullRequestNumbers(body), [124, 125])
  })

  it('uses the trailing PR number and ignores issue references in the title', () => {
    const body = [
      '## 🐛 Bug Fixes',
      '- fix(editor): guard ProseMirror view access before mount (#541) @h4yfans (#569)',
      '- fix(updater): strip HTML from release notes in update dialog (#514) @h4yfans (#566)',
      '- build(deps-dev): bump esbuild from 0.28.0 to 0.28.1 @[dependabot[bot]](https://github.com/apps/dependabot) (#560)'
    ].join('\n')

    assert.deepEqual(extractPullRequestNumbers(body), [569, 566, 560])
  })

  it('extracts a human release note from the PR body', () => {
    const body = [
      '## Summary',
      'Internal details.',
      '',
      '## Release note',
      'Open a note outline more quickly when navigating longer notes.',
      '',
      '## Test plan',
      'pnpm test'
    ].join('\n')

    assert.equal(
      extractReleaseNote(body),
      'Open a note outline more quickly when navigating longer notes.'
    )
  })

  it('treats release note none as no release note', () => {
    assert.equal(extractReleaseNote('## Release note\nnone\n\n## Test plan\npnpm test'), null)
  })

  it('ignores PR template comments when extracting release notes', () => {
    const body = [
      '## Release note',
      '<!-- User-facing release note, or `none` for internal-only changes. -->',
      'none',
      '',
      '## Test plan',
      '- pnpm test'
    ].join('\n')

    assert.equal(extractReleaseNote(body), null)
  })

  it('tracks the exact publish tag in the humanized marker', () => {
    const body = `${buildHumanizedReleaseMarker('v2026-05-08')}\n\n## New Features`

    assert.equal(hasCurrentHumanizedReleaseNotes(body, 'v2026-05-08'), true)
    assert.equal(hasCurrentHumanizedReleaseNotes(body, 'v2026-05-09'), false)
  })

  it('rejects publish when draft notes are not humanized for the resolved tag', () => {
    const body = `${buildHumanizedReleaseMarker('v2026-05-07')}\n\n## New Features`

    assert.throws(
      () =>
        assertHumanizedReleaseNotesForPublish({
          body,
          draftTag: 'vnext',
          expectedTag: 'v2026-05-08'
        }),
      /pnpm release:humanize -- --tag vnext/
    )
  })

  it('extracts the previous tag from an existing compare URL', () => {
    const body =
      '**Full Changelog**: https://github.com/memrynote/memry/compare/v2026-05-01...vnext'

    assert.equal(extractPreviousTagFromReleaseBody(body), 'v2026-05-01')
  })

  it('validates humanized markdown shape before editing a release', () => {
    const markdown = [
      '## New Features',
      '- 📑 Table of Contents Shortcut — Open note outlines faster.',
      '',
      '## Improvements',
      '- 🚀 Faster Startup — The app opens more quickly.',
      '',
      '## Fixes',
      '- 🔗 Better Media Paths — PDF links resolve more consistently.'
    ].join('\n')

    assert.equal(validateHumanizedReleaseMarkdown(markdown), markdown)
    assert.throws(
      () => validateHumanizedReleaseMarkdown('## New Features\n- Missing sections'),
      /Improvements/
    )
    assert.throws(
      () => validateHumanizedReleaseMarkdown(`${markdown}\n\n## Changelog`),
      /Changelog/
    )
    assert.throws(
      () =>
        validateHumanizedReleaseMarkdown(
          [
            '## New Features',
            '📑 No bullet dash — nope.',
            '',
            '## Improvements',
            '',
            '## Fixes'
          ].join('\n')
        ),
      /must be Markdown bullets/
    )
    assert.throws(
      () =>
        validateHumanizedReleaseMarkdown(
          [
            '## New Features',
            '- 📑 Table of Contents Shortcut — Open note outlines faster. (#124)',
            '',
            '## Improvements',
            '',
            '## Fixes'
          ].join('\n')
        ),
      /must not include a PR or issue number/
    )
  })

  it('accepts the no-user-facing-changes fallback shape', () => {
    const markdown = [
      '## New Features',
      '',
      '## Improvements',
      '- ✨ General improvements — performance and stability updates.',
      '',
      '## Fixes'
    ].join('\n')

    assert.equal(validateHumanizedReleaseMarkdown(markdown), markdown)
  })

  it('builds a deterministic changelog separate from AI prose', () => {
    const changelog = buildChangelogSection({
      compareUrl: 'https://github.com/memrynote/memry/compare/v2026-05-01...v2026-05-08',
      pullRequests: [
        { author: 'kaan', number: 124, title: 'feat: add table of contents shortcut' },
        { author: 'kaan', number: 125, title: 'fix: resolve media paths' }
      ]
    })

    assert.equal(
      changelog,
      [
        '## Changelog',
        'Full Changelog: https://github.com/memrynote/memry/compare/v2026-05-01...v2026-05-08',
        '',
        '#124 feat: add table of contents shortcut @kaan',
        '#125 fix: resolve media paths @kaan'
      ].join('\n')
    )
  })

  it('builds final release notes with marker, prose, and changelog', () => {
    const humanized = [
      '## New Features',
      '- 📑 Table of Contents Shortcut — Open note outlines faster.',
      '',
      '## Improvements',
      '- 🚀 Faster Startup — The app opens more quickly.',
      '',
      '## Fixes',
      '- 🔗 Better Media Paths — PDF links resolve more consistently.'
    ].join('\n')

    const body = buildHumanizedReleaseBody({
      compareUrl: 'https://github.com/memrynote/memry/compare/v2026-05-01...v2026-05-08',
      finalTag: 'v2026-05-08',
      humanizedMarkdown: humanized,
      pullRequests: [{ author: 'kaan', number: 124, title: 'feat: add table of contents shortcut' }]
    })

    assert.match(body, /^<!-- memry-humanized-release-notes tag=v2026-05-08 -->/)
    assert.match(body, /## New Features/)
    assert.match(body, /## Changelog/)
    assert.match(body, /#124 feat: add table of contents shortcut @kaan/)
  })

  it('builds a prompt that asks the model to rewrite facts, not invent them', () => {
    const prompt = buildReleaseNotesPrompt({
      finalTag: 'v2026-05-08',
      pullRequests: [
        {
          author: 'kaan',
          labels: ['feature'],
          number: 124,
          releaseNote: 'Open a note outline more quickly when navigating longer notes.',
          title: 'feat: add table of contents shortcut'
        }
      ]
    })

    assert.match(prompt, /Do not invent changes/)
    assert.match(prompt, /New Features/)
    assert.match(prompt, /"number": 124/)
    assert.match(prompt, /Open a note outline/)
  })

  it('builds claude exec args supported by current CLI', () => {
    assert.deepEqual(buildClaudeExecArgs(), [
      '-p',
      '--output-format',
      'text',
      '--setting-sources',
      ''
    ])

    assert.deepEqual(buildClaudeExecArgs({ model: 'claude-sonnet-4-6' }), [
      '-p',
      '--output-format',
      'text',
      '--setting-sources',
      '',
      '--model',
      'claude-sonnet-4-6'
    ])
  })

  it('parses humanizer CLI flags', () => {
    assert.deepEqual(
      parseHumanizeReleaseArgs(['--tag', 'vnext', '--dry-run', '--yes', '--model', 'gpt-5.4']),
      {
        dryRun: true,
        help: false,
        model: 'gpt-5.4',
        tag: 'vnext',
        yes: true
      }
    )
  })
})
