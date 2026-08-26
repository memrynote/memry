/**
 * Attachment download manager E2E (#1829 / #1830).
 *
 * A large attachment is uploaded by device A, then downloaded by device B with
 * the transport cut while the transfer is in flight. Four properties are
 * asserted against real bytes on real disk rather than against a mock:
 *
 *   STREAMS TO DISK — while the transfer is broken, the verified prefix is
 *   sitting in a `.mrypart` file next to the destination. A download that
 *   buffered the whole file in RAM would leave nothing behind.
 *
 *   SURVIVES AN ABANDONED TRANSFER — the cut is held open past the per-chunk
 *   retry budget, so `downloadAttachment` dead-letters and the DownloadQueue
 *   re-drives it. The prefix and its sidecar are still there afterwards, which
 *   is the only thing that makes the next attempt a resume rather than a
 *   restart. Without that wait the test would only pin the in-call retry loop,
 *   where the `for` loop's own cursor — not the sidecar — is what skips ahead.
 *
 *   RESUMES, never restarts — the chunk that landed before the cut is never
 *   requested again; the re-drive picks up at the first missing chunk.
 *
 *   DOES NOT RE-APPLY THE NOTE — a failed and re-driven transfer touches the
 *   attachment, not the note record that referenced it.
 *
 * Chunking is 8 MiB (attachments.ts CHUNK_SIZE), so the fixture file is sized
 * to produce three chunks: cut the second one and there is both a landed
 * prefix to resume from and a trailing chunk to prove the transfer finished.
 *
 * WHERE the socket is cut decides which client code classifies the failure,
 * and the two answers differ — see the second test, which pins a real defect.
 */

import type { ElectronApplication, Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { test, expect, bootstrapSyncDevice } from './fixtures/sync-proxy-fixtures'
import { waitForAppReady } from './utils/electron-helpers'
import type { SharedSyncBootstrap } from './utils/sync-backend'

/**
 * Proxied chunk GETs. The Worker mounts the blob router at `/sync`
 * (`app.route('/sync', blob)`) and the chunk route is
 * `/attachments/chunks/:chunk_hash`, so this is the path the client asks for
 * whenever presigned direct-to-R2 is unconfigured — the shape of every E2E
 * deployment, since no `R2_*` secrets are bound.
 */
const CHUNK_PATH_PREFIX = '/sync/attachments/chunks/'

const CHUNK_BYTES = 8 * 1024 * 1024
const FILE_BYTES = CHUNK_BYTES * 2 + 512 * 1024 // three chunks: 8 MiB, 8 MiB, 512 KiB
const EXPECTED_CHUNKS = 3

/**
 * Sever before a single body byte — and before Node has flushed the response
 * head, since it writes headers lazily on the first `write`. The client sees
 * the connection fail, `binaryFetch`'s own catch turns that into a
 * `NetworkError`, and NetworkError is the class the resume path is built
 * around: the partial survives and the queue re-queues instead of dropping.
 */
const SEVER_BEFORE_RESPONSE = 0

/**
 * Sever 64 KiB into the body: headers are out, bytes are flowing, and then the
 * socket dies. This is the ordinary flaky-network shape and the one the
 * docstring above calls "mid-transfer" — and the client classifies it
 * differently. See the second test.
 */
const SEVER_MID_BODY = 64 * 1024

/**
 * `downloadChunk` wraps every chunk in `retryingRequest({ maxRetries: 5 })`, so
 * a single `downloadAttachment` call spends at most 6 attempts on one chunk
 * before it dead-letters. A severed GET beyond that count can only have been
 * issued by a SECOND call — the queue re-drove the item and the new call read
 * its starting offset off the sidecar.
 */
const IN_CALL_CHUNK_ATTEMPTS = 6

function chunkGets(records: Array<{ method: string; path: string }>): string[] {
  return records
    .filter((r) => r.method === 'GET' && r.path.startsWith(CHUNK_PATH_PREFIX))
    .map((r) => r.path)
}

function countByPath(paths: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1)
  return counts
}

