# Relation Properties Implementation Plan (Steps 1–2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `relation` property type whose values are live references to Notes, Files, Tasks, and Events, plus the reverse "Referenced by" surface and graph edges that fall out of it.

**Architecture:** A relation value is an array of `memry://<kind>/<id>` URI strings stored in the existing note `properties` record — no sync-protocol change. A new index-DB-only `property_refs` table is populated inside `setNoteProperties`, which is the single choke point both the indexer and the sync-pull path already call, so one change covers both. Reverse lookups (backlinks, graph edges) read that table; nothing is synced and the table is rebuildable.

**Tech Stack:** TypeScript, Electron (main/renderer split), Drizzle ORM over better-sqlite3, Zod contracts, React + Radix + Tailwind renderer, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-03-relational-properties-design.md`

## Global Constraints

- **Backward compatibility is mandatory.** Real users run this on real data. No DB resets. Index-DB migrations only in this plan — additive and rebuildable. No data-DB schema change. No sync-protocol change.
- **No new `SyncItemType`.** Relation values ride the existing note/journal payload `properties` field.
- **Logging:** always `createLogger('Scope')`; never raw `console.*`.
- **User-facing errors:** always `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **IPC boundary:** all renderer↔main types go through `packages/contracts`. Run `pnpm ipc:generate` before `pnpm ipc:check` after editing contracts, preload APIs, or main IPC handlers.
- **Tailwind logical properties (RTL):** new markup uses `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`. Never `ml-*`, `mr-*`, `pl-*`, `pr-*`, `left-*`, `right-*`.
- **URI grammar (exact, used by every task):** `memry://<kind>/<id>` where `kind ∈ {note, task, event}` and `<id>` is one or more of `[A-Za-z0-9_-]`. Regex: `/^memry:\/\/(note|task|event)\/([A-Za-z0-9_-]+)$/`.
- **Inference is all-or-nothing:** an array infers `relation` only if it is non-empty and _every_ entry matches the grammar. Empty arrays and mixed arrays stay `text`. Never partially interpret.
- **Dangling refs are never auto-scrubbed.** A deleted target renders as a "deleted" chip; the value stays. Scrubbing would write the note and race sync.
- Verify with `pnpm --filter @memry/desktop test:main`, `test:renderer`, `pnpm typecheck`, `pnpm lint`.

---

## File Structure

**Create:**

- `packages/contracts/src/relation-uri.ts` — URI format/parse/validate. Shared by main (inference, refs) and renderer (chips, picker). Pure functions, no I/O.
- `packages/contracts/src/relation-uri.test.ts` — its tests.
- `apps/desktop/src/main/database/queries/notes/property-ref-queries.ts` — `property_refs` reads/writes. Kept separate from `property-queries.ts` (already 200+ lines and about values, not edges).
- `apps/desktop/src/main/database/queries/notes/property-ref-queries.test.ts`
- `apps/desktop/src/main/ipc/relation-handlers.ts` — the `properties:resolveRefs` handler. Spans both DBs.
- `apps/desktop/src/main/ipc/relation-handlers.test.ts`
- `apps/desktop/src/renderer/src/components/note/info-section/editors/RelationEditor.tsx` — chips + picker trigger.
- `apps/desktop/src/renderer/src/components/note/info-section/editors/RelationPicker.tsx` — the search popover.
- Tests alongside both.

**Modify:**

- `packages/contracts/src/property-types.ts:3` — add `RELATION`.
- `apps/desktop/src/renderer/src/components/note/info-section/types.ts:13,49` — union + `PROPERTY_TYPE_CONFIG`.
- `apps/desktop/src/main/vault/frontmatter.ts:389` — `inferPropertyType`.
- `apps/desktop/src/main/database/queries/notes/query-helpers.ts:40` — `deserializeValue`.
- `packages/db-schema/src/schema/notes-cache.ts` — `propertyRefs` table.
- `apps/desktop/src/main/database/queries/notes/property-queries.ts:25` — `setNoteProperties` populates refs.
- `apps/desktop/src/main/database/queries/notes/index.ts` — re-exports.
- `apps/desktop/src/renderer/src/components/note/info-section/AddPropertyPopup.tsx` — "Relation" entry.
- `apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.tsx` — dispatch to `RelationEditor`.
- `apps/desktop/src/renderer/src/components/folder-view/property-cell.tsx` — read-only chips.
- `apps/desktop/src/main/database/queries/graph.ts` — `relation` edges.

**Explicitly NOT modified:** `packages/contracts/src/sync-payloads.ts`, `packages/db-schema/src/data-schema.ts`, `apps/desktop/src/main/database/drizzle-data/`, `PropertyDefinitionSchema`, `.memry/properties.md` format.

---

## Task 1: `relation` type in contracts and renderer registry

**Files:**

- Modify: `packages/contracts/src/property-types.ts:3-12`
- Modify: `apps/desktop/src/renderer/src/components/note/info-section/types.ts:13-21,49-58`
- Test: `apps/desktop/src/renderer/src/components/note/info-section/info-section.test.tsx`

**Interfaces:**

- Consumes: nothing.
- Produces: `PropertyTypes.RELATION` (value `'relation'`), the renderer `PropertyType` union including `'relation'`, and `PROPERTY_TYPE_CONFIG.relation = { label: 'Relation', icon: Link2 }`.

Do **not** add a `relation` member to `PropertyDefinitionSchema` (`property-types.ts:98`). That union covers only types with extra config (status/select/multiselect/date); `text`, `number`, `checkbox`, `url` have no member and `relation` follows them.

- [ ] **Step 1: Write the failing test**

In `info-section.test.tsx`, add:

