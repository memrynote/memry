/**
 * Class: the delete attestation (`delete-attestation.json`), chapter 04
 * §4.8.4 (#2408).
 *
 * Generated through the production writer
 * `packages/sync-client/src/push/record-encrypt.ts`: every signature below is
 * the `deleteAttestation` field `encryptRecordForPush` put on a real delete
 * push, and every `messageHex` is that module's `deleteAttestationMessage`.
 * The eligibility cases run the shared rule `deleteClaimOf`.
 *
 * **What it pins that fails silently.**
 *
 * - `deletedAt` is signed exactly as pushed. The desktop pushes epoch seconds
 *   and the Rust core epoch milliseconds, so both widths are here: a port that
 *   normalised one to the other would sign bytes no server-stored value
 *   reproduces.
 * - The clock is a nested map, sorted by the encoder like every other map. Two
 *   insertion orders of one clock give one message.
 * - The ids are UTF-8 text, so a non-ASCII id pins the text-length head.
 * - Every `mutations[]` entry is one changed fact of a real claim, or the right
 *   claim under the wrong key. The only correct outcome is a refusal.
 */
import {
  deleteAttestationMessage,
  encryptRecordForPush
} from '../../../sync-client/src/push/record-encrypt.ts'
import { CBOR_FIELD_ORDER } from '../../src/cbor-ordering'
import {
  DELETE_ATTESTATION_PURPOSE,
  deleteClaimOf,
  type DeleteClaim
} from '../../src/delete-attestation'
import type { SyncItemType, SyncOperation, VectorClock } from '../../src/sync-api'
import {
  FIXED,
  b64,
  deterministicProvider,
  fromHex,
  hex,
  signerFromSeed
} from '../../test-vectors/deterministic-provider'
import { meta } from './shared'

const VAULT_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0'

interface Spec {
  name: string
  claim: DeleteClaim
  pins: string
}

const SPECS: Spec[] = [
  {
    name: 'task delete, deletedAt in seconds, clock keys inserted b then a',
    claim: {
      id: 'task-1',
      type: 'task',
      deletedAt: 1_700_000_000,
      clock: { 'dev-b': 3, 'dev-a': 7 }
    },
    pins: 'the desktop width of deletedAt, and the nested clock map sorted by the encoder'
  },
  {
    name: 'task delete, deletedAt in seconds, clock keys inserted a then b',
    claim: {
      id: 'task-1',
      type: 'task',
      deletedAt: 1_700_000_000,
      clock: { 'dev-a': 7, 'dev-b': 3 }
    },
    pins: 'insertion order is cosmetic: the message equals the previous case byte for byte'
  },
  {
    name: 'note delete, deletedAt in milliseconds',
    claim: {
      id: 'note-1',
      type: 'note',
      deletedAt: 1_760_000_000_000,
      clock: { 'device-a': 3 }
    },
    pins: 'the Rust core width of deletedAt: an 8-byte unsigned integer head'
  },
  {
    name: 'tag delete with a non-ASCII id and a clock over 2^32',
    claim: {
      id: 'Grüße 世界 🏷',
      type: 'tag_definition',
      deletedAt: 1_700_000_001,
      clock: { 'device-a': 4_294_967_296, 'device-b': 1, 'device-c': 23 }
    },
    pins: 'UTF-8 byte length in the text head, and uint widths 1, 2 and 8 in one clock'
  }
]

interface Mutation {
  name: string
  claim: DeleteClaim
  /** The key the verifier uses; the signer's unless the mutation swaps it. */
  signerPublicKeyB64: string
}

const mutationsOf = (base: DeleteClaim, otherPublicKeyB64: string, publicKeyB64: string) => {
  const with_ = (name: string, changed: Partial<DeleteClaim>): Mutation => ({
    name,
    claim: { ...base, ...changed },
    signerPublicKeyB64: publicKeyB64
  })
  return [
    with_('the id is swapped', { id: 'task-2' }),
    with_('the type is swapped', { type: 'project' }),
    with_('deletedAt is raised by one second', { deletedAt: base.deletedAt + 1 }),
    with_('deletedAt is restated in milliseconds', { deletedAt: base.deletedAt * 1000 }),
    with_('a clock entry is inflated', { clock: { ...base.clock, 'dev-a': 2 ** 31 } }),
    with_('a clock entry is added', { clock: { ...base.clock, x: 1 } }),
    with_('a clock entry is removed', { clock: { 'dev-a': 7 } }),
    {
      name: 'the right claim under another device key',
      claim: base,
      signerPublicKeyB64: otherPublicKeyB64
    }
  ]
}

