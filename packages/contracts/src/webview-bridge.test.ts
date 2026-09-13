import { describe, expect, it } from 'vitest'
import {
  BRIDGE_PROTOCOL_VERSION,
  GuestMsgSchema,
  HostMsgSchema,
  type HostMsg
} from './webview-bridge.ts'

/**
 * The markdown conversion pair on the wire (T124).
 *
 * Both messages are added AT protocol version 1: the guest is a prebuilt asset
 * shipping inside the app that speaks to it, so there is no older peer on this
 * boundary — only a stale asset, which the freshness hash already catches.
 */
describe('markdown conversion pair', () => {
  it('stays at protocol version 1', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1)
  })

  it('accepts a seed-from-markdown carrying the create-time content verbatim', () => {
    const parsed = HostMsgSchema.safeParse({
      type: 'seed-from-markdown',
      reqId: 'seed:1',
      docId: 'note-1',
      content: '---\ntags: [alpha]\n---\n# Heading\n'
    })
    expect(parsed.success).toBe(true)
    // Verbatim means verbatim: the schema does not trim, split or normalise.
    expect(parsed.success && parsed.data).toMatchObject({
      content: '---\ntags: [alpha]\n---\n# Heading\n'
    })
  })

  it('accepts an empty content, which is the ordinary create', () => {
    expect(
      HostMsgSchema.safeParse({
        type: 'seed-from-markdown',
        reqId: 'seed:1',
        docId: 'note-1',
        content: ''
      }).success
    ).toBe(true)
  })

  it('requires a docId, so a seed can never land on whichever note is mounted', () => {
    expect(
      HostMsgSchema.safeParse({
        type: 'seed-from-markdown',
        reqId: 'seed:1',
        content: 'body'
      }).success
    ).toBe(false)
  })

  it('accepts every markdown-seed outcome', () => {
    const base = { type: 'markdown-seed', reqId: 'seed:1', docId: 'note-1' } as const
    for (const result of [
      { status: 'seeded' },
      { status: 'skipped', reason: 'not-empty' },
      { status: 'skipped', reason: 'no-body' },
      { status: 'error', detail: 'bad markdown' }
    ]) {
      expect(GuestMsgSchema.safeParse({ ...base, result }).success).toBe(true)
    }
  })

  it('refuses an error with no detail, so a failure is never reported as nothing', () => {
    expect(
      GuestMsgSchema.safeParse({
        type: 'markdown-seed',
        reqId: 'seed:1',
        docId: 'note-1',
        result: { status: 'error', detail: '' }
      }).success
    ).toBe(false)
  })

  it('keeps export-markdown, the other half of the pair, unchanged', () => {
    expect(
      HostMsgSchema.safeParse({
        type: 'export-markdown',
        reqId: 'md:1',
        docId: 'note-1'
      }).success
    ).toBe(true)
  })

  /**
   * Backward compatibility, both directions. An older host that never sends
   * `seed-from-markdown` still seeds through `doc-load.seedMarkdown`, which is
   * untouched; and an unknown message shape is REJECTED rather than silently
   * read as something else, so the guest reports it instead of acting on it.
   */
  it('leaves doc-load.seedMarkdown as the seed an older host asks for', () => {
    const parsed = HostMsgSchema.safeParse({
      type: 'doc-load',
      docId: 'note-1',
      stateB64: '',
      seedMarkdown: '# Heading\n'
    })
    expect(parsed.success).toBe(true)
    expect(
      parsed.success && (parsed.data as Extract<HostMsg, { type: 'doc-load' }>).seedMarkdown
    ).toBe('# Heading\n')
  })

  it('rejects a seed-from-markdown whose content is not a string', () => {
    expect(
      HostMsgSchema.safeParse({
        type: 'seed-from-markdown',
        reqId: 'seed:1',
        docId: 'note-1',
        content: { body: 'x' }
      }).success
    ).toBe(false)
  })
})
