/**
 * Verifier for `payload-schemas.json` (T074).
 *
 * Two assertions per unknown-field case, and the SECOND one is the point:
 *
 *  1. the schema accepts the instance and STRIPS the unknown key from the
 *     parsed object — which is what Zod does, and what a projection must
 *     therefore never be pushed back from;
 *  2. the stored payload STRING is unchanged across a parse-and-re-emit cycle.
 *
 * A client that satisfies (1) and fails (2) is desktop today (#2183) and is
 * exactly the shape FR-033 forbids.
 */
import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'

import { SettingsSyncPayloadSchema } from '../settings-sync'
import {
  BookmarkSyncPayloadSchema,
  CalendarBindingSyncPayloadSchema,
  CalendarEventSyncPayloadSchema,
  CalendarExternalEventSyncPayloadSchema,
  CalendarSourceSyncPayloadSchema,
  CanvasFolderSyncPayloadSchema,
  CanvasSyncPayloadSchema,
  CustomIconSyncPayloadSchema,
  FilterSyncPayloadSchema,
  FolderConfigSyncPayloadSchema,
  HomePageSyncPayloadSchema,
  InboxSyncPayloadSchema,
  JournalSyncPayloadSchema,
  NoteSyncPayloadSchema,
  ProjectSyncPayloadSchema,
  PropertyDefinitionSyncPayloadSchema,
  ReminderSyncPayloadSchema,
  StickyDraftSyncPayloadSchema,
  TagCategorySyncPayloadSchema,
  TagDefinitionSyncPayloadSchema,
  TaskActivitySyncPayloadSchema,
  TaskSyncPayloadSchema,
  TemplateSyncPayloadSchema,
  VaultLockSyncPayloadSchema
} from '../sync-payloads'
import { loadVectorFile } from './vector-loader'

const SCHEMAS: Record<string, ZodType> = {
  note: NoteSyncPayloadSchema,
  journal: JournalSyncPayloadSchema,
  folder_config: FolderConfigSyncPayloadSchema,
  custom_icon: CustomIconSyncPayloadSchema,
  tag_definition: TagDefinitionSyncPayloadSchema,
  tag_category: TagCategorySyncPayloadSchema,
  property_definition: PropertyDefinitionSyncPayloadSchema,
  template: TemplateSyncPayloadSchema,
  task: TaskSyncPayloadSchema,
  project: ProjectSyncPayloadSchema,
  task_activity: TaskActivitySyncPayloadSchema,
  reminder: ReminderSyncPayloadSchema,
  settings: SettingsSyncPayloadSchema,
  filter: FilterSyncPayloadSchema,
  inbox: InboxSyncPayloadSchema,
  calendar_source: CalendarSourceSyncPayloadSchema,
  calendar_event: CalendarEventSyncPayloadSchema,
  calendar_external_event: CalendarExternalEventSyncPayloadSchema,
  calendar_binding: CalendarBindingSyncPayloadSchema,
  bookmark: BookmarkSyncPayloadSchema,
  canvas: CanvasSyncPayloadSchema,
  vault_lock: VaultLockSyncPayloadSchema,
  canvas_folder: CanvasFolderSyncPayloadSchema,
  home_page: HomePageSyncPayloadSchema,
  sticky_draft: StickyDraftSyncPayloadSchema
}

interface Case {
  name: string
  pins: string
  payload?: Record<string, unknown>
  expectedParsed?: Record<string, unknown>
  strippedByParse?: string[]
  storedPayloadJson?: string
  expectedPushedPayloadJson?: string
}

const vectors = loadVectorFile<{
  meta: { caseCount: number; subscribedTypes: string[]; desktopOnlyTypes: string[] }
  groups: Array<{ type: string; cases: Case[] }>
}>('payload-schemas.json')

/**
 * What a CONFORMING client does on a local edit: parse a COPY, mutate the
 * stored object, and push the stored object. The parsed projection is never
 * the thing that goes back on the wire.
 */
function editAndReemit(storedJson: string, schema: ZodType): string {
  const stored = JSON.parse(storedJson) as Record<string, unknown>
  // Parse a copy for projections, and throw the result away.
  schema.parse(JSON.parse(storedJson))
  return JSON.stringify(stored)
}

