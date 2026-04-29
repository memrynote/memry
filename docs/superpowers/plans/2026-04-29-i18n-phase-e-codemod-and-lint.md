# i18n Phase E Codemod and Lint Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add Memry's Phase E i18n enforcement tooling: `pnpm i18n:check`, a JSX text literal ESLint gate, and a conservative TODO codemod for remaining untranslated UI strings.

**Architecture:** Phase E is tooling/enforcement only. The AST checker validates `t()` references against English resources and reports untranslated JSX/attribute stragglers; the codemod annotates existing stragglers with `TODO(i18n): wrap in t()` instead of adding translations; the ESLint rule blocks new unannotated JSX text literals while allowing the TODO baseline to be ratcheted down. Existing Phase C namespace patterns remain untouched, and shared i18n registry/resource files are read but not rewritten.

**Tech Stack:** Node 24, TypeScript compiler AST, ESLint 9 flat config, local ESLint rule plugin, Node `node:test`, package scripts, `@memry/i18n` locale JSON resources.

---

## Source Context

Read these before editing:

- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-c-settings.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-c-inbox.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-c-notes.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-c-calendar.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-c-journal.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-c-tasks.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-c-graph.md`
- `package.json`
- `apps/desktop/package.json`
- `eslint.config.mjs`
- `apps/desktop/tsconfig.json`
- `apps/desktop/tsconfig.node.json`
- `apps/desktop/tsconfig.web.json`
- `packages/i18n/tsconfig.json`
- `packages/i18n/package.json`
- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/locales/index.ts`
- `packages/i18n/src/main/index.ts`
- `packages/i18n/src/renderer/use-t.ts`
- `apps/desktop/src/main/menu.ts`
- `apps/desktop/src/renderer/src/lib/ipc-error.ts`

Phase C conventions to preserve:

- Feature copy uses the owning namespace, for example `useT('settings')`, `useT('inbox')`, `useT('notes')`, `useT('calendar')`, `useT('journal')`, `useT('tasks')`, and `useT('graph')`.
- Shared generic verbs/states use `useT('common')` only where Phase B already supplied the key.
- `packages/i18n/src/locales/tr/*.json` and `packages/i18n/src/locales/ar/*.json` stay literal `{}` for Phase C/D/E feature namespaces unless a translation plan explicitly changes them.
- Calendar date/month/weekday labels use `Intl.DateTimeFormat(i18n.language, ...)`, not translation JSON.
- User content stays untranslated: note titles, note body text, folder names, tag names, project names, task titles, saved filter/view names, filenames, URLs, and provider/server payloads.
- Shared i18n registry/resource files are conflict-prone. Phase E should read `I18N_NAMESPACES`, `RESOURCES`, and English JSONs; avoid cleanup-only rewrites.

Out of scope:

- Phase D errors/menu migration.
- Adding or changing translations.
- Changing product behavior.
- Broad RTL Tailwind codemod for `ml-*`, `pr-*`, `left-*`, `text-left`, etc. That is a separate future plan unless the spec is explicitly widened.
- Migrating TODO-marked strings into `t()` calls.

## File Structure

Create:

