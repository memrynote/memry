import { describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { deleteAttestationPayload } from '@memry/contracts/delete-attestation'
import { signPayload } from '../../crypto/signatures'
import type { DrizzleDb } from '../item-handlers'
import {
  applicablePurgedTombstones,
  parsePullItems,
  purgedTombstoneApplyItems
} from './pull-envelope'
import { localTombstoneRefusal } from './purged-tombstone-guard'

vi.mock('./purged-tombstone-guard', () => ({
  readKnownDeviceIds: vi.fn(() => null),
  localTombstoneRefusal: vi.fn(() => null)
}))
vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

const db = {} as DrizzleDb

await sodium.ready
const keys = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(3))
const resolveKey = vi.fn(async (deviceId: string) =>
  deviceId === 'device-a' ? keys.publicKey : null
)
/** device-a's #2408 attestation over task-t's served claim. */
const attestation = (id = 'task-t') =>
  sodium.to_base64(
    signPayload(
      deleteAttestationPayload({
        id,
        type: 'task',
        deletedAt: 1_700_000_000,
        clock: { 'device-a': 2 }
      }),
      CBOR_FIELD_ORDER.DELETE_ATTESTATION,
      keys.privateKey
    ),
    sodium.base64_variants.ORIGINAL
  )

const item = (id: string) => ({
  id,
  type: 'task',
  operation: 'update',
  signature: 'sig',
  signerDeviceId: 'device-2',
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' }
})

describe('parsePullItems', () => {
  // #2292
  it('parses inline items per item, ahead of the pulled ones', () => {
    const parsed = parsePullItems({ items: [item('pulled')] }, [
      item('inline'),
      { id: 'inline-bad', type: 'task' },
      'no id'
    ])

    expect(parsed).toEqual({
      kind: 'envelope',
      items: [expect.objectContaining({ id: 'inline' }), expect.objectContaining({ id: 'pulled' })],
      invalid: [{ id: 'inline-bad', type: 'task' }],
      unnamed: 1,
      purgedTombstones: [],
      refusedTombstones: [],
      blobMissing: []
    })
  })

  // #2292 with #2285: a body that is not an envelope refuses the slice, inline or not.
  it('stays not_envelope when inline items come with a broken pull body', () => {
    expect(parsePullItems({ error: 'x' }, [item('inline')])).toEqual({ kind: 'not_envelope' })
  })

  // #2302 compat: a pre-#2302 body has no sibling lists; a post-#2302 body's items
  // parse exactly as a pre-#2302 client parsed them.
  it('parses items identically with and without the #2302 sibling lists', () => {
    const legacy = parsePullItems({ items: [item('a'), { id: 'bad', type: 'task' }] }, [], ['a'])
    const current = parsePullItems(
      {
        items: [item('a'), { id: 'bad', type: 'task' }],
        purgedTombstones: [
          { id: 'b', type: 'task', deletedAt: 1, clock: { d: 1 }, serverCursor: 2 }
        ],
        blobMissing: [{ id: 'c', type: 'task', serverCursor: 3 }]
      },
      [],
      ['a', 'b', 'c']
    )

    expect(legacy).toMatchObject({ purgedTombstones: [], blobMissing: [] })
    if (legacy.kind !== 'envelope' || current.kind !== 'envelope') throw new Error('envelope')
    expect(current.items).toEqual(legacy.items)
    expect(current.invalid).toEqual(legacy.invalid)
    expect(current.unnamed).toEqual(legacy.unnamed)
  })
})