```tsx
import { PROPERTY_TYPE_CONFIG, PROPERTY_TYPES } from './types'

describe('relation property type registration', () => {
  it('exposes relation in the type registry', () => {
    expect(PROPERTY_TYPES).toContain('relation')
    expect(PROPERTY_TYPE_CONFIG.relation.label).toBe('Relation')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- info-section`
Expected: FAIL — `PROPERTY_TYPE_CONFIG.relation` is undefined.

- [ ] **Step 3: Add the type to contracts**

In `packages/contracts/src/property-types.ts`, extend the const map:

```ts
export const PropertyTypes = {
  TEXT: 'text',
  NUMBER: 'number',
  CHECKBOX: 'checkbox',
  DATE: 'date',
  URL: 'url',
  STATUS: 'status',
  SELECT: 'select',
  MULTISELECT: 'multiselect',
  RELATION: 'relation'
} as const
```

- [ ] **Step 4: Add the type to the renderer registry**

In `apps/desktop/src/renderer/src/components/note/info-section/types.ts`, add `| 'relation'` to the `PropertyType` union, import `Link2` from `@/lib/icons` (verify the export name exists there; if the icon set exposes a different link-ish name, use it and keep it visually distinct from `Link`, which `url` already uses), and add the config entry:

```ts
relation: { label: 'Relation', icon: Link2 }
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @memry/desktop test:renderer -- info-section`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS. If it reports a non-exhaustive switch or `Record<PropertyType, …>` gap anywhere, fix those sites now — that exhaustiveness is the compiler telling you every place relation must be handled.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/property-types.ts apps/desktop/src/renderer/src/components/note/info-section/types.ts apps/desktop/src/renderer/src/components/note/info-section/info-section.test.tsx
git commit -m "feat(properties): register relation property type"
```

---

## Task 2: relation URI helpers

**Files:**

- Create: `packages/contracts/src/relation-uri.ts`
- Test: `packages/contracts/src/relation-uri.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type RelationKind = 'note' | 'task' | 'event'`
  - `interface RelationRef { kind: RelationKind; id: string }`
  - `formatRelationUri(kind: RelationKind, id: string): string`
  - `parseRelationUri(value: unknown): RelationRef | null`
  - `isRelationValue(value: unknown): value is string[]` — true only for a non-empty array where every entry parses.
  - `parseRelationValue(value: unknown): RelationRef[]` — parsed refs, or `[]` when not a relation value.

Note the contracts package may gate its test run separately; if `pnpm test` does not pick this file up, run vitest against the package directly and mention it in the commit body.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import {
  formatRelationUri,
  parseRelationUri,
  isRelationValue,
  parseRelationValue
} from './relation-uri'

describe('relation URIs', () => {
  it('formats and parses a round trip', () => {
    const uri = formatRelationUri('note', 'nte_abc123')
    expect(uri).toBe('memry://note/nte_abc123')
    expect(parseRelationUri(uri)).toEqual({ kind: 'note', id: 'nte_abc123' })
  })

  it('parses each supported kind', () => {
    expect(parseRelationUri('memry://task/tsk_1')).toEqual({ kind: 'task', id: 'tsk_1' })
    expect(parseRelationUri('memry://event/evt_1')).toEqual({ kind: 'event', id: 'evt_1' })
  })

  it('rejects malformed URIs', () => {
    expect(parseRelationUri('memry://project/prj_1')).toBeNull()
    expect(parseRelationUri('memry://note/')).toBeNull()
    expect(parseRelationUri('https://example.com')).toBeNull()
    expect(parseRelationUri('memry://note/a b')).toBeNull()
    expect(parseRelationUri(42)).toBeNull()
    expect(parseRelationUri(null)).toBeNull()
  })

  it('treats a value as relation only when every entry parses', () => {
    expect(isRelationValue(['memry://note/nte_1'])).toBe(true)
    expect(isRelationValue(['memry://note/nte_1', 'memry://task/tsk_2'])).toBe(true)
    expect(isRelationValue([])).toBe(false)
    expect(isRelationValue(['memry://note/nte_1', 'plain text'])).toBe(false)
    expect(isRelationValue('memry://note/nte_1')).toBe(false)
    expect(isRelationValue(null)).toBe(false)
  })

  it('returns parsed refs or an empty array', () => {
    expect(parseRelationValue(['memry://note/nte_1'])).toEqual([{ kind: 'note', id: 'nte_1' }])
    expect(parseRelationValue(['nope'])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/relation-uri.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
export type RelationKind = 'note' | 'task' | 'event'

export interface RelationRef {
  kind: RelationKind
  id: string
}

const RELATION_URI_PATTERN = /^memry:\/\/(note|task|event)\/([A-Za-z0-9_-]+)$/

export function formatRelationUri(kind: RelationKind, id: string): string {
  return `memry://${kind}/${id}`
}

export function parseRelationUri(value: unknown): RelationRef | null {
  if (typeof value !== 'string') return null
  const match = RELATION_URI_PATTERN.exec(value)
  if (!match) return null
  return { kind: match[1] as RelationKind, id: match[2] }
}

export function isRelationValue(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((v) => parseRelationUri(v) !== null)
  )
}

