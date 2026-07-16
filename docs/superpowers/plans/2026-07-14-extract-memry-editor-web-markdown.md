# Extract @memry/markdown + @memry/editor-web Implementation Plan

> Agentic workers: use the `superpowers:subagent-driven-development` sub-skill to execute this plan. Every step below uses `- [ ]` checkbox syntax — check a box only when its exact verification evidence is green. Never batch multiple steps into one action.

**Goal:** Split the preserving markdown⇄BlockNote conversion into a host-agnostic `@memry/markdown` package (killing the renderer/main serializer duplication) and lift the BlockNote schema + 6 custom blocks + 4 custom inlines into a `@memry/editor-web` Vite React-DOM app consumed by the desktop renderer today and the mobile WebView later — keeping desktop green at every step.

**Architecture:** Two independent copies of the identical preservation skeleton exist and have already diverged: `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts` (client `BlockNoteEditor`, serializes callout/youtube/bookmark/file/taskBlock) and `apps/desktop/src/main/sync/blocknote-converter.ts` (`ServerBlockNoteEditor`, serializes ONLY taskBlock/codeBlock — a real behavioral gap). This plan moves the ONE canonical algorithm into `@memry/markdown/convert`, parameterized on an injected `MarkdownEditorPort` (satisfied by both the client and server editors) plus a `CustomBlockCodecRegistry` of React-free codec halves, so both hosts call one implementation. `@memry/editor-web` owns `editorSchema`, the React block/inline specs, and a thin `EditorTransport` seam, re-exporting `@memry/markdown`.

**Tech Stack:** TypeScript, `@blocknote/core|react|code-block|shadcn|xl-ai` pinned `^0.47.1` (`@blocknote/server-util` exact `0.47.1`), `yjs ~13.6.29`, React 19, Vite (library + standalone WebView bundle), Vitest, pnpm workspaces + turbo.

## Global Constraints

Copy these VERBATIM into your working context; they are non-negotiable:

- Backward compatibility is MANDATORY for production installs: every change must work for existing installs, no DB resets, sync protocol / IPC contracts / vault file formats / settings shapes must tolerate data written by older app versions.
- DB schema changes go through additive, hand-written D1/data-DB migrations that preserve existing rows (Drizzle snapshots broken past 0021; data-DB migrations are hand-written).
- Sync-server deploys BEFORE desktop/mobile clients for every additive change (D6 sync item types, D8 settings-push, entitlement_grants).
- Crypto parameters are IMMUTABLE and byte-identical across clients: Argon2id v1.3 ops=3, mem=64 MiB, parallelism=1; BLAKE2b crypto_kdf_derive_from_key with exact 8-char contexts (memryvlt/memrysgn/memryvrf/memrykve/memrylnk/memrymac/memrysas); base64 = sodium.base64_variants.ORIGINAL (standard alphabet, padded); cryptoVersion=1; canonical CBOR in CBOR_FIELD_ORDER.
- E2E-encrypted: server never sees plaintext; it verifies Ed25519 via WebCrypto and validates envelope lengths only.
- Offline-first: SQLite local storage is canonical on mobile; CRDT (Yjs) for note/journal bodies, field-level vector clocks for tasks/projects/calendar; correctness never depends on background execution.
- `@blocknote/*`, `yjs`, and `zod` pinned IDENTICALLY to desktop across clients; a CI check fails the mobile build on drift; BlockNote bumps gated on the markdown round-trip / byte-preservation golden suite.
- `@memry/contracts` is the single wire-format source of truth; mobile MUST import, never copy (copying breaks cross-device crypto/signature interop).
- No Co-Authored-By trailer on commit messages.
- Prettier: single quotes, no semicolons, 100-char width, no trailing commas.
- RTL safety: new code uses logical Tailwind/RN props (ms-/me-, ps-/pe-, start-/end-) that flip automatically in RTL; RN uses I18nManager.forceRTL instead of document.dir.
- Extraction principle: move files, re-export from old paths, tests move with the code, desktop consumes the new package first — each extraction keeps desktop green, verified by the existing suite before mobile exists.
- Logging via `createLogger('Scope')` seam (never raw `console.*`); user-facing errors via `extractErrorMessage(err, fallback)`.
- WCAG AA + reduced-motion + RTL accessibility per PRODUCT.md; personality calm, private, crafted.

**Version pins (single source of truth = `apps/desktop/package.json`), mirror EXACTLY into both new packages:**

```
@blocknote/core        ^0.47.1
@blocknote/react       ^0.47.1
@blocknote/code-block  ^0.47.1
@blocknote/shadcn      ^0.47.1
@blocknote/xl-ai       ^0.47.1
@blocknote/server-util 0.47.1   (EXACT — no caret)
yjs                    ^13.6.29
zod                    ^4.3.4
```

**Extraction-workstream TDD rule:** For each move — (1) `git mv` file(s) into the new package, (2) re-export from the OLD desktop path so every existing import resolves unchanged, (3) move the existing tests with the code, (4) run the existing suite as the pass gate (the moved tests ARE the red→green). Desktop MUST stay green and consume the new package first.

---

## File Structure

### `@memry/markdown` (new package — `packages/markdown/`)

