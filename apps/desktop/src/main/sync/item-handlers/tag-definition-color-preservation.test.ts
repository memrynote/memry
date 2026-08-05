/**
 * Tag colour must survive sync.
 *
 * Live report (2026-07-21, macOS): "one of my primary tags is green and after
 * updating some notes I noticed it's now red." A tag colour is a deliberate
 * user choice; nothing that merely *touches* a tag — a pull from an older
 * build, a re-index after a file edit — is allowed to repaint it.
 *
 * The colour reaches a tag definition down three separate paths, so this suite
 * pins all three:
 *   1. the wire   — `TagDefinitionSyncPayloadSchema` + `ItemApplier`
 *   2. the merge  — `tagDefinitionHandler.applyUpsert`
 *   3. the mint   — `getOrCreateTag`, which vault indexing calls for every tag
 *                   it sees in a note and which picks a palette colour by
 *                   *how many tags happen to exist right now*
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import {
  TagDefinitionSyncPayloadSchema,
  type TagDefinitionSyncPayload
} from '@memry/contracts/sync-payloads'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { tagDefinitionHandler } from './tag-definition-handler'
import {
  ensureTagDefinitions,
  getOrCreateTag,
  updateTagColor
} from '../../database/queries/tag-definitions'
import { SyncQueueManager } from '../queue'
import { ItemApplier } from '../apply-item'
import type { ApplyContext, DrizzleDb } from './types'

/** A payload from a build that does not know about `color` at all. */
const withoutColor = (fields: Record<string, unknown>): TagDefinitionSyncPayload =>
  fields as unknown as TagDefinitionSyncPayload

/** The palette index `getOrCreateTag` lands on is `tagCount % palette.length`. */
const GREEN_AT_TAG_COUNT = 11
const RED_AT_TAG_COUNT = 22

let db: TestDataDb
let emit: ReturnType<typeof vi.fn>
let ctx: ApplyContext
let applier: ItemApplier

const asSync = (handle: TestDataDb): DrizzleDb => handle as unknown as DrizzleDb

function colorOf(handle: TestDataDb, name: string): string | undefined {
  return handle.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()?.color
}

/** Did a human pick that colour, or did the palette hand it out? */
function authoredFlagOf(handle: TestDataDb, name: string): boolean | undefined {
  return handle.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()
    ?.colorAuthored
}

/** Mint `focus` locally as the Nth tag, so its palette colour is deterministic. */
function mintTagAsNth(handle: TestDataDb, name: string, existingTags: number): string {
  for (let i = 0; i < existingTags; i++) getOrCreateTag(handle, `filler-${i}`)
  return getOrCreateTag(handle, name).color
}

beforeEach(() => {
  db = createTestDataDb()
  emit = vi.fn()
  ctx = { db: asSync(db), emit }
  applier = new ItemApplier(asSync(db), emit)
})

describe('tag colour: an incoming payload may only repaint a tag when it says so', () => {
  beforeEach(() => {
    tagDefinitionHandler.applyUpsert(ctx, 'focus', { name: 'focus', color: 'green' }, { mac: 1 })
  })

  it('keeps the local colour when a remote upsert omits color entirely', () => {
    // An older build that predates a field sends it as `undefined`. Collapsing
    // that into the insert default would repaint every tag it ever syncs.
    const result = tagDefinitionHandler.applyUpsert(
      ctx,
      'focus',
      withoutColor({ name: 'focus', categoryId: 'cat-1' }),
      { mac: 2 }
    )

    expect(result).toBe('applied')
    expect(colorOf(db, 'focus')).toBe('green')
  })

  it('keeps the local colour when an omitting payload arrives over the wire', () => {
    // Second line of defence: `color` is required by the schema, so a payload
    // without it never even reaches the merge — it is rejected, not defaulted.
    expect(TagDefinitionSyncPayloadSchema.safeParse({ name: 'focus' }).success).toBe(false)

    const result = applier.apply({
      itemId: 'focus',
      type: 'tag_definition',
      operation: 'update',
      content: new TextEncoder().encode(JSON.stringify({ name: 'focus', sortOrder: 4 })),
      clock: { mac: 2 }
    })

    expect(result).toBe('skipped')
    expect(colorOf(db, 'focus')).toBe('green')
  })

  it('applies an explicit new colour from a dominating clock', () => {
    const result = applier.apply({
      itemId: 'focus',
      type: 'tag_definition',
      operation: 'update',
      content: new TextEncoder().encode(JSON.stringify({ name: 'focus', color: 'violet' })),
      clock: { mac: 2 }
    })

    expect(result).toBe('applied')
    expect(colorOf(db, 'focus')).toBe('violet')
  })

  it('leaves the colour alone when a newer build only moves the tag into a category', () => {
    // A category assignment re-pushes the whole tag. It carries the colour it
    // already had, so the round trip must be colour-neutral.
    const result = tagDefinitionHandler.applyUpsert(
      ctx,
      'focus',
      { name: 'focus', color: 'green', categoryId: 'cat-1', sortOrder: 2 },
      { mac: 2 }
    )

    expect(result).toBe('applied')
    expect(colorOf(db, 'focus')).toBe('green')
  })

  it('does not repaint on a stale update, even one carrying a different colour', () => {
    tagDefinitionHandler.applyUpsert(ctx, 'focus', { name: 'focus', color: 'green' }, { mac: 5 })

    const result = tagDefinitionHandler.applyUpsert(
      ctx,
      'focus',
      { name: 'focus', color: 'red' },
      { mac: 2 }
    )

    expect(result).toBe('skipped')
    expect(colorOf(db, 'focus')).toBe('green')
  })
})