export function parseRelationValue(value: unknown): RelationRef[] {
  if (!isRelationValue(value)) return []
  return value.map((v) => parseRelationUri(v) as RelationRef)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/relation-uri.test.ts`
Expected: PASS (11 assertions across 5 tests)

- [ ] **Step 5: Export from the package entry**

Check how `packages/contracts` exposes submodules (the codebase imports e.g. `@memry/contracts/property-types`). Follow that exact pattern — if it is subpath exports in `package.json`, add `./relation-uri`; if it is a barrel, add the re-export there.

- [ ] **Step 6: Verify the import path resolves**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/relation-uri.ts packages/contracts/src/relation-uri.test.ts packages/contracts/package.json
git commit -m "feat(properties): add relation URI helpers"
```

---

## Task 3: infer `relation` before arrays collapse to text

**Files:**

- Modify: `apps/desktop/src/main/vault/frontmatter.ts:389-420`
- Test: the existing frontmatter test file (find it with `rtk find apps/desktop/src/main/vault -name "frontmatter*.test.ts"`; if none exists, create `frontmatter.test.ts` next to it using the `describe`/`it` style of `apps/desktop/src/main/database/queries/notes/notes.test.ts`)

**Interfaces:**

- Consumes: `isRelationValue` from Task 2.
- Produces: `inferPropertyType(name, value)` returning `'relation'` for well-formed relation arrays. Signature unchanged.

This is landmine #1 from the spec. `frontmatter.ts:401` currently reads `if (Array.isArray(value)) return 'text'` with the comment "arrays no longer supported". The relation check must sit **before** it, or relation values index as text and every downstream surface breaks silently.

- [ ] **Step 1: Write the failing test**

```ts
import { inferPropertyType } from './frontmatter'

describe('inferPropertyType — relation', () => {
  it('infers relation for an all-URI array', () => {
    expect(inferPropertyType('father', ['memry://note/nte_1'])).toBe('relation')
    expect(inferPropertyType('attendees', ['memry://task/tsk_1', 'memry://event/evt_2'])).toBe(
      'relation'
    )
  })

  it('leaves non-relation arrays as text', () => {
    expect(inferPropertyType('tags', [])).toBe('text')
    expect(inferPropertyType('tags', ['a', 'b'])).toBe('text')
    expect(inferPropertyType('mixed', ['memry://note/nte_1', 'plain'])).toBe('text')
    expect(inferPropertyType('bad', ['memry://project/prj_1'])).toBe('text')
  })

  it('does not treat a bare URI string as relation', () => {
    expect(inferPropertyType('father', 'memry://note/nte_1')).toBe('text')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- frontmatter`
Expected: FAIL — first assertion returns `'text'`.

- [ ] **Step 3: Add the branch**

In `frontmatter.ts`, import `isRelationValue` from the contracts relation-uri module and insert the check immediately before the existing array branch:

```ts
// Array of memry:// URIs -> relation (must precede the array->text fallback)
if (isRelationValue(value)) {
  return 'relation'
}

// Array -> text (arrays no longer supported, convert to JSON string)
if (Array.isArray(value)) {
  return 'text'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- frontmatter`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/vault/frontmatter.ts apps/desktop/src/main/vault/frontmatter.test.ts
git commit -m "feat(properties): infer relation type from memry URI arrays"
```

---

## Task 4: deserialize relation values back into arrays

**Files:**

- Modify: `apps/desktop/src/main/database/queries/notes/query-helpers.ts:40-63`
- Test: `apps/desktop/src/main/database/queries/notes/notes.test.ts`

**Interfaces:**

- Consumes: nothing (pure switch extension).
- Produces: `deserializeValue(value, 'relation')` returning `string[]`.

This is landmine #2. `serializeValue` (`query-helpers.ts:27`) already JSON-encodes arrays into `note_properties.value`. Without a matching `relation` case, `deserializeValue` falls through `default` and hands the renderer a JSON _string_; the `Array.isArray(property.value)` guard (the pattern at `PropertyRow.tsx:219`) then renders nothing, with no error anywhere.

- [ ] **Step 1: Write the failing test**

```ts
import { deserializeValue, serializeValue } from './query-helpers'

describe('deserializeValue — relation', () => {
  it('round-trips a relation array', () => {
    const value = ['memry://note/nte_1', 'memry://task/tsk_2']
    expect(deserializeValue(serializeValue(value), 'relation')).toEqual(value)
  })

  it('falls back to a single-element array for non-array JSON', () => {
    expect(deserializeValue('memry://note/nte_1', 'relation')).toEqual(['memry://note/nte_1'])
  })

  it('returns null for a null value', () => {
    expect(deserializeValue(null, 'relation')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- notes.test`
Expected: FAIL — first assertion gets the raw JSON string.

- [ ] **Step 3: Add the case**

In the `deserializeValue` switch, add `relation` next to `multiselect` with identical handling:

```ts
    case 'multiselect':
    case 'relation': {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : [value]
      } catch {
        return [value]
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- notes.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/database/queries/notes/query-helpers.ts apps/desktop/src/main/database/queries/notes/notes.test.ts
git commit -m "fix(properties): deserialize relation values as arrays"
```

---

## Task 5: `property_refs` table and index migration

**Files:**

- Modify: `packages/db-schema/src/schema/notes-cache.ts` (append near `noteLinks`, which starts at :70)
- Create: `apps/desktop/src/main/database/drizzle-index/0020_<generated_name>.sql` (generated, do not hand-name)
- Test: `apps/desktop/src/main/database/property-refs-schema.test.ts` (mirror `tag-categories-schema.test.ts`, which already lives in that directory)

**Interfaces:**

- Consumes: nothing.
- Produces: `propertyRefs` Drizzle table plus `PropertyRefRow` / `NewPropertyRefRow` types, exported from `@memry/db-schema/schema/notes-cache`. Columns: `sourceNoteId`, `propertyName`, `targetType`, `targetId`.

Index DB only. It is re-exported through `index-schema.ts` automatically (`export * from './schema/notes-cache.ts'`). **Do not** add it to `data-schema.ts`.

- [ ] **Step 1: Write the failing test**

Open `apps/desktop/src/main/database/tag-categories-schema.test.ts` first and copy its harness exactly — same imports, same db construction, same migration invocation. Then:

```ts
describe('property_refs schema', () => {
  it('creates the table with the expected columns', () => {
    const columns = db.all(sql`PRAGMA table_info(property_refs)`) as Array<{ name: string }>
    const names = columns.map((c) => c.name).sort()
    expect(names).toEqual(['property_name', 'source_note_id', 'target_id', 'target_type'])
  })

  it('cascades when the source note is deleted', () => {
    // insert a note_cache row, then a property_refs row pointing at it,
    // delete the note, expect zero property_refs rows.
  })
})
```

Fill the second test body using the note-insert helper the neighbouring schema test already uses; do not invent a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- property-refs-schema`
Expected: FAIL — `PRAGMA table_info` returns an empty list.

- [ ] **Step 3: Declare the table**

In `notes-cache.ts`, following the `noteLinks` and `canvasEntityRefs` (`packages/db-schema/src/schema/canvas.ts:72`) patterns:

```ts
/**
 * Which entities a note's relation-typed properties point at. Index DB only,
 * rebuilt from note payloads/files exactly like note_links — never synced.
 */
export const propertyRefs = sqliteTable(
  'property_refs',
  {
    sourceNoteId: text('source_note_id')
      .notNull()
      .references(() => noteCache.id, { onDelete: 'cascade' }),
    propertyName: text('property_name').notNull(),
    targetType: text('target_type').$type<'note' | 'task' | 'event'>().notNull(),
    targetId: text('target_id').notNull()
  },
  (table) => [
    primaryKey({
      columns: [table.sourceNoteId, table.propertyName, table.targetType, table.targetId]
    }),
    index('idx_property_refs_target').on(table.targetType, table.targetId)
  ]
)

export type PropertyRefRow = typeof propertyRefs.$inferSelect
export type NewPropertyRefRow = typeof propertyRefs.$inferInsert
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @memry/desktop db:generate`
Expected: a new `0020_*.sql` under `drizzle-index/` plus its `meta/` snapshot.

Open the generated SQL and confirm it is a plain `CREATE TABLE` + `CREATE INDEX` with no `DROP`, no table rebuild, and no touch to any existing table. If it contains anything else, stop and report — index migrations must be purely additive here.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- property-refs-schema`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db-schema/src/schema/notes-cache.ts apps/desktop/src/main/database/drizzle-index apps/desktop/src/main/database/property-refs-schema.test.ts
git commit -m "feat(properties): add property_refs index table"
```

---

## Task 6: populate and query `property_refs`

**Files:**

- Create: `apps/desktop/src/main/database/queries/notes/property-ref-queries.ts`
- Create: `apps/desktop/src/main/database/queries/notes/property-ref-queries.test.ts`
- Modify: `apps/desktop/src/main/database/queries/notes/property-queries.ts:25-48`
- Modify: `apps/desktop/src/main/database/queries/notes/index.ts`

**Interfaces:**

- Consumes: `parseRelationValue`, `RelationKind` (Task 2); `propertyRefs`, `NewPropertyRefRow` (Task 5).
- Produces:
  - `setPropertyRefs(db: IndexDb, noteId: string, properties: Record<string, unknown>): void` — replaces all rows for the note.
  - `getPropertyRefsForNote(db: IndexDb, noteId: string): PropertyRefRow[]`
  - `getIncomingPropertyRefs(db: IndexDb, targetType: RelationKind, targetId: string): PropertyRefRow[]`

`setNoteProperties` (`property-queries.ts:25`) is the only choke point that matters: the indexer path (`apps/desktop/src/main/projections/projectors/note-derived-state-projector.ts:59`) and the sync-pull path (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:396`) both call it. Populating refs inside it covers both with no call-site edits. Do not add a second call at either site — that would double-write.

- [ ] **Step 1: Write the failing test**

```ts
describe('property refs', () => {
  it('writes one row per parsed URI', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', {
      father: ['memry://note/nte_dad'],
      attendees: ['memry://task/tsk_1', 'memry://event/evt_2'],
      email: 'john@doe.com'
    })

    const rows = getPropertyRefsForNote(db, 'nte_source')
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.propertyName === 'father')).toEqual([
      {
        sourceNoteId: 'nte_source',
        propertyName: 'father',
        targetType: 'note',
        targetId: 'nte_dad'
      }
    ])
  })

  it('ignores non-relation values', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', { tags: ['a', 'b'], mixed: ['memry://note/nte_1', 'x'] })
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(0)
  })

  it('replaces previous rows wholesale', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', { father: ['memry://note/nte_old'] })
    setPropertyRefs(db, 'nte_source', { father: ['memry://note/nte_new'] })

    const rows = getPropertyRefsForNote(db, 'nte_source')
    expect(rows).toHaveLength(1)
    expect(rows[0].targetId).toBe('nte_new')
  })

  it('finds incoming refs by target', () => {
    insertTestNote(db, 'nte_a')
    insertTestNote(db, 'nte_b')
    setPropertyRefs(db, 'nte_a', { father: ['memry://note/nte_dad'] })
    setPropertyRefs(db, 'nte_b', { father: ['memry://note/nte_dad'] })

    const incoming = getIncomingPropertyRefs(db, 'note', 'nte_dad')
    expect(incoming.map((r) => r.sourceNoteId).sort()).toEqual(['nte_a', 'nte_b'])
  })

  it('is populated through setNoteProperties', () => {
    insertTestNote(db, 'nte_source')
    setNoteProperties(db, 'nte_source', { father: ['memry://note/nte_dad'] }, (name, value) =>
      inferPropertyType(name, value)
    )
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(1)
  })
})
```

Use the same `createTestIndexDb` harness and note-insert helper as `notes.test.ts` (imports at `notes.test.ts:1-5`); do not invent a new fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- property-ref-queries`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the queries**

```ts
import { and, eq } from 'drizzle-orm'
import {
  propertyRefs,
  type NewPropertyRefRow,
  type PropertyRefRow
} from '@memry/db-schema/schema/notes-cache'
import { parseRelationValue, type RelationKind } from '@memry/contracts/relation-uri'
import type { IndexDb } from '../../types'

export function setPropertyRefs(
  db: IndexDb,
  noteId: string,
  properties: Record<string, unknown>
): void {
  db.delete(propertyRefs).where(eq(propertyRefs.sourceNoteId, noteId)).run()

  const rows: NewPropertyRefRow[] = []
  for (const [propertyName, value] of Object.entries(properties)) {
    for (const ref of parseRelationValue(value)) {
      rows.push({ sourceNoteId: noteId, propertyName, targetType: ref.kind, targetId: ref.id })
    }
  }

  if (rows.length > 0) {
    db.insert(propertyRefs).values(rows).run()
  }
}

export function getPropertyRefsForNote(db: IndexDb, noteId: string): PropertyRefRow[] {
  return db.select().from(propertyRefs).where(eq(propertyRefs.sourceNoteId, noteId)).all()
}

export function getIncomingPropertyRefs(
  db: IndexDb,
  targetType: RelationKind,
  targetId: string
): PropertyRefRow[] {
  return db
    .select()
    .from(propertyRefs)
    .where(and(eq(propertyRefs.targetType, targetType), eq(propertyRefs.targetId, targetId)))
    .all()
}
```

- [ ] **Step 4: Wire it into `setNoteProperties`**

In `property-queries.ts`, call it at the end of `setNoteProperties` — after the value rows are written, and outside the `entries.length > 0` guard so that clearing a note's properties also clears its refs:

```ts
    db.insert(noteProperties).values(propertyRecords).run()
  }

  setPropertyRefs(db, noteId, properties)
}
```

- [ ] **Step 5: Re-export from the queries barrel**

Add `setPropertyRefs`, `getPropertyRefsForNote`, `getIncomingPropertyRefs` to `apps/desktop/src/main/database/queries/notes/index.ts` alongside the existing `setNoteProperties` export (:56).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main -- property-ref-queries`
Expected: PASS (5 tests)

Run: `pnpm --filter @memry/desktop test:main`
Expected: PASS — confirms neither the projector nor the sync-pull path regressed.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/database/queries/notes
git commit -m "feat(properties): index relation values into property_refs"
```

---

## Task 7: `properties:resolveRefs` IPC

**Files:**

- Create: `apps/desktop/src/main/ipc/relation-handlers.ts`
- Create: `apps/desktop/src/main/ipc/relation-handlers.test.ts`
- Modify: `packages/contracts` (channel + payload types — follow the neighbouring properties/notes contract module exactly)
- Modify: preload/generated RPC via `pnpm ipc:generate`

**Interfaces:**

- Consumes: `parseRelationUri`, `RelationKind` (Task 2).
- Produces: `properties:resolveRefs(uris: string[]) => ResolvedRelationRef[]` where

```ts
interface ResolvedRelationRef {
  uri: string
  targetType: RelationKind
  targetId: string
  title: string
  subtitle?: string
  exists: boolean
  fileType?: string
}
```

**This handler spans both databases.** Note targets come from `note_cache` (index DB); task targets from `tasks` and event targets from `calendar_events` (both data DB — `packages/db-schema/src/data-schema.ts:13,20`). Take both handles; do not assume one connection. Do **not** resolve `calendar_external_events` — external provider events are out of scope per the spec.

- [ ] **Step 1: Write the failing test**

```ts
describe('properties:resolveRefs', () => {
  it('resolves a note, a task and an event', async () => {
    const result = await resolveRefs(indexDb, dataDb, [
      'memry://note/nte_1',
      'memry://task/tsk_1',
      'memry://event/evt_1'
    ])
    expect(result.map((r) => r.title)).toEqual(['Richard Doe', 'Call Richard', 'Lunch'])
    expect(result.every((r) => r.exists)).toBe(true)
  })

  it('marks missing targets as non-existent without throwing', async () => {
    const [ref] = await resolveRefs(indexDb, dataDb, ['memry://note/nte_gone'])
    expect(ref.exists).toBe(false)
    expect(ref.uri).toBe('memry://note/nte_gone')
  })

  it('marks malformed URIs as non-existent without throwing', async () => {
    const [ref] = await resolveRefs(indexDb, dataDb, ['not-a-uri'])
    expect(ref.exists).toBe(false)
  })

  it('preserves input order and length', async () => {
    const uris = ['memry://task/tsk_1', 'memry://note/nte_1']
    const result = await resolveRefs(indexDb, dataDb, uris)
    expect(result.map((r) => r.uri)).toEqual(uris)
  })

  it('returns fileType for file notes', async () => {
    const [ref] = await resolveRefs(indexDb, dataDb, ['memry://note/nte_pdf'])
    expect(ref.fileType).toBe('pdf')
  })
})
```

Seed the fixtures with the same test-db helpers the neighbouring main-process IPC tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- relation-handlers`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handler**

Group the parsed URIs by kind, issue one `inArray` query per kind (three queries maximum regardless of input size — never one query per URI), then map results back onto the input array preserving order. Unparseable or missing targets produce `{ uri, targetType, targetId, title: '', exists: false }` with `targetType`/`targetId` best-effort from the parse (use `'note'`/`''` when the parse failed). Use `createLogger('RelationRefs')` for any warn-level logging.

- [ ] **Step 4: Register the channel and regenerate the RPC map**

Add the channel to `packages/contracts` following the existing properties channels, register the handler where the other note/property handlers are registered, then:

```bash
pnpm ipc:generate
pnpm ipc:check
```

Expected: `ipc:check` PASS. If it reports the invoke map is out of date, re-run `ipc:generate` and commit the regenerated file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main -- relation-handlers`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/ipc packages/contracts apps/desktop/src/preload
git commit -m "feat(properties): add resolveRefs IPC for relation targets"
```

---

## Task 8: "Relation" entry in the add-property popup

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/note/info-section/AddPropertyPopup.tsx`
- Test: `apps/desktop/src/renderer/src/components/note/info-section/info-section.test.tsx`

**Interfaces:**

- Consumes: `PROPERTY_TYPE_CONFIG.relation` (Task 1).
- Produces: a selectable "Relation" option that calls the popup's existing `onSelect`/`onAdd` callback with `type: 'relation'`.

Read the component before editing: if it renders from `PROPERTY_TYPES` it may already list Relation after Task 1, in which case this task is only the test plus any ordering/icon adjustment. Do not restructure the component.

- [ ] **Step 1: Write the failing test**

```tsx
it('offers Relation as a property type', async () => {
  const onAdd = vi.fn()
  render(<AddPropertyPopup onAdd={onAdd} /* match the real prop signature */ />)
  await userEvent.click(screen.getByText('Relation'))
  expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ type: 'relation' }))
})
```

Match the component's real props and the file's existing render/mocking conventions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- info-section`
Expected: FAIL (or PASS immediately if the popup is registry-driven — in that case note it and move to Step 4).

- [ ] **Step 3: Add the entry**

Add Relation to the popup's type list, or confirm the registry drives it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- info-section`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/info-section
git commit -m "feat(properties): offer Relation in the add-property popup"
```

---

## Task 9: relation chips in the property row (read path)

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/info-section/editors/RelationEditor.tsx`
- Create: `apps/desktop/src/renderer/src/components/note/info-section/editors/RelationEditor.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/note/info-section/PropertyRow.tsx` (dispatch near the `multiselect` branch at :218)

**Interfaces:**

- Consumes: `ResolvedRelationRef` and the `properties:resolveRefs` channel (Task 7); `parseRelationUri` (Task 2).
- Produces: `<RelationEditor value={string[]} onChange={(next: string[]) => void} />` rendering one chip per URI.

Chips show a kind icon plus the **resolved** title — never a stored title. A ref with `exists: false` renders in a muted "deleted" style and stays in `value`. Use logical Tailwind classes only.

- [ ] **Step 1: Write the failing test**

```tsx
describe('RelationEditor', () => {
  it('renders one chip per resolved ref', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      }
    ])
    render(<RelationEditor value={['memry://note/nte_1']} onChange={vi.fn()} />)
    expect(await screen.findByText('Richard Doe')).toBeInTheDocument()
  })

  it('renders a deleted chip for a missing target and keeps the value', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_gone',
        targetType: 'note',
        targetId: 'nte_gone',
        title: '',
        exists: false
      }
    ])
    const onChange = vi.fn()
    render(<RelationEditor value={['memry://note/nte_gone']} onChange={onChange} />)
    expect(await screen.findByTestId('relation-chip-deleted')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes a chip through onChange without mutating the input array', async () => {
    mockResolveRefs([
      {
        uri: 'memry://note/nte_1',
        targetType: 'note',
        targetId: 'nte_1',
        title: 'Richard Doe',
        exists: true
      },
      {
        uri: 'memry://task/tsk_2',
        targetType: 'task',
        targetId: 'tsk_2',
        title: 'Call',
        exists: true
      }
    ])
    const value = ['memry://note/nte_1', 'memry://task/tsk_2']
    const onChange = vi.fn()
    render(<RelationEditor value={value} onChange={onChange} />)
    await userEvent.click(await screen.findByLabelText('Remove Richard Doe'))
    expect(onChange).toHaveBeenCalledWith(['memry://task/tsk_2'])
    expect(value).toEqual(['memry://note/nte_1', 'memry://task/tsk_2'])
  })

  it('renders nothing but stays mounted for an empty value', () => {
    render(<RelationEditor value={[]} onChange={vi.fn()} />)
    expect(screen.queryByTestId('relation-chip')).not.toBeInTheDocument()
  })
})
```

`mockResolveRefs` is a local helper stubbing the `window.api` call — follow the IPC-mocking pattern already used in `PropertyRow.test.tsx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- RelationEditor`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the editor**

Resolve on mount and whenever `value` changes; render chips from the resolved list; remove produces a new array via `filter`.

- [ ] **Step 4: Dispatch from PropertyRow**

Add the branch next to the `multiselect` one, mirroring its shape:

```tsx
if (property.type === 'relation') {
  const val = Array.isArray(property.value) ? (property.value as string[]) : []
  return <RelationEditor value={val} onChange={onValueChange} />
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- "RelationEditor|PropertyRow"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/info-section
git commit -m "feat(properties): render relation values as chips"
```

---

## Task 10: relation picker (write path)

**Files:**

- Create: `apps/desktop/src/renderer/src/components/note/info-section/editors/RelationPicker.tsx`
- Create: `apps/desktop/src/renderer/src/components/note/info-section/editors/RelationPicker.test.tsx`
- Modify: `RelationEditor.tsx` to mount the picker behind a "+" trigger

**Interfaces:**

- Consumes: existing note/task/event search — reuse the same channels the canvas add-card picker uses rather than adding new ones (find them with `rtk grep -rn "search" apps/desktop/src/main/ipc | rtk grep -i "note\|task\|event"`).
- Produces: `<RelationPicker onSelect={(uri: string) => void} />` inside a Radix Popover.

Embedded Popover (the tag-icon-chip / EmojiPicker-in-Popover pattern), **not** a body portal. jsdom does not open pickers on its own — use the project's existing picker mock pattern (see the `picker-jsdom-mock` convention already used in renderer tests). Results grouped: Notes & Files, Tasks, Events. Selecting appends a URI built with `formatRelationUri`.

- [ ] **Step 1: Write the failing test**

```tsx
describe('RelationPicker', () => {
  it('groups results by kind', async () => {
    mockSearch({
      notes: [{ id: 'nte_1', title: 'Richard Doe' }],
      tasks: [{ id: 'tsk_1', title: 'Call Richard' }],
      events: []
    })
    render(<RelationPicker onSelect={vi.fn()} />)
    await userEvent.type(screen.getByRole('textbox'), 'rich')
    expect(await screen.findByText('NOTES & FILES')).toBeInTheDocument()
    expect(await screen.findByText('TASKS')).toBeInTheDocument()
  })

  it('emits a well-formed URI on select', async () => {
    mockSearch({ notes: [{ id: 'nte_1', title: 'Richard Doe' }], tasks: [], events: [] })
    const onSelect = vi.fn()
    render(<RelationPicker onSelect={onSelect} />)
    await userEvent.type(screen.getByRole('textbox'), 'rich')
    await userEvent.click(await screen.findByText('Richard Doe'))
    expect(onSelect).toHaveBeenCalledWith('memry://note/nte_1')
  })

  it('does not add a duplicate URI', async () => {
    mockSearch({ notes: [{ id: 'nte_1', title: 'Richard Doe' }], tasks: [], events: [] })
    const onChange = vi.fn()
    render(<RelationEditor value={['memry://note/nte_1']} onChange={onChange} />)
    await userEvent.click(screen.getByLabelText('Add relation'))
    await userEvent.type(screen.getByRole('textbox'), 'rich')
    await userEvent.click(await screen.findByText('Richard Doe'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- RelationPicker`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the picker and wire the trigger**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- "RelationPicker|RelationEditor"`
Expected: PASS

- [ ] **Step 5: Verify in the running app**

Run: `pnpm dev`, add a Relation property to a note, link a note / a file / a task / an event, reopen the note, confirm the chips resolve and the raw frontmatter shows `memry://` URIs. Then delete one target and confirm the chip goes to the deleted state while the value survives a reopen.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/note/info-section
git commit -m "feat(properties): add relation picker"
```

---

## Task 11: relation chips in folder view (read-only)

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/folder-view/property-cell.tsx`
- Test: `apps/desktop/src/renderer/src/components/folder-view/property-cell.test.tsx`

**Interfaces:**

- Consumes: `properties:resolveRefs` (Task 7).
- Produces: nothing new.

Read-only in v1 — no picker, no removal. Batch-resolve per rendered page of rows rather than per cell; a folder with 200 rows must not issue 200 IPC calls.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders relation values as compact chips', async () => {
  mockResolveRefs([
    {
      uri: 'memry://note/nte_1',
      targetType: 'note',
      targetId: 'nte_1',
      title: 'Richard Doe',
      exists: true
    }
  ])
  render(<PropertyCell type="relation" value={['memry://note/nte_1']} />)
  expect(await screen.findByText('Richard Doe')).toBeInTheDocument()
})