| Path                                                      | Responsibility                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/markdown/package.json`                          | name `@memry/markdown`; exports `.`, `./convert`, `./codecs`, `./frontmatter`, `./ports`, `./schema-props`; deps `@memry/shared`, `@memry/contracts`, `@memry/app-core`, `@blocknote/core@^0.47.1`, `yjs`, `gray-matter`, `nanoid`; NO react, NO @blocknote/react, NO @blocknote/server-util.                                        |
| `packages/markdown/tsconfig.json`                         | Extends `@memry/typescript-config`; `noEmit` typecheck.                                                                                                                                                                                                                                                                              |
| `packages/markdown/src/index.ts`                          | Barrel re-exporting `./convert`, `./ports`, `./schema-props`, `./codecs` (NOT `./frontmatter` — that stays a separate entry so the WebView bundle never pulls `@memry/app-core`).                                                                                                                                                    |
| `packages/markdown/src/ports.ts`                          | Seam interfaces `MarkdownEditorPort`, `CustomBlockCodecRegistry`, `LineCodec`, `SegmentCodec`.                                                                                                                                                                                                                                       |
| `packages/markdown/src/convert.ts`                        | THE unified preservation skeleton: `parseMarkdownPreservingBlanks`, `serializeBlocksPreservingBlanks`, `sanitizeBlockIds`, `isEmptyParagraph`, plus private `serializeBlocks`/`parseMarkdownChunkPreservingNesting`/`serializeBlocksWithNestingMarkers`/`parseContentRun`/`hasMarkerSerializedChildren`/`canSerializeChildNatively`. |
| `packages/markdown/src/convert.test.ts`                   | Merged round-trip unit tests (from `markdown-utils.test.ts` + skeleton cases of `blocknote-converter.test.ts`) driven by a fake `MarkdownEditorPort`.                                                                                                                                                                                |
| `packages/markdown/src/schema-props.ts`                   | Shared `propSchema` constants (`TASK_BLOCK_PROP_SCHEMA`, `CALLOUT_PROP_SCHEMA`, `YOUTUBE_PROP_SCHEMA`, `BOOKMARK_PROP_SCHEMA`, `FILE_PROP_SCHEMA`) — the single source both editor-web React specs and main server specs consume (prevents prop drift).                                                                              |
| `packages/markdown/src/codecs/index.ts`                   | `createDefaultCodecs()` building the `CustomBlockCodecRegistry` from the pure halves.                                                                                                                                                                                                                                                |
| `packages/markdown/src/codecs/file-block-markers.ts`      | `FileBlockProps`, `FILE_BLOCK_REGEX`, `serializeFileBlock`, `parseFileBlockMarker` (moved).                                                                                                                                                                                                                                          |
| `packages/markdown/src/codecs/file-block-markers.test.ts` | Round-trip unit test for file markers (new).                                                                                                                                                                                                                                                                                         |
| `packages/markdown/src/codecs/youtube.ts`                 | `serializeYoutubeEmbed`, `EMBED_BLOCK_REGEX` (pure halves moved out of the `.tsx`).                                                                                                                                                                                                                                                  |
| `packages/markdown/src/codecs/bookmark.ts`                | `serializeBookmark`, `BOOKMARK_BLOCK_REGEX` (pure halves moved out of the `.tsx`).                                                                                                                                                                                                                                                   |
| `packages/markdown/src/codecs/callout.ts`                 | `serializeCalloutBlock`, `splitMarkdownByCallouts`, `CALLOUT_TYPES`, `CalloutTypeValue`, `ContentSegment` (pure halves moved out of the `.tsx`).                                                                                                                                                                                     |
| `packages/markdown/src/codecs/url.ts`                     | `extractDomain` (small pure helper moved off the heavy renderer `url-metadata.ts`).                                                                                                                                                                                                                                                  |
| `packages/markdown/src/frontmatter.ts`                    | `parseNote`, `serializeParsedNote`, `serializeNote`, `extractTitleFromPath`, `validateNoteId`, `extractWikiLinks`, + the property/snippet/word-count helpers, + `NoteFrontmatter`/`ParsedNote`/`ParseNoteStats`/`SerializeParsedNoteOptions` (moved).                                                                                |
| `packages/markdown/src/note-id.ts`                        | `generateNoteId`, `isValidNoteId` (moved so frontmatter has no desktop dep).                                                                                                                                                                                                                                                         |
| `packages/markdown/src/pins.test.ts`                      | Asserts `@blocknote/*` versions in `@memry/markdown`, `@memry/editor-web`, and `apps/desktop` are byte-identical.                                                                                                                                                                                                                    |

### `@memry/editor-web` (new app+lib — `apps/editor-web/`)

| Path                                   | Responsibility                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- | ------ | ------------------------------------------------------ |
| `apps/editor-web/package.json`         | name `@memry/editor-web`; `exports.` → `./src/index.ts` (desktop consumes source); scripts `build:lib`, `build:standalone`, `typecheck`, `test`; deps `@memry/markdown`, `@memry/shared`, `@memry/i18n`, `@blocknote/core | react | code-block | shadcn | xl-ai@^0.47.1`; peerDeps `react@^19`, `react-dom@^19`. |
| `apps/editor-web/tsconfig.json`        | Extends `@memry/typescript-config`; JSX react.                                                                                                                                                                            |
| `apps/editor-web/vite.config.ts`       | Two build targets — library entry (`src/index.ts`) and standalone single-file WebView bundle (`index.html`).                                                                                                              |
| `apps/editor-web/index.html`           | Standalone WebView entry mounting the editor with `editorSchema` + the mobile `EditorTransport`.                                                                                                                          |
| `apps/editor-web/src/index.ts`         | Library barrel: `editorSchema`, `EditorSchema`, all block/inline creators, `EditorTransport`, and a re-export of `@memry/markdown`.                                                                                       |
| `apps/editor-web/src/editor-schema.ts` | `editorSchema = BlockNoteSchema.create({...})` (moved).                                                                                                                                                                   |
| `apps/editor-web/src/transport.ts`     | `EditorTransport` seam + `createIpcTransport` (desktop) + `createWebViewTransport` (mobile).                                                                                                                              |
| `apps/editor-web/src/blocks/*`         | Moved React block specs: `callout-block.tsx`, `file-block.tsx`, `youtube-embed-block.tsx`, `bookmark-block.tsx`, `bookmark-block-render.tsx`, `task-block/` (whole dir).                                                  |
| `apps/editor-web/src/inlines/*`        | Moved React inline specs: `wiki-link.tsx` (+ utils/menu/preview siblings), `hash-tag.tsx` (+ plugin/menu siblings), `link-mention.ts` (+ utils/preview), `date-mention.tsx` (+ utils/options/ghost/popover siblings).     |

### Modified desktop files (become re-export shims or delegating callers)

| Path                                                                                                                | Change                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts`                                      | Body deleted; re-exports the 4 public fns from `@memry/markdown`.                                                                                 |
| `apps/desktop/src/renderer/src/components/note/content-area/file-block-markers.ts`                                  | Re-export shim from `@memry/markdown/codecs`.                                                                                                     |
| `apps/desktop/src/renderer/src/components/note/content-area/editor-schema.ts`                                       | Re-export shim from `@memry/editor-web`.                                                                                                          |
| `apps/desktop/src/renderer/src/components/note/content-area/{callout-block,youtube-embed-block,bookmark-block}.tsx` | Import pure halves from `@memry/markdown/codecs`, keep re-exporting them; (moved to editor-web in Task 7).                                        |
| `apps/desktop/src/main/vault/frontmatter.ts`                                                                        | Re-export shim from `@memry/markdown/frontmatter`.                                                                                                |
| `apps/desktop/src/main/lib/id.ts`                                                                                   | `generateNoteId`/`isValidNoteId` re-export from `@memry/markdown/note-id`.                                                                        |
| `apps/desktop/src/main/sync/blocknote-converter.ts`                                                                 | Delete duplicated skeleton; extend `serverSchema` with server callout/youtube/bookmark/file specs; delegate parse/serialize to `@memry/markdown`. |
| `apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx`                                        | Repoint `editorSchema`/specs → `@memry/editor-web`; parse/serialize → `@memry/markdown` (via editor-web re-export).                               |
| `apps/desktop/src/renderer/src/components/note/content-area/hooks/use-editor-sync.ts`                               | Repoint markdown-utils import; wire desktop `EditorTransport`.                                                                                    |
| `apps/desktop/src/renderer/src/components/note/content-area/hooks/use-block-note-setup.ts`                          | Repoint `editorSchema` + spec imports → `@memry/editor-web`.                                                                                      |
| `apps/desktop/package.json`                                                                                         | Add `@memry/editor-web` + `@memry/markdown` workspace deps.                                                                                       |
| `turbo.json` / root `tsconfig.json`                                                                                 | Add build/test/typecheck pipeline + project references for the two new packages.                                                                  |

---

## Task 1: Scaffold `@memry/markdown` package skeleton

**Files:**

- Create `packages/markdown/package.json`
- Create `packages/markdown/tsconfig.json`
- Create `packages/markdown/src/index.ts`
- Create `packages/markdown/vitest.config.ts`
- Modify `turbo.json` (verify `packages/*` glob coverage; no edit needed if `pipeline` is task-based)

**Interfaces:**

- Produces: package `@memry/markdown` resolvable via workspace; subpath exports `.`, `./convert`, `./codecs`, `./frontmatter`, `./ports`, `./schema-props`, `./note-id`.

- [ ] **Step 1: Write the failing test.** Create `packages/markdown/src/index.ts` with a single sentinel export and `packages/markdown/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MARKDOWN_PACKAGE } from './index'

describe('@memry/markdown package', () => {
  it('is resolvable as a workspace package', () => {
    expect(MARKDOWN_PACKAGE).toBe('@memry/markdown')
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Run `pnpm --filter @memry/markdown test`. Expect failure: `Cannot find module ... @memry/markdown` or no such filter (package.json absent yet).

- [ ] **Step 3: Minimal implementation.** Create `packages/markdown/package.json`:

```json
{
  "name": "@memry/markdown",
  "version": "0.1.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./convert": "./src/convert.ts",
    "./codecs": "./src/codecs/index.ts",
    "./ports": "./src/ports.ts",
    "./schema-props": "./src/schema-props.ts",
    "./frontmatter": "./src/frontmatter.ts",
    "./note-id": "./src/note-id.ts"
  },
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@blocknote/core": "^0.47.1",
    "@memry/app-core": "workspace:*",
    "@memry/contracts": "workspace:*",
    "@memry/shared": "workspace:*",
    "gray-matter": "^4.0.3",
    "nanoid": "^5.0.7",
    "yjs": "^13.6.29"
  },
  "devDependencies": {
    "@memry/typescript-config": "workspace:*",
    "vitest": "^3.2.0"
  }
}
```

Create `packages/markdown/tsconfig.json`:

```json
{
  "extends": "@memry/typescript-config/base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

Create `packages/markdown/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
})
```

Set `packages/markdown/src/index.ts`:

```ts
export const MARKDOWN_PACKAGE = '@memry/markdown'
```

Run `pnpm install` at repo root so the workspace link is created. Confirm `gray-matter`, `nanoid`, and `vitest` versions match what `apps/desktop` already resolves (read `pnpm why gray-matter nanoid vitest` and pin to the same major).

- [ ] **Step 4: Run tests, expect PASS.** Run `pnpm --filter @memry/markdown test`. Expect `1 passed`. Run `pnpm --filter @memry/markdown typecheck` — expect no errors.

- [ ] **Step 5: Commit.** `git add packages/markdown pnpm-lock.yaml && git commit -m "chore(markdown): scaffold @memry/markdown package"`

---

## Task 2: Move `file-block-markers.ts` into `@memry/markdown/codecs`

**Files:**

- Create `packages/markdown/src/codecs/file-block-markers.ts` (moved from `apps/desktop/src/renderer/src/components/note/content-area/file-block-markers.ts`)
- Create `packages/markdown/src/codecs/file-block-markers.test.ts` (new)
- Modify `apps/desktop/src/renderer/src/components/note/content-area/file-block-markers.ts` → re-export shim
- Modify `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts` (import path only)

**Interfaces:**

- Produces: `interface FileBlockProps { url: string; name: string; size: number; mimeType: string }`; `FILE_BLOCK_REGEX: RegExp`; `serializeFileBlock(props: FileBlockProps): string`; `parseFileBlockMarker(marker: string): FileBlockProps | null`.

- [ ] **Step 1: Write the failing test.** Create `packages/markdown/src/codecs/file-block-markers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { serializeFileBlock, parseFileBlockMarker } from './file-block-markers'

describe('file block markers', () => {
  it('round-trips props through the html comment marker', () => {
    const props = { url: 'memry://a', name: 'a.pdf', size: 12, mimeType: 'application/pdf' }
    const marker = serializeFileBlock(props)
    expect(marker).toBe(
      '<!-- file:{"url":"memry://a","name":"a.pdf","size":12,"mimeType":"application/pdf"} -->'
    )
    expect(parseFileBlockMarker(marker)).toEqual(props)
  })

  it('returns null on malformed markers', () => {
    expect(parseFileBlockMarker('<!-- file:not-json -->')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Run `pnpm --filter @memry/markdown test file-block-markers`. Expect: `Cannot find module './file-block-markers'`.

- [ ] **Step 3: Minimal implementation.** `git mv apps/desktop/src/renderer/src/components/note/content-area/file-block-markers.ts packages/markdown/src/codecs/file-block-markers.ts` (content is already React/DOM-free; no edits to the body). Then recreate the OLD path as a shim `apps/desktop/src/renderer/src/components/note/content-area/file-block-markers.ts`:

```ts
export {
  FILE_BLOCK_REGEX,
  serializeFileBlock,
  parseFileBlockMarker,
  type FileBlockProps
} from '@memry/markdown/codecs'
```

Update `markdown-utils.ts` line 35 import to `from './file-block-markers'` (unchanged path — resolves to the shim; leave as-is). Export the four symbols from `packages/markdown/src/codecs/index.ts` for the `@memry/markdown/codecs` entry (create the file with just this re-export for now):

```ts
export {
  FILE_BLOCK_REGEX,
  serializeFileBlock,
  parseFileBlockMarker,
  type FileBlockProps
} from './file-block-markers'
```

- [ ] **Step 4: Run tests, expect PASS.** Run `pnpm --filter @memry/markdown test file-block-markers` → `2 passed`. Then `pnpm --filter @memry/desktop test:renderer -- file-block` → the existing `file-block.test.tsx` still passes (imports resolve through the shim). Run `pnpm typecheck` → clean.

- [ ] **Step 5: Commit.** `git add packages/markdown apps/desktop/src/renderer/src/components/note/content-area/file-block-markers.ts && git commit -m "refactor(markdown): move file-block-markers into @memry/markdown/codecs"`

---

## Task 3: Move `frontmatter.ts` (+ `note-id`) into `@memry/markdown/frontmatter`

**Files:**

- Create `packages/markdown/src/note-id.ts`
- Create `packages/markdown/src/frontmatter.ts` (moved from `apps/desktop/src/main/vault/frontmatter.ts`)
- Modify `apps/desktop/src/main/vault/frontmatter.ts` → re-export shim
- Modify `apps/desktop/src/main/lib/id.ts` → re-export `generateNoteId`/`isValidNoteId`
- Gate: `apps/desktop/src/main/vault/byte-preservation.golden.test.ts` STAYS (imports `./frontmatter` + `./file-ops` + fs fixtures) and is the pass gate.

**Interfaces:**

- Consumes: `@memry/app-core/markdown` → `splitFrontmatterBlock`, `serializeParsedMarkdownNote`, `writeMarkdownNote`, `type Eol`.
- Produces: `parseNote(rawContent, filePath?, stats?): ParsedNote`; `serializeParsedNote(parsed, content, options): string`; `serializeNote(fm, content): string`; `extractTitleFromPath(filePath): string`; `validateNoteId(id): boolean`; `extractWikiLinks(content): string[]`; `generateNoteId(): string`; `isValidNoteId(id): boolean`; interfaces `NoteFrontmatter`, `ParsedNote`, `ParseNoteStats`, `SerializeParsedNoteOptions`.
- Dependency direction: `@memry/markdown` → `@memry/app-core`. Verify `@memry/app-core` does NOT import `@memry/markdown` (no cycle exists today; keep it that way).

- [ ] **Step 1: Write the failing test.** Create `packages/markdown/src/note-id.ts` empty for now, and add `packages/markdown/src/frontmatter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseNote, serializeParsedNote, isValidNoteId } from './frontmatter'

describe('frontmatter round-trip', () => {
  it('re-serializes an unedited note byte-identically', () => {
    const raw = '---\ntags:\n  - a\n---\nHello body\n'
    const parsed = parseNote(raw, 'Note.md')
    const out = serializeParsedNote(parsed, parsed.content, { frontmatterEdited: false })
    expect(out).toBe(raw)
    expect(parsed.frontmatter.tags).toEqual(['a'])
  })

  it('validates 12-char lowercase note ids', () => {
    expect(isValidNoteId('abc123def456')).toBe(true)
    expect(isValidNoteId('TOO-SHORT')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Run `pnpm --filter @memry/markdown test frontmatter`. Expect: `Cannot find module './frontmatter'`.

- [ ] **Step 3: Minimal implementation.** Create `packages/markdown/src/note-id.ts` (moved logic; independent of desktop):

```ts
import { customAlphabet } from 'nanoid'

const noteIdAlphabet = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)

export const generateNoteId = (): string => noteIdAlphabet()

export function isValidNoteId(id: string): boolean {
  return /^[0-9a-z]{12}$/.test(id)
}
```

`git mv apps/desktop/src/main/vault/frontmatter.ts packages/markdown/src/frontmatter.ts`. In the moved file, change line 16 import from `import { generateNoteId, isValidNoteId } from '../lib/id'` to `import { generateNoteId, isValidNoteId } from './note-id'` (the `@memry/app-core/markdown` import stays unchanged). Recreate the OLD desktop path `apps/desktop/src/main/vault/frontmatter.ts` as a shim:

```ts
export {
  parseNote,
  serializeParsedNote,
  serializeNote,
  extractTitleFromPath,
  validateNoteId,
  extractWikiLinks,
  extractTags,
  extractInlineTagsFromMarkdown,
  calculateWordCount,
  generateContentHash,
  extractProperties,
  inferPropertyType,
  serializePropertyValue,
  deserializePropertyValue,
  createSnippet,
  type NoteFrontmatter,
  type ParsedNote,
  type ParseNoteStats,
  type SerializeParsedNoteOptions
} from '@memry/markdown/frontmatter'
```

In `apps/desktop/src/main/lib/id.ts`, replace the two local definitions of `generateNoteId` and `isValidNoteId` with a re-export so there is one source (keep `generateId`, `generateJournalId`, `generateShortId`, `isValidId` local):

```ts
export { generateNoteId, isValidNoteId } from '@memry/markdown/note-id'
```

- [ ] **Step 4: Run tests, expect PASS.** Run `pnpm --filter @memry/markdown test frontmatter` → `2 passed`. Then run the desktop golden gate — the cross-cutting round-trip suite must stay green through the shim: `pnpm --filter @memry/desktop test:main -- byte-preservation.golden`. Expect all fixtures pass (`>= 14 fixtures`). Run `pnpm typecheck` → clean. If `better-sqlite3 ERR_DLOPEN_FAILED` appears, run `pnpm --filter @memry/desktop rebuild:node` first.

- [ ] **Step 5: Commit.** `git add packages/markdown apps/desktop/src/main/vault/frontmatter.ts apps/desktop/src/main/lib/id.ts && git commit -m "refactor(markdown): move frontmatter parse/serialize into @memry/markdown"`

---

## Task 4: Move pure codec halves + define ports + default codec registry

**Files:**

- Create `packages/markdown/src/codecs/youtube.ts` (pure halves from `youtube-embed-block.tsx`)
- Create `packages/markdown/src/codecs/bookmark.ts` (pure halves from `bookmark-block.tsx`)
- Create `packages/markdown/src/codecs/callout.ts` (pure halves from `callout-block.tsx`)
- Create `packages/markdown/src/codecs/url.ts` (`extractDomain`)
- Create `packages/markdown/src/ports.ts`
- Create `packages/markdown/src/schema-props.ts`
- Modify `packages/markdown/src/codecs/index.ts` → add `createDefaultCodecs()`
- Modify `apps/desktop/.../youtube-embed-block.tsx`, `bookmark-block.tsx`, `callout-block.tsx` → import pure halves from `@memry/markdown/codecs`, keep re-exporting them
- Modify `apps/desktop/.../markdown-utils.ts` (imports of pure halves point at `@memry/markdown/codecs`)

**Interfaces:**

- Consumes: `@memry/shared/youtube` → `extractYouTubeVideoId(url): string | null`; `@memry/shared/task-block` → `serializeTaskBlock(props): string`, `type TaskBlockProps`.
- Produces (`ports.ts`):

```ts
import type { Block, PartialBlock } from '@blocknote/core'

export interface MarkdownEditorPort {
  tryParseMarkdownToBlocks(markdown: string): Promise<Block[]>
  blocksToMarkdownLossy(blocks: PartialBlock[]): Promise<string>
}

export interface LineCodec {
  test(line: string): boolean
  parse(line: string): Block | null
}

export interface SegmentCodec {
  splitSegments(
    markdown: string
  ): Array<
    | { kind: 'custom'; parse(editor: MarkdownEditorPort): Promise<Block[]> }
    | { kind: 'markdown'; text: string }
  >
}

export interface CustomBlockCodecRegistry {
  serializeBlock(
    block: Block,
    serializeInner: (blocks: Block[]) => Promise<string>
  ): Promise<string | null>
  segment?: SegmentCodec
  lineParsers: LineCodec[]
}
```

- Produces (`codecs/index.ts`): `createDefaultCodecs(): CustomBlockCodecRegistry`.
- Produces (`schema-props.ts`): `TASK_BLOCK_PROP_SCHEMA`, `CALLOUT_PROP_SCHEMA`, `YOUTUBE_PROP_SCHEMA`, `BOOKMARK_PROP_SCHEMA`, `FILE_PROP_SCHEMA`.

- [ ] **Step 1: Write the failing test.** Create `packages/markdown/src/codecs/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createDefaultCodecs } from './index'

const noopInner = async () => ''

describe('createDefaultCodecs', () => {
  it('serializes a youtube block to an embed marker', async () => {
    const codecs = createDefaultCodecs()
    const block = { type: 'youtubeEmbed', props: { videoUrl: 'https://youtu.be/x' } } as never
    expect(await codecs.serializeBlock(block, noopInner)).toBe('![embed](https://youtu.be/x)')
  })

  it('serializes a task block with subtasks on tight lines', async () => {
    const codecs = createDefaultCodecs()
    const block = {
      type: 'taskBlock',
      props: { taskId: 'a', title: 'Parent', checked: false, parentTaskId: '' },
      children: [
        {
          type: 'taskBlock',
          props: { taskId: 'b', title: 'Child', checked: true, parentTaskId: 'a' }
        }
      ]
    } as never
    const out = await codecs.serializeBlock(block, noopInner)
    expect(out?.split('\n').length).toBe(2)
  })

  it('parses an embed marker line into a youtube block', () => {
    const codecs = createDefaultCodecs()
    const yt = codecs.lineParsers.find((lp) => lp.test('![embed](https://youtu.be/x)'))
    const block = yt?.parse('![embed](https://youtu.be/x)') as {
      type: string
      props: { videoId: string }
    }
    expect(block.type).toBe('youtubeEmbed')
    expect(block.props.videoId).toBe('x')
  })

  it('returns null serialize for plain paragraphs', async () => {
    const codecs = createDefaultCodecs()
    expect(
      await codecs.serializeBlock({ type: 'paragraph', props: {} } as never, noopInner)
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Run `pnpm --filter @memry/markdown test codecs/index`. Expect: `createDefaultCodecs is not a function` / module has only the file-block re-exports.

- [ ] **Step 3: Minimal implementation.** Move pure halves with `git mv`-then-split (the source functions currently sit alongside React specs, so copy the pure lines out and delete them from the `.tsx`, replacing with a re-export). Create `packages/markdown/src/codecs/youtube.ts`:

```ts
export const EMBED_BLOCK_REGEX = /!\[embed\]\(([^)]+)\)/g

export function serializeYoutubeEmbed(videoUrl: string): string {
  return `![embed](${videoUrl})`
}
```

Create `packages/markdown/src/codecs/bookmark.ts`:

```ts
export const BOOKMARK_BLOCK_REGEX = /!\[bookmark\]\(([^)]+)\)/g

export function serializeBookmark(url: string): string {
  return `![bookmark](${url})`
}
```

Create `packages/markdown/src/codecs/url.ts` (pure, no `URL`-throw leakage):

```ts
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
```

Create `packages/markdown/src/codecs/callout.ts` by moving the pure block from `callout-block.tsx` (the `CALLOUT_TYPES` list, `CalloutTypeValue`, `CALLOUT_LINE_REGEX`, `serializeCalloutBlock`, `splitMarkdownByCallouts`, `ContentSegment`/`CalloutSegment`/`MarkdownSegment` types — copy verbatim from lines 190–260 plus the `CALLOUT_TYPES` declaration). Keep the exported names identical:

```ts
export const CALLOUT_TYPES = [
  { value: 'info' },
  { value: 'warning' },
  { value: 'error' },
  { value: 'success' }
] as const

export type CalloutTypeValue = (typeof CALLOUT_TYPES)[number]['value']

export type CalloutSegment = { kind: 'callout'; type: CalloutTypeValue; content: string }
export type MarkdownSegment = { kind: 'markdown'; text: string }
export type ContentSegment = CalloutSegment | MarkdownSegment

const CALLOUT_LINE_REGEX = /^> \[!(\w+)\](.*)/

export function serializeCalloutBlock(type: string, contentMarkdown: string): string {
  const lines = contentMarkdown.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return `> [!${type}]`
  const quoted = lines.map((line) => `> ${line}`).join('\n')
  return `> [!${type}]\n${quoted}`
}

export function splitMarkdownByCallouts(markdown: string): ContentSegment[] {
  const validTypes: readonly string[] = CALLOUT_TYPES.map((t) => t.value)
  const lines = markdown.split('\n')
  const segments: ContentSegment[] = []
  let mdLines: string[] = []
  let i = 0

  const flushMarkdown = (): void => {
    const text = mdLines.join('\n').trim()
    if (text) segments.push({ kind: 'markdown', text })
    mdLines = []
  }

  while (i < lines.length) {
    const match = lines[i].match(CALLOUT_LINE_REGEX)
    if (match) {
      flushMarkdown()
      const rawType = match[1]
      const type = validTypes.includes(rawType) ? (rawType as CalloutTypeValue) : 'info'
      const contentLines: string[] = []
      const titleText = match[2].trim()
      if (titleText) contentLines.push(titleText)
      i++
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        contentLines.push(lines[i] === '>' ? '' : lines[i].slice(2))
        i++
      }
      segments.push({ kind: 'callout', type, content: contentLines.join('\n').trim() })
    } else {
      mdLines.push(lines[i])
      i++
    }
  }

  flushMarkdown()
  return segments
}
```

> NOTE: `CALLOUT_TYPES` in the live `callout-block.tsx` carries UI metadata (label/icon) beyond `value`. Read the real declaration before moving and copy it verbatim (including any icon/label fields) so `editor-web`'s slash-menu and renderer keep working through the re-export; the codec only reads `.value`.

Create `packages/markdown/src/ports.ts` with the interfaces from the Interfaces block above. Create `packages/markdown/src/schema-props.ts`:

```ts
import { defaultProps } from '@blocknote/core'

export const TASK_BLOCK_PROP_SCHEMA = {
  taskId: { default: '' },
  title: { default: '' },
  checked: { default: false },
  parentTaskId: { default: '' }
} as const

export const CALLOUT_PROP_SCHEMA = {
  textAlignment: defaultProps.textAlignment,
  textColor: defaultProps.textColor,
  type: { default: 'info' as const, values: ['info', 'warning', 'error', 'success'] as const }
} as const

export const YOUTUBE_PROP_SCHEMA = {
  videoId: { default: '' },
  videoUrl: { default: '' }
} as const

export const BOOKMARK_PROP_SCHEMA = {
  url: { default: '' },
  domain: { default: '' },
  title: { default: '' },
  description: { default: '' },
  image: { default: '' },
  favicon: { default: '' },
  siteName: { default: '' }
} as const

export const FILE_PROP_SCHEMA = {
  url: { default: '' },
  name: { default: '' },
  size: { default: 0 },
  mimeType: { default: '' }
} as const
```

Replace `packages/markdown/src/codecs/index.ts` with the full default registry:

```ts
import { type Block } from '@blocknote/core'
import { extractYouTubeVideoId } from '@memry/shared/youtube'
import { serializeTaskBlock, type TaskBlockProps } from '@memry/shared/task-block'
import type { CustomBlockCodecRegistry } from '../ports'
import { serializeFileBlock, parseFileBlockMarker, type FileBlockProps } from './file-block-markers'
import { serializeYoutubeEmbed } from './youtube'
import { serializeBookmark } from './bookmark'
import { serializeCalloutBlock, splitMarkdownByCallouts } from './callout'
import { extractDomain } from './url'

export {
  FILE_BLOCK_REGEX,
  serializeFileBlock,
  parseFileBlockMarker,
  type FileBlockProps
} from './file-block-markers'
export { serializeYoutubeEmbed, EMBED_BLOCK_REGEX } from './youtube'
export { serializeBookmark, BOOKMARK_BLOCK_REGEX } from './bookmark'
export {
  serializeCalloutBlock,
  splitMarkdownByCallouts,
  CALLOUT_TYPES,
  type CalloutTypeValue,
  type ContentSegment
} from './callout'
export { extractDomain } from './url'

const EMBED_LINE_REGEX = /^!\[embed\]\(([^)]+)\)$/
const BOOKMARK_LINE_REGEX = /^!\[bookmark\]\(([^)]+)\)$/
const FILE_BLOCK_LINE_REGEX = /^<!-- file:\{[^}]+\} -->$/

export function createDefaultCodecs(): CustomBlockCodecRegistry {
  return {
    async serializeBlock(block, serializeInner) {
      const type = block.type as string
      if (type === 'taskBlock') {
        const lines = [serializeTaskBlock(block.props as unknown as TaskBlockProps)]
        for (const child of (block.children ?? []) as Block[]) {
          if ((child.type as string) === 'taskBlock') {
            lines.push(serializeTaskBlock(child.props as unknown as TaskBlockProps))
          }
        }
        return lines.join('\n')
      }
      if (type === 'youtubeEmbed') {
        return serializeYoutubeEmbed((block.props as { videoUrl: string }).videoUrl)
      }
      if (type === 'bookmark') {
        return serializeBookmark((block.props as { url: string }).url)
      }
      if (type === 'file') {
        return serializeFileBlock(block.props as FileBlockProps)
      }
      if (type === 'callout') {
        const contentMd = (await serializeInner([block])).trim()
        return serializeCalloutBlock((block.props as { type: string }).type, contentMd)
      }
      return null
    },
    segment: {
      splitSegments(markdown) {
        return splitMarkdownByCallouts(markdown).map((seg) =>
          seg.kind === 'callout'
            ? {
                kind: 'custom' as const,
                async parse(editor) {
                  const parsed = await editor.tryParseMarkdownToBlocks(seg.content)
                  const inlineContent = parsed[0]?.content ?? seg.content
                  return [
                    {
                      type: 'callout',
                      props: { type: seg.type },
                      content: inlineContent
                    } as unknown as Block
                  ]
                }
              }
            : { kind: 'markdown' as const, text: seg.text }
        )
      }
    },
    lineParsers: [
      {
        test: (line) => EMBED_LINE_REGEX.test(line.trim()),
        parse(line) {
          const m = line.trim().match(EMBED_LINE_REGEX)
          if (!m) return null
          const videoId = extractYouTubeVideoId(m[1])
          if (!videoId) return null
          return { type: 'youtubeEmbed', props: { videoId, videoUrl: m[1] } } as unknown as Block
        }
      },
      {
        test: (line) => BOOKMARK_LINE_REGEX.test(line.trim()),
        parse(line) {
          const m = line.trim().match(BOOKMARK_LINE_REGEX)
          if (!m) return null
          return {
            type: 'bookmark',
            props: { url: m[1], domain: extractDomain(m[1]) }
          } as unknown as Block
        }
      },
      {
        test: (line) => FILE_BLOCK_LINE_REGEX.test(line.trim()),
        parse(line) {
          const props = parseFileBlockMarker(line.trim())
          if (!props) return null
          return { type: 'file', props } as unknown as Block
        }
      }
    ]
  }
}
```

Now make the three renderer `.tsx` specs consume the moved pure halves so there is one source. In `youtube-embed-block.tsx` delete the local `EMBED_BLOCK_REGEX`/`serializeYoutubeEmbed` and add `export { EMBED_BLOCK_REGEX, serializeYoutubeEmbed } from '@memry/markdown/codecs'`. Same pattern for `bookmark-block.tsx` (`BOOKMARK_BLOCK_REGEX`, `serializeBookmark`) and `callout-block.tsx` (`serializeCalloutBlock`, `splitMarkdownByCallouts`, `CALLOUT_TYPES`, `CalloutTypeValue`, `ContentSegment`) — the React `createReactBlockSpec` halves stay. Update `markdown-utils.ts` imports of `splitMarkdownByCallouts`/`serializeCalloutBlock`/`serializeYoutubeEmbed`/`serializeBookmark`/`extractDomain` to `@memry/markdown/codecs` (leave `extractYouTubeVideoId` from `@memry/shared/youtube`).

- [ ] **Step 4: Run tests, expect PASS.** Run `pnpm --filter @memry/markdown test codecs/index` → `4 passed`. Run `pnpm --filter @memry/desktop test:renderer -- callout-block` and `-- youtube` and `-- bookmark` (the moved-out re-exports keep those green). Run `pnpm typecheck` → clean.

- [ ] **Step 5: Commit.** `git add packages/markdown apps/desktop/src/renderer/src/components/note/content-area && git commit -m "refactor(markdown): extract pure block codecs + ports + default registry"`

---

## Task 5: Extract the unified skeleton into `convert.ts`; make renderer `markdown-utils.ts` a shim

**Files:**

- Create `packages/markdown/src/convert.ts`
- Create `packages/markdown/src/convert.test.ts` (moved + merged from `markdown-utils.test.ts`)
- Modify `packages/markdown/src/index.ts` → barrel-export `convert` + `ports` + `schema-props` + `codecs`
- Modify `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts` → re-export shim
- Delete `apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.test.ts` (moved)

**Interfaces:**

- Consumes: `MarkdownEditorPort`, `CustomBlockCodecRegistry` (Task 4); `@memry/shared/empty-lines`, `@memry/shared/block-colors`, `@memry/shared/inline-colors`, `@memry/shared/block-nesting`; `createDefaultCodecs()` (Task 4).
- Produces:

```ts
parseMarkdownPreservingBlanks(editor: MarkdownEditorPort, markdown: string, codecs?: CustomBlockCodecRegistry): Promise<Block[]>
serializeBlocksPreservingBlanks(editor: MarkdownEditorPort, blocks: Block[], codecs?: CustomBlockCodecRegistry): Promise<string>
sanitizeBlockIds(blocks: Block[]): Block[]
isEmptyParagraph(block: Block): boolean
```

- [ ] **Step 1: Write the failing test.** `git mv apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.test.ts packages/markdown/src/convert.test.ts`. Change its import line to `from './convert'`. The existing fake-editor tests already exercise the algorithm with a plain object satisfying `MarkdownEditorPort`. Append one gap-preservation round-trip case at the end of the file:

```ts
describe('serialize→parse blank-line preservation', () => {
  it('keeps a two-blank-line gap stable across a round-trip', async () => {
    let id = 0
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (md: string) =>
        md
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => ({
            id: `p-${++id}`,
            type: 'paragraph',
            props: {},
            content: [{ type: 'text', text: l.trim(), styles: {} }],
            children: []
          }))
      ),
      blocksToMarkdownLossy: vi.fn(async (blocks: Array<{ content?: Array<{ text: string }> }>) =>
        blocks.map((b) => b.content?.[0]?.text ?? '').join('\n\n')
      )
    }
    const md = 'A\n\n\nB'
    const blocks = await parseMarkdownPreservingBlanks(editor, md)
    const out = await serializeBlocksPreservingBlanks(editor, blocks as never[])
    expect(out).toBe(md)
  })
})
```

Ensure the top import block reads:

```ts
import {
  isEmptyParagraph,
  parseMarkdownPreservingBlanks,
  sanitizeBlockIds,
  serializeBlocksPreservingBlanks
} from './convert'
```

- [ ] **Step 2: Run it, expect FAIL.** Run `pnpm --filter @memry/markdown test convert`. Expect: `Cannot find module './convert'`.

- [ ] **Step 3: Minimal implementation.** Create `packages/markdown/src/convert.ts` — the single skeleton (generalized from the renderer copy; `editor` typed as `MarkdownEditorPort`, custom blocks routed through `codecs`):

```ts
import { type Block } from '@blocknote/core'
import {
  splitMarkdownPreservingBlanks,
  assembleMarkdownWithBlanks,
  separateBlockImages,
  normalizeSerializedMarkdown,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import {
  type BlockColors,
  BLOCK_COLORS_LINE_REGEX,
  hasNonDefaultColors,
  parseBlockColorsMarker,
  serializeBlockColorsMarker
} from '@memry/shared/block-colors'
import {
  applyInlineColorTokens,
  extractInlineColorRuns,
  maskInlineColorSpans,
  restoreInlineColorTokens
} from '@memry/shared/inline-colors'
import {
  createBlockNestingMarker,
  restoreBlockNesting,
  splitMarkdownByBlockNestingMarkers
} from '@memry/shared/block-nesting'
import type { MarkdownEditorPort, CustomBlockCodecRegistry } from './ports'
import { createDefaultCodecs } from './codecs'

export function isEmptyParagraph(block: Block): boolean {
  if (block.type !== 'paragraph') return false
  if (block.children?.length) return false
  const content = block.content as unknown[]
  return !content || content.length === 0
}

const MARKDOWN_LIST_BLOCK_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem'])

function canSerializeChildNatively(parent: Block, child: Block): boolean {
  return (
    MARKDOWN_LIST_BLOCK_TYPES.has(parent.type as string) &&
    MARKDOWN_LIST_BLOCK_TYPES.has(child.type as string)
  )
}

function hasMarkerSerializedChildren(block: Block): boolean {
  const children = (block.children ?? []) as Block[]
  if (children.length === 0) return false
  return children.some(
    (child) => !canSerializeChildNatively(block, child) || hasMarkerSerializedChildren(child)
  )
}

// Funnel every BlockNote serialization through the shared normalizer so both
// hosts emit `-` bullets, tight lists, single-newline paragraphs. Inline colors
// are wrapped in tokens first and re-emitted as `<span style="…">` after.
async function serializeBlocks(editor: MarkdownEditorPort, blocks: Block[]): Promise<string> {
  const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks as never[])
  const md = normalizeSerializedMarkdown(await editor.blocksToMarkdownLossy(wrapped as never[]))
  return restoreInlineColorTokens(md, replacements)
}

async function parseMarkdownChunkPreservingNesting(
  editor: MarkdownEditorPort,
  markdown: string
): Promise<Block[]> {
  const chunks = splitMarkdownByBlockNestingMarkers(markdown)
  if (chunks.length === 0) return []
  if (chunks.length === 1 && chunks[0].level === 0) {
    return editor.tryParseMarkdownToBlocks(chunks[0].text)
  }
  const blocks: Block[] = []
  const levels: number[] = []
  for (const chunk of chunks) {
    const parsed = await editor.tryParseMarkdownToBlocks(chunk.text)
    blocks.push(...parsed)
    levels.push(...parsed.map(() => chunk.level))
  }
  return restoreBlockNesting(blocks, levels)
}

async function serializeBlocksWithNestingMarkers(
  editor: MarkdownEditorPort,
  blocks: Block[]
): Promise<string> {
  const parts: string[] = []
  let currentLevel = 0
  const appendBlock = async (block: Block, level: number): Promise<void> => {
    if (level !== currentLevel) {
      parts.push(createBlockNestingMarker(level))
      currentLevel = level
    }
    const shallowBlock = { ...block, children: [] } as Block
    const markdown = (await serializeBlocks(editor, [shallowBlock])).trim()
    if (markdown) parts.push(markdown)
    for (const child of (block.children ?? []) as Block[]) {
      await appendBlock(child, level + 1)
    }
  }
  for (const block of blocks) await appendBlock(block, 0)
  if (currentLevel !== 0) parts.push(createBlockNestingMarker(0))
  return parts.join('\n\n')
}

export function sanitizeBlockIds(blocks: Block[]): Block[] {
  let didChange = false
  const sanitizeBlock = (block: Block): Block => {
    let nextBlock = block
    const id = (block as { id?: unknown }).id
    if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
      const { id: _removedId, ...rest } = block as Block & { id: unknown }
      nextBlock = rest as Block
      didChange = true
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      const nextChildren = block.children.map((child) => sanitizeBlock(child as Block))
      const childrenChanged = nextChildren.some((child, index) => child !== block.children[index])
      if (childrenChanged) {
        nextBlock = { ...nextBlock, children: nextChildren } as Block
        didChange = true
      }
    }
    return nextBlock
  }
  const nextBlocks = blocks.map(sanitizeBlock)
  return didChange ? nextBlocks : blocks
}

// One content run: block-color markers + custom line markers (embed/bookmark/
// file) split out; everything else buffers and parses with nesting preserved.
async function parseContentRun(
  editor: MarkdownEditorPort,
  text: string,
  codecs: CustomBlockCodecRegistry
): Promise<Block[]> {
  const blocks: Block[] = []
  let buffer: string[] = []
  let pendingColors: BlockColors | null = null

  const flushBuffer = async (): Promise<void> => {
    if (buffer.length === 0) return
    const parsed = await parseMarkdownChunkPreservingNesting(editor, buffer.join('\n'))
    if (pendingColors && parsed[0]) parsed[0].props = { ...parsed[0].props, ...pendingColors }
    pendingColors = null
    blocks.push(...parsed)
    buffer = []
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (BLOCK_COLORS_LINE_REGEX.test(trimmed)) {
      const colors = parseBlockColorsMarker(trimmed)
      if (colors) {
        await flushBuffer()
        pendingColors = colors
        continue
      }
    }
    let handled = false
    for (const lp of codecs.lineParsers) {
      if (lp.test(line)) {
        const parsedBlock = lp.parse(line)
        if (parsedBlock) {
          await flushBuffer()
          pendingColors = null
          blocks.push(parsedBlock)
          handled = true
          break
        }
      }
    }
    if (!handled) buffer.push(line)
  }
  await flushBuffer()
  return blocks
}

export async function parseMarkdownPreservingBlanks(
  editor: MarkdownEditorPort,
  markdown: string,
  codecs: CustomBlockCodecRegistry = createDefaultCodecs()
): Promise<Block[]> {
  const { text: masked, spans } = maskInlineColorSpans(markdown)
  const segments = codecs.segment?.splitSegments(masked) ?? [
    { kind: 'markdown' as const, text: masked }
  ]
  const blocks: Block[] = []

  for (const seg of segments) {
    if (seg.kind === 'custom') {
      blocks.push(...(await seg.parse(editor)))
      continue
    }
    const blankSegments = splitMarkdownPreservingBlanks(separateBlockImages(seg.text))
    for (const bs of blankSegments) {
      if (bs.type === 'content') {
        blocks.push(...(await parseContentRun(editor, bs.text, codecs)))
      } else {
        for (let i = 0; i < bs.extraLines; i++) {
          blocks.push({
            type: 'paragraph',
            content: [],
            children: [],
            props: {}
          } as unknown as Block)
        }
      }
    }
  }

  return applyInlineColorTokens(blocks as never[], spans) as Block[]
}

export async function serializeBlocksPreservingBlanks(
  editor: MarkdownEditorPort,
  blocks: Block[],
  codecs: CustomBlockCodecRegistry = createDefaultCodecs()
): Promise<string> {
  const segments: MarkdownSegment[] = []
  let contentGroup: Block[] = []
  let emptyCount = 0
  const serializeInner = (bs: Block[]): Promise<string> => serializeBlocks(editor, bs)

  const flushContent = async (): Promise<void> => {
    if (contentGroup.length === 0) return
    segments.push({ type: 'content', text: (await serializeBlocks(editor, contentGroup)).trim() })
    contentGroup = []
  }
  const flushGap = (): void => {
    if (emptyCount === 0) return
    segments.push({ type: 'gap', extraLines: emptyCount })
    emptyCount = 0
  }

  for (const block of blocks) {
    const custom = await codecs.serializeBlock(block, serializeInner)
    if (custom !== null) {
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: custom })
    } else if (isEmptyParagraph(block)) {
      await flushContent()
      emptyCount++
    } else if (hasNonDefaultColors(block.props as BlockColors)) {
      await flushContent()
      flushGap()
      const blockMd = (await serializeBlocks(editor, [block])).trim()
      segments.push({
        type: 'content',
        text: `${serializeBlockColorsMarker(block.props as BlockColors)}\n${blockMd}`
      })
    } else if (hasMarkerSerializedChildren(block)) {
      await flushContent()
      flushGap()
      segments.push({
        type: 'content',
        text: await serializeBlocksWithNestingMarkers(editor, [block])
      })
    } else {
      flushGap()
      contentGroup.push(block)
    }
  }

  await flushContent()
  flushGap()
  return assembleMarkdownWithBlanks(segments)
}
```

Set `packages/markdown/src/index.ts`:

```ts
export * from './convert'
export * from './ports'
export * from './schema-props'
export * from './codecs'
```

Replace the renderer `markdown-utils.ts` body with a shim (its callers pass `(editor, md)` / `(editor, blocks)` with no codecs — the defaulted `codecs` param keeps them compatible):

```ts
export {
  isEmptyParagraph,
  sanitizeBlockIds,
  parseMarkdownPreservingBlanks,
  serializeBlocksPreservingBlanks
} from '@memry/markdown'
```

- [ ] **Step 4: Run tests, expect PASS.** Run `pnpm --filter @memry/markdown test convert` → all moved cases + the new gap case pass. Run the renderer suite that exercises save/parse: `pnpm --filter @memry/desktop test:renderer -- ContentArea` and `-- use-editor-sync`. Run `pnpm typecheck` → clean.

- [ ] **Step 5: Commit.** `git add packages/markdown apps/desktop/src/renderer/src/components/note/content-area/markdown-utils.ts && git commit -m "refactor(markdown): unify preservation skeleton in @memry/markdown/convert"`

---

## Task 6: Rewire main `blocknote-converter.ts` to delegate to `@memry/markdown` (close the callout/youtube/bookmark/file gap)

**Files:**

- Modify `apps/desktop/src/main/sync/blocknote-converter.ts` (delete duplicated skeleton; add server specs; delegate)
- Modify `apps/desktop/src/main/sync/blocknote-converter.test.ts` (drop skeleton cases now covered in `convert.test.ts`; keep Yjs/server-editor cases)
- Create fixtures `apps/desktop/src/main/vault/__fixtures__/golden-vault/callout-writeback.md`, `youtube-writeback.md`, `bookmark-writeback.md`, `file-writeback.md`
- Gate: `apps/desktop/src/main/vault/byte-preservation.golden.test.ts`

**Interfaces:**

- Consumes: `parseMarkdownPreservingBlanks`, `serializeBlocksPreservingBlanks` (Task 5); `createDefaultCodecs` (Task 4); `TASK_BLOCK_PROP_SCHEMA`, `CALLOUT_PROP_SCHEMA`, `YOUTUBE_PROP_SCHEMA`, `BOOKMARK_PROP_SCHEMA`, `FILE_PROP_SCHEMA` (Task 4).
- Produces: UNCHANGED public API — `yDocToMarkdown`, `markdownToBlocks`, `blocksToYFragment`, `markdownToYFragment`, `yFragmentToBlocks`, `repairEmptyBlockIds`, `ensureBlockIds` (signatures identical, so `crdt-feed.ts`, `crdt-writeback.ts`, `crdt-provider.ts` need no change).
- **Backward-compat note:** main previously flattened callout/youtube/bookmark/file on the CRDT writeback path; after this task it emits their markers, matching what the renderer save path has always written. This is a vault-byte behavior change on the writeback path ONLY and is verified by the golden suite + a differential snapshot (Step 1). No existing marker format changes.

- [ ] **Step 1: Write the failing test (differential + new golden fixtures).** First capture current main output as a differential guard in `blocknote-converter.test.ts` (append):

```ts
describe('main serializes custom blocks on writeback (gap closed)', () => {
  it('round-trips a callout through markdown→fragment→markdown', async () => {
    const md = '> [!info]\n> Heads up'
    const doc = new Y.Doc()
    await markdownToYFragment(md, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    const out = await yDocToMarkdown(doc)
    expect(out).toBe(md)
  })

  it('round-trips a youtube embed marker', async () => {
    const md = '![embed](https://youtu.be/abc123)'
    const doc = new Y.Doc()
    await markdownToYFragment(md, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    const out = await yDocToMarkdown(doc)
    expect(out).toBe(md)
  })
})
```

Add golden fixtures (real files under the fixtures dir). Create `callout-writeback.md`:

```
> [!info]
> Heads up
```

Create `youtube-writeback.md`:

```
![embed](https://youtu.be/abc123)
```

Create `bookmark-writeback.md`:

```
![bookmark](https://example.com/post)
```

Create `file-writeback.md`:

```
<!-- file:{"url":"memry://x","name":"x.pdf","size":10,"mimeType":"application/pdf"} -->
```

- [ ] **Step 2: Run it, expect FAIL.** Run `pnpm --filter @memry/desktop test:main -- blocknote-converter`. Expect the two new round-trip cases FAIL — current main flattens callout/youtube to plain text (`out` is `Heads up` / the raw link text), not the marker.

- [ ] **Step 3: Minimal implementation.** In `blocknote-converter.ts`:
  1. Add server specs mirroring `createServerTaskBlock`, using the shared prop schemas so props never drift, so `ServerBlockNoteEditor` can round-trip these nodes (callout needs `content: 'inline'` for `serializeInner`):

```ts
import {
  TASK_BLOCK_PROP_SCHEMA,
  CALLOUT_PROP_SCHEMA,
  YOUTUBE_PROP_SCHEMA,
  BOOKMARK_PROP_SCHEMA,
  FILE_PROP_SCHEMA
} from '@memry/markdown/schema-props'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from '@memry/markdown'

const throwingRender = () => {
  throw new Error('server block spec is serialization-only and must not be rendered')
}

const createServerTaskBlock = createBlockSpec(
  { type: 'taskBlock' as const, propSchema: TASK_BLOCK_PROP_SCHEMA, content: 'none' },
  { render: throwingRender }
)
const createServerCalloutBlock = createBlockSpec(
  { type: 'callout' as const, propSchema: CALLOUT_PROP_SCHEMA, content: 'inline' },
  { render: throwingRender }
)
const createServerYoutubeBlock = createBlockSpec(
  { type: 'youtubeEmbed' as const, propSchema: YOUTUBE_PROP_SCHEMA, content: 'none' },
  { render: throwingRender }
)
const createServerBookmarkBlock = createBlockSpec(
  { type: 'bookmark' as const, propSchema: BOOKMARK_PROP_SCHEMA, content: 'none' },
  { render: throwingRender }
)
const createServerFileBlock = createBlockSpec(
  { type: 'file' as const, propSchema: FILE_PROP_SCHEMA, content: 'none' },
  { render: throwingRender }
)

const serverSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    taskBlock: createServerTaskBlock(),
    callout: createServerCalloutBlock(),
    youtubeEmbed: createServerYoutubeBlock(),
    bookmark: createServerBookmarkBlock(),
    file: createServerFileBlock()
  }
})
```

2. Delete the duplicated private helpers (lines ~197–458 of the current file): `isEmptyParagraph`, `createEmptyParagraph`, `MARKDOWN_LIST_BLOCK_TYPES`, `serializeBlocks`, `canSerializeChildNatively`, `hasMarkerSerializedChildren`, `parseMarkdownChunkPreservingNesting`, `serializeBlocksWithNestingMarkers`, `markdownToBlocksPreserving`, `parseContentWithColorMarkers`, `blocksToMarkdownPreserving`.
3. Repoint the two internal callers to the shared skeleton (the `ServerBlockNoteEditor` satisfies `MarkdownEditorPort` structurally — it has `tryParseMarkdownToBlocks` and `blocksToMarkdownLossy`):

```ts
export async function yDocToMarkdown(
  doc: Y.Doc,
  fragmentName = CRDT_FRAGMENT_NAME
): Promise<string | null> {
  try {
    const editor = getEditor()
    const fragment = doc.getXmlFragment(fragmentName)
    const blocks = editor.yXmlFragmentToBlocks(fragment)
    if (blocks.length === 0) return ''
    return await serializeBlocksPreservingBlanks(editor as never, blocks as Block[])
  } catch (err) {
    log.error('Yjs-to-markdown conversion failed', err)
    return null
  }
}

export async function markdownToBlocks(markdown: string): Promise<Block[] | null> {
  try {
    const editor = getEditor()
    return (await parseMarkdownPreservingBlanks(editor as never, markdown)) as Block[]
  } catch (err) {
    log.error('Markdown-to-blocks conversion failed', err)
    return null
  }
}
```

Keep `getEditor`, `ensureBlockIds`, `blocksToYFragment`, `repairEmptyBlockIds`, `markdownToYFragment`, `yFragmentToBlocks` exactly as they are. Remove now-unused imports (`splitMarkdownPreservingBlanks`, `assembleMarkdownWithBlanks`, `separateBlockImages`, `normalizeSerializedMarkdown`, the block-colors/inline-colors/block-nesting families, `PartialBlock` if unreferenced) — run lint to find the orphans. 4. In `blocknote-converter.test.ts`, delete the skeleton-only cases that now live in `convert.test.ts` (blank-line/nesting/color-marker unit cases) but KEEP every case that exercises `ServerBlockNoteEditor`, Yjs fragments, code-block language, `repairEmptyBlockIds`, and task normalization.

- [ ] **Step 4: Run tests, expect PASS.** Run `pnpm --filter @memry/desktop test:main -- blocknote-converter` → the two new round-trip cases now pass. Run the golden gate with the new fixtures: `pnpm --filter @memry/desktop test:main -- byte-preservation.golden` → all fixtures (now `>= 18`) pass. Run `pnpm lint` and `pnpm typecheck` → clean. If native load error, `pnpm --filter @memry/desktop rebuild:node`.

- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/sync/blocknote-converter.ts apps/desktop/src/main/sync/blocknote-converter.test.ts apps/desktop/src/main/vault/__fixtures__ && git commit -m "refactor(sync): delegate main serializer to @memry/markdown, close custom-block writeback gap"`

---

## Task 7: Scaffold `@memry/editor-web`; move `editor-schema` + block/inline specs; repoint desktop renderer

**Files:**

- Create `apps/editor-web/package.json`, `apps/editor-web/tsconfig.json`, `apps/editor-web/vitest.config.ts`
- Create `apps/editor-web/src/editor-schema.ts` (moved) + `apps/editor-web/src/index.ts`
- Move to `apps/editor-web/src/blocks/`: `callout-block.tsx`, `file-block.tsx`, `youtube-embed-block.tsx`, `bookmark-block.tsx`, `bookmark-block-render.tsx`, whole `task-block/` dir (`index.tsx`, `task-block-renderer.tsx`, `task-block-utils.ts`, `task-creation-popover.tsx`, `task-prefetch-context.tsx`, `use-task-block-data.ts`, `__tests__/`, `task-slash-menu-item.test.ts`, `task-block-renderer.test.tsx`, `use-task-block-data.test.tsx`)
- Move to `apps/editor-web/src/inlines/`: `wiki-link.tsx`+`wiki-link-utils.ts`+`wiki-link-menu.tsx`+`wiki-link-preview-card.tsx` (+ tests), `hash-tag.tsx`+`hash-tag-inline-plugin.ts`+`hash-tag-space-plugin.ts`+`hash-tag-menu.tsx` (+ tests), `link-mention.ts`+`link-mention-utils.ts`+`link-mention-preview-card.tsx` (+ tests), `date-mention.tsx`+`date-mention-utils.ts`+`date-mention-options.ts`+`date-mention-ghost.ts`+`date-mention-ghost-plugin.ts`+`date-mention-popover.tsx` (+ tests)
- Modify old renderer paths → re-export shims
- Modify `apps/desktop/src/renderer/src/components/note/content-area/{editor-schema.ts,ContentArea.tsx,hooks/use-block-note-setup.ts,hooks/use-editor-sync.ts}` → repoint imports
- Modify `apps/desktop/package.json` → add `@memry/editor-web`, `@memry/markdown`

**Interfaces:**

- Consumes: `@memry/markdown` (all convert + codec + schema-prop exports); `@memry/shared`; `@memry/i18n/renderer`.
- Produces: `editorSchema = BlockNoteSchema.create({...})`, `type EditorSchema = typeof editorSchema`, and every block/inline creator (`createCalloutBlock`, `createFileBlock`, `createFileBlockContent`, `createYoutubeEmbedBlock`, `createBookmarkBlock`, `createTaskBlock`, `getTaskSlashMenuItem`, `WikiLink`, `parseWikiLinkText`, `createWikiLinkInlineContent`, `HashTag`, `createHashTagInlineContent`, `normalizeHashTags`, `extractInlineTags`, `LinkMention`, `serializeLinkMentionToken`, `parseLinkMentionToken`, `MENTION_TOKEN_REGEX`, `createLinkMentionContent`, `DateMention`, `createDateMentionContent`, `formatDateMentionLabel`, `setDateMentionPrefs`, `createDateMentionPillDom`).
- **Prop-schema invariant:** each moved React block spec MUST replace its inline `propSchema` object with the imported constant from `@memry/markdown/schema-props` (`createTaskBlock` → `TASK_BLOCK_PROP_SCHEMA`, `createCalloutBlock` → `CALLOUT_PROP_SCHEMA`, etc.) so it can never drift from the main server specs.

- [ ] **Step 1: Write the failing test.** Create `apps/editor-web/package.json`, `tsconfig.json`, `vitest.config.ts` (jsdom env, mirror the renderer's setup shims for Radix Popover / `Element.scrollTo`). Add `apps/editor-web/src/editor-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { editorSchema } from './editor-schema'

describe('editorSchema', () => {
  it('registers the 6 custom blocks and 4 custom inlines', () => {
    const blocks = Object.keys(editorSchema.blockSchema)
    const inlines = Object.keys(editorSchema.inlineContentSchema)
    expect(blocks).toEqual(
      expect.arrayContaining(['file', 'callout', 'youtubeEmbed', 'bookmark', 'taskBlock'])
    )
    expect(inlines).toEqual(
      expect.arrayContaining(['wikiLink', 'hashTag', 'linkMention', 'dateMention'])
    )
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Run `pnpm --filter @memry/editor-web test editor-schema`. Expect: no such filter / `Cannot find module './editor-schema'`.

- [ ] **Step 3: Minimal implementation.** Create `apps/editor-web/package.json`:

```json
{
  "name": "@memry/editor-web",
  "version": "0.1.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "build:lib": "vite build --mode lib",
    "build:standalone": "vite build --mode standalone"
  },
  "dependencies": {
    "@blocknote/code-block": "^0.47.1",
    "@blocknote/core": "^0.47.1",
    "@blocknote/react": "^0.47.1",
    "@blocknote/shadcn": "^0.47.1",
    "@blocknote/xl-ai": "^0.47.1",
    "@memry/i18n": "workspace:*",
    "@memry/markdown": "workspace:*",
    "@memry/shared": "workspace:*"
  },
  "peerDependencies": { "react": "^19", "react-dom": "^19" },
  "devDependencies": {
    "@memry/typescript-config": "workspace:*",
    "@vitejs/plugin-react": "^4.3.0",
    "react": "^19",
    "react-dom": "^19",
    "vite": "^6.0.0",
    "vitest": "^3.2.0"
  }
}
```

`git mv` each block/inline file into `apps/editor-web/src/blocks/**` and `apps/editor-web/src/inlines/**` (paths listed in Files). For every moved file, rewrite its imports: BlockNote imports stay; pure codec halves come from `@memry/markdown/codecs`; prop schemas from `@memry/markdown/schema-props`; icons/i18n keep their `@/lib/...` / `@memry/i18n/renderer` paths — but those `@/` aliases resolve to the desktop renderer. Since editor-web is a separate app, replace desktop `@/lib/*` imports used by the specs with either a moved local helper or a `@memry/shared` equivalent (audit each moved file's `@/` imports; the small ones — `youtube-utils` thumbnails, `icons`, `url-metadata.fetchLinkPreview` — move into `apps/editor-web/src/lib/` or import from `@memry/shared`). Create `apps/editor-web/src/editor-schema.ts` (moved verbatim from the renderer, imports now relative to `./blocks` / `./inlines`). Create `apps/editor-web/src/index.ts`:

```ts
export { editorSchema, type EditorSchema } from './editor-schema'
export * from './blocks/callout-block'
export * from './blocks/file-block'
export * from './blocks/youtube-embed-block'
export * from './blocks/bookmark-block'
export * from './blocks/task-block'
export * from './inlines/wiki-link'
export * from './inlines/hash-tag'
export * from './inlines/link-mention'
export * from './inlines/date-mention'
export * from './transport'
export * from '@memry/markdown'
```

Leave a re-export shim at EACH old renderer path so untouched desktop importers stay green, e.g. the renderer `editor-schema.ts`:

```ts
export { editorSchema, type EditorSchema } from '@memry/editor-web'
```

and e.g. the renderer `callout-block.tsx`:

```ts
export { createCalloutBlock, getCalloutSlashMenuItem } from '@memry/editor-web'
export {
  serializeCalloutBlock,
  splitMarkdownByCallouts,
  CALLOUT_TYPES
} from '@memry/markdown/codecs'
```

Repoint the four hot consumers directly at the packages (drop the shim dependency for the files we touch anyway): `ContentArea.tsx`, `use-block-note-setup.ts`, `use-editor-sync.ts` import `editorSchema`/specs from `@memry/editor-web` and parse/serialize from `@memry/markdown`. Add `@memry/editor-web` + `@memry/markdown` to `apps/desktop/package.json` dependencies. Create `apps/editor-web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'standalone' ? [viteSingleFile()] : [])],
  build:
    mode === 'lib'
      ? { lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' }, outDir: 'dist/lib' }
      : { outDir: 'dist/standalone', assetsInlineLimit: 100_000_000 }
}))
```

Create `apps/editor-web/index.html` mounting the standalone WebView bundle against `editorSchema` + `createWebViewTransport()` (Task 8 provides the transport). Add `vite-plugin-singlefile` to devDependencies.

- [ ] **Step 4: Run tests, expect PASS.** Run `pnpm install`. Run `pnpm --filter @memry/editor-web test` → moved block/inline tests + `editor-schema.test.ts` pass (fix jsdom setup shims as they surface — Radix Popover won't open in jsdom, assign `Element.prototype.scrollTo`). Run the desktop renderer suite `pnpm --filter @memry/desktop test:renderer` → green through the shims + repointed imports. Run `pnpm typecheck` and `pnpm lint` → clean. Run `pnpm check:architecture` to confirm main still has no `@blocknote/react`/editor-web import.

- [ ] **Step 5: Commit.** `git add apps/editor-web apps/desktop && git commit -m "refactor(editor-web): extract editorSchema + block/inline specs into @memry/editor-web"`

---

## Task 8: Add `EditorTransport` seam, standalone WebView bundle, and version-pin CI gate

**Files:**

- Create `apps/editor-web/src/transport.ts`
- Create `apps/editor-web/src/transport.test.ts`
- Modify `apps/editor-web/index.html` (wire `createWebViewTransport`)
- Modify `apps/desktop/src/renderer/src/components/note/content-area/hooks/use-editor-sync.ts` (wrap existing IPC Y.Doc provider in `createIpcTransport`)
- Create `packages/markdown/src/pins.test.ts` (version-pin gate) + `scripts/check-blocknote-pins.mjs`
- Modify root `package.json` scripts (`check:blocknote-pins`) + `turbo.json` (register both new packages' `test`/`typecheck`/`build` tasks)

**Interfaces:**

- Produces:

```ts
export interface EditorTransport {
  postYjsUpdate(update: Uint8Array): void
  onYjsUpdate(cb: (update: Uint8Array) => void): void
  onReady(cb: () => void): void
}
export function createIpcTransport(deps: {
  send(update: Uint8Array): void
  subscribe(cb: (update: Uint8Array) => void): () => void
}): EditorTransport
export function createWebViewTransport(): EditorTransport
```

- The desktop adapter wraps the existing `yjs-ipc-provider` used by `use-editor-sync.ts`; the mobile adapter wraps `window.ReactNativeWebView.postMessage` with base64-encoded binary updates and origin tagging (loop prevention), per spec §4/§9.

- [ ] **Step 1: Write the failing test.** Create `apps/editor-web/src/transport.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createIpcTransport } from './transport'

describe('createIpcTransport', () => {
  it('forwards posted updates to send and delivers subscribed updates', () => {
    const send = vi.fn()
    let subCb: ((u: Uint8Array) => void) | null = null
    const transport = createIpcTransport({
      send,
      subscribe: (cb) => {
        subCb = cb
        return () => {}
      }
    })
    const received: Uint8Array[] = []
    transport.onYjsUpdate((u) => received.push(u))
    transport.postYjsUpdate(new Uint8Array([1, 2]))
    subCb?.(new Uint8Array([3, 4]))
    expect(send).toHaveBeenCalledWith(new Uint8Array([1, 2]))
    expect(received).toEqual([new Uint8Array([3, 4])])
  })
})
```

- [ ] **Step 2: Run it, expect FAIL.** Run `pnpm --filter @memry/editor-web test transport`. Expect: `Cannot find module './transport'`.

- [ ] **Step 3: Minimal implementation.** Create `apps/editor-web/src/transport.ts`:

```ts
export interface EditorTransport {
  postYjsUpdate(update: Uint8Array): void
  onYjsUpdate(cb: (update: Uint8Array) => void): void
  onReady(cb: () => void): void
}

export function createIpcTransport(deps: {
  send(update: Uint8Array): void
  subscribe(cb: (update: Uint8Array) => void): () => void
}): EditorTransport {
  const readyCbs: Array<() => void> = []
  return {
    postYjsUpdate: (update) => deps.send(update),
    onYjsUpdate: (cb) => {
      deps.subscribe(cb)
    },
    onReady: (cb) => {
      readyCbs.push(cb)
      cb()
    }
  }
}

// Mobile: RN owns the Y.Docs; the bundle mirrors updates over postMessage as
// base64 (RN bridge is string-only) with an origin tag so echoed updates from
// our own postMessage are ignored (loop prevention).
export function createWebViewTransport(): EditorTransport {
  const listeners: Array<(u: Uint8Array) => void> = []
  const readyCbs: Array<() => void> = []
  const rn = (globalThis as { ReactNativeWebView?: { postMessage(s: string): void } })
    .ReactNativeWebView

  const toB64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u))
  const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

  window.addEventListener('message', (e: MessageEvent) => {
    try {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : '')
      if (msg?.origin === 'editor-web') return
      if (msg?.type === 'yjs-update') listeners.forEach((cb) => cb(fromB64(msg.update)))
      if (msg?.type === 'ready') readyCbs.forEach((cb) => cb())
    } catch {
      /* non-JSON host messages are ignored */
    }
  })

  return {
    postYjsUpdate: (update) =>
      rn?.postMessage(
        JSON.stringify({ origin: 'editor-web', type: 'yjs-update', update: toB64(update) })
      ),
    onYjsUpdate: (cb) => {
      listeners.push(cb)
    },
    onReady: (cb) => {
      readyCbs.push(cb)
    }
  }
}
```

Wire the desktop side in `use-editor-sync.ts`: build `createIpcTransport({ send, subscribe })` where `send`/`subscribe` bridge the existing `yjs-ipc-provider` (do not change the provider — just adapt it). Wire `index.html` to instantiate the BlockNote editor with `editorSchema` and `createWebViewTransport()`. Add the pin gate `packages/markdown/src/pins.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))

