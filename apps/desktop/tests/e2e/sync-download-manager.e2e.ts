/**
 * Attachment download manager E2E (#1829 / #1830).
 *
 * A large attachment is uploaded by device A, then downloaded by device B with
 * the transport cut mid-transfer. Three properties are asserted against real
 * bytes on real disk rather than against a mock:
 *
 *   RESUMES, never restarts — the chunk that landed before the cut is never
 *   requested again; the retry picks up at the first missing chunk.
 *
 *   STREAMS TO DISK — while the transfer is broken, the verified prefix is
 *   sitting in a `.mrypart` file next to the destination. A download that
 *   buffered the whole file in RAM would leave nothing behind.
 *
 *   DOES NOT RE-APPLY THE NOTE — a failed and re-driven transfer touches the
 *   attachment, not the note record that referenced it.
 *
 * Chunking is 8 MiB (attachments.ts CHUNK_SIZE), so the fixture file is sized
 * to produce three chunks: cut the second one and there is both a landed
 * prefix to resume from and a trailing chunk to prove the transfer finished.
 */

import fs from 'node:fs'
import path from 'node:path'

import { test, expect, bootstrapSyncDevice } from './fixtures/sync-proxy-fixtures'
import { waitForAppReady } from './utils/electron-helpers'

const CHUNK_BYTES = 8 * 1024 * 1024
const FILE_BYTES = CHUNK_BYTES * 2 + 512 * 1024 // three chunks: 8 MiB, 8 MiB, 512 KiB
const EXPECTED_CHUNKS = 3

function blobGets(records: Array<{ method: string; path: string }>): string[] {
  return records
    .filter((r) => r.method === 'GET' && r.path.startsWith('/sync/blob/'))
    .map((r) => r.path)
}