it('does not offer editing affordances', async () => {
  mockResolveRefs([
    {
      uri: 'memry://note/nte_1',
      targetType: 'note',
      targetId: 'nte_1',
      title: 'Richard Doe',
      exists: true
    }
  ])
  render(<PropertyCell type="relation" value={['memry://note/nte_1']} />)
  expect(await screen.findByText('Richard Doe')).toBeInTheDocument()
  expect(screen.queryByLabelText('Add relation')).not.toBeInTheDocument()
})
```

Match the component's real props.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- property-cell`
Expected: FAIL — the cell renders the raw array.

- [ ] **Step 3: Add the branch**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- property-cell`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/folder-view
git commit -m "feat(properties): render relation chips in folder view"
```

---

## Task 12: reverse references in backlinks (Step 2)

**Files:**

- Modify: whichever query powers the backlinks panel — start from `getIncomingLinks` (`apps/desktop/src/main/database/queries/notes/link-queries.ts:32`) and follow its callers
- Modify: the backlinks panel component that consumes it
- Test: alongside each

**Interfaces:**

- Consumes: `getIncomingPropertyRefs` (Task 6).
- Produces: incoming entries carrying a discriminator so the UI can label property-sourced ones — extend the existing incoming-link shape with `via?: { kind: 'property'; propertyName: string }`; wiki-link entries leave it undefined.