const BLOCKNOTE = ['@blocknote/core', '@blocknote/react', '@blocknote/code-block']

describe('blocknote version lockstep', () => {
  const desktop = read('../../../apps/desktop/package.json').dependencies
  const editorWeb = read('../../../apps/editor-web/package.json').dependencies
  const markdown = read('../package.json').dependencies

  it('pins @blocknote/core identically across desktop, editor-web, markdown', () => {
    expect(editorWeb['@blocknote/core']).toBe(desktop['@blocknote/core'])
    expect(markdown['@blocknote/core']).toBe(desktop['@blocknote/core'])
  })

  it('pins every @blocknote/* in editor-web to the desktop version', () => {
    for (const dep of BLOCKNOTE) expect(editorWeb[dep]).toBe(desktop[dep])
  })
})
```

Add `scripts/check-blocknote-pins.mjs` (same assertion, exit 1 on drift) and a root `package.json` script `"check:blocknote-pins": "node scripts/check-blocknote-pins.mjs"`. Register both new packages in `turbo.json` (`test`, `typecheck`, `build:lib` tasks) and add project references in the root `tsconfig.json` so `pnpm typecheck` includes them.

- [ ] **Step 4: Run tests, expect PASS.** Run `pnpm --filter @memry/editor-web test transport` → `1 passed`. Run `pnpm --filter @memry/markdown test pins` → `2 passed`. Run `node scripts/check-blocknote-pins.mjs` → exit 0. Build the standalone bundle: `pnpm --filter @memry/editor-web build:standalone` → single-file `dist/standalone/index.html` emitted with inlined assets. Run full gates: `pnpm typecheck`, `pnpm lint`, `pnpm --filter @memry/desktop test:renderer`, `pnpm --filter @memry/desktop test:main -- byte-preservation.golden`, `pnpm check:architecture` → all green.

- [ ] **Step 5: Commit.** `git add apps/editor-web apps/desktop packages/markdown scripts/check-blocknote-pins.mjs package.json turbo.json tsconfig.json && git commit -m "feat(editor-web): add EditorTransport seam, standalone WebView bundle, and blocknote version-pin gate"`

---

## Final verification (run before declaring the workstream done)

- [ ] `pnpm lint` — clean
- [ ] `pnpm typecheck` — clean across all packages incl. `@memry/markdown` + `@memry/editor-web`
- [ ] `pnpm --filter @memry/markdown test` — all green
- [ ] `pnpm --filter @memry/editor-web test` — all green
- [ ] `pnpm --filter @memry/desktop test:renderer` — green (renderer consumes both new packages)
- [ ] `pnpm --filter @memry/desktop test:main -- blocknote-converter` — green (main delegates; custom-block gap closed)
- [ ] `pnpm --filter @memry/desktop test:main -- byte-preservation.golden` — green with the new callout/youtube/bookmark/file writeback fixtures (the @blocknote bump gate)
- [ ] `pnpm check:architecture` — main process stays React-free (no `@blocknote/react` / `@memry/editor-web` import from `src/main`)
- [ ] `pnpm check:blocknote-pins` — `@blocknote/*` identical across desktop / editor-web / markdown
- [ ] `pnpm --filter @memry/editor-web build:standalone` — single-file WebView bundle builds
- [ ] `git diff --check` — no whitespace errors