- `apps/desktop/scripts/i18n/check.mjs` - CLI entrypoint for `pnpm i18n:check`.
- `apps/desktop/scripts/i18n/scan-source.mjs` - TypeScript AST scanner for `t()` references and user-facing string surfaces.
- `apps/desktop/scripts/i18n/resources.mjs` - locale JSON loading, namespace/key flattening, and key existence helpers.
- `apps/desktop/scripts/i18n/report.mjs` - stable formatter for pass/warn/fail output.
- `apps/desktop/scripts/i18n/codemod-todo-jsx-literals.mjs` - conservative codemod that annotates stragglers with `TODO(i18n): wrap in t()`.
- `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.mjs` - local ESLint rule implementation.
- `apps/desktop/scripts/i18n/eslint/index.mjs` - local plugin export consumed by `eslint.config.mjs`.
- `apps/desktop/scripts/i18n/fixtures/check/pass.tsx`
- `apps/desktop/scripts/i18n/fixtures/check/missing-key.tsx`
- `apps/desktop/scripts/i18n/fixtures/check/untranslated-jsx.tsx`
- `apps/desktop/scripts/i18n/fixtures/check/allowed-user-content.tsx`
- `apps/desktop/scripts/i18n/fixtures/codemod/input.tsx`
- `apps/desktop/scripts/i18n/fixtures/codemod/output.tsx`
- `apps/desktop/scripts/i18n/resources.test.mjs`
- `apps/desktop/scripts/i18n/scan-source.test.mjs`
- `apps/desktop/scripts/i18n/check.test.mjs`
- `apps/desktop/scripts/i18n/codemod-todo-jsx-literals.test.mjs`
- `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.test.mjs`

Modify:

- `package.json` - add root `i18n:check` and focused i18n tooling test scripts.
- `apps/desktop/package.json` - add desktop `i18n:check`, codemod dry-run, and focused tooling test scripts.
- `eslint.config.mjs` - import the local i18n ESLint plugin and enable the JSX text rule for production renderer TSX only.

Do not modify unless an implementation test proves it is necessary:

- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/locales/index.ts`
- `packages/i18n/src/locales/{en,tr,ar}/*.json`

## Enforcement Policy

`pnpm i18n:check` must fail on:

- `t('namespace:key.path')` or `t('key.path')` calls that do not exist in English resources.
- Unknown namespaces.
- Unannotated user-facing JSX text children in production renderer `.tsx` files.
- Unannotated user-facing string attributes in production renderer `.tsx` files for `aria-label`, `title`, `placeholder`, `alt`, and component props named `label`, `description`, `emptyText`, `tooltip`, or `message` when their value is a plain English string literal.
- New TODO baseline growth if a baseline count option is implemented in this phase.

`pnpm i18n:check` must warn, not fail, on:

- Missing `tr`/`ar` keys that exist in English resources.
- Orphan English keys that are not referenced.
- Existing TODO-annotated stragglers.

The ESLint rule must be a hard error for unannotated JSX text literals in production renderer code. To keep `pnpm lint` usable with the current warning baseline, it should allow existing literals only when the codemod has placed an adjacent `TODO(i18n): wrap in t()` comment. That makes new unannotated literals fail immediately while leaving a visible, ratchetable debt list.

Ignore/exempt:

- `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `apps/desktop/tests/**`, and fixtures unless a test explicitly scans them.
- `data-testid`, `id`, `className`, `role`, `type`, `value` enum-like props, route strings, CSS variables, IPC channels, storage keys, keyboard shortcuts, and one-letter command hints.
- Logs and developer assertion messages that are not presented to users.
- Electron native menu `role` strings; explicit menu labels should already come from `menu.json` after Phase D.
- Service/provider payloads and user-authored content values.

## Chunk 1: AST Checker Core

### Task 1: Add failing scanner tests

**Files:**
- Create: `apps/desktop/scripts/i18n/fixtures/check/pass.tsx`
- Create: `apps/desktop/scripts/i18n/fixtures/check/missing-key.tsx`
- Create: `apps/desktop/scripts/i18n/fixtures/check/untranslated-jsx.tsx`
- Create: `apps/desktop/scripts/i18n/fixtures/check/allowed-user-content.tsx`
- Create: `apps/desktop/scripts/i18n/scan-source.test.mjs`
- Create: `apps/desktop/scripts/i18n/resources.test.mjs`

- [x] **Step 1: Write checker fixture for passing code**

`pass.tsx` should include:

```tsx
import { useT } from '@memry/i18n/renderer'

export function PassingComponent({ noteTitle }: { noteTitle: string }) {
  const { t } = useT('notes')
  return (
    <section aria-label={t('page.title')}>
      <h1>{t('page.empty.title')}</h1>
      <span>{noteTitle}</span>
    </section>
  )
}
```

- [x] **Step 2: Write checker fixture for a missing English key**

`missing-key.tsx` should call an English key that does not exist:

```tsx
import { useT } from '@memry/i18n/renderer'

export function MissingKey() {
  const { t } = useT('notes')
  return <p>{t('missing.phaseEKey')}</p>
}
```

- [x] **Step 3: Write checker fixture for untranslated JSX and attributes**

`untranslated-jsx.tsx` should include visible text plus one attribute:

```tsx
export function Untranslated() {
  return (
    <button aria-label="Create note">
      Create Note
    </button>
  )
}
```

- [x] **Step 4: Write checker fixture for allowed user content and technical strings**

`allowed-user-content.tsx` should include user data and technical props:

```tsx
export function Allowed({ noteTitle }: { noteTitle: string }) {
  return (
    <article data-testid="note-card" role="article">
      <h2>{noteTitle}</h2>
      <kbd>N</kbd>
    </article>
  )
}
```

- [x] **Step 5: Write resource helper tests**

Cover:

- English resources flatten to keys such as `notes:page.empty.title`.
- Unknown namespaces are rejected.
- `tr`/`ar` missing keys are classified as warnings.
- Existing Phase C empty namespace files are accepted as `{}`.

- [x] **Step 6: Write source scanner tests**

Cover:

- Passing fixture reports no failures.
- Missing key fixture reports a missing English key.
- Untranslated fixture reports both `Create Note` and `aria-label="Create note"`.
- Allowed user content fixture reports no failures.
- `.test.tsx` and `.spec.tsx` paths are ignored by default.

- [x] **Step 7: Run tests to verify they fail before implementation**

```bash
pnpm --filter @memry/desktop exec node --test scripts/i18n/resources.test.mjs scripts/i18n/scan-source.test.mjs
```

Expected: fail because `resources.mjs` and `scan-source.mjs` do not exist yet.

### Task 2: Implement resource loading helpers

**Files:**
- Create: `apps/desktop/scripts/i18n/resources.mjs`

- [x] **Step 1: Implement JSON resource loading**

Use `node:fs`, `node:path`, and `node:url`. Resolve the workspace root from the script location, then load:

- `packages/i18n/src/shared/config.ts` only if needed for namespace text parsing.
- `packages/i18n/src/locales/en/*.json`
- `packages/i18n/src/locales/tr/*.json`
- `packages/i18n/src/locales/ar/*.json`

Prefer reading JSON files directly over importing TS modules. This avoids Vite/TS resolution in a CLI script.

- [x] **Step 2: Implement `flattenKeys(namespace, object)`**

Rules:

- Nested JSON becomes `namespace:path.to.leaf`.
- Only string leaves count as translation keys.
- Empty objects produce no keys and no error.

- [x] **Step 3: Implement key checks**

Expose helpers:

- `loadLocaleResources(workspaceRoot)`
- `flattenLocale(localeResources)`
- `hasEnglishKey(key)`
- `compareLocaleCompleteness({ englishKeys, localeKeys })`

- [x] **Step 4: Run focused tests**

```bash
pnpm --filter @memry/desktop exec node --test scripts/i18n/resources.test.mjs
```

Expected: pass.

### Task 3: Implement TypeScript AST scanner

**Files:**
- Create: `apps/desktop/scripts/i18n/scan-source.mjs`

- [x] **Step 1: Parse TS/TSX using the TypeScript compiler API**

Use the existing `typescript` dependency. Do not add a parser dependency unless the compiler API proves insufficient.

Scan default globs:

- `apps/desktop/src/renderer/src/**/*.{ts,tsx}`
- `apps/desktop/src/main/**/*.{ts,tsx}`

Exclude:

- `**/*.test.ts`
- `**/*.test.tsx`
- `**/*.spec.ts`
- `**/*.spec.tsx`
- `apps/desktop/tests/**`
- `apps/desktop/src/renderer/src/**/*.d.ts`
- `apps/desktop/src/main/**/*.d.ts`

- [x] **Step 2: Track namespace-bound `t` functions**

Handle these patterns:

```tsx
const { t } = useT('notes')
const { t: tCommon } = useT('common')
const t = i18n.getFixedT(null, 'menu')
i18n.t('errors:sync.network-failed')
```

Resolve:

- `t('page.empty.title')` under a bound namespace to `notes:page.empty.title`.
- `tCommon('button.cancel')` to `common:button.cancel`.
- Fully-qualified calls like `i18n.t('menu:file.label')` as already namespaced.

If a dynamic key is encountered, report a warning with file/line and skip existence validation.

- [x] **Step 3: Detect user-facing JSX text and attributes**

Report:

- `JsxText` containing alphabetic characters.
- String literal JSX attributes for `aria-label`, `title`, `placeholder`, `alt`.
- String literal props likely to be user-facing: `label`, `description`, `emptyText`, `tooltip`, `message`.

Ignore:

- Whitespace-only JSX text.
- Text inside `<code>`, `<pre>`, `<kbd>`, and SVG `<title>` when it is an icon/accessibility technical label already covered elsewhere.
- Comments containing `TODO(i18n): wrap in t()` immediately before or on the same line as the literal. Use `// TODO(i18n): wrap in t()` where TypeScript syntax allows it; use `{/* TODO(i18n): wrap in t() */}` only for JSX child positions where a line comment would become rendered text.
- Technical props from the enforcement policy.