Only `targetType === 'note'` refs belong in a note's backlinks. Task and event surfaces are Task 13.

- [ ] **Step 1: Write the failing test**

```ts
it('includes property relations in incoming links', () => {
  insertTestNote(db, 'nte_dad')
  insertTestNote(db, 'nte_john')
  setPropertyRefs(db, 'nte_john', { father: ['memry://note/nte_dad'] })

  const incoming = getIncomingReferences(db, 'nte_dad')
  expect(incoming).toContainEqual(
    expect.objectContaining({
      sourceNoteId: 'nte_john',
      via: { kind: 'property', propertyName: 'father' }
    })
  )
})

it('still includes wiki links', () => {
  insertTestNote(db, 'nte_dad')
  insertTestNote(db, 'nte_note')
  setNoteLinks(db, 'nte_note', [{ targetTitle: 'Dad', targetId: 'nte_dad' }])

  const incoming = getIncomingReferences(db, 'nte_dad')
  expect(incoming.some((r) => r.sourceNoteId === 'nte_note' && r.via === undefined)).toBe(true)
})

it('does not duplicate a source that links both ways', () => {
  insertTestNote(db, 'nte_dad')
  insertTestNote(db, 'nte_john')
  setNoteLinks(db, 'nte_john', [{ targetTitle: 'Dad', targetId: 'nte_dad' }])
  setPropertyRefs(db, 'nte_john', { father: ['memry://note/nte_dad'] })

  const incoming = getIncomingReferences(db, 'nte_dad')
  expect(incoming.filter((r) => r.sourceNoteId === 'nte_john')).toHaveLength(2)
})
```

