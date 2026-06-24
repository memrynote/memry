# Ponytail Audit — Memry Electron Monorepo

> Whole-repo over-engineering hunt. **Complexity only** — correctness bugs, security, and performance are out of scope (separate review pass). This report **lists**; it applies nothing.
>
> Scope: `apps/desktop` (~440k LOC main+renderer+preload), `apps/sync-server`, `apps/extension`, 25 `packages/*`, root `scripts/` + build automation.
> Method: 5 parallel hunters, each grep-verified caller/import counts. Headline deletes re-verified by hand (see notes).
> Tags: `delete:` dead code · `stdlib:` reinvented stdlib · `native:` platform already does it · `yagni:` abstraction with one user · `shrink:` same logic, fewer lines.

---

## Headline numbers

| Lever                                    | Realizable cut                                             |
| ---------------------------------------- | ---------------------------------------------------------- |
| **Dependencies removable**               | **~9** (8 npm packages + 1 `@types`)                       |
| **npm packages (workspace) collapsible** | **~14–16** (12 importers→1, + 3 thin domain/storage folds) |
| **Scripts deletable / replaceable**      | **~8 hard, ~4 large rewrites**                             |
| **Lines removable**                      | **~5,000–6,000**                                           |

Three tiers below, ranked **biggest cut first** within each. Start with **Tier 1** (verified-dead, near-zero risk). Tiers 2–3 are judgment calls flagged with effort/risk.

---

## Tier 1 — Verified dead. Delete now. (low risk)

These are confirmed by grep to have **zero imports / zero callers / zero automation references**. No behavior change.

### Dependencies (re-verified by hand — all 0 imports)

`delete:` `radix-ui` umbrella package — pulls ALL Radix; 31 files import scoped `@radix-ui/*` (already declared), zero `from 'radix-ui'`. [apps/desktop/package.json]
`delete:` `sodium-native` — 0 imports anywhere; crypto uses `libsodium-wrappers-sumo` (67 files). Not in packaged-runtime allowlist. [apps/desktop/package.json]
`delete:` `happy-dom` — 0 imports; every vitest project uses `environment: 'jsdom'`. [apps/desktop/package.json]
`delete:` `pdf-parse` + `@types/pdf-parse` — 0 imports; PDF uses `pdfjs-dist`/`react-pdf`. [apps/desktop/package.json]
`delete:` `idb` — 0 direct imports; IndexedDB covered by `y-indexeddb`. [apps/desktop/package.json]
`delete:` `cobe` (WebGL globe) — 0 imports in src. [apps/desktop/package.json]
`delete:` `marked` + `dompurify` in the extension — runtime deps, 0 imports; its `@memry/article-extract` dep uses `defuddle`+`linkedom`. [apps/extension/package.json]
`native:` `framer-motion` — sole importer `tasks/celebration-progress.tsx` imports `{ motion, AnimatePresence }`, both re-exported by the already-present `motion` package. **Needs a 1-line import swap** (`framer-motion` → `motion/react`), then drop the dep. [apps/desktop/package.json]

