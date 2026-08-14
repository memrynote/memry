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