interface EligibilitySpec {
  name: string
  input: {
    id: string
    type: SyncItemType
    operation: SyncOperation
    clock?: VectorClock
    deletedAt?: number
  }
}

const ELIGIBILITY: EligibilitySpec[] = [
  {
    name: 'a delete of a clock-required type with a clock and deletedAt',
    input: { id: 't', type: 'task', operation: 'delete', clock: { d: 1 }, deletedAt: 5 }
  },
  {
    name: 'an update',
    input: { id: 't', type: 'task', operation: 'update', clock: { d: 1 }, deletedAt: 5 }
  },
  {
    name: 'a create',
    input: { id: 't', type: 'note', operation: 'create', clock: { d: 1 } }
  },
  {
    name: 'a settings delete (settings has no required clock)',
    input: { id: 'general', type: 'settings', operation: 'delete', clock: { d: 1 }, deletedAt: 5 }
  },
  {
    name: 'a clockless delete',
    input: { id: 't', type: 'task', operation: 'delete', deletedAt: 5 }
  },
  {
    name: 'a delete with an empty clock',
    input: { id: 't', type: 'task', operation: 'delete', clock: {}, deletedAt: 5 }
  },
  {
    name: 'a delete with no deletedAt (the server would store its own time)',
    input: { id: 't', type: 'task', operation: 'delete', clock: { d: 1 } }
  }
]

export async function buildDeleteAttestation(): Promise<Record<string, unknown>> {
  const crypto = deterministicProvider()
  const signer = signerFromSeed(FIXED.SEED_A)
  const other = signerFromSeed(FIXED.SEED_B)
  const publicKeyB64 = b64(signer.publicKey)

  const cases = []
  for (const spec of SPECS) {
    const { pushItem } = await encryptRecordForPush(crypto, {
      id: spec.claim.id,
      type: spec.claim.type,
      operation: 'delete',
      content: new Uint8Array(0),
      vaultKey: fromHex(VAULT_KEY),
      signingSecretKey: signer.secretKey,
      signerDeviceId: signer.deviceId,
      clock: spec.claim.clock,
      deletedAt: spec.claim.deletedAt
    })
    if (!pushItem.deleteAttestation) throw new Error(`${spec.name}: the writer did not attest`)
    const message = deleteAttestationMessage(spec.claim)
    // Proven verifiable before it is committed.
    const signature = crypto.fromBase64(pushItem.deleteAttestation)
    if (!crypto.verifyDetached(signature, message, signer.publicKey)) {
      throw new Error(`${spec.name}: the attestation does not verify`)
    }
    cases.push({
      name: spec.name,
      pins: spec.pins,
      claim: spec.claim,
      messageHex: hex(message),
      signatureB64: pushItem.deleteAttestation
    })
  }

  const base = cases[0]
  const mutations = mutationsOf(SPECS[0].claim, b64(other.publicKey), publicKeyB64).map(
    (mutation) => {
      const message = deleteAttestationMessage(mutation.claim)
      const verifies = crypto.verifyDetached(
        crypto.fromBase64(base.signatureB64),
        message,
        crypto.fromBase64(mutation.signerPublicKeyB64)
      )
      if (verifies) throw new Error(`mutation "${mutation.name}" still verifies`)
      return { ...mutation, of: base.name, signatureB64: base.signatureB64, verifies }
    }
  )

  const claimOf = ELIGIBILITY.map((spec) => ({ ...spec, claim: deleteClaimOf(spec.input) }))

  return {
    meta: meta({
      class: 'delete-attestation',
      chapter:
        'docs/protocol/04-record-envelope.md §4.8.4, docs/protocol/05-record-sync.md §5.12.3',
      writer: 'packages/sync-client/src/push/record-encrypt.ts',
      purpose: DELETE_ATTESTATION_PURPOSE,
      fieldOrder: CBOR_FIELD_ORDER.DELETE_ATTESTATION,
      signerSeedHex: FIXED.SEED_A,
      signerPublicKeyB64: publicKeyB64,
      signerDeviceId: signer.deviceId,
      otherSeedHex: FIXED.SEED_B,
      otherPublicKeyB64: b64(other.publicKey),
      notBound:
        'vaultId and signerDeviceId are not signed: the verifier picks the key by signerDeviceId, so a swapped id fails',
      caseCount: cases.length
    }),
    cases,
    mutations,
    claimOf
  }
}