- [x] **Step 4: Compute line/column locations**

Use TypeScript source-file helpers. Report paths relative to the workspace root.

- [x] **Step 5: Run focused scanner tests**

```bash
pnpm --filter @memry/desktop exec node --test scripts/i18n/scan-source.test.mjs
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/scripts/i18n/resources.mjs apps/desktop/scripts/i18n/scan-source.mjs apps/desktop/scripts/i18n/fixtures/check apps/desktop/scripts/i18n/resources.test.mjs apps/desktop/scripts/i18n/scan-source.test.mjs
git commit -m "feat(i18n): add AST scanner for i18n checks"
```

## Chunk 2: `pnpm i18n:check` CLI

### Task 4: Add CLI tests first

**Files:**
- Create: `apps/desktop/scripts/i18n/check.test.mjs`
- Create: `apps/desktop/scripts/i18n/report.mjs` after the failing test exists

- [x] **Step 1: Write CLI behavior tests**

Use `node:test`, `node:assert/strict`, `node:child_process`, and temporary fixture directories.

Cover:

- `--paths <fixture>` returns exit code `0` for passing fixture.
- Missing English key exits `1` and prints the missing key plus file path.
- Missing `tr`/`ar` keys print warnings but exit `0`.
- Orphan English keys print warnings but exit `0`.
- `--format json` emits parseable JSON for CI tooling.
- `--max-todo <n>` fails when TODO-annotated straggler count exceeds `n`.

- [x] **Step 2: Run CLI tests to verify failure**

```bash
pnpm --filter @memry/desktop exec node --test scripts/i18n/check.test.mjs
```

Expected: fail because `check.mjs` is missing.

### Task 5: Implement CLI and scripts

**Files:**
- Create: `apps/desktop/scripts/i18n/check.mjs`
- Create: `apps/desktop/scripts/i18n/report.mjs`
- Modify: `package.json`
- Modify: `apps/desktop/package.json`

- [x] **Step 1: Implement `check.mjs`**

CLI options:

- `--paths <path...>` optional, defaults to production renderer/main source globs.
- `--format text|json`, default `text`.
- `--max-todo <number>` optional ratchet.
- `--allow-todo` default true for the first Phase E landing.
- `--strict-todo` optional future mode that fails any TODO-marked straggler.

Exit rules:

- Exit `1` for missing English keys, unknown namespaces, unannotated untranslated strings, malformed locale JSON, or TODO count above `--max-todo`.
- Exit `0` for warnings only.

- [x] **Step 2: Implement stable text report**

Match the spec shape:

```text
✓ 847 keys used across 312 files
✓ All keys exist in en/* bundles
⚠ 234 keys missing in tr/* (will fall back to en)
⚠ 234 keys missing in ar/* (will fall back to en)
⚠ 19 TODO(i18n) stragglers remain
✗ 3 untranslated strings
```

Use ASCII fallback if the repo prefers it during implementation; stability matters more than symbols.

- [x] **Step 3: Add scripts**

In root `package.json`:

```json
"i18n:check": "pnpm --filter @memry/desktop i18n:check",
"test:i18n-tools": "pnpm --filter @memry/desktop test:i18n-tools"
```

In `apps/desktop/package.json`:

```json
"i18n:check": "node scripts/i18n/check.mjs",
"test:i18n-tools": "node --test scripts/i18n/*.test.mjs scripts/i18n/eslint/*.test.mjs"
```

- [x] **Step 4: Run focused CLI tests**

```bash
pnpm --filter @memry/desktop test:i18n-tools
```

Expected: all i18n tooling tests created so far pass.

- [x] **Step 5: Run the real checker and record baseline**

```bash
pnpm i18n:check
```

Expected during initial implementation: likely fails on current unannotated stragglers. Do not migrate strings. Record the count; the codemod task will annotate the baseline.

- [ ] **Step 6: Commit**

```bash
git add package.json apps/desktop/package.json apps/desktop/scripts/i18n/check.mjs apps/desktop/scripts/i18n/report.mjs apps/desktop/scripts/i18n/check.test.mjs
git commit -m "feat(i18n): add i18n check CLI"
```

## Chunk 3: ESLint Rule

### Task 6: Write ESLint RuleTester cases

**Files:**
- Create: `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.test.mjs`
- Create: `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.mjs` after failing tests
- Create: `apps/desktop/scripts/i18n/eslint/index.mjs` after rule exists

- [x] **Step 1: Write valid cases**

Use `RuleTester` from `eslint`.

Valid cases:

```tsx
const { t } = useT('notes')
export function A() {
  return <h1>{t('page.empty.title')}</h1>
}
```

```tsx
export function B({ title }: { title: string }) {
  return <h1>{title}</h1>
}
```

```tsx
export function C() {
  return (
    <button>
      {/* TODO(i18n): wrap in t() */}
      Create Note
    </button>
  )
}
```

```tsx
export function D() {
  return <kbd>N</kbd>
}
```

- [x] **Step 2: Write invalid cases**

Invalid cases:

```tsx
export function A() {
  return <h1>Create Note</h1>
}
```

```tsx
export function B() {
  return <><span>Loading...</span><span>Failed</span></>
}
```

Each invalid case should assert message id `jsxTextLiteral`.

- [x] **Step 3: Verify tests fail before implementation**

```bash
pnpm --filter @memry/desktop exec node --test scripts/i18n/eslint/no-jsx-text-literals.test.mjs
```

Expected: fail because rule file is missing.

### Task 7: Implement and wire ESLint rule

**Files:**
- Create: `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.mjs`
- Create: `apps/desktop/scripts/i18n/eslint/index.mjs`
- Modify: `eslint.config.mjs`

- [x] **Step 1: Implement rule**

Rule behavior:

- Visit `JSXText`.
- Trim/collapse whitespace.
- Ignore empty text and punctuation-only text.
- Ignore text under `kbd`, `code`, `pre`, `script`, `style`.
- Ignore if adjacent comments include `TODO(i18n): wrap in t()`.
- Report `JSX text literal must use t() or be marked with TODO(i18n).`

Do not add auto-fix in the ESLint rule. The codemod owns annotations.

- [x] **Step 2: Export local plugin**

`index.mjs` should export:

