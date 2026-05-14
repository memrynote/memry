import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AttachmentInput } from '@memry/contracts/ipc-agent'
import type { InboxItemType } from '@memry/contracts/inbox-api'

import { MentionIcon, mentionColorForKind, type MentionIconSpec } from '../mention-icons'

describe('mention icons', () => {
  it('returns muted colors for every mention attachment kind', () => {
    const expected: Record<AttachmentInput['kind'], string> = {
      note: 'bg-sky-500/10 text-sky-700 ring-sky-500/15 dark:text-sky-300',
      current_note: 'bg-sky-500/10 text-sky-700 ring-sky-500/15 dark:text-sky-300',
      task: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/15 dark:text-emerald-300',
      inbox: 'bg-amber-500/10 text-amber-700 ring-amber-500/15 dark:text-amber-300',
      calendar_event: 'bg-violet-500/10 text-violet-700 ring-violet-500/15 dark:text-violet-300',
      journal: 'bg-rose-500/10 text-rose-700 ring-rose-500/15 dark:text-rose-300',
      folder: 'bg-stone-500/10 text-stone-700 ring-stone-500/15 dark:text-stone-300',
      project: 'bg-stone-500/10 text-stone-700 ring-stone-500/15 dark:text-stone-300'
    }

    for (const [kind, className] of Object.entries(expected)) {
      expect(mentionColorForKind(kind as AttachmentInput['kind'])).toBe(className)
    }
  })

  it('renders vector icons for non-emoji mention kinds', () => {
    const icons: MentionIconSpec[] = [
      { kind: 'note' },
      { kind: 'current_note' },
      { kind: 'task' },
      { kind: 'journal' },
      { kind: 'calendar_event' },
      { kind: 'folder' },
      { kind: 'project' }
    ]

    for (const icon of icons) {
      const { container, unmount } = render(<MentionIcon icon={icon} className="size-3" />)

      expect(container.querySelector('svg')).toBeTruthy()
      unmount()
    }
  })

  it('renders note emoji icons before falling back to the note vector icon', () => {
    render(<MentionIcon icon={{ kind: 'note', emoji: '🔥' }} />)

    expect(screen.getByText('🔥')).toBeInTheDocument()
  })

  it('renders every inbox item icon variant', () => {
    const itemTypes: Array<InboxItemType | null> = [
      'link',
      'note',
      'image',
      'voice',
      'video',
      'clip',
      'pdf',
      'social',
      'reminder',
      null
    ]

    for (const itemType of itemTypes) {
      const { container, unmount } = render(
        <MentionIcon icon={{ kind: 'inbox', itemType }} className="size-3" />
      )

      expect(container.querySelector('svg')).toBeTruthy()
      unmount()
    }
  })
})
