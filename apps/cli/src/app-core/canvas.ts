import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { and, count, desc, eq, isNull } from 'drizzle-orm'
import {
  canvasAssets,
  canvasEntityEdges,
  canvasEntityRefs,
  canvasFolders,
  canvases,
  vaultMetadata
} from '@memry/db-schema/data-schema'
import { CANVAS_ENTITY_TYPES, type CanvasEntityRef } from '@memry/contracts/canvas-api'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
import { createId } from '@memry/app-core/ids'
import type { DataDb } from './database.ts'
import { safeFilename } from './paths.ts'

// Mirrors desktop's canvas store (apps/desktop/src/main/canvas/store.ts,
// scene-file.ts, folder-paths.ts, edge-index.ts, scene-refs.ts). Those modules
// import Electron-bound helpers (logger, vault paths) and cannot be bundled
// here, so the rules are copied and held to the desktop behavior by
// canvas.test.ts. A canvas is a plain `.excalidraw` document at
// `<vault>/canvases/[<folder>/]<Title>.excalidraw`; the `canvases` row indexes
// it. Drawing is never edited from the CLI.

const CANVAS_DIR = 'canvases'
const CANVAS_FILE_EXT = '.excalidraw'
const MAX_CANVAS_FOLDER_DEPTH = 8
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

export interface CanvasSummary {
  id: string
  title: string | null
  folder: string | null
  icon: string | null
  ownerNoteId: string | null
  createdAt: number
  updatedAt: number
}

export interface CanvasListItem extends CanvasSummary {
  itemCount: number
  /** The document is missing or unreadable on disk. */
  unreadable: boolean
}

export interface CanvasRecord extends CanvasSummary {
  scene: string
  unreadable?: boolean
}

export interface CanvasCreateInput {
  title?: string | null
  folder?: string | null
  icon?: string | null
  /** Serialized Excalidraw scene JSON. Empty or absent creates a blank canvas. */
  scene?: string
}

export interface CanvasExportResult {
  id: string
  path: string
  bytes: number
}

export interface CanvasDeleteResult {
  deleted: boolean
  /**
   * The canvas had synced before. Only the document was removed; the running
   * desktop app turns that into a synced delete (its vault watcher, or its
   * missed-removals replay at the next open). Until then the row stays listed
   * as unreadable.
   */
  syncPending: boolean
}

export interface CanvasService {
  list(options?: { folder?: string }): Promise<CanvasListItem[]>
  get(id: string): Promise<CanvasRecord | null>
  create(input: CanvasCreateInput): Promise<CanvasRecord>
  duplicate(id: string): Promise<CanvasRecord | null>
  delete(id: string): Promise<CanvasDeleteResult>
  export(id: string, targetPath?: string): Promise<{ scene: string } | CanvasExportResult | null>
}

interface CanvasFileShape {
  type?: string
  version?: number
  source?: string
  elements?: unknown
  appState?: unknown
  files?: unknown
  memry?: unknown
}

const EMPTY_SCENE: CanvasFileShape = {
  type: 'excalidraw',
  version: 2,
  source: 'memry',
  elements: [],
  appState: {},
  files: {}
}

