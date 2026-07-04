# Top-Level Properties — Design

**Date:** 2026-07-05
**Branch:** `obs-properties-top-level`
**Status:** Approved, pending implementation

## Goal

Every custom property is a top-level frontmatter key, written in exactly the
style Obsidian itself emits (P1.6, decision locked). Result: Obsidian's
Properties UI can edit every Memry property, and an Obsidian property-edit of
a Memry-written file produces **no formatting diff**. The nested
`properties:` object disappears from new writes; legacy files flatten on
their next property edit.

## Current behavior

- `apps/desktop/src/main/vault/notes-crud.ts:233-237` — `createNote` nests
  the merged property record under `frontmatter.properties`.
- `apps/desktop/src/main/vault/notes-crud.ts:518-533` — `updateNote` rebuilds
  frontmatter and re-nests `newFrontmatter.properties` (or deletes the key
  when empty), then `serializeNote` re-stringifies the whole file.
- `apps/desktop/src/main/vault/frontmatter.ts:140-152` — `serializeNote` uses
  `matter.stringify` (gray-matter 4.0.3 → bundled js-yaml **3.15.0**):
  single-quote quoting, `lineWidth` 80 folding, no control over Obsidian's
  conventions.
- `apps/desktop/src/main/vault/frontmatter.ts:326-360` —
  `RESERVED_FRONTMATTER_KEYS` = `id,title,created,modified,tags,aliases,emoji,localOnly`;
  `extractProperties` prefers the nested `properties` object and only falls
  back to top-level non-reserved keys. Nested-wins means a nested block
  **shadows** top-level keys today.
- `apps/desktop/src/main/vault/frontmatter.ts:396-427` — `inferPropertyType`
  maps arrays to `'text'` (JSON-encoded), so Obsidian list properties don't
  survive as lists.
- Property-edit IPC path: `use-property-section.ts` → `use-properties.ts`
  (`propertiesService.set`) → `properties:set` in
  `apps/desktop/src/main/ipc/properties-handlers.ts:61-88` → `updateNote({ id,
properties })` (notes) or `writeJournalEntryWithContent` (journals, via
  `updateJournalProperties`, same file :164-200).
- Index/sync: `apps/desktop/src/main/vault/note-sync.ts:135-205` —
  `extractNoteMetadata` calls `extractProperties`; the record lands in the
  canonical DB (`saveCanonicalNote` + per-key `saveCanonicalPropertyDefinition`
  with `inferPropertyType`) and the `MarkdownNoteProjection`. Sync payloads
  carry the plain record (`note-handler.ts:422-448`); on pull, `applyUpsert`
  writes it back **nested** (`note-handler.ts:241-245, 291-295`).
- Journal duplicate: `apps/desktop/src/main/vault/journal.ts:187-221` has its
  own reserved-keys set + nested-first `extractJournalProperties`. CLI
  duplicate: `packages/app-core/src/markdown.ts`.

## Design

### 1. Write format — Obsidian emit style

Target style (README research, help.obsidian.md + forum 65851/69048/66297):
block lists with 2-space-indented `- `, dates `YYYY-MM-DD`, datetimes
`YYYY-MM-DDTHH:MM:SS`, booleans `true|false`, double quotes **only** where
syntactically required (always around values containing `[[...]]`), key order
preserved, new keys appended last, never comments/flow style/anchors, empty
values emit `key:` with nothing after.

**js-yaml 4 can match this** — with the right options. gray-matter's bundled
js-yaml 3 cannot (single-quote style, no `quotingType`). Add `js-yaml@^4` as a
direct dependency of `@memry/desktop` and stop using `matter.stringify`
(gray-matter stays for **parsing** only). New emitter:

```ts
// apps/desktop/src/main/vault/frontmatter-emit.ts
import { dump, CORE_SCHEMA } from 'js-yaml'

const DUMP_OPTIONS = {
  schema: CORE_SCHEMA, // no YAML 1.1 timestamp resolver — else js-yaml
  //                      quotes the string '2026-07-05' to keep it a string
  indent: 2,
  noArrayIndent: false, // lists indent 2 under the key: `tags:\n  - a`
  flowLevel: -1, //        block style everywhere, never `[a, b]`
  quotingType: '"' as const, // Obsidian quotes with double quotes
  forceQuotes: false, //   ...and only when syntactically required
  lineWidth: -1, //        DEFAULT IS 80 — folds long scalars into multi-line
  //                       plain style => ghost diffs on every long value
  noRefs: true, //         never emit anchors/aliases
  noCompatMode: true, //   don't quote YAML 1.1-isms (`yes`, `on`)
  styles: { '!!null': 'empty' } // empty property => `key:` like Obsidian
}

export function emitFrontmatterBlock(entries: Array<[string, unknown]>): string {
  const body = entries.map(([key, value]) => dump({ [key]: value }, DUMP_OPTIONS)).join('')
  return `---\n${body}---\n`
}
```

Dumping **one key per `dump` call** and concatenating sidesteps JS object
integer-key hoisting (a property named `2024` would otherwise jump to the
front) — key order is exactly the `entries` order: original on-disk order,
new keys appended last (mirrors `processFrontMatter`).

Why each option is load-bearing: `CORE_SCHEMA` keeps date strings plain while
still quoting `"true"`/`"123"` strings (bool/int resolvers exist in core);
`quotingType '"'` + `forceQuotes false` gives `related: "[[Plan]]"` but
`status: In Progress`; `lineWidth: -1` is the one silent killer — the default
80 re-wraps long text values. Values are emitted verbatim (never reformatted);
when Memry itself sets a date/datetime value it normalizes to `YYYY-MM-DD` /
`YYYY-MM-DDTHH:MM:SS` (no millis, no `Z`) before writing.

### 2. Reserved keys (after spec 01)

With `id`/`title`/`created`/`modified`/`emoji`/`localOnly` gone
(01-frontmatter-diet), **Memry claims no keys**. `RESERVED_FRONTMATTER_KEYS`
shrinks to `tags` and `aliases` — Obsidian-shared semantics routed to the
first-class tag/alias systems (list format, no `#` prefix), excluded from the
generic property record. `cssclasses` passes through untouched as a normal
property. Same set replaces the journal copy (`journal.ts:187-198`).

### 3. When frontmatter is rewritten

Only the edited note's frontmatter is re-emitted, and only when a property
value/name/order actually changed. The mechanism (raw-block capture, verbatim
re-emit of untouched blocks, no-op detection) is owned by
[04-byte-preservation.md](04-byte-preservation.md); this spec only defines the
bytes produced when a rewrite is warranted. Body edits never touch
frontmatter (Obsidian parity).

### 4. Type handling

| YAML value            | Obsidian type | Memry `PropertyType`                  |
| --------------------- | ------------- | ------------------------------------- |
| plain/quoted string   | text          | `text` (also `url`/`status`/`select`) |
| block list of strings | list          | `multiselect`                         |
| number                | number        | `number`                              |
| `true` / `false`      | checkbox      | `checkbox`                            |
| `YYYY-MM-DD`          | date          | `date`                                |
| `YYYY-MM-DDTHH:MM:SS` | datetime      | `date` (full string preserved)        |

Change `inferPropertyType` (frontmatter.ts:396-427): `Array.isArray(value)` →
`PropertyTypes.MULTISELECT` (today `'text'`), so Obsidian list properties
round-trip as YAML block lists instead of JSON strings. DB storage is
unchanged — `serializePropertyValue`/`deserializePropertyValue` already
JSON-encode arrays. Reading `.obsidian/types.json` to seed per-key types is
[08-obsidian-settings-readonly.md](08-obsidian-settings-readonly.md)'s job;
this spec only infers from values.

### 5. Legacy nested `properties:` blocks

Pre-production: **no bulk migration, no scan-time rewrite.** Flatten happens
on the next property edit of that note:

- Read side (`extractProperties`, journal + app-core copies): invert
  precedence — top-level non-reserved keys are primary; a mapping-valued
  `properties` key is merged in as legacy. **Collision rule: top-level wins**
  — it is the value Obsidian users see and edit; the nested copy was invisible
  to Obsidian. A non-mapping `properties` value is just a normal property.
- Write side (`updateNote` / journal write): emit the merged record as
  top-level keys and drop the `properties` key entirely. Key order: original
  top-level order first, then legacy nested keys in their original order,
  then newly added keys.