function countByPath(paths: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1)
  return counts
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

    await bootstrapSyncDevice(electronAppA, syncBootstrap.deviceA)
    await pageA.reload()
    await pageA.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageA)

    // ---- device A: a note plus one large attachment, uploaded to sync ------
    const seeded = await pageA.evaluate(
      async ({ fileBytes }) => {
        const created = await window.api.notes.create({
          title: `download-manager-${Date.now().toString(36)}`,
          content: 'holds one large attachment'
        })
        if (!created.success || !created.note) {
          throw new Error(created.error ?? 'note create failed')
        }

        // Compressible-but-not-uniform bytes: a run of identical bytes would
        // let compression collapse the payload and defeat the chunk count.
        const payload = new Uint8Array(fileBytes)
        for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >> 13)) & 0xff

        // The vault's attachment allow-list is by extension; `.bin` is not on
        // it. The bytes are what matter here, not the label.
        const file = new File([payload], 'large-fixture.txt', {
          type: 'text/plain'
        })
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
          // `AttachmentInfo.path` is a memry-file:// URL, not a filesystem
          // path — the real path is rebuilt from the vault root below.
          storedFilename: stored.filename
        }
      },
      { fileBytes: FILE_BYTES }
    )

    const localPath = path.join(vaultPathA, 'attachments', seeded.noteId, seeded.storedFilename)
    expect(fs.statSync(localPath).size).toBe(FILE_BYTES)

    const uploadResult = await pageA.evaluate(
      async ({ noteId, filePath }) => {
        return window.api.syncAttachments.upload({ noteId, filePath })
      },
      { noteId: seeded.noteId, filePath: localPath }
    )
    expect(uploadResult.success, uploadResult.error ?? 'attachment sync upload failed').toBe(true)
    const attachmentId = uploadResult.attachmentId!
    expect(attachmentId).toBeTruthy()

    // `syncAttachments.upload` resolves only once every chunk and the manifest
    // are registered server-side, so its success IS the completion signal. The
    // chunk rows are checked as evidence the file really chunked — the count is
    // a floor, not an equality: the outbox can upload the same file
    // independently and each upload encrypts under a fresh file key.
    const db = await syncBootstrap.server.getD1()
    const chunkRows = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM blob_chunks
          WHERE user_id = (SELECT id FROM users WHERE email = ?)`
      )
      .bind(syncBootstrap.email)
      .first<{ c: number }>()
    expect(chunkRows?.c ?? 0).toBeGreaterThanOrEqual(EXPECTED_CHUNKS)

    // ---- device B: first authentication, then an interrupted download -----
    await bootstrapSyncDevice(electronAppB, syncBootstrap.deviceB)
    await pageB.reload()
    await pageB.waitForLoadState('domcontentloaded')
    await waitForAppReady(pageB)

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
    const noteBefore = await readNoteState(seeded.noteId)
    expect(noteBefore.modified, 'the note record never reached device B').not.toBeNull()

    // The download IPC refuses any destination outside `<vault>/attachments`.
    const targetPath = path.join(vaultPathB, 'attachments', 'e2e-download', 'large-fixture.txt')
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })

    // Sever every chunk GET except the first distinct one, and keep severing:
    // the queue treats a transport failure as transient and re-queues rather
    // than giving up, so the fault stays armed until the partial file has been
    // observed on disk. That is what makes this deterministic — no dependence
    // on how many times a chunk is retried before an attempt is abandoned.
    let firstChunkPath: string | null = null
    syncProxy.injectFault({
      match: (method, pathname) => {
        if (method !== 'GET' || !pathname.startsWith('/sync/blob/')) return false
        if (firstChunkPath === null) {
          firstChunkPath = pathname
          return false
        }
        return pathname !== firstChunkPath
      },
      afterBytes: 0,
      maxHits: Number.MAX_SAFE_INTEGER
    })

    let downloadRejection: string | null = null
    const downloadPromise = pageB
      .evaluate(
        ({ id, dest }) =>
          window.api.syncAttachments.download({ attachmentId: id, targetPath: dest }),
        { id: attachmentId, dest: targetPath }
      )
      .catch((err: unknown) => {
        downloadRejection = err instanceof Error ? err.message : String(err)
        return { success: false as const, error: downloadRejection, filePath: undefined }
      })

    // STREAMS TO DISK: while the transfer is broken, the verified prefix is
    // sitting in a `.mrypart` file next to the destination with a resume
    // sidecar beside it. A download that buffered the file whole in RAM would
    // leave nothing here.
    const partialDir = path.dirname(targetPath)
    const readPartial = (): { size: number; chunksDone: number; chunkCount: number } | null => {
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

    const waitForPartial = async (): Promise<ReturnType<typeof readPartial>> => {
      const deadline = Date.now() + 120_000
      for (;;) {
        const state = readPartial()
        if (state && state.chunksDone >= 1) return state
        if (Date.now() > deadline) return null
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }

    // Race the transfer against the partial appearing: if the download settles
    // first, it never got a chunk onto disk, and its own result carries the
    // reason — far more useful than "no partial appeared".
    const raced = await Promise.race([
      downloadPromise.then((result) => ({ kind: 'settled' as const, result })),
      waitForPartial().then((state) => ({ kind: 'partial' as const, state }))
    ])
    if (raced.kind === 'settled') {
      throw new Error(
        `download settled before any chunk reached disk: ${JSON.stringify(raced.result)}` +
          (downloadRejection ? ` (rejection: ${downloadRejection})` : '')
      )
    }
    expect(raced.state).toMatchObject({
      chunkCount: EXPECTED_CHUNKS,
      chunksDone: 1,
      size: CHUNK_BYTES
    })

    expect(
      syncProxy.faultHits(),
      'the fault never fired — nothing was interrupted'
    ).toBeGreaterThan(0)
    const chunkGetsWhileBroken = countByPath(blobGets(syncProxy.records))
    expect(firstChunkPath).not.toBeNull()
    expect(chunkGetsWhileBroken.get(firstChunkPath!)).toBe(1)

    // ---- let it finish -----------------------------------------------------
    syncProxy.clearFaults()
    const resumed = await downloadPromise
    expect(resumed.success, resumed.error ?? 'resumed transfer failed').toBe(true)
    expect(fs.statSync(targetPath).size).toBe(FILE_BYTES)
    expect(
      fs.readdirSync(partialDir).filter((name) => name.endsWith('.mrypart')),
      'the partial must be renamed into place'
    ).toEqual([])

    // RESUMES, NEVER RESTARTS: the chunk that landed before the first cut is
    // never asked for again. A restart-from-zero would fetch it a second time.
    const chunksAfter = countByPath(blobGets(syncProxy.records))
    expect(
      chunksAfter.get(firstChunkPath!),
      'the chunk that landed before the cut was re-downloaded — the transfer restarted instead of resuming'
    ).toBe(1)
    expect(chunksAfter.size).toBe(EXPECTED_CHUNKS)

    // DOES NOT RE-APPLY THE NOTE: the record the attachment belongs to is
    // untouched by the failure and the re-drive.
    const noteAfter = await readNoteState(seeded.noteId)
    expect(noteAfter).toEqual(noteBefore)
  })
})