interface PartialState {
  size: number
  chunksDone: number
  chunkCount: number
}

/** The `.mrypart` + sidecar pair next to the destination, or null if absent. */
function readPartial(partialDir: string): PartialState | null {
  const found = fs.readdirSync(partialDir).find((name) => name.endsWith('.mrypart'))
  if (!found) return null
  const partialFile = path.join(partialDir, found)
  try {
    const sidecar = JSON.parse(fs.readFileSync(`${partialFile}.json`, 'utf8')) as {
      chunksDone: number
      chunkCount: number
    }
    return {
      size: fs.statSync(partialFile).size,
      chunksDone: sidecar.chunksDone,
      chunkCount: sidecar.chunkCount
    }
  } catch {
    return null
  }
}

async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

interface StagedTransfer {
  noteId: string
  attachmentId: string
  targetPath: string
  partialDir: string
}

/**
 * Device A uploads a three-chunk attachment; device B authenticates, pulls the
 * note, and is left ready to download that attachment on demand.
 */
async function stageDevices(args: {
  electronAppA: ElectronApplication
  electronAppB: ElectronApplication
  pageA: Page
  pageB: Page
  vaultPathA: string
  vaultPathB: string
  syncBootstrap: SharedSyncBootstrap
}): Promise<StagedTransfer> {
  const { electronAppA, electronAppB, pageA, pageB, vaultPathA, vaultPathB, syncBootstrap } = args

  await bootstrapSyncDevice(electronAppA, syncBootstrap.deviceA)
  await pageA.reload()
  await pageA.waitForLoadState('domcontentloaded')
  await waitForAppReady(pageA)

  // ---- device A: a note plus one large attachment, uploaded to sync --------
  const seeded = await pageA.evaluate(
    async ({ fileBytes }) => {
      const created = await window.api.notes.create({
        title: `download-manager-${Date.now().toString(36)}`,
        content: 'holds one large attachment'
      })
      if (!created.success || !created.note) {
        throw new Error(created.error ?? 'note create failed')
      }

      // Compressible-but-not-uniform bytes: a run of identical bytes would let
      // compression collapse the payload and defeat the chunk count.
      const payload = new Uint8Array(fileBytes)
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >> 13)) & 0xff

      // The vault's attachment allow-list is by extension; `.bin` is not on it.
      // The bytes are what matter here, not the label.
      const file = new File([payload], 'large-fixture.txt', { type: 'text/plain' })
      const uploaded = await window.api.notes.uploadAttachment(created.note.id, file)
      if (!uploaded.success || !uploaded.path) {
        throw new Error(uploaded.error ?? 'attachment write failed')
      }

      const listed = await window.api.notes.listAttachments(created.note.id)
      const stored = listed[0]
      if (!stored) throw new Error('attachment not listed after write')

      return {
        noteId: created.note.id,
        title: created.note.title,
        // `AttachmentInfo.path` is a memry-file:// URL, not a filesystem path —
        // the real path is rebuilt from the vault root below.
        storedFilename: stored.filename
      }
    },
    { fileBytes: FILE_BYTES }
  )

  const localPath = path.join(vaultPathA, 'attachments', seeded.noteId, seeded.storedFilename)
  expect(fs.statSync(localPath).size).toBe(FILE_BYTES)

  const uploadResult = await pageA.evaluate(
    async ({ noteId, filePath }) => window.api.syncAttachments.upload({ noteId, filePath }),
    { noteId: seeded.noteId, filePath: localPath }
  )
  expect(uploadResult.success, uploadResult.error ?? 'attachment sync upload failed').toBe(true)
  const attachmentId = uploadResult.attachmentId!
  expect(attachmentId).toBeTruthy()

  // `syncAttachments.upload` resolves only once every chunk and the manifest are
  // registered server-side, so its success IS the completion signal. The chunk
  // rows are checked as evidence the file really chunked — the count is a floor,
  // not an equality: the outbox can upload the same file independently and each
  // upload encrypts under a fresh file key.
  const db = await syncBootstrap.server.getD1()
  const chunkRows = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM blob_chunks
          WHERE user_id = (SELECT id FROM users WHERE email = ?)`
    )
    .bind(syncBootstrap.email)
    .first<{ c: number }>()
  expect(chunkRows?.c ?? 0).toBeGreaterThanOrEqual(EXPECTED_CHUNKS)

  // ---- device B: first authentication, then the note ----------------------
  await bootstrapSyncDevice(electronAppB, syncBootstrap.deviceB)
  await pageB.reload()
  await pageB.waitForLoadState('domcontentloaded')
  await waitForAppReady(pageB)

  // On-demand only, and BEFORE the note lands. Applying a note that references
  // an attachment emits `download-needed`, and that eager fan-out enqueues the
  // same attachment against `<vault>/attachments/<noteId>/`. It is a different
  // destination, so the queue does not dedupe it against the explicit download
  // below — but both transfers pull the same chunk objects over the same paths,
  // so an eager GET can be the request a fault rule lets through, leaving every
  // GET the transfer under test makes severed, its first included. Suppressing
  // the background paths (this is exactly the documented on-demand-only mode;
  // `syncAttachments.download` runs regardless of the toggle) leaves one
  // transfer to reason about.
  const syncSettings = await pageB.evaluate(() =>
    window.api.settings.setSyncSettings({ attachmentAutoDownload: false })
  )
  expect(syncSettings.success, syncSettings.error ?? 'could not disable auto-download').toBe(true)

  await expect
    .poll(
      async () => {
        await pageB.evaluate(() => window.api.syncOps.triggerSync())
        return pageB.evaluate(
          (id) => window.api.notes.get(id).then((n) => n?.title ?? null),
          seeded.noteId
        )
      },
      { timeout: 240_000, intervals: [2_000] }
    )
    .toBe(seeded.title)

  // The download IPC refuses any destination outside `<vault>/attachments`.
  const targetPath = path.join(vaultPathB, 'attachments', 'e2e-download', 'large-fixture.txt')
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  return {
    noteId: seeded.noteId,
    attachmentId,
    targetPath,
    partialDir: path.dirname(targetPath)
  }
}

test.describe('Attachment download manager', () => {
  test('resumes an interrupted transfer from disk instead of restarting it', async ({
    electronAppA,
    electronAppB,
    pageA,
    pageB,
    vaultPathA,
    vaultPathB,
    syncBootstrap,
    syncProxy
  }) => {
    test.setTimeout(600_000)

    const staged = await stageDevices({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      vaultPathA,
      vaultPathB,
      syncBootstrap
    })

    const readNoteState = (id: string) =>
      pageB.evaluate(
        (noteId) =>
          window.api.notes.get(noteId).then((n) => ({
            content: n?.content ?? null,
            modified: n?.modified ? String(n.modified) : null,
            wordCount: n?.wordCount ?? null
          })),
        id
      )
    const noteBefore = await readNoteState(staged.noteId)
    expect(noteBefore.modified, 'the note record never reached device B').not.toBeNull()

    // Let the first chunk GET through, then sever every one after it and keep
    // severing: a transport failure is transient by design, so the queue
    // re-queues rather than giving up and the fault must stay armed until the
    // test has seen what it came for. With the background fan-out suppressed in
    // stageDevices, the request that gets through IS chunk 0 of this transfer.
    let firstChunkPath: string | null = null
    syncProxy.injectFault({
      match: (method, pathname) => {
        if (method !== 'GET' || !pathname.startsWith(CHUNK_PATH_PREFIX)) return false
        if (firstChunkPath === null) {
          firstChunkPath = pathname
          return false
        }
        return pathname !== firstChunkPath
      },
      afterBytes: SEVER_BEFORE_RESPONSE,
      maxHits: Number.MAX_SAFE_INTEGER
    })

    let downloadRejection: string | null = null
    const downloadPromise = pageB
      .evaluate(
        ({ id, dest }) =>
          window.api.syncAttachments.download({ attachmentId: id, targetPath: dest }),
        { id: staged.attachmentId, dest: staged.targetPath }
      )
      .catch((err: unknown) => {
        downloadRejection = err instanceof Error ? err.message : String(err)
        return { success: false as const, error: downloadRejection, filePath: undefined }
      })

    // STREAMS TO DISK: while the transfer is broken, the verified prefix is
    // sitting in a `.mrypart` file next to the destination with a resume sidecar
    // beside it. A download that buffered the file whole in RAM would leave
    // nothing here.
    //
    // Race the transfer against the partial appearing: if the download settles
    // first, it never got a chunk onto disk, and its own result carries the
    // reason — far more useful than "no partial appeared".
    const raced = await Promise.race([
      downloadPromise.then((result) => ({ kind: 'settled' as const, result })),
      pollUntil(() => (readPartial(staged.partialDir)?.chunksDone ?? 0) >= 1, 120_000).then(
        (found) => ({ kind: 'partial' as const, found })
      )
    ])
    if (raced.kind === 'settled') {
      throw new Error(
        `download settled before any chunk reached disk: ${JSON.stringify(raced.result)}` +
          (downloadRejection ? ` (rejection: ${downloadRejection})` : '')
      )
    }
    expect(raced.found, 'no verified prefix ever appeared next to the destination').toBe(true)
    expect(readPartial(staged.partialDir)).toMatchObject({
      chunkCount: EXPECTED_CHUNKS,
      chunksDone: 1,
      size: CHUNK_BYTES
    })

    expect(
      syncProxy.faultHits(),
      'the fault never fired — nothing was interrupted'
    ).toBeGreaterThan(0)
    expect(firstChunkPath).not.toBeNull()
    expect(countByPath(chunkGets(syncProxy.records)).get(firstChunkPath!)).toBe(1)

    // SURVIVES AN ABANDONED TRANSFER: hold the cut open until the missing chunk
    // has been asked for more times than one call is allowed to ask, which can
    // only happen once the first call dead-lettered and the queue re-drove it.
    // The prefix must still be on disk when the replacement call starts, or the
    // resume below is really an in-call `for` loop that never restarted.
    const severedBeyondOneCall = await pollUntil(
      () => syncProxy.faultHits() > IN_CALL_CHUNK_ATTEMPTS,
      240_000
    )
    expect(
      severedBeyondOneCall,
      'the transfer was never abandoned and re-driven, so nothing resumed off the sidecar'
    ).toBe(true)
    expect(
      readPartial(staged.partialDir),
      'the abandoned transfer discarded its verified prefix instead of keeping it for the re-drive'
    ).toMatchObject({ chunkCount: EXPECTED_CHUNKS, chunksDone: 1, size: CHUNK_BYTES })

    // ---- let it finish -----------------------------------------------------
    syncProxy.clearFaults()
    const resumed = await downloadPromise
    expect(resumed.success, resumed.error ?? 'resumed transfer failed').toBe(true)
    expect(fs.statSync(staged.targetPath).size).toBe(FILE_BYTES)
    expect(
      fs.readdirSync(staged.partialDir).filter((name) => name.endsWith('.mrypart')),
      'the partial must be renamed into place'
    ).toEqual([])

    // RESUMES, NEVER RESTARTS: the chunk that landed before the first cut is
    // never asked for again. A restart-from-zero would fetch it a second time.
    const chunksAfter = countByPath(chunkGets(syncProxy.records))
    expect(
      chunksAfter.get(firstChunkPath!),
      'the chunk that landed before the cut was re-downloaded — the transfer restarted instead of resuming'
    ).toBe(1)
    expect(chunksAfter.size).toBe(EXPECTED_CHUNKS)

    // DOES NOT RE-APPLY THE NOTE: the record the attachment belongs to is
    // untouched by the failure and the re-drive.
    const noteAfter = await readNoteState(staged.noteId)
    expect(noteAfter).toEqual(noteBefore)
  })

  /**
   * KNOWN DEFECT — expected to fail until the classification gap is closed.
   *
   * The test above cuts the socket before the response head is flushed, so the
   * client's `fetch` call itself rejects and `binaryFetch` converts it into a
   * `NetworkError`. That is the only transport failure the resume path
   * recognises: `isResumableDownloadError` keeps the partial, and
   * `DownloadQueue.processItem` re-queues instead of rejecting.
   *
   * Cut the socket 64 KiB INTO the body instead — the ordinary flaky-network
   * shape — and the failure surfaces from `await resp.arrayBuffer()` inside
   * `downloadChunk`, which sits OUTSIDE `binaryFetch`'s try/catch. It arrives
   * as a bare `net::ERR_INCOMPLETE_CHUNKED_ENCODING`, so it is neither a
   * NetworkError, nor a RateLimitError, nor a 5xx SyncServerError. Both
   * consequences follow: the verified prefix is securely deleted, and the queue
   * drops the item rather than backing off and re-driving it.
   *
   * `attachment-presign.ts` reads its body outside its own try/catch the same
   * way, so the direct-to-R2 path shares the shape.
   *
   * Marked `fail` rather than skipped: it runs on every suite run and turns red
   * the moment the classification is fixed.
   */
  test.fail(
    'keeps the verified prefix when the socket is cut mid-body',
    async ({
      electronAppA,
      electronAppB,
      pageA,
      pageB,
      vaultPathA,
      vaultPathB,
      syncBootstrap,
      syncProxy
    }) => {
      test.setTimeout(600_000)

      const staged = await stageDevices({
        electronAppA,
        electronAppB,
        pageA,
        pageB,
        vaultPathA,
        vaultPathB,
        syncBootstrap
      })

      let firstChunkPath: string | null = null
      syncProxy.injectFault({
        match: (method, pathname) => {
          if (method !== 'GET' || !pathname.startsWith(CHUNK_PATH_PREFIX)) return false
          if (firstChunkPath === null) {
            firstChunkPath = pathname
            return false
          }
          return pathname !== firstChunkPath
        },
        afterBytes: SEVER_MID_BODY,
        maxHits: Number.MAX_SAFE_INTEGER
      })

      const download = pageB
        .evaluate(
          ({ id, dest }) =>
            window.api.syncAttachments.download({ attachmentId: id, targetPath: dest }),
          { id: staged.attachmentId, dest: staged.targetPath }
        )
        .catch((err: unknown) => ({
          success: false as const,
          error: err instanceof Error ? err.message : String(err),
          filePath: undefined
        }))

      const landed = await Promise.race([
        download.then((result) => ({ kind: 'settled' as const, result })),
        pollUntil(() => (readPartial(staged.partialDir)?.chunksDone ?? 0) >= 1, 120_000).then(
          (found) => ({ kind: 'partial' as const, found })
        )
      ])
      if (landed.kind === 'settled') {
        throw new Error(
          `download settled before any chunk reached disk: ${JSON.stringify(landed.result)}`
        )
      }
      expect(landed.found, 'no verified prefix ever appeared next to the destination').toBe(true)

      // A mid-body cut is still "only the transport failed": the chunk already
      // on disk is decrypted and verified, so it must survive for the re-drive.
      // Today it does not — the first call dead-letters after its 6 attempts and
      // wipes the partial on the way out, and the queue never re-drives.
      const settled = await download
      expect(
        readPartial(staged.partialDir),
        `verified prefix discarded after ${settled.error ?? 'the transfer failed'}`
      ).toMatchObject({ chunkCount: EXPECTED_CHUNKS, chunksDone: 1, size: CHUNK_BYTES })
    }
  )
})