> Keep (verified justified, do not re-flag): `nanoid` (variable-length readable file IDs via `customAlphabet` — `crypto.randomUUID` can't), `safe-buffer` (pinned transitive, asserted in `runtime-dependencies.test.ts`), `date-fns`/`mime-types`/`pako`/`openai`+`@ai-sdk/openai` (distinct real uses).

### Dead code

`delete:` **OneNote importer** — registration is commented out (`register-builtins.ts:39`) pending an Azure app that doesn't exist; no live caller. Delete the 4-file dir + the `packages/onenote-import` package. [apps/desktop/src/main/import/onenote/*, packages/onenote-import] — **~567 LOC + a package**
`delete:` 8 unused exports in `url-utils.ts` (`parseUrl`, `extractBaseDomain`, `normalizeUrl`, `isPdfUrl`, `isImageUrl`, `isVideoUrl`, `isAudioUrl`, `getUrlContentType`) — 0 callers repo-wide. [apps/desktop/src/main/lib/url-utils.ts] — **~105 LOC**
`delete:` `extractSnippet` — exported, 0 callers. [apps/desktop/src/main/lib/search-utils.ts:103]
`delete:` two dead renderer hooks `useFocusManagement` + `useThrottledTabSwitch` — only callers are the barrel + a test that exists solely to test them. Delete hooks, barrel lines, and the test blocks. [hooks/use-focus-management.ts, hooks/use-throttled-tab-switch.ts, hooks/index.ts:27-28, hooks/missing-hooks.test.tsx] — **~80 LOC**
`delete:` over-`export`ed file-internal helpers — drop the `export` keyword (callers are in-file only): `markdownToHtml`/`escapeHtml`/`getEmbeddedStyles` [main/lib/export-utils.ts], `escapeSearchQuery` [main/lib/search-utils.ts:14].

### Dead scripts / config (re-verified)

`delete:` `apps/desktop/scripts/test-metascraper.mjs` — 0 references anywhere (no package.json/CI/husky). Scratch script. [~84 LOC]
`delete:` `generate:icons-alt` package script → points at `scripts/generate-icons-alt.mjs` which **does not exist**. Dead key. [apps/desktop/package.json:92]
`delete:` `check:contract-boundaries` — byte-identical duplicate alias of `check:contracts`, referenced nowhere (only `check:contracts` runs, via `pretypecheck`). [package.json:58]
`delete:` `outdated:check` — defined, invoked by no hook/CI. [package.json]
`delete:` 3 co-located `*.test.mjs` run by **no** runner (absent from `test:release`, every vitest glob, and CI): `check-staged-secrets.test.mjs`, `docs-impact.test.mjs`, `check-staged-renderer-guards.test.mjs`. [scripts/] — **~7 KB**
`delete:` (soft) `check-native.js` + `check:native` script — defined but invoked by no husky/CI; usable only as a manual `pnpm check:native`. Drop if you don't run it by hand. [apps/desktop/scripts/check-native.js, package.json:60] — **~70 LOC**

---

## Tier 2 — Reinvented stdlib / platform. Replace. (low–medium risk)

`stdlib:` **3 hand-rolled RFC-4180 CSV tokenizers** (~315 LOC), near-identical — ticktick/todoist parsers differ only by type name. Extract one `parseCsv`. [packages/csv-import/src/parse-csv.ts, packages/ticktick-import/src/parse-csv.ts, packages/todoist-import/src/parse-csv.ts]
`stdlib:` **`parseArgs()` hand-rolled in ~11 scripts** (`for` loops over `process.argv`) — `node:util` `parseArgs` ships this. ~15–30 LOC each. [scripts/*.mjs, apps/desktop/scripts/*]
`stdlib:` `sleep`/`delay` reinvented 3× as `(ms)=>new Promise(r=>setTimeout(r,ms))` — hoist one helper (signal-aware one already exists at `sync/retry.ts:44`). [sync/upload-queue.ts:133, import/onenote/onenote-graph.ts:53]
`stdlib:` `walk()` recursive-readdir copy-pasted in both boundary checkers + `repair-package-links.js` — `fs.readdirSync(dir,{recursive:true})` / `fs.glob` replaces all three. [check-architecture-boundaries.js:70, check-contract-boundaries.js:22]
`native:` `useDebouncedValue` defined **3× identically** — keep the export at `hooks/use-task-filters.ts:26`, delete the two verbatim copies. [pages/folder-view.tsx:19-33, components/inbox-detail/link-input.tsx:20-32] — **~26 LOC**
`stdlib:` `utcNow()` is `new Date().toISOString()` wrapped as a package export — inline it. [packages/shared/src/utc.ts]
`shrink:` several raw-`keydown` keyboard hooks (`useSearchShortcut`/`useNewNoteShortcut`/`useSaveFilterShortcut`) re-hand-roll the `useEffect`+`isMac` block that `use-keyboard-shortcuts-base.ts` already provides (see `useSettingsShortcut`). Route through `useKeyboardShortcuts`. [hooks/] — **~30 LOC**

---

## Tier 3 — Single-user abstractions (YAGNI). Collapse. (judgment / higher effort)

Ranked by cut size. These are correct calls but bigger diffs — confirm intent before swinging.

`yagni:` **Collapse the 12 importer-logic packages → one `@memry/importers`** with a module per source (apple-journal/apple-notes/bear/csv/evernote/google-keep/html/markdown/onenote/roam/ticktick/todoist). Each has **exactly 1 consumer** (its desktop `*-importer.ts`), nearly all are dependency-free pure functions; 12× package.json + tsconfig + build entries are pure monorepo overhead with no shared-versioning benefit. [packages/*-import] — **−11 packages**
`yagni:` **7 `*SyncService` classes are thin wrappers over `RecordSyncController`** — each adds an init/get/reset singleton trio + 3 pure-forwarding enqueueCreate/Update/Delete methods. Collapse to one generic factory over the controller config. [sync/{filter,inbox,tag-definition,folder-config,calendar-source,calendar-binding,calendar-external-event}-sync.ts] — **~540 LOC**
`yagni:` **5 near-identical inbox type→icon switch components** — `InboxTypeIcon` (new, full map) supersedes `ItemTypeIcon`, two `TypeIcon`s, `ListTypeIcon`. Collapse to one + optional `transcriptionStatus` prop. [components/inbox/inbox-type-icon.tsx, inbox-list.tsx:122, bulk/bulk-file-panel.tsx:18, inbox-detail/content-section.tsx:123] — **~90 LOC**
`yagni:` `packages/domain-inbox` (782 LOC) is a single-consumer abstraction layer (`main/inbox/domain.ts`) — fold into the desktop inbox module, or merge the three `domain-*` into one `@memry/domain`. [packages/domain-inbox]
`yagni:` `packages/storage-vault` (242 LOC, no deps) is just `note-content-store` + `journal-format` file I/O — fold into `@memry/storage-data`. [packages/storage-vault]
`yagni:` `packages/domain-notes` (161 LOC, 1 real consumer) — inline `buildCanonicalNoteMetadata`/`resolveNoteSyncPolicy` into storage-data or the desktop caller. [packages/domain-notes]
`yagni:` `SocialPlatform` is a single-member union (`'twitter'`) threaded through `detectSocialPlatform`/`isSocialPost`/`extractSocialPost` — inline as boolean `isTwitterPost`. [lib/url-utils.ts:15, inbox/social.ts]
`yagni:` `contexts/index.ts` barrel has **zero consumers** (every caller imports `@/contexts/tabs` etc. directly). Delete. [renderer contexts/index.ts] — **~47 LOC**
`yagni:` `ai-inline-context.tsx` — a Context with a single consumer wrapping a single provider; drop the context layer, call `useAIInline(...)` where consumed. [contexts/ai-inline-context.tsx]
`shrink:` `inbox-zero-state.tsx` (113 LOC) + its 2-line barrel are used only by `empty-state.tsx` — inline + drop the barrel. [components/empty-state/*]
`shrink:` `@memry/rpc` `defineMethod`/`defineEvent`/`defineDomain` are no-op identity factories (return config as-is, only attach phantom generics) — collapse to plain typed object literals. **(The package stays — it's the codegen source for `ipc:generate`, NOT a re-export of contracts.)** [packages/rpc/src/schema.ts]
`shrink:` preload `api/*` (17 files, ~1000 LOC of mechanical `invoke()`/`subscribe()`) — `generated-rpc.ts` already proves these are codegen-able; extend the generator to the hand-written ones. [apps/desktop/src/preload/api]
`shrink:` sync-server: 2 copy-pasted "query batch → R2 delete → D1 delete" blocks in `cleanupExpiredTombstones`/`cleanupOrphanedBlobChunks` — one helper. [apps/sync-server/src/services/cleanup.ts]

### Heavyweight automation (large rewrites — decide deliberately)

`native:` `check-architecture-boundaries.js` (452 LOC) is a hand-rolled import-graph walker doing what `eslint-plugin-import` `no-restricted-paths` / `eslint-plugin-boundaries` does declaratively. [scripts/check-architecture-boundaries.js]
`native:` `check-contract-boundaries.js` (131 LOC) — same hand-rolled walker for ONE rule; a single eslint `no-restricted-imports` block replaces it. [scripts/check-contract-boundaries.js]
`native:` `check-staged-secrets.mjs` (291 LOC + dead test) reinvents gitleaks/trufflehog with regex + a TS-type/placeholder heuristic engine — a standard pre-commit secrets hook replaces it. [scripts/check-staged-secrets.mjs]
`native:` `check-staged-renderer-guards.mjs` (94 LOC) flags `console.*` + physical Tailwind classes — eslint already lints these files; add `no-console` + a logical-props rule and delete the hook. [scripts/check-staged-renderer-guards.mjs]
`yagni:` `apps/desktop/scripts/i18n/scan-source.mjs` (568 LOC) is a second untranslated-literal scanner duplicating the 4 wired i18n eslint rules; exists only to count `i18n.todo` markers. Collapse onto eslint. [apps/desktop/scripts/i18n/scan-source.mjs]
`yagni:` **release pipeline** (`release.mjs` 254 + `humanize-release-notes.mjs` 254 + `build-reddit-release-post.mjs` 135 + 3 `*-utils.mjs` + ~28 KB tests) — bespoke `gh`-CLI + LLM orchestration for a pre-prod solo app; `gh release create` / `release-drafter.yml` replaces ~90%. [scripts/release*.mjs] — **~1000 LOC**
`yagni:` **docs-impact / docs-ai-update pipeline** (217 + 137 LOC + test + pre-push branch logic) gates every push on spawning Codex to write VitePress docs; a path-glob CI label replaces it. [scripts/docs-impact.mjs, scripts/docs-ai-update.mjs] — **~400 LOC**
`native:` `run-turbo.js` (39 LOC) wraps `spawnSync(turbo)` with a pnpm-store fallback — `turbo run …` / `pnpm exec turbo` directly removes the indirection. [scripts/run-turbo.js]
`yagni:` `doctor.config.ts` mutes ~70 of react-doctor's rules (tool is disabled-by-config) — prune to what you enforce, or drop config + script + workflow. [doctor.config.ts]
`shrink:` `release.mjs` + `humanize-release-notes.mjs` redefine identical `runGh`/`readGhJson`/`confirmDispatch`/`sleep` — hoist to the already-imported `release-utils.mjs`. ~40 LOC.

---

## Not over-engineered — leave alone (so they don't get re-flagged)

- **Home-dashboard widget system** (`widget-registry`/`widget-frame`/`board-grid`/5 widgets) — registry has 5 real registrations consumed by both render + add-menu; drag/resize/config is shared chrome; `ConfigEditor` is correctly optional (only `folder` needs it).
- **`@memry/contracts`** (495 consumers, real Zod IPC boundary), **`@memry/i18n`** (568 consumers), **`@memry/article-extract`** (real desktop + extension consumers).
- **`@memry/rpc`** — it's the codegen _source_ feeding `ipc:generate`, not a contracts re-export. Only its 3 identity factories are trim-able (Tier 3).
- **Import framework core** — registry is a 35-line Map wrapper, context is real IPC progress plumbing, `preview()` is used by csv/notion and surfaced in Settings. Keep the framework; collapse the 12 _packages_ (Tier 3).
- `dotenv` in Electron main — `--env-file` isn't honored cleanly across packaged/dev; not a safe cut (unverified).

---

## Recommended execution order (safest cut-per-effort first)

1. **Tier 1 deletes** — drop 8 deps + `framer-motion` swap; delete OneNote, the dead exports/hooks, the 4 dead script/config keys, 3 dead tests. One PR, all grep-verified dead. _(~−1,000 LOC, −9 deps, −1 package)_
2. **Tier 2 stdlib swaps** — dedupe CSV parser, `useDebouncedValue`, `sleep`, `walk`; adopt `node:util parseArgs`. _(~−450 LOC)_
3. **Tier 3 quick wins** — 7 `*SyncService` factory collapse, 5 type-icons → 1, barrels/single-consumer contexts. _(~−700 LOC)_
4. **Tier 3 package consolidation** — 12 importers → `@memry/importers`; fold `storage-vault`/`domain-notes`/`domain-inbox`. _(−14 packages — bigger diff, one focused PR)_
5. **Automation rewrites** — only if you want them: boundary checkers → eslint rules, secrets → gitleaks, release/docs pipelines → `gh`/CI. _(~−2,400 LOC — each its own decision)_

**net: ~−5,000 to −6,000 lines, −9 deps, −14 to −16 workspace packages possible.**