```js
import noJsxTextLiterals from './no-jsx-text-literals.mjs'

export default {
  rules: {
    'no-jsx-text-literals': noJsxTextLiterals
  }
}
```

- [x] **Step 3: Wire flat config**

In `eslint.config.mjs`:

- Import the plugin:

```js
import i18nPlugin from './apps/desktop/scripts/i18n/eslint/index.mjs'
```

- Add a config block after React JSX config and before the final broad rules block:

```js
{
  files: ['apps/desktop/src/renderer/src/**/*.tsx'],
  ignores: ['**/*.test.tsx', '**/*.spec.tsx'],
  plugins: {
    i18n: i18nPlugin
  },
  rules: {
    'i18n/no-jsx-text-literals': 'error'
  }
}
```

Do not enable this rule for main-process `.ts`; menu/errors are already enforced by `pnpm i18n:check` key validation and Phase D ownership.

- [x] **Step 4: Run RuleTester cases**

```bash
pnpm --filter @memry/desktop exec node --test scripts/i18n/eslint/no-jsx-text-literals.test.mjs
```

Expected: pass.

- [ ] **Step 5: Run lint before codemod and confirm intentional failures**

```bash
pnpm lint
```

Expected: fails on unannotated JSX text literals if stragglers remain. This is intentional before the codemod baseline. Do not weaken the rule to warnings.

- [ ] **Step 6: Commit**

```bash
git add eslint.config.mjs apps/desktop/scripts/i18n/eslint
git commit -m "feat(i18n): add JSX text literal ESLint rule"
```

## Chunk 4: TODO Codemod

### Task 8: Write codemod fixture tests

**Files:**
- Create: `apps/desktop/scripts/i18n/fixtures/codemod/input.tsx`
- Create: `apps/desktop/scripts/i18n/fixtures/codemod/output.tsx`
- Create: `apps/desktop/scripts/i18n/codemod-todo-jsx-literals.test.mjs`
- Create: `apps/desktop/scripts/i18n/codemod-todo-jsx-literals.mjs` after failing tests

- [x] **Step 1: Write input fixture**

Include:

```tsx
export function Example({ noteTitle }: { noteTitle: string }) {
  return (
    <section>
      <h1>Create Note</h1>
      <p>{noteTitle}</p>
      <button aria-label="Close dialog">Close</button>
      <kbd>N</kbd>
    </section>
  )
}
```

- [x] **Step 2: Write expected output fixture**

The codemod should annotate only stragglers. In JSX child positions, use JSX comments so the TODO does not render; elsewhere prefer the literal line-comment form `// TODO(i18n): wrap in t()`:

```tsx
export function Example({ noteTitle }: { noteTitle: string }) {
  return (
    <section>
      {/* TODO(i18n): wrap in t() */}
      <h1>Create Note</h1>
      <p>{noteTitle}</p>
      {/* TODO(i18n): wrap aria-label in t() */}
      <button aria-label="Close dialog">
        {/* TODO(i18n): wrap in t() */}
        Close
      </button>
      <kbd>N</kbd>
    </section>
  )
}
```

If the implementation chooses `// TODO(i18n): wrap in t()` before the whole element for attributes, adjust the expected fixture once and keep it stable.

- [x] **Step 3: Write idempotency test**

Running the codemod twice must produce the same output.

- [x] **Step 4: Write dry-run test**

`--dry-run` should report changed file count without writing.

- [x] **Step 5: Verify tests fail before implementation**

```bash
pnpm --filter @memry/desktop exec node --test scripts/i18n/codemod-todo-jsx-literals.test.mjs
```

Expected: fail because codemod is missing.

### Task 9: Implement codemod and scripts

**Files:**
- Create: `apps/desktop/scripts/i18n/codemod-todo-jsx-literals.mjs`
- Modify: `apps/desktop/package.json`
- Modify: `package.json` if a root passthrough is desired

- [x] **Step 1: Implement conservative patcher**

Use the same `scan-source.mjs` detection logic so the checker, rule, and codemod agree.

