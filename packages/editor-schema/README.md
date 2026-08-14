# @memry/editor-schema

**A node spec that exists on one side only is a data-loss bug, not a rendering gap.**

The renderer and the main process build their BlockNote schema from this one
package. That symmetry is not cosmetic: main converts the shared Y.Doc through
y-prosemirror, whose answer to a node name its schema cannot build is to
**delete the element from the doc** — and that delete replicates to every
device. The same is true of an implementation that diverges: BlockNote
serializes inline content inside a table through `render`, so a server `render`
that is rich rewrites the vault file, and one that throws makes `yDocToMarkdown`
return `null` so the note stops writing back at all.

## Layout

| Path                                        | What lives there                                                |
| ------------------------------------------- | --------------------------------------------------------------- |
| `src/schema.ts`                             | `createMemrySchema` — the one place a Memry schema is assembled |
| `src/inline/`                               | inline node configs, their on-disk form, and the portable specs |
| `src/blocks/configs`                        | block configs: type + propSchema + content, no presentation     |
| `src/blocks/markdown`                       | the bytes each custom block reaches the vault file as           |
| `src/blocks/server-specs` / `src/server.ts` | main's headless half — Node + jsdom, no React                   |

Presentation stays with each process (main has no React). Everything that
decides what reaches disk is shared.

## The canonical form of a wiki link

**In the CRDT it is a `wikiLink` NODE. On disk it is `[[target]]` TEXT.**

The two ends reach that agreement from opposite directions, which is why it has
to be stated rather than inferred:

- **Main never parses `[[X]]`.** `WikiLinkSerializationOnly` carries no `parse`
  rule, so the parser that seeds a note's shared Y.Doc from its vault file
  (`crdt-provider.seedFromMarkdown` → `markdownToYFragment`) leaves the brackets
  as plain text. It cannot do otherwise: the editor's `parse` rule promotes any
  element whose whole text reads `[[X]]`, and in a markdown importer that
  swallows the `<li>`, `<blockquote>` or `<td>` around the link.
- **The renderer always promotes.** `normalizeWikiLinks`, called from
  `use-editor-sync.ts`'s `handleChange`, is not gated on collaboration, so the
  first change event after a note opens replaces the text with the node — and
  that write lands in the shared doc through y-prosemirror.
- **Write-back turns the node back into the same bytes** (`wikiLinkToText`).

So a note's first open converts text → node exactly once, and the round trip is
a fixed point from then on: a `wikiLink` node carries its target in props, so
`[[` never reappears in the document and the normalizer stops matching. Opening
a note does not modify it, which is both the user-visible contract and what
protects Obsidian fidelity.

Do not "fix" the asymmetry by giving main a `parse` rule or by dropping the
renderer's promotion. Each end is the way it is for its own reason, and the
convergence is gated by test —
`apps/desktop/src/main/sync/note-open-byte-stability.test.ts` (five open →
write-back cycles per fixture, byte-identical, no write) and
`apps/desktop/src/renderer/src/components/note/content-area/wiki-link-collab-promotion.test.ts`
(a real editor on a real Y.Doc promotes once and then stops).

One shape does **not** converge and is tracked separately: a wiki link inside a
longer marked phrase (`~~Cancelled: [[Meeting]]~~`) is rewritten once, to
`~~Cancelled: ~~[[Meeting]]`. See #1439.

## The gate

`src/schema-contract.test.ts` (`pnpm --filter @memry/editor-schema test`) checks
that every type in `MEMRY_BLOCK_TYPES` / `MEMRY_INLINE_CONTENT_TYPES` has a
server spec, that each spec's `propSchema` is the shared config's, and that
every server `render` emits exactly what its own `toExternalHTML` emits without
throwing. Case lists are derived from those exported arrays, so **a spec added
without a fixture fails the suite** rather than going untested.

Two companion gates live where the other halves do:

- `apps/desktop/src/renderer/src/components/note/content-area/editor-schema.test.ts`
  — renderer schema vs main schema: identical node-type key sets and identical
  per-type configs.
- `apps/desktop/src/main/sync/blocknote-converter.test.ts` — the real
  `yDocToMarkdown`: every custom type round-trips with the Y.Doc byte-unchanged,
  and the bytes match this package's own serializers.