The third test pins deliberate behavior: a wiki link and a property relation are two distinct references and both are shown, each labeled. If the panel should collapse them instead, change the test and the code together — do not leave it ambiguous.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- link-queries`
Expected: FAIL

- [ ] **Step 3: Implement the union**

- [ ] **Step 4: Label property relations in the panel**

Property-sourced rows read `<property name> → <source title>`; wiki-link rows keep their current rendering.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main -- link-queries` and `pnpm --filter @memry/desktop test:renderer -- backlinks`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/database/queries/notes apps/desktop/src/renderer/src
git commit -m "feat(properties): surface property relations in backlinks"
```

---

## Task 13: `relation` edges in the graph (Step 2)

**Files:**

- Modify: `apps/desktop/src/main/database/queries/graph.ts`
- Test: `apps/desktop/src/main/database/queries/graph.test.ts`

**Interfaces:**

- Consumes: `propertyRefs` (Task 5).
- Produces: `GraphEdge` entries with `type: 'relation'`. Check `GraphEdge` in `@memry/contracts` first — if `type` is a closed union, add `'relation'` there and handle the new case wherever edges are styled (`graph.ts:9` `NODE_COLORS` is the node analogue; find the edge equivalent in the renderer).

Note→note edges only in v1. Skip refs whose `targetType` is `task` or `event`, and skip note targets absent from `note_cache` — a dangling ref must not produce an edge to a non-existent node.

- [ ] **Step 1: Write the failing test**

```ts
it('emits a relation edge between two notes', () => {
  insertTestNote(db, 'nte_john')
  insertTestNote(db, 'nte_dad')
  setPropertyRefs(db, 'nte_john', { father: ['memry://note/nte_dad'] })

  const { edges } = getGraphData(dataDb, indexDb)
  expect(edges).toContainEqual(
    expect.objectContaining({ source: 'nte_john', target: 'nte_dad', type: 'relation' })
  )
})