Sync pull (`note-handler.ts:241-245, 291-295`) writes remote records through
the same top-level emit helper — pulled files come out flattened too.

## Implementation plan

1. `apps/desktop/package.json`: add `js-yaml@^4` + dev `@types/js-yaml`.
2. **Tests first** — `apps/desktop/src/main/vault/frontmatter-emit.test.ts`:
   literal-string fixtures (section Verification) for the emitter.
3. Add `frontmatter-emit.ts` with `DUMP_OPTIONS` + `emitFrontmatterBlock`
   (per-key dump, concat) as above; make tests green.
4. `frontmatter.ts`: shrink `RESERVED_FRONTMATTER_KEYS` to
   `['tags', 'aliases']` (coordinate with spec 01's serializeNote rewrite);
   invert `extractProperties` precedence + legacy merge; `inferPropertyType`
   array → `MULTISELECT`. Update `frontmatter.test.ts`.
5. `notes-crud.ts`: `createNote` (233-237) spreads properties top-level;
   `updateNote` (518-533) builds ordered entries (existing order → legacy
   nested → new keys), drops `properties` nesting, routes through the emitter.
6. `journal.ts`: same reserved-keys + precedence change in
   `extractJournalProperties`; `writeJournalEntryWithContent` emits top-level.
7. `sync/item-handlers/note-handler.ts` (241-245, 291-295): replace
   `parsed.frontmatter.properties = remoteProperties` with the top-level
   helper; delete the legacy key.
8. `packages/app-core/src/markdown.ts`: align the CLI parse/write duplicates.
9. Run gates; add a flatten-on-edit integration test in
   `notes-crud`/`properties-handlers` tests.

## Verification

`pnpm typecheck`, `pnpm lint`, `pnpm test:desktop`, `pnpm ipc:check` (no
contract change expected), docs gate per CLAUDE.md.

Emit-style fixtures compare against **literal expected YAML strings**, e.g.:

```ts
expect(
  emitFrontmatterBlock([
    ['status', 'In Progress'],
    ['tags', ['project', 'q3/planning']],
    ['due', '2026-07-05'],
    ['reviewed', false],
    ['related', '[[Quarterly Plan]]'],
    ['priority', 3],
    ['notes', null]
  ])
).toBe(
  '---\n' +
    'status: In Progress\n' +
    'tags:\n' +
    '  - project\n' +
    '  - q3/planning\n' +
    'due: 2026-07-05\n' +
    'reviewed: false\n' +
    'related: "[[Quarterly Plan]]"\n' +
    'priority: 3\n' +
    'notes:\n' +
    '---\n'
)
```

Plus: numeric-looking string stays quoted (`code: "007"`), long string not
folded (lineWidth), key named `2024` keeps its position, round-trip
`extractProperties(parse(emit(x))) == x`, legacy nested+top-level collision
resolves top-level-wins, golden Obsidian-edited file (from spec 04's corpus)
re-emits byte-identical.

## Interactions

- [01-frontmatter-diet.md](01-frontmatter-diet.md) — removes Memry-claimed
  keys; this spec assumes it landed (reserved set = `tags`/`aliases`). Both
  touch `serializeNote`; land 01 first.
- [04-byte-preservation.md](04-byte-preservation.md) — owns _when_ to rewrite
  and key-order capture from the raw frontmatter block; this spec owns the
  bytes emitted.
- [08-obsidian-settings-readonly.md](08-obsidian-settings-readonly.md) —
  `.obsidian/types.json` as a read-only type source overriding inference.

## Open questions

- `noCompatMode: true` assumes Obsidian leaves `yes`/`on` unquoted — verify
  against a live Obsidian 1.9 fixture before freezing `DUMP_OPTIONS`.
- Multiline text values: js-yaml emits block literal (`|-`); Obsidian's
  Properties UI doesn't produce multiline text, so this should be unreachable
  from Memry writes — confirm and, if needed, escape to a quoted scalar.
- Should `status`/`select` values with option metadata (colors) ever hint
  their type into `.obsidian/types.json`? Out of scope here (we never write
  into `.obsidian/`), noted for spec 08's read-only counterpart.
