import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseReleaseNoteFragment,
  renderReleaseNotes,
  validateReleaseNoteFragment
} from './release-notes.mjs'

describe('release notes', () => {
  it('parses a release-note fragment with emoji-backed frontmatter', () => {
    const fragment = parseReleaseNoteFragment(
      'docs/releases/unreleased/readable-release-notes.md',
      `---
category: new
emoji: "📄"
title: "Readable Release Notes"
---

View stable releases through curated notes written for users instead of raw commit lists.
`
    )

    assert.deepEqual(fragment, {
      body: 'View stable releases through curated notes written for users instead of raw commit lists.',
      category: 'new',
      emoji: '📄',
      path: 'docs/releases/unreleased/readable-release-notes.md',
      title: 'Readable Release Notes'
    })
  })

  it('rejects fragments without exactly one emoji and a user-facing sentence', () => {
    assert.throws(
      () =>
        validateReleaseNoteFragment({
          body: 'Fixed IPC crash.',
          category: 'fix',
          emoji: '',
          path: 'docs/releases/unreleased/fix.md',
          title: 'IPC fix'
        }),
      /emoji/
    )

    assert.throws(
      () =>
        validateReleaseNoteFragment({
          body: 'Fixed IPC crash.',
          category: 'fix',
          emoji: '🛠️🧱',
          path: 'docs/releases/unreleased/fix.md',
          title: 'IPC fix'
        }),
      /exactly one emoji/
    )

    assert.throws(
      () =>
        validateReleaseNoteFragment({
          body: '',
          category: 'fix',
          emoji: '🛠️',
          path: 'docs/releases/unreleased/fix.md',
          title: 'IPC fix'
        }),
      /body/
    )
  })

  it('renders categorized release notes with one emoji per row', () => {
    const output = renderReleaseNotes({
      fragments: [
        {
          body: 'View stable releases through curated notes written for users instead of raw commit lists.',
          category: 'new',
          emoji: '📄',
          path: 'docs/releases/unreleased/readable-release-notes.md',
          title: 'Readable Release Notes'
        },
        {
          body: 'Dragging across note and journal blocks now selects the blocks themselves.',
          category: 'improvement',
          emoji: '🧱',
          path: 'docs/releases/unreleased/block-selection.md',
          title: 'Improved Editor Blocks'
        },
        {
          body: 'Calendar snooze chips now recover more gracefully after quick actions.',
          category: 'fix',
          emoji: '🛠️',
          path: 'docs/releases/unreleased/calendar-snooze.md',
          title: 'More Reliable Calendar Snoozes'
        }
      ],
      tag: 'v2026-05-07'
    })

    assert.equal(
      output,
      `# Memry v2026-05-07

## New Features

📄 **Readable Release Notes** — View stable releases through curated notes written for users instead of raw commit lists.

## Improvements

🧱 **Improved Editor Blocks** — Dragging across note and journal blocks now selects the blocks themselves.

## Stability and Fixes

🛠️ **More Reliable Calendar Snoozes** — Calendar snooze chips now recover more gracefully after quick actions.
`
    )
  })
})
