/**
 * Class: chunk-hold holder ids and requests (`chunk-holds.json`), chapter 14
 * §14.8.1 and §14.8.2.
 *
 * Generated through Electron's `apps/desktop/src/main/canvas/assets/chunk-holds.ts`,
 * imported for real, with a fake `fetchFn` that records each request and
 * answers the `missing` list a case names. Holder ids are what every device
 * must derive alike: a canvas hold taken on one device is released from
 * another. The probe ids are local to one device, but a probe left held by
 * Electron is released by the next probe of the same pair, so they are pinned
 * too. Each request case records the bodies in send order and the outcome.
 *
 * Verified in Rust only (`crates/memry-core/tests/attachment_holds.rs`), like
 * `note-fold-text`: the TypeScript side is Electron's own module, the oracle
 * this generator runs, so a `src/__tests__/` verifier would check it against
 * itself.
 */
// A namespace import: desktop's sources are CommonJS to Node, and the ESM
// loader cannot see their named exports statically.
import * as electronModule from '../../../../apps/desktop/src/main/canvas/assets/chunk-holds.ts'
import { fromHex } from '../../test-vectors/deterministic-provider'
import { meta } from './shared'

// Loaded as CommonJS, the exports may sit under `default`.
type Electron = typeof electronModule
const electron: Electron =
  (electronModule as Electron & { default?: Electron }).default ?? electronModule

const VAULT_KEY = '6a1f3c5e7b9d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a'
const OTHER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const hash = (seed: string): string => seed.repeat(64).slice(0, 64)
/** A distinct 64-hex value per `n`. */
const hex64 = (n: number): string => n.toString(16).padStart(64, '0')

interface Sent {
  path: string
  body: unknown
}

/** Runs `run` against a recording server that answers each hold with `missing(body)`. */
async function recorded<T>(
  vaultKey: string,
  missing: (holderIds: string[]) => string[],
  run: (deps: electronModule.ChunkHoldDeps) => Promise<T>
): Promise<{ requests: Sent[]; outcome: T }> {
  const requests: Sent[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname
    const body: { holds?: Array<{ holderId: string }>; holderIds?: string[] } = JSON.parse(
      typeof init?.body === 'string' ? init.body : ''
    )
    requests.push({ path, body })
    const answer = body.holds
      ? { missing: missing(body.holds.map((h) => h.holderId)) }
      : { released: body.holderIds?.length ?? 0 }
    return new Response(JSON.stringify(answer), { status: 200 })
  }
  const outcome = await run({
    getAccessToken: async () => 'placeholder-token',
    getSyncServerUrl: () => 'https://sync.example',
    getVaultId: () => 'default',
    getVaultKey: async () => fromHex(vaultKey),
    fetchFn
  })
  return { requests, outcome }
}

/** `HoldOutcome` with its `Set` as a sorted list. */
function plain(outcome: electronModule.HoldOutcome): Record<string, unknown> {
  return outcome.status === 'ok'
    ? { status: 'ok', missing: [...outcome.missing].toSorted() }
    : outcome
}

const CANVAS_IDS: Array<[string, string, string]> = [
  ['ascii', 'canvas-1', hash('a')],
  ['uuid canvas', '0f8e3a52-9c1d-4b7e-a2f0-5d6c7b8a9e01', hash('b')],
  ['Turkish and emoji canvas id', 'Çizim İğdır 🎨', hash('c')],
  ['empty content hash', 'canvas-1', ''],
  ['canvas id and content hash swapped', hash('a'), 'canvas-1']
]

const images = (n: number, from = 0): electronModule.AssetHold[] =>
  Array.from({ length: n }, (_, i) => ({
    contentHash: hex64(from + i),
    chunkHashes: [hex64(0x1000 + from + i), hex64(0x2000 + from + i)]
  }))

export async function buildChunkHolds(): Promise<Record<string, unknown>> {
  // Readies the module's libsodium before the synchronous id function.
  await recorded(
    VAULT_KEY,
    () => [],
    (deps) =>
      electron.holdCanvasAssetChunks(
        'warm-up',
        [{ contentHash: 'x', chunkHashes: [hash('0')] }],
        deps
      )
  )

  const holderIds = [VAULT_KEY, OTHER_KEY].flatMap((key) =>
    CANVAS_IDS.map(([name, canvasId, contentHash]) => ({
      name: key === VAULT_KEY ? name : `${name}, other vault key`,
      vaultKey: key,
      domain: 'memry/canvas-asset-hold/v1',
      a: canvasId,
      b: contentHash,
      holderId: electron.canvasAssetHolderId(fromHex(key), canvasId, contentHash)
    }))
  )

  const canvasTwo = images(2)
  const canvasDup = [...images(2), { ...images(1)[0], chunkHashes: [hash('e')] }]
  const attachments = [
    { attachmentId: 'att-1', chunkHashes: [hash('1')] },
    { attachmentId: 'att-2', chunkHashes: [hash('2'), hash('3')] },
    { attachmentId: 'att-3', chunkHashes: [hash('4')] }
  ]

  const requestCases = [
    {
      name: 'canvas hold, the server names the second image and an unknown holder',
      kind: 'hold-canvas',
      canvasId: 'canvas-1',
      images: canvasTwo,
      ...(await recorded(
        VAULT_KEY,
        (ids) => [ids[1], hash('f')],
        async (deps) => plain(await electron.holdCanvasAssetChunks('canvas-1', canvasTwo, deps))
      ))
    },
    {
      name: 'canvas hold, a repeated image keeps its first place and its last chunks',
      kind: 'hold-canvas',
      canvasId: 'canvas-1',
      images: canvasDup,
      ...(await recorded(
        VAULT_KEY,
        () => [],
        async (deps) => plain(await electron.holdCanvasAssetChunks('canvas-1', canvasDup, deps))
      ))
    },
    {
      name: 'canvas hold, 65 images in two requests',
      kind: 'hold-canvas',
      canvasId: 'canvas-2',
      images: images(65),
      ...(await recorded(
        VAULT_KEY,
        (ids) => ids.slice(-1),
        async (deps) => plain(await electron.holdCanvasAssetChunks('canvas-2', images(65), deps))
      ))
    },
    {
      name: 'note probe, the server names the second attachment',
      kind: 'probe-note',
      noteId: 'note-1',
      attachments,
      ...(await recorded(
        VAULT_KEY,
        (ids) => [ids[1]],
        async (deps) => plain(await electron.probeNoteAttachments('note-1', attachments, deps))
      ))
    }
  ]

  return {
    meta: meta({
      class: 'chunk-holds',
      source: 'apps/desktop/src/main/canvas/assets/chunk-holds.ts',
      holderId:
        'lowercase hex of crypto_generichash(32, `${domain}\\0${a}\\0${b}`, vaultKey); vaultKey is hex',
      requests:
        'bodies in send order; each hold is answered with `missing` as the case names it, each release with `released`'
    }),
    holderIds,
    requests: requestCases
  }
}
