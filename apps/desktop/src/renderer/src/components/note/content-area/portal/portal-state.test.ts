import { describe, expect, it } from 'vitest'
import { PORTAL_MAX_DEPTH } from '@memry/shared/portal-block'
import {
  ROOT_PORTAL_ANCESTRY,
  descendPortalAncestry,
  isPortalBlocked,
  isPortalCycle,
  resolvePortalStatus,
  withHostFrame,
  type PortalAncestry,
  type PortalStatusInput,
  type PortalWindowTarget
} from './portal-state'

const whole = (note: string): PortalWindowTarget => ({ kind: 'note', note })
const block = (note: string, anchor: string): PortalWindowTarget => ({
  kind: 'blocks',
  note,
  blocks: [anchor],
  open: {}
})

function input(overrides: Partial<PortalStatusInput> = {}): PortalStatusInput {
  return {
    target: whole('src'),
    ancestry: ROOT_PORTAL_ANCESTRY,
    source: 'found',
    syncing: false,
    locked: false,
    blockFound: null,
    ...overrides
  }
}

describe('isPortalCycle', () => {
  it('flags a whole-note portal inside its own note', () => {
    expect(isPortalCycle(whole('a'), withHostFrame(ROOT_PORTAL_ANCESTRY, 'a'))).toBe(true)
  })

  it('allows a block of the host note: the portal is only inside it if it sits in that block', () => {
    expect(isPortalCycle(block('a', 'x1x1'), withHostFrame(ROOT_PORTAL_ANCESTRY, 'a'))).toBe(false)
  })

  it('catches a portal that sits inside the block it shows, one window down', () => {
    const inside = descendPortalAncestry(
      withHostFrame(ROOT_PORTAL_ANCESTRY, 'a'),
      block('a', 'x1x1')
    )
    expect(isPortalCycle(block('a', 'x1x1'), withHostFrame(inside, 'a'))).toBe(true)
  })

  it('allows another block of a note an enclosing window shows', () => {
    const inside = descendPortalAncestry(ROOT_PORTAL_ANCESTRY, whole('b'))
    expect(isPortalCycle(block('b', 'y2y2'), inside)).toBe(false)
  })

  it('flags A shows B shows A', () => {
    let ancestry: PortalAncestry = withHostFrame(ROOT_PORTAL_ANCESTRY, 'a')
    ancestry = descendPortalAncestry(ancestry, whole('b'))
    expect(isPortalCycle(whole('a'), withHostFrame(ancestry, 'b'))).toBe(true)
  })
})

describe('resolvePortalStatus', () => {
  it('is ok for a live, unlocked source', () => {
    expect(resolvePortalStatus(input())).toBe('ok')
  })

  it('waits while the source loads', () => {
    expect(resolvePortalStatus(input({ source: 'loading' }))).toBe('loading')
  })

  it('names a deleted source, or one still syncing in', () => {
    expect(resolvePortalStatus(input({ source: 'missing' }))).toBe('missing-note')
    expect(resolvePortalStatus(input({ source: 'missing', syncing: true }))).toBe('not-synced')
  })

  it('names a missing block only once the window has looked', () => {
    const target = block('src', 'abcd')
    expect(resolvePortalStatus(input({ target, blockFound: null }))).toBe('ok')
    expect(resolvePortalStatus(input({ target, blockFound: true }))).toBe('ok')
    expect(resolvePortalStatus(input({ target, blockFound: false }))).toBe('missing-block')
  })

  it('reports a locked source', () => {
    expect(resolvePortalStatus(input({ locked: true }))).toBe('locked')
  })

  it('stops at the depth limit', () => {
    let ancestry: PortalAncestry = ROOT_PORTAL_ANCESTRY
    for (let i = 0; i < PORTAL_MAX_DEPTH; i += 1) {
      ancestry = descendPortalAncestry(ancestry, whole(`n${i}`))
    }
    expect(resolvePortalStatus(input({ ancestry }))).toBe('too-deep')
    expect(resolvePortalStatus(input({ ancestry: { frames: ancestry.frames.slice(1) } }))).toBe(
      'ok'
    )
  })

  it('reports a cycle before anything else', () => {
    const ancestry = withHostFrame(ROOT_PORTAL_ANCESTRY, 'src')
    expect(resolvePortalStatus(input({ ancestry, source: 'missing' }))).toBe('cycle')
  })
})

describe('isPortalBlocked', () => {
  it('draws content for ok and locked, and shows a card for every other state', () => {
    expect(isPortalBlocked('ok')).toBe(false)
    expect(isPortalBlocked('locked')).toBe(false)
    expect(isPortalBlocked('loading')).toBe(false)
    for (const status of [
      'missing-note',
      'missing-block',
      'cycle',
      'too-deep',
      'not-synced'
    ] as const) {
      expect(isPortalBlocked(status)).toBe(true)
    }
  })
})
