import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { PropertyDefinitionSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { propertyDefinitionHandler } from './property-definition-handler'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../vault/property-definitions', () => ({
  PropertyDefinitionsService: { get: () => ({ applyRemoteDelete: vi.fn(async () => {}) }) }
}))

const AREA_OPTIONS = JSON.stringify([{ value: 'Work', color: 'indigo' }])

function makeCtx(testDb: TestDatabaseResult): ApplyContext {
  return { db: testDb.db as unknown as DrizzleDb, emit: vi.fn() }
}

function read(testDb: TestDatabaseResult, name: string) {
  return testDb.db
    .select()
    .from(propertyDefinitions)
    .where(eq(propertyDefinitions.name, name))
    .get()
}

describe('propertyDefinitionHandler', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
  })

  afterEach(() => {
    testDb.close()
  })

  it('inserts a definition it has never seen, options JSON intact', () => {
    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 1 }
    )

    expect(result).toBe('applied')
    expect(read(testDb, 'area')).toMatchObject({
      name: 'area',
      type: 'select',
      options: AREA_OPTIONS,
      clock: { 'device-b': 1 }
    })
  })

  it('applies a strictly newer clock', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 1 }
    )

    const next = JSON.stringify([{ value: 'Work', color: 'sky' }])
    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: next },
      { 'device-b': 2 }
    )

    expect(result).toBe('applied')
    expect(read(testDb, 'area')?.options).toBe(next)
  })

  it('skips an older clock rather than repainting the options', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 3 }
    )

    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: '[]' },
      { 'device-b': 2 }
    )

    expect(result).toBe('skipped')
    expect(read(testDb, 'area')?.options).toBe(AREA_OPTIONS)
  })

  it('reports a concurrent edit as a conflict and takes the remote fields', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-a': 1 }
    )

    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: '[]' },
      { 'device-b': 1 }
    )

    expect(result).toBe('conflict')
    expect(read(testDb, 'area')?.options).toBe('[]')
    expect(read(testDb, 'area')?.clock).toEqual({ 'device-a': 1, 'device-b': 1 })
  })

  it('keeps a field the sender omitted instead of clearing it', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, defaultValue: 'Work' },
      { 'device-b': 1 }
    )

    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 2 }
    )

    // An older client that does not know `defaultValue` sends no key at all.
    // Treating that as "clear it" is how saved views were destroyed once.
    expect(read(testDb, 'area')?.defaultValue).toBe('Work')
  })

  it('honours an explicit null as a clear', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, defaultValue: 'Work' },
      { 'device-b': 1 }
    )

    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, defaultValue: null },
      { 'device-b': 2 }
    )

    expect(read(testDb, 'area')?.defaultValue).toBeNull()
  })

  it('deletes on a strictly newer tombstone', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 1 }
    )

    expect(propertyDefinitionHandler.applyDelete(ctx, 'area', { 'device-b': 2 })).toBe('applied')
    expect(read(testDb, 'area')).toBeUndefined()
  })

  it('refuses a tombstone that has not seen the local edit', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-a': 2 }
    )

    expect(propertyDefinitionHandler.applyDelete(ctx, 'area', { 'device-b': 1 })).toBe('skipped')
    expect(read(testDb, 'area')).toBeDefined()
  })

  it('seeds every unclocked definition exactly once', () => {
    testDb.db
      .insert(propertyDefinitions)
      .values({ name: 'area', type: 'select', options: AREA_OPTIONS })
      .run()

    const queue = new SyncQueueManager(testDb.db as never)
    const seeded = propertyDefinitionHandler.seedUnclocked(
      testDb.db as unknown as DrizzleDb,
      'device-a',
      queue
    )

    expect(seeded).toBe(1)
    expect(read(testDb, 'area')?.clock).toEqual({ 'device-a': 1 })
    // Without the clock write above, every sync would re-seed the whole table.
    expect(
      propertyDefinitionHandler.seedUnclocked(testDb.db as unknown as DrizzleDb, 'device-a', queue)
    ).toBe(0)
  })

  it('pushes a definition that rebuilds intact on a second device', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      {
        name: 'area',
        type: 'select',
        options: AREA_OPTIONS,
        defaultValue: 'Work',
        color: 'indigo'
      },
      { 'device-a': 1 }
    )

    const payload = propertyDefinitionHandler.buildPushPayload(
      testDb.db as unknown as DrizzleDb,
      'area',
      'device-a',
      'update'
    )
    // Pinned against the schema the receiver validates with, not against this
    // handler: a field the row gains and the payload drops is rejected by every
    // peer, and the sender never hears about it.
    const parsed = PropertyDefinitionSyncPayloadSchema.safeParse(JSON.parse(payload!))
    expect(parsed.success).toBe(true)

    const second = createTestDataDb()
    propertyDefinitionHandler.applyUpsert(makeCtx(second), 'area', parsed.data!, { 'device-a': 1 })

    // Anything lost here is what the second device shows the user: a `select`
    // property as bare text with its option colours gone.
    expect(read(second, 'area')).toMatchObject({
      type: 'select',
      options: AREA_OPTIONS,
      defaultValue: 'Work',
      color: 'indigo',
      clock: { 'device-a': 1 },
      createdAt: read(testDb, 'area')!.createdAt
    })
    second.close()
  })

  it('pushes a row written before the sync columns existed', () => {
    testDb.db.insert(propertyDefinitions).values({ name: 'area', type: 'select' }).run()

    const payload = propertyDefinitionHandler.buildPushPayload(
      testDb.db as unknown as DrizzleDb,
      'area',
      'device-a',
      'update'
    )
    const parsed = JSON.parse(payload!) as Record<string, unknown>

    expect(PropertyDefinitionSyncPayloadSchema.safeParse(parsed).success).toBe(true)
    // A missing clock must be absent, never `null`: `VectorClockSchema` rejects
    // `null`, so an old install's very first push is refused by the receiver.
    expect('clock' in parsed).toBe(false)
    expect(parsed).toMatchObject({ options: null, defaultValue: null, color: null })
  })

  it('builds no payload for a definition the delete already removed', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 1 }
    )
    propertyDefinitionHandler.applyDelete(ctx, 'area', { 'device-b': 2 })

    // The queue still holds the edit that raced the delete. A payload built
    // from the missing row would push a definition the user just removed.
    expect(
      propertyDefinitionHandler.buildPushPayload(
        testDb.db as unknown as DrizzleDb,
        'area',
        'device-a',
        'update'
      )
    ).toBeNull()
  })

  it('reads the local row back for a conflict report', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      { 'device-b': 1 }
    )

    // This is the "local version" half of the conflict report and the input to
    // orphan repair; an empty snapshot shows the user a blank local side.
    expect(
      propertyDefinitionHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'area')
    ).toMatchObject({ options: AREA_OPTIONS, clock: { 'device-b': 1 } })
    expect(
      propertyDefinitionHandler.fetchLocal(testDb.db as unknown as DrizzleDb, 'missing')
    ).toBeUndefined()
  })

  it('ignores a tombstone for a definition it never had', () => {
    expect(propertyDefinitionHandler.applyDelete(ctx, 'area', { 'device-b': 1 })).toBe('skipped')
    // A re-delivered tombstone, or a peer that created and deleted before this
    // device ever pulled. Emitting tells the renderer to drop a property that
    // is still live here.
    expect(ctx.emit).not.toHaveBeenCalled()
  })

  it('falls back to the clock inside the payload when the envelope carries none', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, clock: { 'device-b': 4 } },
      {}
    )

    // The manifest re-enqueue path and older senders carry the clock in the
    // body. Dropping it stores an empty clock, and the row then accepts a stale
    // `device-b: 3` push that repaints the user's options.
    expect(read(testDb, 'area')?.clock).toEqual({ 'device-b': 4 })
  })

  it('takes the first real clock a peer sends over a row that has none', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS },
      {}
    )
    expect(read(testDb, 'area')?.clock).toEqual({})

    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: '[]' },
      { 'device-b': 1 }
    )

    // An empty clock must not read as concurrent with the first clocked update
    // a peer sends, or the definition is stuck reporting conflicts forever.
    expect(result).toBe('applied')
    expect(read(testDb, 'area')?.clock).toEqual({ 'device-b': 1 })
  })

  it('keeps colour and options a sender that predates them omits', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, color: 'indigo' },
      { 'device-b': 1 }
    )

    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select' },
      { 'device-b': 2 }
    )

    // A client from before the colour column sends no `color` key at all.
    // Reading that as a clear repaints every synced property grey.
    expect(read(testDb, 'area')).toMatchObject({ color: 'indigo', options: AREA_OPTIONS })
  })

  it('deletes a definition that was never synced and has no clock', () => {
    testDb.db
      .insert(propertyDefinitions)
      .values({ name: 'area', type: 'select', options: AREA_OPTIONS })
      .run()

    // Built from `.memry/properties.md` and never pushed, so the row has no
    // clock. Refuse the tombstone here and the definition is undeletable on
    // this device: it comes straight back on the next reload.
    expect(propertyDefinitionHandler.applyDelete(ctx, 'area', { 'device-b': 1 })).toBe('applied')
    expect(read(testDb, 'area')).toBeUndefined()
  })

  it('takes the winning options array whole when two devices reorder it', () => {
    const local = JSON.stringify([
      { value: 'Work', color: 'indigo' },
      { value: 'Home', color: 'sky' }
    ])
    const remote = JSON.stringify([
      { value: 'Home', color: 'sky' },
      { value: 'Work', color: 'indigo' }
    ])
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: local },
      { 'device-a': 1 }
    )

    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: remote },
      { 'device-b': 1 }
    )

    // Two devices dragged the same select into different orders. Last-write-wins
    // has to take the remote array whole; interleaving the two would leave each
    // device with its own dropdown order for one property and never converge.
    expect(result).toBe('conflict')
    expect(read(testDb, 'area')?.options).toBe(remote)
  })

  it('round-trips an options blob whose per-option fields it does not know', () => {
    const futuristic = JSON.stringify([
      { value: 'Work', color: 'indigo', icon: 'briefcase', sortIndex: 3 }
    ])

    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: futuristic },
      { 'device-b': 1 }
    )

    const payload = propertyDefinitionHandler.buildPushPayload(
      testDb.db as unknown as DrizzleDb,
      'area',
      'device-a',
      'update'
    )

    // `options` is opaque JSON on purpose. Normalising it here silently
    // destroys a newer client's option metadata on every hop through this one.
    expect((JSON.parse(payload!) as Record<string, unknown>).options).toBe(futuristic)
  })

  it('repaints a definition a peer recoloured', () => {
    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, color: 'indigo' },
      { 'device-b': 1 }
    )

    propertyDefinitionHandler.applyUpsert(
      ctx,
      'area',
      { name: 'area', type: 'select', options: AREA_OPTIONS, color: 'rose' },
      { 'device-b': 2 }
    )

    // The mirror of the omitted-key case above: a colour the sender does supply
    // has to land, or the user recolours a property on one device and watches it
    // stay the old colour everywhere else.
    expect(read(testDb, 'area')?.color).toBe('rose')
  })

  it('inserts a definition that carries no options at all', () => {
    const result = propertyDefinitionHandler.applyUpsert(
      ctx,
      'due',
      { name: 'due', type: 'date' },
      { 'device-b': 1 }
    )

    // A `date` property has nothing to put in `options`, and the empty column
    // is what tells this device it is not a select. Defaulting it to `'[]'`
    // here would render the peer's date field as an empty dropdown.
    expect(result).toBe('applied')
    expect(read(testDb, 'due')).toMatchObject({
      type: 'date',
      options: null,
      defaultValue: null,
      color: null
    })
  })
})