CLI options:

- `--paths <path...>` optional, defaults to `apps/desktop/src/renderer/src`.
- `--dry-run` reports changes without writing.
- `--write` applies comments.
- `--check` exits `1` if changes would be needed.

Behavior:

- Insert `TODO(i18n): wrap in t()` comments adjacent to JSX text children.
- Insert `// TODO(i18n): wrap in t()` comments before lines with user-facing string attributes when a line comment is syntactically safe; otherwise insert a JSX comment before the element.
- Preserve file formatting as much as possible.
- Be idempotent.
- Do not replace strings with `t()` calls.
- Do not touch locale JSONs or shared i18n registry files.

- [x] **Step 2: Add package scripts**

In `apps/desktop/package.json`:

```json
"i18n:codemod:todo": "node scripts/i18n/codemod-todo-jsx-literals.mjs --write",
"i18n:codemod:todo:check": "node scripts/i18n/codemod-todo-jsx-literals.mjs --check",
"i18n:codemod:todo:dry-run": "node scripts/i18n/codemod-todo-jsx-literals.mjs --dry-run"
```

Optional root passthroughs in `package.json`:

```json
"i18n:codemod:todo": "pnpm --filter @memry/desktop i18n:codemod:todo",
"i18n:codemod:todo:check": "pnpm --filter @memry/desktop i18n:codemod:todo:check",
"i18n:codemod:todo:dry-run": "pnpm --filter @memry/desktop i18n:codemod:todo:dry-run"
```

- [x] **Step 3: Run codemod tests**

```bash
pnpm --filter @memry/desktop exec node --test scripts/i18n/codemod-todo-jsx-literals.test.mjs
```

Expected: pass.

- [x] **Step 4: Dry-run the real repo**

```bash
pnpm --filter @memry/desktop i18n:codemod:todo:dry-run
```

Expected: prints the files that would receive TODO comments. Review the list. If it includes test files, locale files, generated files, or user content-only surfaces, fix the scanner filters before writing.

- [x] **Step 5: Apply the TODO baseline**

```bash
pnpm --filter @memry/desktop i18n:codemod:todo
```

Expected: only production renderer/source files receive `TODO(i18n)` comments. No translation JSON changes.

- [x] **Step 6: Run checker after codemod**

```bash
pnpm i18n:check
```

Expected: exits `0` if all missing English keys are resolved and all stragglers are TODO-annotated. It may warn about TODO count, orphan keys, and missing TR/AR keys.

- [ ] **Step 7: Commit**

```bash
git add package.json apps/desktop/package.json apps/desktop/scripts/i18n/codemod-todo-jsx-literals.mjs apps/desktop/scripts/i18n/codemod-todo-jsx-literals.test.mjs apps/desktop/scripts/i18n/fixtures/codemod apps/desktop/src/renderer/src
git commit -m "chore(i18n): annotate untranslated JSX stragglers"
```

## Chunk 5: Full Integration and Ratchet

### Task 10: Align checker, codemod, and lint behavior

**Files:**
- Modify as needed: `apps/desktop/scripts/i18n/scan-source.mjs`
- Modify as needed: `apps/desktop/scripts/i18n/check.mjs`
- Modify as needed: `apps/desktop/scripts/i18n/codemod-todo-jsx-literals.mjs`
- Modify as needed: `apps/desktop/scripts/i18n/eslint/no-jsx-text-literals.mjs`

- [x] **Step 1: Confirm all three tools agree on the same baseline**

Run:

```bash
pnpm --filter @memry/desktop i18n:codemod:todo:check
pnpm i18n:check
pnpm lint
```

Expected:

- Codemod check passes because no unannotated stragglers remain.
- `pnpm i18n:check` exits `0` with warnings only.
- `pnpm lint` exits `0 errors`; existing warning baseline may remain.

- [x] **Step 2: Add a TODO ratchet note to CLI output**

If the baseline has TODOs, print a line like:

