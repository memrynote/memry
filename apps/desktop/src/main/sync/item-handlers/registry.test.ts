import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SYNC_ITEM_TYPES, RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import type { SyncItemType } from '@memry/contracts/sync-api'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { getAllHandlers, getHandler } from './index'

/**
 * Types that are deliberately absent from the record-handler registry because
 * they travel a different transport. Anything NOT listed here must resolve to a
 * handler — `ItemApplier.apply` logs a warning and returns 'skipped' for an
 * unregistered type, which is silent data loss on the receiving device.
 */
const NON_RECORD_TYPES: SyncItemType[] = [
  // Blobs pushed/pulled through the attachment outbox + R2, never a record row.
  'attachment'
]

/**
 * Types excluded from the emit-via-`ctx.emit` probe only. They still have to
 * satisfy every structural assertion above.
 */
const EMIT_PROBE_EXEMPT: Partial<Record<SyncItemType, string>> = {
  // Writes the index DB as well as the data DB, so it cannot run against a bare
  // data-db handle. Covered by note-handler.test.ts.
  note: 'requires an initialised index database',
  journal: 'requires an initialised index database',
  // Notifies the renderer by walking BrowserWindow.getAllWindows() itself
  // (settings-handler.ts) instead of going through ctx.emit.
  settings: 'broadcasts directly via BrowserWindow, not ctx.emit'
}

const PROJECT_ID = 'registry-probe-project'
const CALENDAR_SOURCE_ID = 'registry-probe-calendar-source'
const CONVERSATION_ID = 'registry-probe-conversation'

/**
 * Minimal valid payload per type. Most sync payload schemas are fully optional
 * (handlers merge with `data.x ?? existing.x`), so `{}` parses. Types with a
 * required field — or an FK parent — get an explicit fixture here.
 */
const FIXTURE_OVERRIDES: Partial<Record<SyncItemType, Record<string, unknown>>> = {
  journal: { date: '2026-08-05' },
  tag_definition: { name: 'registry-probe', color: '#00ff00' },
  tag_category: { name: 'Registry Probe', sortOrder: 0 },
  folder_config: { icon: null },
  // tasks.project_id is NOT NULL and FK-bound (#837), so the parent is seeded
  // in beforeEach and referenced here.
  task: { projectId: PROJECT_ID },
  calendar_external_event: { sourceId: CALENDAR_SOURCE_ID },
  agent_conversation: {
    vaultId: 'registry-probe-vault',
    title: 'Registry probe',
    backend: 'claude',
    backendModel: null,
    trustList: [],
    pinned: false,
    fieldClocks: {},
    createdAt: 1,
    updatedAt: 1
  },
  agent_message: {
    conversationId: CONVERSATION_ID,
    role: 'user',
    content: { role: 'user', data: { text: 'registry probe' } },
    attachments: [],
    toolCallId: null,
    status: 'completed',
    createdAt: 1,
    updatedAt: 1
  }
}

let db: TestDataDb

beforeEach(() => {
  db = createTestDataDb()

  // Seed FK parents through their own handlers so the fixtures stay honest:
  // if a parent handler stops applying, this fails loudly rather than silently
  // weakening the child assertions.
  const seedEmit = vi.fn()
  const seedCtx = { db, emit: seedEmit, vaultKey: new Uint8Array(32) }

  const projectHandler = getHandler('project')!
  expect(projectHandler.applyUpsert(seedCtx, PROJECT_ID, {}, { 'device-seed': 1 })).toBe('applied')

  const sourceHandler = getHandler('calendar_source')!
  expect(sourceHandler.applyUpsert(seedCtx, CALENDAR_SOURCE_ID, {}, { 'device-seed': 1 })).toBe(
    'applied'
  )

  const conversationHandler = getHandler('agent_conversation')!
  expect(
    conversationHandler.applyUpsert(
      seedCtx,
      CONVERSATION_ID,
      conversationHandler.schema.parse(FIXTURE_OVERRIDES.agent_conversation),
      { 'device-seed': 1 }
    )
  ).toBe('applied')
})

describe('sync item handler registry', () => {
  it('registers a handler for every syncable item type', () => {
    const missing = SYNC_ITEM_TYPES.filter(
      (type) => !NON_RECORD_TYPES.includes(type) && !getHandler(type)
    )

    expect(missing).toEqual([])
  })

  it('registers a handler for every record sync item type', () => {
    const missing = RECORD_SYNC_ITEM_TYPES.filter((type) => !getHandler(type))

    expect(missing).toEqual([])
  })

  it('maps every type key to a handler that declares the same type', () => {
    const mismatched = SYNC_ITEM_TYPES.filter((type) => {
      const handler = getHandler(type)
      return handler !== undefined && handler.type !== type
    })

    expect(mismatched).toEqual([])
  })

  it('registers each handler under exactly one type', () => {
    const handlers = getAllHandlers()
    const declaredTypes = handlers.map((h) => h.type)

    expect(new Set(declaredTypes).size).toBe(handlers.length)
  })

  describe('renderer notification', () => {
    // A handler that mutates the local DB without emitting leaves the running
    // renderer showing stale data until the app is restarted — the "vault is
    // updated but the app does not refresh" class of report.
    for (const type of SYNC_ITEM_TYPES) {
      if (NON_RECORD_TYPES.includes(type)) continue
      const exemption = EMIT_PROBE_EXEMPT[type]
      if (exemption) {
        it.skip(`${type}: emit probe skipped — ${exemption}`, () => {})
        continue
      }

      it(`${type}: emits a renderer event when a remote upsert is applied`, () => {
        const handler = getHandler(type)
        expect(handler, `no handler registered for ${type}`).toBeDefined()

        const parsed = handler!.schema.safeParse(FIXTURE_OVERRIDES[type] ?? {})
        expect(
          parsed.success,
          `no minimal fixture for ${type} — add one to FIXTURE_OVERRIDES`
        ).toBe(true)

        const emit = vi.fn()
        const result = handler!.applyUpsert(
          { db, emit, vaultKey: new Uint8Array(32) },
          `${type}-registry-probe`,
          parsed.success ? (parsed as { data: unknown }).data : {},
          { 'device-remote': 1 }
        )

        if (result !== 'applied') {
          // Only 'applied' obligates a broadcast; a skip/parse_error changed
          // nothing locally so there is nothing for the renderer to re-read.
          return
        }

        expect(
          emit,
          `${type} applied a remote upsert without notifying the renderer`
        ).toHaveBeenCalled()
      })
    }
  })
})