it('skips task and event refs', () => {
  insertTestNote(db, 'nte_john')
  setPropertyRefs(db, 'nte_john', { attendees: ['memry://task/tsk_1', 'memry://event/evt_1'] })

  const { edges } = getGraphData(dataDb, indexDb)
  expect(edges.filter((e) => e.type === 'relation')).toHaveLength(0)
})

it('skips refs whose target note does not exist', () => {
  insertTestNote(db, 'nte_john')
  setPropertyRefs(db, 'nte_john', { father: ['memry://note/nte_gone'] })

  const { edges } = getGraphData(dataDb, indexDb)
  expect(edges.filter((e) => e.type === 'relation')).toHaveLength(0)
})
```

Match `getGraphData`'s real signature and return shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- graph`
Expected: FAIL

- [ ] **Step 3: Implement the edges**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- graph`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/database/queries/graph.ts apps/desktop/src/main/database/queries/graph.test.ts
git commit -m "feat(graph): add relation edges from property refs"
```

---

## Task 14: compatibility verification and full gate

**Files:** none modified unless a defect is found.

**Interfaces:** none.

This is the release gate from the spec's compat section. The old-client check cannot be skipped or assumed — it is the one claim in this design that current-branch tests cannot prove.

- [ ] **Step 1: Old-client render check**