describe('tag colour: note indexing must not re-colour a tag it did not create', () => {
  it('returns the stored colour for a tag that already exists', () => {
    tagDefinitionHandler.applyUpsert(ctx, 'focus', { name: 'focus', color: 'green' }, { mac: 1 })

    // What the vault watcher runs for every tag in a note it just re-read.
    ensureTagDefinitions(db, ['focus'])

    expect(colorOf(db, 'focus')).toBe('green')
  })

  it('never falls back to the #808080 insert default when re-indexing a synced tag', () => {
    // A tag pulled from another device with no colour of its own gets the grey
    // default once. Re-indexing must keep that row, not mint a palette colour
    // on top of it.
    tagDefinitionHandler.applyUpsert(ctx, 'focus', withoutColor({ name: 'focus' }), { mac: 1 })
    expect(colorOf(db, 'focus')).toBe('#808080')

    ensureTagDefinitions(db, ['focus', 'reading', 'focus'])

    expect(colorOf(db, 'focus')).toBe('#808080')
    expect(colorOf(db, 'reading')).not.toBe('#808080')
  })

  it('keeps the colour when indexing sees the tag in different casing', () => {
    tagDefinitionHandler.applyUpsert(ctx, 'focus', { name: 'focus', color: 'green' }, { mac: 1 })

    ensureTagDefinitions(db, ['Focus', ' FOCUS '])

    expect(db.select().from(tagDefinitions).all()).toHaveLength(1)
    expect(colorOf(db, 'focus')).toBe('green')
  })
})

/**
 * The reported flip, reproduced end to end through real code only.
 *
 * `getOrCreateTag` colours a brand-new tag with `palette[tagCount % 24]`, so
 * the same tag name mints *green* on the device where it was the 12th tag and
 * *red* on the device where it was the 23rd. That auto-minted colour is then
 * pushed like any user choice (`seedUnclocked`) and lands as a concurrent clock
 * on the first device, where last-write-wins used to repaint a colour the user
 * picked with one nobody picked at all.
 *
 * The fix is `color_authored`: the palette's pick travels marked as nobody's
 * choice and may create a tag but never repaint one, while a colour set through
 * the picker still wins the very same merge.
 *
 * Trigger matches the report exactly: the mint happens inside
 * `ensureTagDefinitions`, which the vault watcher calls when notes are edited.
 */
describe('tag colour: green → red across devices (report 2026-07-21)', () => {
  function pushLocallyMintedTag(handle: TestDataDb, deviceId: string): string {
    const queue = new SyncQueueManager(handle)
    tagDefinitionHandler.seedUnclocked(asSync(handle), deviceId, queue)
    const row = queue.peek(200).find((item) => item.itemId === 'focus')
    if (!row) throw new Error('expected the locally minted tag to be queued for push')
    return row.payload
  }

  function replayOnDeviceA(payload: string): ReturnType<ItemApplier['apply']> {
    // Parsed by the receiver's own schema first, exactly as ItemApplier does.
    expect(TagDefinitionSyncPayloadSchema.safeParse(JSON.parse(payload)).success).toBe(true)
    return applier.apply({
      itemId: 'focus',
      type: 'tag_definition',
      operation: 'create',
      content: new TextEncoder().encode(payload),
      clock: { 'device-b': 1 }
    })
  }

  it('documents the palette drift that makes the two devices disagree', () => {
    const deviceB = createTestDataDb()

    expect(mintTagAsNth(db, 'focus', GREEN_AT_TAG_COUNT)).toBe('green')
    expect(mintTagAsNth(deviceB, 'focus', RED_AT_TAG_COUNT)).toBe('red')
  })

  it('a locally auto-minted colour must not repaint the tag on other devices', () => {
    mintTagAsNth(db, 'focus', GREEN_AT_TAG_COUNT)
    pushLocallyMintedTag(db, 'device-a')

    const deviceB = createTestDataDb()
    mintTagAsNth(deviceB, 'focus', RED_AT_TAG_COUNT)

    // The clocks still merge — the rest of the row has to converge — but the
    // colour is the one thing a concurrent seed may not decide.
    expect(replayOnDeviceA(pushLocallyMintedTag(deviceB, 'device-b'))).toBe('conflict')
    expect(colorOf(db, 'focus')).toBe('green')
  })

  it('still lets a colour the user actually picked win the same concurrent merge', () => {
    // Same shape as above, but on device B the user opened the colour picker.
    // Authorship, not the clock, is what separates the two cases.
    mintTagAsNth(db, 'focus', GREEN_AT_TAG_COUNT)
    pushLocallyMintedTag(db, 'device-a')

    const deviceB = createTestDataDb()
    mintTagAsNth(deviceB, 'focus', RED_AT_TAG_COUNT)
    updateTagColor(deviceB, 'focus', 'red')

    expect(replayOnDeviceA(pushLocallyMintedTag(deviceB, 'device-b'))).toBe('conflict')
    expect(colorOf(db, 'focus')).toBe('red')
  })

  it('marks a tag authored only once someone picks its colour', () => {
    getOrCreateTag(db, 'focus')
    expect(authoredFlagOf(db, 'focus')).toBe(false)

    updateTagColor(db, 'focus', 'violet')
    expect(authoredFlagOf(db, 'focus')).toBe(true)
  })
})
