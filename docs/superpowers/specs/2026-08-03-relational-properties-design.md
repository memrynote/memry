# Relational Properties — Design

**Date:** 2026-08-03
**Status:** Draft — pending review
**Supersedes:** `2026-07-22-relation-properties-design.md` (commit `346dcf2be`, branch `claude/session-8eea32`, never merged to main). That draft framed the full relational model as _rejected_; this one reframes it as _gated_, and names the gate.

## Origin

In-app beta feedback, 2026-07-22, v2026-07-19.2 · MacIntel:

> I wish I could link to other Notes (maybe even Files, Tasks, Events, etc.) inside of Properties. Also I would like to be able to refer to Properties with something like "note_name.property". Even better would be something like "note_name.property.property", if note_name.property links to another note. Example (notes about people): john_doe.father.email would give me his fathers email address (whom I of course would have to have another note about).
> Is this asking too much? I always wanted Obsidian-like-Apps to not only be notes apps, but also fully relational Databases...

Reply sent 2026-07-23 committed to shipping property linking, and called the query aspect interesting.

The closing sentence is the actual request. The ask is not "a link field" — it is **the notes app behaving as a relational database**. This spec targets that end state and sequences it by architectural risk rather than by feature size.

## Product goal

Four steps, in dependency order:

| Step                         | What the user gets                                                         | Protocol cost                |
| ---------------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| **1. Relation property**     | A property whose value is a live reference to a Note, File, Task, or Event | None                         |
| **2. Reverse references**    | "Referenced by" on the target + relation edges in the graph                | None                         |
| **3. Dot-path references**   | `{{john_doe.father.email}}` resolved inline, read-only                     | None                         |
| **4. Rollups + query views** | Aggregate over related notes; saved filtered table/board views             | **Requires definition sync** |

Steps 1–3 are fully specified here and implementable today. Step 4 is specified to the point of its blocker and deliberately not designed further until that blocker is resolved.

### The gate on step 4