Install a currently-released build alongside the dev build, pointed at a vault containing a note with a relation property. Confirm the released build (a) opens the note without throwing, (b) shows the value as raw text/JSON rather than crashing, and (c) after editing an unrelated property and syncing, leaves the relation value byte-identical.

Record the release version tested in the commit body. If the value is altered or the app throws, **stop** — that is a data-loss finding and the design needs revisiting before merge.

- [ ] **Step 2: Two-device round trip**

With two dev profiles (`pnpm --filter @memry/desktop dev:a` and `dev:b`), create a relation property on A, sync, and confirm B renders resolved chips — proving inference plus `ensurePropertyDefinition` materialize the type without any definition sync.

- [ ] **Step 3: Index rebuild check**

Delete the index DB and let it rebuild. Confirm `property_refs` repopulates and backlinks/graph return, proving the table is genuinely rebuildable.

- [ ] **Step 4: Full verification suite**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check:architecture
pnpm check:contracts
pnpm ipc:check
git diff --check
```

Expected: all PASS.

- [ ] **Step 5: Docs gate**

```bash
pnpm docs:impact --base origin/main --strict
```

If it reports `missing-docs`, update `apps/docs/src/**` (a new property type is user-facing and almost certainly needs a docs entry) or run `pnpm docs:ai-update --base origin/main`, then re-run `docs:impact` and `pnpm docs:build`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(properties): document the relation property type"
```

---

## Self-Review Notes

**Spec coverage.** Step 1: value format → Tasks 2/3/4; contracts → Task 1; `property_refs` → Tasks 5/6; resolveRefs → Task 7; add-property → Task 8; chips → Task 9; picker → Task 10; dangling refs → Tasks 9/13; folder view → Task 11. Step 2: backlinks → Task 12; graph → Task 13. Sync/compat → Task 14. Task/event incoming surfaces are named in the spec's step 2 but deferred here — they need the same union as Task 12 applied to two more views, and are cleaner as a follow-up once Task 12 fixes the shape.

**Not in this plan.** Step 3 (dot-path) is a separate plan depending only on the URI format from Task 2. Step 4 (rollups, views) is gated on definition sync.

**Known soft spots.** Tasks 8, 10, 11, 12 and 13 require reading the target component or query before editing — their exact prop and return shapes were not read while planning, so each says so explicitly rather than inventing a signature. The icon name in Task 1 is the one guess in the plan and is flagged inline.