describe('parsePullItems purged tombstones (#2302)', () => {
  const tombstone = (overrides: Record<string, unknown> = {}) => ({
    id: 'task-t',
    type: 'task',
    deletedAt: 1_700_000_000,
    clock: { 'device-a': 2 },
    serverCursor: 9,
    ...overrides
  })
  const parse = (entries: unknown[], requested = ['task-t']) => {
    const parsed = parsePullItems({ items: [], purgedTombstones: entries }, [], requested)
    if (parsed.kind !== 'envelope') throw new Error('expected an envelope')
    return parsed
  }

  // #2302
  it('admits a requested, clock-required tombstone with a non-empty clock', () => {
    expect(parse([tombstone()]).purgedTombstones).toEqual([
      { id: 'task-t', type: 'task', deletedAt: 1_700_000_000, clock: { 'device-a': 2 } }
    ])
  })

  // #2302: an unsigned delete without a clock would apply unconditionally.
  it('refuses a tombstone with no clock or an empty clock', () => {
    const parsed = parse(
      [tombstone({ clock: undefined }), tombstone({ id: 'task-u', clock: {} })],
      ['task-t', 'task-u']
    )

    expect(parsed.purgedTombstones).toEqual([])
    expect(parsed.refusedTombstones).toEqual([
      { id: 'task-t', type: 'task', reason: 'clockless' },
      { id: 'task-u', type: 'task', reason: 'clockless' }
    ])
  })

  // #2302
  it('refuses a tombstone for a type outside RECORD_CLOCK_REQUIRED_ITEM_TYPES', () => {
    const parsed = parse([tombstone({ id: 'general', type: 'settings' })], ['general'])

    expect(parsed.purgedTombstones).toEqual([])
    expect(parsed.refusedTombstones).toEqual([
      { id: 'general', type: 'settings', reason: 'type_not_clocked' }
    ])
  })

  // #2302: the server may only delete what this request asked for.
  it('refuses a tombstone for an id the request did not name', () => {
    const parsed = parse([tombstone({ id: 'task-other' })])

    expect(parsed.purgedTombstones).toEqual([])
    expect(parsed.refusedTombstones).toEqual([
      { id: 'task-other', type: 'task', reason: 'not_requested' }
    ])
  })

  // #2302: per entry, never per page.
  it('keeps the valid siblings of a malformed entry', () => {
    const parsed = parse([{ id: 'task-t' }, 'junk', tombstone()])

    expect(parsed.purgedTombstones).toHaveLength(1)
    expect(parsed.refusedTombstones.map((entry) => entry.reason)).toEqual(['shape', 'shape'])
  })

  const attested = (id = 'task-t') =>
    tombstone({ id, signerDeviceId: 'device-a', deleteAttestation: attestation(id) })

  // #2408: half an attestation is none; the entry is admitted and later refused.
  it('keeps the attestation only when both fields are present', () => {
    const parsed = parse(
      [
        attested(),
        tombstone({ id: 'task-u', signerDeviceId: 'device-a' }),
        tombstone({ id: 'task-v', deleteAttestation: attestation('task-v') })
      ],
      ['task-t', 'task-u', 'task-v']
    )

    expect(parsed.purgedTombstones.map((t) => t.attestation)).toEqual([
      { signerDeviceId: 'device-a', signature: attestation() },
      undefined,
      undefined
    ])
  })

  // #2302, #2408: the apply input is exactly what the signed path hands the
  // applier for a delete, attributed to the device that attested it.
  it('maps an attested tombstone to a delete apply item and skips what the caller names', async () => {
    const parsed = parse([attested(), attested('task-done')], ['task-t', 'task-done'])

    expect(
      await purgedTombstoneApplyItems(parsed, (ref) => ref.id === 'task-done', { db, resolveKey })
    ).toEqual([
      {
        id: 'task-t',
        type: 'task',
        operation: 'delete',
        content: '',
        clock: { 'device-a': 2 },
        deletedAt: 1_700_000_000,
        signerDeviceId: 'device-a'
      }
    ])
  })

  // #2408: an admitted entry without a verifying attestation never applies.
  it('applies nothing unattested, unknown-signer or invalid', async () => {
    vi.mocked(localTombstoneRefusal).mockClear()
    const parsed = parse(
      [
        tombstone(),
        tombstone({
          id: 'task-u',
          signerDeviceId: 'device-x',
          deleteAttestation: attestation('task-u')
        }),
        tombstone({ id: 'task-v', signerDeviceId: 'device-a', deleteAttestation: attestation() })
      ],
      ['task-t', 'task-u', 'task-v']
    )

    const result = await applicablePurgedTombstones(db, parsed.purgedTombstones, resolveKey)

    expect(result.apply).toEqual([])
    expect(result.refused).toEqual([])
    expect(result.unverified.map(({ id, reason }) => [id, reason])).toEqual([
      ['task-t', 'unattested'],
      ['task-u', 'signer_unknown'],
      ['task-v', 'attestation_invalid']
    ])
    expect(localTombstoneRefusal).not.toHaveBeenCalled()
  })

  // #2408: the signer's key is resolved once per signer, and a failure is thrown, not refused.
  it('resolves each signer once and throws when resolution fails', async () => {
    const parsed = parse([attested(), attested('task-u')], ['task-t', 'task-u'])
    resolveKey.mockClear()

    await applicablePurgedTombstones(db, parsed.purgedTombstones, resolveKey)
    expect(resolveKey).toHaveBeenCalledTimes(1)

    await expect(
      applicablePurgedTombstones(db, parsed.purgedTombstones, async () => {
        throw new Error('offline')
      })
    ).rejects.toThrow('offline')
  })

  // #2302 review: a local refusal (purged-tombstone-guard) still applies after verification.
  it('drops an attested tombstone the local guard refuses', async () => {
    vi.mocked(localTombstoneRefusal).mockReturnValueOnce('local_clockless')
    const parsed = parse([attested()])

    expect(await purgedTombstoneApplyItems(parsed, () => false, { db, resolveKey })).toEqual([])
  })
})

describe('parsePullItems blobMissing (#2302)', () => {
  // #2302
  it('keeps requested, well-formed entries as item refs', () => {
    const parsed = parsePullItems(
      {
        items: [],
        blobMissing: [
          { id: 'task-b', type: 'task', serverCursor: 3 },
          { id: 'task-x', type: 'task', serverCursor: 4 },
          { type: 'task' }
        ]
      },
      [],
      ['task-b']
    )

    expect(parsed).toMatchObject({ blobMissing: [{ id: 'task-b', type: 'task' }] })
  })
})