```text
warn: 37 TODO(i18n) stragglers remain. Pass --max-todo 37 to freeze this count.
```

Do not fail on this count unless `--max-todo` is supplied.

- [x] **Step 3: Decide whether to freeze the count in the script**

Preferred safe first landing:

- Do not hardcode `--max-todo` in `package.json` until the baseline is reviewed.
- Document the exact count in the PR description.
- Follow-up PR can add `--max-todo <count>` after reviewers accept the baseline.

If the user wants a strict ratchet in the same PR, update root `i18n:check` to:

```json
"i18n:check": "pnpm --filter @memry/desktop i18n:check -- --max-todo <current-count>"
```

- [ ] **Step 4: Commit any alignment fixes**

```bash
git add apps/desktop/scripts/i18n eslint.config.mjs package.json apps/desktop/package.json
git commit -m "fix(i18n): align Phase E tooling gates"
```

Only create this commit if there are real changes after the earlier commits.

## Final Verification Gate

Run all commands from the worktree root:

- [x] `pnpm --filter @memry/desktop test:i18n-tools`
  - Expected: all AST checker, CLI, ESLint RuleTester, and codemod fixture tests pass.
- [x] `pnpm --filter @memry/desktop i18n:codemod:todo:dry-run`
  - Expected: reports zero pending changes after the TODO baseline commit.
- [x] `pnpm --filter @memry/desktop i18n:codemod:todo:check`
  - Expected: passes.
- [x] `pnpm i18n:check`
  - Expected: exits `0`; warnings for `tr`/`ar` missing keys, orphan keys, or TODOs are allowed.
- [x] `pnpm lint`
  - Expected: exits `0`; existing warnings are acceptable, new i18n rule errors are intentional and must be fixed or TODO-annotated.
- [x] `pnpm typecheck`
  - Expected: passes except for documented pre-existing test-file type errors if they still exist in this branch.
- [x] `pnpm --filter @memry/i18n test`
  - Expected: existing i18n package tests pass.
- [x] `pnpm --filter @memry/desktop test:main -- locale-handler`
  - Expected: main locale IPC tests still pass.
- [x] `pnpm --filter @memry/desktop test:renderer -- i18n`
  - Expected: renderer i18n tests still pass.

If any command fails:

- Stop.
- Record the exact command, exit code, and first actionable error.
- Fix only Phase E tooling files or TODO annotations caused by this plan.
- Do not migrate translation content as part of the fix.

## Final Review Checklist

- [x] `package.json` has `i18n:check`.
- [x] `apps/desktop/package.json` has `i18n:check`, `test:i18n-tools`, and codemod dry-run/check/write scripts.
- [x] `pnpm i18n:check` validates English key existence and exits non-zero for missing English keys.
- [x] `pnpm i18n:check` warns, not fails, for missing TR/AR content.
- [x] `pnpm i18n:check` reports TODO straggler count.
- [x] ESLint rejects new unannotated JSX text literals in production renderer TSX.
- [x] ESLint allows TODO-annotated baseline literals so `pnpm lint` can pass with the current warning baseline.
- [x] Codemod is dry-run capable, idempotent, fixture-tested, and does not replace strings with `t()`.
- [x] No locale JSON translation content was added.
- [x] No Phase D errors/menu migration work was included.
- [x] No broad RTL Tailwind codemod was included.
- [x] Shared i18n registry/resource files were not reformatted or rewritten unless a test-proven bug required it.

## Commit Plan

Use atomic commits while implementing; do not run these during plan writing.

```bash
git commit -m "feat(i18n): add AST scanner for i18n checks"
git commit -m "feat(i18n): add i18n check CLI"
git commit -m "feat(i18n): add JSX text literal ESLint rule"
git commit -m "chore(i18n): annotate untranslated JSX stragglers"
git commit -m "fix(i18n): align Phase E tooling gates"
```

Omit the final `fix` commit if no alignment changes are needed.