function splitFolder(folder: string | null | undefined): string[] {
  if (!folder) return []
  return folder
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function normalizeFolder(folder: string | null | undefined): string | null {
  const segments = splitFolder(folder)
  if (segments.length > MAX_CANVAS_FOLDER_DEPTH) {
    throw new Error(`Canvas folders cannot nest deeper than ${MAX_CANVAS_FOLDER_DEPTH} levels`)
  }
  return segments.length > 0 ? segments.join('/') : null
}

function portableBase(title: string | null): string {
  let base = safeFilename(title?.trim() || 'Canvas') || 'Canvas'
  base = base.replace(/[. ]+$/, '')
  if (!base) base = 'Canvas'
  if (WINDOWS_RESERVED_NAMES.test(base)) base = `${base} canvas`
  return base
}

function portableFolder(folder: string | null): string | null {
  const segments = splitFolder(normalizeFolder(folder)).map((segment) => portableBase(segment))
  return segments.length > 0 ? segments.join('/') : null
}

function resolveCanvasFile(vaultPath: string, relativePath: string): string {
  const segments = relativePath.split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Canvas path escapes the vault: ${relativePath}`)
  }
  return path.join(vaultPath, ...segments)
}

function relativeCanvasPath(filename: string, folder: string | null): string {
  const normalized = portableFolder(folder)
  return normalized ? `${CANVAS_DIR}/${normalized}/${filename}` : `${CANVAS_DIR}/${filename}`
}

function folderOfPath(relativePath: string): string | null {
  const folderSegments = relativePath.split('/').filter(Boolean).slice(1, -1)
  return folderSegments.length > 0 ? folderSegments.join('/') : null
}

function allocatePath(vaultPath: string, title: string | null, folder: string | null): string {
  const base = portableBase(title)
  let candidate = relativeCanvasPath(`${base}${CANVAS_FILE_EXT}`, folder)
  let counter = 1
  while (existsSync(resolveCanvasFile(vaultPath, candidate))) {
    counter += 1
    candidate = relativeCanvasPath(`${base} ${counter}${CANVAS_FILE_EXT}`, folder)
  }
  return candidate
}

/** Fixed head keys, then the rest sorted: two devices holding one scene emit one text. */
function canonicalize(parsed: CanvasFileShape, meta: unknown): Record<string, unknown> {
  const { type, version, source, elements, appState, files, memry: _memry, ...rest } = parsed
  const out: Record<string, unknown> = {
    type: type ?? EMPTY_SCENE.type,
    version: version ?? EMPTY_SCENE.version,
    source: source ?? EMPTY_SCENE.source
  }
  if (meta) out.memry = meta
  out.elements = elements ?? []
  out.appState = appState ?? {}
  out.files = files ?? {}
  for (const key of Object.keys(rest).sort()) {
    out[key] = (rest as Record<string, unknown>)[key]
  }
  return out
}

function withCanvasMeta(
  scene: string,
  meta: { id: string; createdAt: number; updatedAt: number }
): string {
  let parsed: CanvasFileShape
  if (!scene.trim()) {
    parsed = { ...EMPTY_SCENE }
  } else {
    try {
      parsed = JSON.parse(scene) as CanvasFileShape
    } catch {
      throw new Error('Canvas scene is not valid JSON')
    }
  }
  return JSON.stringify(canonicalize(parsed, meta), null, 2)
}

function stripCanvasMeta(content: string): string {
  if (!content.trim()) return ''
  let parsed: CanvasFileShape
  try {
    parsed = JSON.parse(content) as CanvasFileShape
  } catch {
    return content
  }
  return JSON.stringify(canonicalize(parsed, null))
}

function writeFileAtomic(absolutePath: string, content: string): void {
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  const tmp = path.join(path.dirname(absolutePath), `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, content, 'utf-8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, absolutePath)
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Cleanup is best effort; the original error is what matters.
    }
    throw error
  }
}

