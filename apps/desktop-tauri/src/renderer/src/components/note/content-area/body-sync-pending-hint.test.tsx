import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { BodySyncPendingHint } from './body-sync-pending-hint'

const mocks = vi.hoisted(() => ({
  syncContextValue: null as null | {
    state: { initialSyncProgress: { phase: string; current: number; total: number } | null }
  }
}))

vi.mock('@/contexts/sync-context', () => ({
  useSyncOptional: () => mocks.syncContextValue
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

const initialSyncActive = () => {
  mocks.syncContextValue = {
    state: { initialSyncProgress: { phase: 'notes', current: 12, total: 200 } }
  }
}

const makeFragment = (): Y.XmlFragment => {
  const doc = new Y.Doc()
  return doc.getXmlFragment('blocks')
}

describe('BodySyncPendingHint', () => {
  beforeEach(() => {
    mocks.syncContextValue = null
  })

  it('shows the pending hint for an empty doc while the initial sync is running', () => {
    // #given a note opened mid-initial-sync whose cold CRDT batch has not
    // applied — main seeds nothing from an empty markdown file, so the editor
    // binds a live, empty fragment (#1830)
    initialSyncActive()

    render(<BodySyncPendingHint fragment={makeFragment()} />)

    // #then the phantom empty body is labelled as possibly still syncing
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText('editor.bodySyncPending')).toBeInTheDocument()
  })

  it('clears the hint the moment the body streams in', () => {
    // #given the hint is showing
    initialSyncActive()
    const fragment = makeFragment()
    render(<BodySyncPendingHint fragment={fragment} />)
    expect(screen.getByRole('status')).toBeInTheDocument()

    // #when the cold batch applies and content lands in the live fragment
    act(() => {
      fragment.insert(0, [new Y.XmlElement('paragraph')])
    })

    // #then the note no longer reads as empty, so the hint retires
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('never shows for a doc that already has content', () => {
    initialSyncActive()
    const fragment = makeFragment()
    fragment.insert(0, [new Y.XmlElement('paragraph')])

    render(<BodySyncPendingHint fragment={fragment} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('stays silent outside the initial sync window', () => {
    // #given steady state — an empty doc here is just an empty note
    mocks.syncContextValue = { state: { initialSyncProgress: null } }

    render(<BodySyncPendingHint fragment={makeFragment()} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('stays silent with no sync provider at all', () => {
    // #given a mount outside SyncProvider (canvas embeds, tests) — no
    // provider must read as "no initial sync running"
    mocks.syncContextValue = null

    render(<BodySyncPendingHint fragment={makeFragment()} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
