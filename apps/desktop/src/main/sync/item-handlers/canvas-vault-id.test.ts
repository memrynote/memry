import fs from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { vaultMetadata } from '@memry/db-schema/data-schema'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
import type { CanvasFolderSyncPayload, CanvasSyncPayload } from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
// Asset IO drags electron in; these tests carry scenes without assets.
vi.mock('../../canvas/assets/asset-service-context', () => ({
  buildAssetServiceContext: vi.fn(() => null),
  releaseUnshownCanvasHolds: vi.fn()
}))
vi.mock('../../canvas/assets/asset-service', () => ({ ensureAssetsPresent: vi.fn() }))
const vaultDir = vi.hoisted(() => ({ current: '' }))
vi.mock('../../canvas/vault-path', () => ({
  getCanvasVaultPath: () => vaultDir.current || null
}))

import { canvasHandler } from './canvas-handler'
import { canvasFolderHandler } from './canvas-folder-handler'
import { listCanvases } from '../../canvas/store'
import { listCanvasFolders } from '../../canvas/folder-store'

// #5772: a Rust core restamps a record it wrote under its pre-bind local id
// (LOCAL_ID) to the server vault id (SERVER_ID). This Electron peer pulled the
// record before the restamp, so it stores LOCAL_ID.
const SERVER_ID = 'server-vault'
const LOCAL_ID = 'rust-local-vault'
const OTHER_ID = 'another-vault'

const scene = (marker: string): string =>
  JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {}, marker })

const tempDirs: string[] = []

/** A device bound to SERVER_ID, with its own data db and vault folder. */
function device(): { db: TestDataDb; vaultPath: string } {
  const db = createTestDataDb()
  const now = Date.now()
  db.insert(vaultMetadata)
    .values({ id: 'singleton', vaultUuid: SERVER_ID, createdAt: now, updatedAt: now })
    .run()
  const vaultPath = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'memry-canvas-vault-id-'))
  tempDirs.push(vaultPath)
  return { db, vaultPath }
}

function applyCanvas(
  target: { db: TestDataDb; vaultPath: string },
  payload: CanvasSyncPayload
): string {
  vaultDir.current = target.vaultPath
  return canvasHandler.applyUpsert({ db: target.db, emit: vi.fn() }, 'c1', payload, {})
}

function pushedCanvas(target: { db: TestDataDb; vaultPath: string }): CanvasSyncPayload {
  vaultDir.current = target.vaultPath
  return JSON.parse(canvasHandler.buildPushPayload(target.db, 'c1', 'electron', 'update')!)
}

const folderId = canvasFolderSyncId('Work')

function applyFolder(db: TestDataDb, payload: CanvasFolderSyncPayload): string {
  return canvasFolderHandler.applyUpsert({ db, emit: vi.fn() }, folderId, payload, {})
}

function pushedFolder(db: TestDataDb): CanvasFolderSyncPayload {
  return JSON.parse(canvasFolderHandler.buildPushPayload(db, folderId, 'electron', 'update')!)
}

let electron: { db: TestDataDb; vaultPath: string }

beforeEach(() => {
  electron = device()
})

afterEach(() => {
  vaultDir.current = ''
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('canvas vaultId over a pulled restamp (#5772)', () => {
  it('a pulled restamp replaces the stored old id, and the next push and a fresh device carry the server id', () => {
    applyCanvas(electron, { id: 'c1', vaultId: LOCAL_ID, scene: scene('a'), clock: { rust: 1 } })

    expect(
      applyCanvas(electron, {
        id: 'c1',
        vaultId: SERVER_ID,
        scene: scene('a'),
        clock: { rust: 2 }
      })
    ).toBe('applied')

    const pushed = pushedCanvas(electron)
    expect(pushed.vaultId).toBe(SERVER_ID)
    expect(listCanvases(electron.db, SERVER_ID).map((c) => c.id)).toEqual(['c1'])

    const fresh = device()
    applyCanvas(fresh, pushed)
    expect(listCanvases(fresh.db, SERVER_ID).map((c) => c.id)).toEqual(['c1'])
  })

  it('a restamp concurrent with a local edit still lands on the server id', () => {
    applyCanvas(electron, {
      id: 'c1',
      vaultId: LOCAL_ID,
      scene: scene('a'),
      clock: { rust: 1, electron: 1 }
    })

    applyCanvas(electron, { id: 'c1', vaultId: SERVER_ID, scene: scene('a'), clock: { rust: 2 } })

    expect(pushedCanvas(electron).vaultId).toBe(SERVER_ID)
  })

  it("a remote stating another vault's id never moves the stored id", () => {
    applyCanvas(electron, { id: 'c1', vaultId: SERVER_ID, scene: scene('a'), clock: { rust: 1 } })

    applyCanvas(electron, { id: 'c1', vaultId: OTHER_ID, scene: scene('b'), clock: { rust: 2 } })

    expect(pushedCanvas(electron).vaultId).toBe(SERVER_ID)
  })
})

describe('canvas folder vaultId over a pulled restamp (#5772)', () => {
  it('a pulled restamp replaces the stored old id, and the next push and a fresh device carry the server id', () => {
    applyFolder(electron.db, { id: folderId, vaultId: LOCAL_ID, path: 'Work', clock: { rust: 1 } })

    expect(
      applyFolder(electron.db, {
        id: folderId,
        vaultId: SERVER_ID,
        path: 'Work',
        clock: { rust: 2 }
      })
    ).toBe('applied')

    const pushed = pushedFolder(electron.db)
    expect(pushed.vaultId).toBe(SERVER_ID)

    const fresh = device()
    applyFolder(fresh.db, pushed)
    expect(listCanvasFolders(fresh.db, SERVER_ID).map((f) => f.path)).toEqual(['Work'])
  })

  it("a remote stating another vault's id never moves the stored id", () => {
    applyFolder(electron.db, { id: folderId, vaultId: SERVER_ID, path: 'Work', clock: { rust: 1 } })

    applyFolder(electron.db, { id: folderId, vaultId: OTHER_ID, path: 'Work', clock: { rust: 2 } })

    expect(pushedFolder(electron.db).vaultId).toBe(SERVER_ID)
  })
})