function readScene(vaultPath: string, relativePath: string | null): string | null {
  if (!relativePath) return null
  try {
    return stripCanvasMeta(readFileSync(resolveCanvasFile(vaultPath, relativePath), 'utf-8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
    throw error
  }
}

interface SceneElementLike {
  id?: unknown
  type?: unknown
  isDeleted?: unknown
  customData?: unknown
  startBinding?: unknown
  endBinding?: unknown
  startArrowhead?: unknown
  endArrowhead?: unknown
}

function sceneElements(scene: string): SceneElementLike[] {
  if (!scene) return []
  try {
    const elements = (JSON.parse(scene) as { elements?: unknown }).elements
    return Array.isArray(elements) ? (elements as SceneElementLike[]) : []
  } catch {
    return []
  }
}

function cardRef(element: SceneElementLike): CanvasEntityRef | null {
  if (element.type !== 'rectangle' || element.isDeleted === true) return null
  const data = element.customData
  if (!data || typeof data !== 'object') return null
  const entityType = (data as Record<string, unknown>).entityType
  const entityId = (data as Record<string, unknown>).entityId
  if (
    typeof entityType !== 'string' ||
    !(CANVAS_ENTITY_TYPES as readonly string[]).includes(entityType) ||
    typeof entityId !== 'string' ||
    entityId.length === 0
  ) {
    return null
  }
  return { entityType: entityType as CanvasEntityRef['entityType'], entityId }
}

function boundElementId(binding: unknown): string | null {
  if (!binding || typeof binding !== 'object') return null
  const id = (binding as { elementId?: unknown }).elementId
  return typeof id === 'string' && id.length > 0 ? id : null
}

function extractRefs(scene: string): CanvasEntityRef[] {
  const seen = new Set<string>()
  const refs: CanvasEntityRef[] = []
  for (const element of sceneElements(scene)) {
    const ref = cardRef(element)
    if (!ref) continue
    const key = `${ref.entityType}:${ref.entityId}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

function extractEdges(
  scene: string
): Array<{ arrowId: string; source: CanvasEntityRef; target: CanvasEntityRef }> {
  const elements = sceneElements(scene)
  const cardsById = new Map<string, CanvasEntityRef>()
  for (const element of elements) {
    const ref = cardRef(element)
    if (ref && typeof element.id === 'string') cardsById.set(element.id, ref)
  }
  if (cardsById.size < 2) return []

  const edges: Array<{ arrowId: string; source: CanvasEntityRef; target: CanvasEntityRef }> = []
  const seenArrows = new Set<string>()
  for (const element of elements) {
    if (element.type !== 'arrow' || element.isDeleted === true) continue
    if (typeof element.id !== 'string' || element.id.length === 0) continue
    if (seenArrows.has(element.id)) continue
    const startId = boundElementId(element.startBinding)
    const endId = boundElementId(element.endBinding)
    const start = startId ? cardsById.get(startId) : undefined
    const end = endId ? cardsById.get(endId) : undefined
    if (!start || !end) continue
    if (start.entityType === end.entityType && start.entityId === end.entityId) continue
    const reversed = element.startArrowhead != null && element.endArrowhead == null
    seenArrows.add(element.id)
    edges.push({
      arrowId: element.id,
      source: reversed ? end : start,
      target: reversed ? start : end
    })
  }
  return edges
}

function toSummary(row: typeof canvases.$inferSelect): CanvasSummary {
  return {
    id: row.id,
    title: row.title,
    folder: row.folder ?? null,
    icon: row.icon ?? null,
    ownerNoteId: row.ownerNoteId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function createCanvasService({
  dataDb,
  vaultPath
}: {
  dataDb: DataDb
  vaultPath: string
}): CanvasService {
  function vaultId(): string {
    const existing = dataDb
      .select({ vaultUuid: vaultMetadata.vaultUuid })
      .from(vaultMetadata)
      .where(eq(vaultMetadata.id, 'singleton'))
      .get()
    if (existing) return existing.vaultUuid
    const uuid = crypto.randomUUID()
    const now = Date.now()
    dataDb
      .insert(vaultMetadata)
      .values({ id: 'singleton', vaultUuid: uuid, createdAt: now, updatedAt: now })
      .run()
    return uuid
  }

  /** The stored spelling of a folder: a live folder row wins on case, as on desktop. */
  function storedFolder(folder: string | null | undefined): string | null {
    const canonical = portableFolder(folder ?? null)
    if (!canonical) return null
    const row = dataDb
      .select({ path: canvasFolders.path })
      .from(canvasFolders)
      .where(
        and(eq(canvasFolders.id, canvasFolderSyncId(canonical)), isNull(canvasFolders.deletedAt))
      )
      .get()
    return row?.path ?? canonical
  }

  function liveRow(id: string): typeof canvases.$inferSelect | undefined {
    return dataDb
      .select()
      .from(canvases)
      .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
      .get()
  }

  function insertCanvas(input: CanvasCreateInput & { ownerNoteId?: string | null }): CanvasRecord {
    const id = createId('canvas')
    const now = Date.now()
    const scene = input.scene ?? ''
    if (scene.trim()) {
      try {
        JSON.parse(scene)
      } catch {
        throw new Error('Canvas scene is not valid JSON')
      }
    }
    const filePath = allocatePath(vaultPath, input.title ?? null, storedFolder(input.folder))
    const folder = folderOfPath(filePath)
    const icon = input.icon ?? null

    writeFileAtomic(
      resolveCanvasFile(vaultPath, filePath),
      withCanvasMeta(scene, { id, createdAt: now, updatedAt: now })
    )

    // `clock` stays null: desktop's sync seeds clock-less canvases on its next start.
    dataDb
      .insert(canvases)
      .values({
        id,
        vaultId: vaultId(),
        title: input.title ?? null,
        filePath,
        folder,
        icon,
        ownerNoteId: input.ownerNoteId ?? null,
        snapshotCiphertext: '',
        vectorClock: {},
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastSyncedAt: null,
        clock: null
      })
      .run()
    if (scene) rewriteIndexes(id, scene)

    return {
      id,
      title: input.title ?? null,
      folder,
      icon,
      ownerNoteId: input.ownerNoteId ?? null,
      createdAt: now,
      updatedAt: now,
      scene: readScene(vaultPath, filePath) ?? scene
    }
  }

  function rewriteIndexes(id: string, scene: string): void {
    dataDb.delete(canvasEntityRefs).where(eq(canvasEntityRefs.canvasId, id)).run()
    for (const ref of extractRefs(scene)) {
      dataDb
        .insert(canvasEntityRefs)
        .values({ canvasId: id, entityType: ref.entityType, entityId: ref.entityId })
        .onConflictDoNothing()
        .run()
    }
    dataDb.delete(canvasEntityEdges).where(eq(canvasEntityEdges.canvasId, id)).run()
    for (const edge of extractEdges(scene)) {
      dataDb
        .insert(canvasEntityEdges)
        .values({
          canvasId: id,
          arrowId: edge.arrowId,
          sourceType: edge.source.entityType,
          sourceId: edge.source.entityId,
          targetType: edge.target.entityType,
          targetId: edge.target.entityId
        })
        .onConflictDoNothing()
        .run()
    }
  }

  return {
    async list(options = {}) {
      const wanted = options.folder === undefined ? undefined : storedFolder(options.folder)
      const rows = dataDb
        .select({
          row: canvases,
          itemCount: count(canvasEntityRefs.entityId)
        })
        .from(canvases)
        .leftJoin(canvasEntityRefs, eq(canvasEntityRefs.canvasId, canvases.id))
        .where(and(eq(canvases.vaultId, vaultId()), isNull(canvases.deletedAt)))
        .groupBy(canvases.id)
        .orderBy(desc(canvases.updatedAt))
        .all()
      return rows
        .filter(({ row }) => wanted === undefined || (row.folder ?? null) === wanted)
        .map(({ row, itemCount }) => ({
          ...toSummary(row),
          itemCount,
          unreadable: !row.filePath || !existsSync(resolveCanvasFile(vaultPath, row.filePath))
        }))
    },

    async get(id) {
      const row = liveRow(id)
      if (!row) return null
      const scene = readScene(vaultPath, row.filePath)
      if (scene === null) return { ...toSummary(row), scene: '', unreadable: true }
      return { ...toSummary(row), scene }
    },

    async create(input) {
      return insertCanvas(input)
    },

    async duplicate(id) {
      const row = liveRow(id)
      if (!row) return null
      const scene = readScene(vaultPath, row.filePath)
      // A copy of ink we cannot read would be an empty canvas wearing the original's name.
      if (scene === null) return null

      const folder = normalizeFolder(row.folder)
      const copyFilename = allocatePath(vaultPath, row.title, folder).split('/').pop()!
      const copyTitle = row.title === null ? null : copyFilename.slice(0, -CANVAS_FILE_EXT.length)
      const created = insertCanvas({ title: copyTitle, folder, icon: row.icon, scene })

      // Asset GC treats a content hash as orphaned when no OTHER canvas holds a
      // row for it, so the copy needs the original's asset rows.
      for (const asset of dataDb
        .select()
        .from(canvasAssets)
        .where(eq(canvasAssets.canvasId, id))
        .all()) {
        dataDb
          .insert(canvasAssets)
          .values({ ...asset, canvasId: created.id })
          .onConflictDoNothing()
          .run()
      }
      return created
    },

    async delete(id) {
      const row = liveRow(id)
      if (!row) return { deleted: false, syncPending: false }

      const absolutePath = row.filePath ? resolveCanvasFile(vaultPath, row.filePath) : null
      const synced = row.clock !== null
      if (!synced) {
        // Never pushed: nothing to tell peers, so a local tombstone is the whole delete.
        const now = Date.now()
        dataDb.transaction((tx) => {
          tx.update(canvases)
            .set({ deletedAt: now, updatedAt: now })
            .where(eq(canvases.id, id))
            .run()
          tx.delete(canvasEntityRefs).where(eq(canvasEntityRefs.canvasId, id)).run()
          tx.delete(canvasEntityEdges).where(eq(canvasEntityEdges.canvasId, id)).run()
        })
      }
      if (absolutePath) rmSync(absolutePath, { force: true })
      return { deleted: true, syncPending: synced }
    },

    async export(id, targetPath) {
      const row = liveRow(id)
      if (!row) return null
      const scene = readScene(vaultPath, row.filePath)
      if (scene === null) throw new Error(`Canvas ${id} has no readable document`)
      // Excalidraw's own file format, without the memry sidecar.
      const content = JSON.stringify(JSON.parse(scene), null, 2)
      if (!targetPath) return { scene: content }
      const absolute = path.resolve(targetPath)
      if (existsSync(absolute)) throw new Error(`Refusing to overwrite existing file: ${absolute}`)
      writeFileAtomic(absolute, content)
      return { id, path: absolute, bytes: Buffer.byteLength(content) }
    }
  }
}