Property _definitions_ are not synced. The durable source is `.memry/properties.md` frontmatter (`apps/desktop/src/main/vault/property-definitions.ts:19,50`), cached into a `property_definitions` table (`packages/db-schema/src/schema/notes-cache.ts:110`) — note that this table is materialized in **both** databases (index migrations `0000_previous_toxin.sql` / `0019_bitter_zarda.sql`, data migration `0022_notes_journal_vault.sql`), and `PropertyDefinitionsService` writes both. Across devices only property _names_ travel, in `note_metadata.propertyDefinitionNames` (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:417`); the receiving device re-derives the type with `inferPropertyType`.

This is survivable for steps 1–3 because a relation value is self-describing: an array of `memry://…` URIs infers back to `relation` with no definition needed. It is fatal for step 4 because a rollup definition ("over relation `attendees`, take property `email`, function `list`") cannot be inferred from any value — the value _is_ the computed output. Same for a saved view's filter config. On a second device those properties would degrade to text.

So step 4 is blocked on a definition/config sync mechanism — the same missing piece that blocks custom template sync, and the same one that `X-Memry-Sync-Types` negotiation (#754) exists to unblock. Building step 4 before that lands would ship a feature that silently breaks on every user's second device.

## Non-goals

- Bidirectional relation **editing** (adding the relation from the target's side). Step 2 delivers the read direction. Writing from the target means writing the source note's properties, which are whole-record LWW with no field clocks — a concurrent-edit clobber vector for an ergonomic gain.
- Field-level vector clocks for note properties.
- Inbox items as relation targets (transient; filed items become notes anyway).
- External (read-only ICS/provider) calendar events as targets — native Memry events only.
- Rename-fix for title-based body `[[wikilinks]]` (independent; unchanged here).
- Storing a display-title cache next to the ID in frontmatter. Titles resolve live; a cache is addable later without a format break.

---

## Step 1 — `relation` property type

### Value format

A relation value is **always an array** of entity URI strings:

```yaml
properties:
  father:
    - 'memry://note/nte_abc123'
  attendees:
    - 'memry://task/tsk_def456'
    - 'memry://event/evt_ghi789'
```

- Scheme: `memry://<kind>/<id>`, `kind ∈ {note, task, event}`.
- `note` covers markdown notes, journals, **and files** — files are already note rows discriminated by `fileType`, so file linking costs nothing extra.
- Single-value is the array of length 1. No separate scalar form; one shape to parse everywhere.

**Values are IDs, never titles.** Renaming a target writes nothing to referencing notes; display text resolves live from the index. Title-based values were rejected: today's rename is a pure filesystem rename that touches no referencing note (`apps/desktop/src/main/vault/notes-rename.ts`), so title values would need a fan-out rewrite across N notes, and under whole-record LWW on note properties that fan-out is a cross-device data-loss vector. Titles are also not unique.

### Contracts

- Add `RELATION: 'relation'` to `PropertyTypes` (`packages/contracts/src/property-types.ts:3`, currently 8 types).
- **`PropertyDefinitionSchema` is not touched.** That discriminated union covers only the four types carrying extra config — status, select, multiselect, date (`property-types.ts:98`); `text`, `number`, `checkbox`, and `url` have no member. `relation` carries no config either, so it follows them. **No target-kind restriction field**: such a field would be a definition-only fact, unsyncable per the gate above, so the picker offers all kinds and the value carries its own kind. This also means `.memry/properties.md` never needs a format change for step 1.
- Mirror in the renderer registry: `PropertyType` union and `PROPERTY_TYPE_CONFIG` (`apps/desktop/src/renderer/src/components/note/info-section/types.ts:13,49`).
- `properties:set` already carries `z.record(z.string(), z.unknown())` — no change. New IPC channels below go through `packages/contracts` + `pnpm ipc:generate`.

### Two existing landmines this must clear

Both are verified in current code and both silently degrade arrays:

1. **`inferPropertyType` collapses every array to text.** `apps/desktop/src/main/vault/frontmatter.ts:401` — `if (Array.isArray(value)) return 'text'`, commented "arrays no longer supported". The relation check must come _before_ this branch: an array whose entries all match `memry://(note|task|event)/<id>` infers `relation`. An empty array stays `text` (nothing to infer from). A mixed array (some URIs, some not) stays `text` — never partially interpret.

2. **`deserializeValue` has no relation case.** `apps/desktop/src/main/database/queries/notes/query-helpers.ts:40` switches on type; `multiselect` (:50) parses JSON back to an array, everything else falls through to returning the raw string. Without a `relation` case the renderer receives a JSON string, and `PropertyRow.tsx:219`-style `Array.isArray(value)` guards render it as empty. Add `relation` alongside `multiselect` (same parse, same non-array fallback).

Storage itself needs no change: `serializeValue` (`query-helpers.ts:27`) JSON-encodes arrays into `note_properties.value` (`packages/db-schema/src/schema/notes-cache.ts:96`), which already documents itself as JSON-encoded for arrays.

### Index: `property_refs`

New table in `packages/db-schema/src/schema/notes-cache.ts`, modeled on `canvas_entity_refs` (`packages/db-schema/src/schema/canvas.ts:72`):

```
property_refs (
  sourceNoteId  TEXT NOT NULL,   -- FK note_cache, ON DELETE CASCADE
  propertyName  TEXT NOT NULL,
  targetType    TEXT NOT NULL,   -- 'note' | 'task' | 'event'
  targetId      TEXT NOT NULL,
  PRIMARY KEY (sourceNoteId, propertyName, targetType, targetId)
)
-- index on (targetType, targetId) for reverse lookup
```

- **Index DB only, never synced, rebuildable** — same class as `note_links` (`notes-cache.ts:70`). Migration goes in `apps/desktop/src/main/database/drizzle-index/` (latest is `0019_bitter_zarda.sql`). Index-DB migrations are compat-safe by construction.
- Populated wherever `setNoteProperties` runs (`property-queries.ts:25`) — indexer/projector path and the sync pull path in `note-handler.ts`. Rows for a note are replaced wholesale, matching that function's existing delete-then-insert shape. Note deletion cascades.

### Resolution IPC

`properties:resolveRefs(uris: string[]) → Array<{ uri, targetType, targetId, title, subtitle?, exists, fileType? }>`

Batch endpoint in main. It **spans both databases**: note targets come from `note_cache` (index DB), task targets from `tasks` and event targets from `calendar_events` (both data DB — `packages/db-schema/src/data-schema.ts:13,20`). External provider events (`calendar_external_events`) are deliberately not resolved, per non-goals. The handler therefore takes both db handles; it must not assume a single connection.

Renderer resolves once per note view and re-resolves on the change events the backlinks panel already listens to. Unknown or invalid URIs come back `exists: false` rather than throwing.

### UI

**Add property** — `AddPropertyPopup.tsx` gains a "Relation" entry with a link-style icon distinct from `url`.

**Property row** — `PropertyRow.tsx` renders relation values as chips: entity-kind icon + live-resolved title + remove affordance.

```
John Doe
────────────────────────────────────────
 Status      ● Active
 Email       john@doe.com
 Father      🔗 Richard Doe  ×
 Company     🔗 Acme Inc.  ×          +
 Contract    🔗 📄 contract.pdf  ×
 + Add property
```

**RelationPicker** — Radix Popover, embedded (follow the tag-icon-chip / EmojiPicker-in-Popover pattern, not a body portal). Single search box, results grouped by kind: Notes & Files (notes FTS), Tasks (tasks FTS), Events (calendar query). Selecting appends a URI.

```
┌ Link to…  ────────────────────┐
│ 🔍 rich                       │
│ NOTES & FILES                 │
│   📄 Richard Doe              │
│   📕 richard-cv.pdf           │
│ TASKS                         │
│   ☐ Call Richard              │
│ EVENTS                        │
│   📅 Lunch w/ Richard · 12 Aug│
└───────────────────────────────┘
```

**Chip click navigates** — note/file to a tab (existing file-vs-note routing), task to task view, event to calendar focused on that event.

**Dangling refs** — when a target is gone, the chip renders in a "deleted" state and **the value is kept**. Auto-scrubbing would write the note and race sync.

**Folder view** — `components/folder-view/property-cell.tsx` renders relation values as compact chips, read-only in v1.

**RTL** — all new markup uses logical Tailwind classes (`ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`) per project rules.

---

## Step 2 — reverse references

No new storage: `property_refs` is already indexed on `(targetType, targetId)`.

- **Backlinks panel** unions `note_links` with `property_refs WHERE targetType='note' AND targetId=?`, labeling each property-sourced entry with its property name:

  ```
  Referenced by
     Father → John Doe
     Father → Jane Doe
  ```

- **Task and event views** get the same incoming list, which is the first time either surface can answer "which notes point at me".
- **Graph** (`apps/desktop/src/main/database/queries/graph.ts`) gains a `relation` edge type from `property_refs`. Note→note edges only in v1; task/event nodes are a follow-up since events are not graph nodes today.

---

## Step 3 — dot-path references

Read-time computed references. `john_doe.father.email` resolves note "john_doe" → relation property `father` → target note → property `email`.

### Editor surface

New BlockNote inline content `propertyRef` with props `{ path: string }`, inserted from the `@`-mention menu as a new item kind alongside `note | date | remind` (`apps/desktop/src/renderer/src/components/note/content-area/mention-menu.tsx`), with segment-by-segment autocomplete — first segment from note titles, later segments from the resolved note's property names.

```
typing:    @john_doe.father.email
markdown:  {{john_doe.father.email}}
rendered:  richard@doe.com          (computed styling, tooltip = full path)
```

Markdown serialization is the literal `{{path}}`. It round-trips as plain text in Obsidian and re-hydrates on load. Journals reuse the same inline through their extension set.

### Resolver (main)

`properties:resolvePath(path) → { status: 'ok', value, valueType } | { status: 'unresolved', failedSegment }`

1. First segment → `resolveNoteByTitle` (existing exact/case-insensitive lookup in link-queries).
2. Middle segments → must be a `relation` property containing at least one `memry://note/` URI; hop to the **first** note target. Note relations only — task/event targets are terminal display, not traversable.
3. Final segment → any property on the resolved note, returned with its type for formatting. A relation-typed final value displays as comma-joined resolved titles.
4. Any failure → `unresolved` with the failing segment; the editor renders the literal `{{path}}` in a subtle warning style.

Batch-resolved per open document, re-resolved on note change events. **Nothing is persisted** — display-only, so staleness can never corrupt data.

### Accepted limitations

- The **first hop is title-based** and therefore rename-fragile, exactly like body wikilinks today. Hops 2+ are ID-based and rename-proof. If a wikilink rename-fix ever lands, first hops ride it.
- Multi-value hops take the first target (deterministic: array order).
- Property names containing dots are unsupported.

---

## Step 4 — rollups and query views (gated)

Target behavior: a `rollup` property type (source relation + target property + function: count/sum/list/latest), and saved filtered views over notes rendered with the existing folder-view column machinery.

**Blocked on definition/config sync**, per the gate section above. Both a rollup's formula and a view's filter are definition-side facts that no value can imply, so on a second device they degrade to text.

When that mechanism exists, this step is comparatively cheap: rollups compute at read time from `property_refs` + `note_properties`, and views extend an existing table/board surface rather than introducing one. Nothing in steps 1–3 needs to change to enable it — which is the point of specifying it now.

---

## Sync and compatibility (mandatory)

- **No sync-protocol change in steps 1–3.** Relation values ride the existing note/journal payload `properties` field (`packages/contracts/src/sync-payloads.ts:154,170` — `z.record(z.string(), z.unknown())`), which is schema-valid for every released client. No new `SyncItemType`, frozen legacy list untouched, no server-before-desktop ordering.
- **Data DB:** no schema change. `propertyDefinitionNames` continues to carry names only.
- **Index DB:** one additive, rebuildable table.
- **New client → old client. Lossless only while that device never pushes the note at all.** Established by inspecting the shipped release `v2026-07-19.2`:
  - _Pull_ assigns the value verbatim into frontmatter (`sync/item-handlers/note-handler.ts`, `parsed.frontmatter.properties = remoteProperties`) and indexes it. The old build's `inferPropertyType` yields `text` for the array, so `deserializeValue(..., 'text')` stores it as a raw JSON string. The vault file is fine; **the index DB is already wrong at this point.**
  - _Push does not re-read properties from the file._ Both push builders — `sync/note-sync.ts:95` and `sync/item-handlers/note-handler-sync-helpers.ts:63` — build the payload with `propsToRecord(getNoteProperties(indexDb, ...))`. Only `content` and `tags` are re-read from disk. So **any** push of that note ships the flattened string: a body edit, a tag change, a rename, a dirty-recovery reseed. It does not take a property edit, and the user gets no signal.
    (Do not confuse `apps/desktop/src/main/vault/note-sync.ts`, which does call `extractProperties(frontmatter)` — that is the _indexing_ path, not a push builder. Same basename, opposite direction. Neither push builder is touched by this branch, so this is released behaviour.)
  - _Editing a property on that device_ is the fastest route, not the only one: `use-properties.ts` rebuilds the entire record from index-DB values, so the flattened string is also written back to YAML. The relation is then gone from the vault file too: quoted string, no `property_refs`, no graph edge, no backlink.
  - **This is a pre-existing class, not a new failure mode.** Property definitions never sync — `.memry/properties.md` is not referenced anywhere in the sync code — so a `multiselect` array created on one device already flattens the same way on another. Relation is the second instance, not the first.
  - _Verification item before release:_ the risk is **writing**, not rendering. Rendering an array in an old build is the cheap half and `multiselect` already proves the path exists. What must be checked against a real released build is what that build **pushes** for a note carrying a relation value — and the trigger to test is any ordinary edit, not a property edit: rename the note, change a tag, edit the body.
  - The same gap exists on the **originating** device, and is not a cross-version problem at all: the first value written for a UI-created relation is `[]`, which no inference can recognise. See "Type inference on the empty default" below.

- **Type inference on the empty default.** `getDefaultValueForType('relation')` is `[]` and no type crosses the `properties:set` boundary, so the first thing main indexes for a new relation is an empty array — and `isRelationValue([])` is false by construction. Inference alone therefore cannot type a relation on the device that created it, and neither definition writer (`getPropertyType`'s `ensurePropertyDefinition`, `vault/note-sync.ts`'s `saveCanonicalPropertyDefinition`) ever corrects an existing row, so that first `text` verdict would stick forever.
  Both of `setNoteProperties`' production callers therefore apply the same structural override — an array of `memry://` URIs is a relation whatever the stored definition says:
  - `getPropertyType` (`property-queries.ts`) for the note projector: local edits, externally-authored notes, re-indexing, sync creates.
  - `resolveSyncPropertyType` (`sync/item-handlers/note-property-type.ts`) for `noteHandler.applyUpsert`: sync updates. This one is not optional cleanup — the file that handler writes is passed to `markWritebackIgnored`, which the watcher honours, so the projector never revisits it. Left unfixed, a device whose definition was pinned to `text` would re-flatten every incoming update and, per the push-builder note above, re-broadcast the damage.
    Both are read-time only and neither persists `relation` into a definition store: the index-DB definitions table is a derived cache of `.memry/properties.md`, and `PropertyDefinitionSchema` has no `relation` member, so persisting one would make the whole file fail to parse and drop every definition in it.
- **New client → new client.** The receiving device infers `relation` and auto-creates the definition via `ensurePropertyDefinition` (`property-queries.ts:168`), which writes the index-DB copy that drives rendering — it does not write `.memry/properties.md`. That is sufficient here precisely because the value is self-describing, and is a second illustration of why definition-side facts (step 4) need a real sync mechanism.
- **Vault portability.** Raw frontmatter shows `memry://` URIs. Accepted: relation properties are Memry-native. Obsidian shows inert strings, and byte-preservation rules already guarantee unedited frontmatter round-trips untouched.

## Testing

**Main / unit**

- `inferPropertyType`: relation detection; empty array → text; mixed array → text; malformed URI → text; ordering versus the existing array→text branch.
- `deserializeValue`: relation JSON → array; non-array JSON → fallback; malformed → fallback.
- URI parse/validate helper.
- `property_refs`: populate, wholesale replace, cascade on note delete, reverse lookup by target.
- `resolveRefs`: batch across all three entity tables; missing target → `exists: false`.
- `resolvePath`: happy path; failure at each segment position; multi-value hop; relation-typed terminal value.

**Sync**

- Pull writes relation values → frontmatter + `note_properties` + `property_refs`.
- Push round-trips values byte-identical.
- Simulated old-client payload (relation values, no definition) infers safely.

**Renderer**

- AddPropertyPopup lists Relation.
- PropertyRow chip render / resolved / dangling states.
- RelationPicker keyboard flow (jsdom picker mocks per existing pattern).
- `propertyRef` inline serialize/parse round-trip.
- Folder-view relation cell.

## Sequencing

1. **Steps 1 + 2 as one PR series** — they share `property_refs` and step 2 is nearly free once it exists.
2. **Step 3** as a separate series, depending only on step 1's URI format.
3. **Definition/config sync** — shared infrastructure with template sync and `X-Memry-Sync-Types` (#754).
4. **Step 4** after 3.

If top-level properties (`docs/obs/05-properties-top-level.md`) is implemented in the same cycle, land it first — it touches the same `frontmatter.ts` and `note-handler.ts` paths. This design is agnostic to it: relation values are ordinary property values and move with whatever emit/extract rules land.

## Rejected alternatives

- **Title-based relation values** (`"[[Title]]"` in YAML) — rename fan-out across N referencing notes, clobbering under whole-record LWW, dangling titles after offline renames, non-unique titles.
- **A synced edge table as a new `SyncItemType`** — needs sync-type negotiation, server-before-desktop deploy, and a per-edge conflict mechanism notes do not have. `property_refs` is the promotion path if this is ever wanted.
- **Target-kind restriction on the definition** (e.g. "this property only accepts Tasks") — a definition-only fact, unsyncable today, so it would apply on one device and not another.
- **Shipping rollups now with local-only definitions** — works on the authoring device, silently degrades everywhere else. This is what the gate exists to prevent.
