/**
 * Two notes whose paths differ only in case share one file on a
 * case-insensitive disk, and the file holds one twin's body. The provider
 * never takes that file into the other twin's doc: not as the file a pulled
 * note owes, and not as the seed of an empty doc (#5297).
 *
 * @module sync/crdt-case-twin-file.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createTestVault } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { insertNoteCache } from '@main/database/queries/notes'
import { upsertNoteMetadata } from '@memry/storage-data'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  isDatabaseInitialized: () => true
}))
vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))
vi.mock('../vault/notes-io', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getVaultRoot: vi.fn()
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))

import { getDatabase, getIndexDatabase } from '../database'
import {
  getDatabase as getClientDatabase,
  getIndexDatabase as getClientIndexDatabase
} from '../database/client'
import { getVaultRoot } from '../vault/notes-io'
import { generateContentHash } from '../vault/frontmatter'
import { markdownToYFragment } from './blocknote-converter'
import { getCrdtProvider } from './crdt-provider'
import { owesFileBody, recordOwedFileBody } from './crdt-owed-file-body'
// Registers the write-back port the provider calls, as the app's startup does.
import './crdt-writeback'

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe.runIf(fileSystemIgnoresCase())('case twins sharing one file', () => {
  let vault: ReturnType<typeof createTestVault>
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('case-twin-file')
    data = createTestDataDb()
    index = createTestIndexDb()
    vi.mocked(getDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getClientDatabase).mockReturnValue(asClientDb(data.db))
    vi.mocked(getIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getClientIndexDatabase).mockReturnValue(index.db)
    vi.mocked(getVaultRoot).mockReturnValue(vault.path)
  })

  afterEach(async () => {
    await getCrdtProvider().purge('remote-lower')
    index.close()
    data.close()
    vault.cleanup()
  })

  /** A pulled note's rows, and its body written into the shared file. */
  function seed(id: string, relativePath: string, body: string): void {
    const fields = {
      id,
      path: relativePath,
      title: 'a',
      fileType: 'markdown' as const,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z',
      fileSize: body.length
    }
    upsertNoteMetadata(asClientDb(data.db), fields)
    insertNoteCache(index.db, { ...fields, contentHash: generateContentHash(body) })
    fs.mkdirSync(path.dirname(path.join(vault.path, relativePath)), { recursive: true })
    fs.writeFileSync(path.join(vault.path, relativePath), body)
  }

  /** The lower twin's live doc, after the upper twin's body landed in the file. */
  async function openLowerTwin(): Promise<Y.Doc> {
    seed('remote-lower', 'Supernotes/a.md', '# a\n\nlower\n')
    seed('remote-upper', 'SUPERNOTES/a.md', '# a\n\nupper\n')
    return getCrdtProvider().open('remote-lower', undefined, { skipSeed: true })
  }

  const bodyOf = (doc: Y.Doc) => JSON.stringify(doc.getXmlFragment(CRDT_FRAGMENT_NAME).toJSON())

  it('a pulled twin that owes its file keeps the server body', async () => {
    const doc = await openLowerTwin()
    const server = new Y.Doc()
    await markdownToYFragment('# a\n\nlower\n', server.getXmlFragment(CRDT_FRAGMENT_NAME))
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server))
    recordOwedFileBody('remote-lower')

    expect(await getCrdtProvider().takeFileAfterMerge('remote-lower', doc)).toBe(true)

    expect(bodyOf(doc)).toContain('lower')
    expect(bodyOf(doc)).not.toContain('upper')
    expect(owesFileBody('remote-lower')).toBe(true)
  })

  it('an empty twin doc is not seeded from the shared file', async () => {
    const doc = await openLowerTwin()

    await getCrdtProvider().takeFileAfterMerge('remote-lower', doc)

    expect(bodyOf(doc)).not.toContain('upper')
  })
})