/** What a NON-conforming client does: re-serialise the projection. */
function reemitFromProjection(storedJson: string, schema: ZodType): string {
  return JSON.stringify(schema.parse(JSON.parse(storedJson)))
}

describe('payload-schemas vectors', () => {
  it('carries the recorded case count, four per type', () => {
    const total = vectors.groups.reduce((n, g) => n + g.cases.length, 0)
    expect(total).toBe(vectors.meta.caseCount)
    expect(vectors.groups).toHaveLength(25)
    for (const group of vectors.groups) expect(group.cases).toHaveLength(4)
  })

  it('covers the twenty-one subscribed types and the four desktop-only types', () => {
    expect(vectors.meta.subscribedTypes).toHaveLength(21)
    expect(vectors.meta.desktopOnlyTypes).toEqual([
      'vault_lock',
      'canvas_folder',
      'home_page',
      'sticky_draft'
    ])
    const covered = [...vectors.meta.subscribedTypes, ...vectors.meta.desktopOnlyTypes].toSorted()
    expect(vectors.groups.map((g) => g.type).toSorted()).toEqual(covered)
    expect(Object.keys(SCHEMAS).toSorted()).toEqual(covered)
  })

  for (const group of vectors.groups) {
    const schema = SCHEMAS[group.type]

    for (const entry of group.cases.slice(0, 3)) {
      // oxlint-disable-next-line vitest/valid-title -- title comes from vector/fixture data typed as string; the rule is not type-aware
      it(entry.name, () => {
        const parsed = schema.parse(entry.payload)
        expect(parsed, entry.pins).toEqual(entry.expectedParsed)
      })
    }

    it(`${group.type}: the unknown key is stripped from the PARSED object`, () => {
      const entry = group.cases[2]
      const parsed = schema.parse(entry.payload) as Record<string, unknown>
      for (const key of entry.strippedByParse ?? []) {
        const top = key.split('.')[0]
        if (key.includes('.')) {
          const nested = (parsed[top] ?? {}) as Record<string, unknown>
          /* oxlint-disable vitest/no-conditional-expect -- table/vector-driven loop: each case asserts only the properties its row defines */
          expect(key.split('.')[1] in nested, `${key} must be stripped by parse`).toBe(false)
        } else {
          expect(key in parsed, `${key} must be stripped by parse`).toBe(false)
          /* oxlint-enable vitest/no-conditional-expect */
        }
      }
      expect(
        (entry.strippedByParse ?? []).length,
        'no unknown key means the case tests nothing'
      ).toBeGreaterThan(0)
    })

    // oxlint-disable-next-line vitest/valid-title -- title comes from vector/fixture data typed as string; the rule is not type-aware
    it(group.cases[3].name, () => {
      const entry = group.cases[3]
      const stored = entry.storedPayloadJson!
      // The conforming path: bytes survive.
      expect(editAndReemit(stored, schema), entry.pins).toBe(entry.expectedPushedPayloadJson)
      // The non-conforming path MUST differ, or this case proves nothing.
      expect(
        reemitFromProjection(stored, schema),
        'pushing the projection back must LOSE the unknown key — if it does not, this case is not testing FR-033'
      ).not.toBe(entry.expectedPushedPayloadJson)
    })
  }

  it('the reminder case uses triggeredAt, the field the schema deliberately omits', () => {
    const group = vectors.groups.find((g) => g.type === 'reminder')!
    expect(group.cases[2].strippedByParse).toContain('triggeredAt')
  })

  it('SyncTimestampSchema accepts a number and normalises it to a string', () => {
    // The cautionary fact of chapter 13 §13.5, asserted rather than described.
    const parsed = NoteSyncPayloadSchema.parse({ modifiedAt: 1760000000000 }) as {
      modifiedAt: string
    }
    expect(typeof parsed.modifiedAt).toBe('string')
    expect(parsed.modifiedAt).toBe(new Date(1760000000000).toISOString())
    const asString = NoteSyncPayloadSchema.parse({ modifiedAt: parsed.modifiedAt }) as {
      modifiedAt: string
    }
    expect(asString.modifiedAt, 'a string still parses to itself').toBe(parsed.modifiedAt)
  })
})
