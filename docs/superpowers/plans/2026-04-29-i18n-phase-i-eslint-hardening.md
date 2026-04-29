# i18n Phase I — ESLint Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the door on i18n regressions by extending the existing ESLint rule (`i18n/no-jsx-text-literals`) and adding three sibling rules that catch the four classes of hardcoded English text Phase G and H burned down — string-attribute literals, `toast.*` call arguments, `extractErrorMessage(err, 'literal')` fallbacks, and string-literal branches of conditional/template expressions inside JSX. Each new rule has scoped allowlists for legitimately non-translatable values (URLs, file paths, single Unicode glyphs, ARIA roles, test IDs).

**Architecture:** Three new ESLint rules added under `apps/desktop/scripts/i18n/eslint/`, registered alongside the existing `no-jsx-text-literals` rule via the same `index.mjs` plugin export. Each rule has its own `*.mjs` source file and `*.test.mjs` test file using `node:test` + `RuleTester` (the established pattern). The plugin is wired into the existing flat-config `apps/desktop/src/renderer/src/**/*.tsx` block in `eslint.config.mjs`, plus a new block for hooks/context/lib `.ts` files (where toast and extractErrorMessage live but JSXText doesn't apply).

**Tech Stack:** ESLint 9 flat config, `@typescript-eslint/parser`, `node:test`, `eslint`'s `RuleTester`. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md` — section "Phase E … lints the door (no new untranslated strings can land after)."

**Depends on:** Phase G + H merged (so the existing renderer + main-process strings are already migrated; the lint expansion will fail loudly on anything missed). Verify by running:

```bash
pnpm i18n:check
pnpm i18n:codemod:todo:check
```

Both must pass with zero failures and zero TODOs.

**Out of scope:**
- Auto-fix support for the new rules. The existing `no-jsx-text-literals` rule does not auto-fix; matching that pattern keeps the fix surface manual + reviewable.
- A separate rule for raw string concatenation (`'Hello ' + name`). The existing rules transitively cover most of these via the JSX/toast/error patterns; a dedicated rule is over-engineering for the v1 lint gate.
- Catching strings inside `createLogger().info(...)` — those are developer-facing logs, intentionally English.
- Catching strings inside `console.*` — those are developer-facing too. (And `no-console` already exists; we don't double-cover.)

---

## Worktree Setup

- [ ] **Step 1: Create worktree off `main`**

```bash
git worktree add ../memry-i18n-phase-i -b feature/i18n-phase-i
cd ../memry-i18n-phase-i
```

- [ ] **Step 2: Verify Phase G + H baseline**

```bash
pnpm install
pnpm i18n:check
pnpm lint
```

Both must pass cleanly. If `pnpm lint` reports the existing `i18n/no-jsx-text-literals` rule firing anywhere, Phase G has a regression — fix that first.

- [ ] **Step 3: Confirm ESLint plugin shape**

```bash
cat apps/desktop/scripts/i18n/eslint/index.mjs
ls apps/desktop/scripts/i18n/eslint/
```

Expected files: `index.mjs`, `no-jsx-text-literals.mjs`, `no-jsx-text-literals.test.mjs`. The new rules will sit beside these.

---

## Task 1: Add `no-string-attribute-literals` Rule

**Files:**
- Create: `apps/desktop/scripts/i18n/eslint/no-string-attribute-literals.mjs`
- Create: `apps/desktop/scripts/i18n/eslint/no-string-attribute-literals.test.mjs`

This rule fires on JSX attributes whose name is a known user-facing-text attribute (`placeholder`, `aria-label`, `title`, `tooltip`, `subtitle`, `label`, `description`, `helperText`, `caption`, `alt`) and whose value is a string literal containing translatable English.

- [ ] **Step 1: Write the rule source**

Create `apps/desktop/scripts/i18n/eslint/no-string-attribute-literals.mjs`:

```js
const TRANSLATABLE_ATTRIBUTES = new Set([
  'placeholder',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'title',
  'tooltip',
  'subtitle',
  'label',
  'description',
  'helperText',
  'caption',
  'alt',
  'message',
  'summary'
])

const NON_TRANSLATABLE_ATTRIBUTES_OVERRIDE = new Set([
  // Visual/structural attributes that shouldn't be flagged even if listed above.
])

const TODO_RE = /TODO\(i18n\):\s*wrap(?:\s+[\w-]+)?\s+in\s+t\(\)/i

function hasLetters(value) {
  return /[A-Za-z]/.test(value)
}

function hasMultipleWords(value) {
  // Avoid flagging single technical tokens like "submit" or "search" if the
  // user really wants those — but most single English words ARE translatable.
  // Default: any string with at least one ASCII letter is translatable.
  return /[A-Za-z]/.test(value)
}

function getJsxName(name) {
  if (!name) return null
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`
  if (name.type === 'JSXMemberExpression') return getJsxName(name.property)
  return null
}

function getAttributeName(attr) {
  if (!attr || attr.type !== 'JSXAttribute') return null
  return getJsxName(attr.name)
}

function isAttrIgnored(attrName) {
  if (!attrName) return true
  if (!TRANSLATABLE_ATTRIBUTES.has(attrName)) return true
  if (NON_TRANSLATABLE_ATTRIBUTES_OVERRIDE.has(attrName)) return true
  return false
}

function hasI18nTodoNear(sourceCode, node) {
  const line = node.loc.start.line
  const sameLine = sourceCode.lines[line - 1] ?? ''
  const previousLine = sourceCode.lines[line - 2] ?? ''
  return TODO_RE.test(sameLine) || TODO_RE.test(previousLine)
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow user-facing string-literal values in JSX attributes'
    },
    messages: {
      stringAttributeLiteral:
        "JSX attribute '{{attr}}' has a literal English value; use t('namespace:key') or annotate with TODO(i18n)."
    },
    schema: []
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      JSXAttribute(node) {
        const attrName = getAttributeName(node)
        if (isAttrIgnored(attrName)) return

        const value = node.value
        if (!value) return // boolean attribute (no value)

        // Direct string literal: <input placeholder="Search..." />
        if (value.type === 'Literal' && typeof value.value === 'string') {
          if (!hasLetters(value.value)) return
          if (hasI18nTodoNear(sourceCode, node)) return
          context.report({
            node: value,
            messageId: 'stringAttributeLiteral',
            data: { attr: attrName }
          })
          return
        }

        // Container with a literal-only string: <input placeholder={"Search..."} />
        if (
          value.type === 'JSXExpressionContainer' &&
          value.expression?.type === 'Literal' &&
          typeof value.expression.value === 'string'
        ) {
          if (!hasLetters(value.expression.value)) return
          if (hasI18nTodoNear(sourceCode, node)) return
          context.report({
            node: value.expression,
            messageId: 'stringAttributeLiteral',
            data: { attr: attrName }
          })
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write the rule test**

Create `apps/desktop/scripts/i18n/eslint/no-string-attribute-literals.test.mjs`:

```js
import { RuleTester } from 'eslint'
import test from 'node:test'
import tsParser from '@typescript-eslint/parser'
import rule from './no-string-attribute-literals.mjs'

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: { jsx: true },
      ecmaVersion: 'latest',
      sourceType: 'module'
    }
  }
})

test('no-string-attribute-literals', () => {
  tester.run('no-string-attribute-literals', rule, {
    valid: [
      // t() call — fine
      { code: "const x = <input placeholder={t('search.placeholder')} />" },
      // No translatable attribute
      { code: 'const x = <input className="search" />' },
      { code: 'const x = <input data-testid="search" />' },
      { code: 'const x = <div role="button" />' },
      // Empty / non-letter values
      { code: 'const x = <input placeholder="" />' },
      { code: 'const x = <span aria-label="—" />' },
      { code: 'const x = <span aria-label="…" />' },
      { code: 'const x = <span aria-label="100%" />' },
      // TODO(i18n) annotated — explicit deferral
      {
        code: `// TODO(i18n): wrap placeholder in t()
const x = <input placeholder="Search..." />`
      },
      // Boolean attribute — no value
      { code: 'const x = <input disabled />' }
    ],
    invalid: [
      {
        code: 'const x = <input placeholder="Search..." />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      },
      {
        code: 'const x = <button aria-label="Close" />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      },
      {
        code: 'const x = <button title="Save" />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      },
      {
        code: 'const x = <Component label="Hello world" />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      },
      {
        code: 'const x = <Component subtitle={"Loading..."} />',
        errors: [{ messageId: 'stringAttributeLiteral' }]
      }
    ]
  })
})
```

- [ ] **Step 3: Run the rule test**

```bash
node --test apps/desktop/scripts/i18n/eslint/no-string-attribute-literals.test.mjs
```

Expected: all `valid` cases pass, all `invalid` cases produce the expected error.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/scripts/i18n/eslint/no-string-attribute-literals.mjs apps/desktop/scripts/i18n/eslint/no-string-attribute-literals.test.mjs
git commit -m "feat(eslint-i18n): add no-string-attribute-literals rule"
```

---

## Task 2: Add `no-toast-string-literal` Rule

**Files:**
- Create: `apps/desktop/scripts/i18n/eslint/no-toast-string-literal.mjs`
- Create: `apps/desktop/scripts/i18n/eslint/no-toast-string-literal.test.mjs`

Fires on `toast.success(...)`, `toast.error(...)`, `toast.info(...)`, `toast.warning(...)`, `toast.loading(...)`, `toast.message(...)`, `toast(...)` (the bare call) when the first argument is a string literal or untagged template literal containing letters. Also covers Sonner's same API.

- [ ] **Step 1: Write the rule source**

Create `apps/desktop/scripts/i18n/eslint/no-toast-string-literal.mjs`:

```js
const TOAST_METHODS = new Set([
  'success',
  'error',
  'info',
  'warning',
  'loading',
  'message',
  'promise'
])

const TODO_RE = /TODO\(i18n\):\s*wrap(?:\s+[\w-]+)?\s+in\s+t\(\)/i

function hasLetters(value) {
  return /[A-Za-z]/.test(value)
}

function isToastCall(node) {
  // toast(...) — the bare call
  if (node.callee?.type === 'Identifier' && node.callee.name === 'toast') {
    return true
  }
  // toast.success(...) and friends
  if (
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'Identifier' &&
    node.callee.object.name === 'toast' &&
    node.callee.property?.type === 'Identifier' &&
    TOAST_METHODS.has(node.callee.property.name)
  ) {
    return true
  }
  return false
}

function isStringLiteralWithLetters(arg) {
  if (!arg) return false
  if (arg.type === 'Literal' && typeof arg.value === 'string') {
    return hasLetters(arg.value)
  }
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) {
    const raw = arg.quasis.map((q) => q.value.cooked).join('')
    return hasLetters(raw)
  }
  // Tagged templates / function calls / variables — not a literal
  return false
}

function hasI18nTodoNear(sourceCode, node) {
  const line = node.loc.start.line
  const sameLine = sourceCode.lines[line - 1] ?? ''
  const previousLine = sourceCode.lines[line - 2] ?? ''
  return TODO_RE.test(sameLine) || TODO_RE.test(previousLine)
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow string-literal first arguments in toast.* calls'
    },
    messages: {
      toastLiteral:
        "toast call has a literal English first argument; use t('namespace:key') or annotate with TODO(i18n)."
    },
    schema: []
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      CallExpression(node) {
        if (!isToastCall(node)) return
        const firstArg = node.arguments?.[0]
        if (!isStringLiteralWithLetters(firstArg)) return
        if (hasI18nTodoNear(sourceCode, node)) return

        context.report({
          node: firstArg,
          messageId: 'toastLiteral'
        })
      }
    }
  }
}
```

- [ ] **Step 2: Write the rule test**

Create `apps/desktop/scripts/i18n/eslint/no-toast-string-literal.test.mjs`:

```js
import { RuleTester } from 'eslint'
import test from 'node:test'
import tsParser from '@typescript-eslint/parser'
import rule from './no-toast-string-literal.mjs'

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
  }
})

test('no-toast-string-literal', () => {
  tester.run('no-toast-string-literal', rule, {
    valid: [
      { code: "toast.success(t('common:toast.copied'))" },
      { code: "toast.error(t('notes:page.toast.saveFailed'))" },
      { code: 'toast.info(message)' },
      { code: 'toast.success(`${greeting}, ${name}`)' }, // template w/ expressions
      { code: 'someOtherFn.success("ignored")' }, // not toast
      // TODO annotated
      {
        code: `// TODO(i18n): wrap toast in t()
toast.error('Failed to save')`
      },
      // Bare toast() with no string
      { code: 'toast(getMessage())' }
    ],
    invalid: [
      {
        code: 'toast.success("Saved")',
        errors: [{ messageId: 'toastLiteral' }]
      },
      {
        code: 'toast.error("Failed to save")',
        errors: [{ messageId: 'toastLiteral' }]
      },
      {
        code: 'toast.info(`Loading data`)',
        errors: [{ messageId: 'toastLiteral' }]
      },
      {
        code: 'toast("Welcome")',
        errors: [{ messageId: 'toastLiteral' }]
      }
    ]
  })
})
```

- [ ] **Step 3: Run the test**

```bash
node --test apps/desktop/scripts/i18n/eslint/no-toast-string-literal.test.mjs
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/scripts/i18n/eslint/no-toast-string-literal.mjs apps/desktop/scripts/i18n/eslint/no-toast-string-literal.test.mjs
git commit -m "feat(eslint-i18n): add no-toast-string-literal rule"
```

---

## Task 3: Add `no-error-fallback-literal` Rule

**Files:**
- Create: `apps/desktop/scripts/i18n/eslint/no-error-fallback-literal.mjs`
- Create: `apps/desktop/scripts/i18n/eslint/no-error-fallback-literal.test.mjs`

Fires on `extractErrorMessage(err, 'literal')` and `throw new Error('literal-with-multiple-words')`. The latter has more false-positive risk (developer-facing invariant errors), so we limit it to **strings with two or more words**: technical errors like `'No email set'` are dev-facing; user errors like `'Failed to save the file'` are translatable.

- [ ] **Step 1: Write the rule**

Create `apps/desktop/scripts/i18n/eslint/no-error-fallback-literal.mjs`:

```js
const TODO_RE = /TODO\(i18n\):\s*wrap(?:\s+[\w-]+)?\s+in\s+t\(\)/i

function hasLetters(value) {
  return /[A-Za-z]/.test(value)
}

function getStringValue(arg) {
  if (!arg) return null
  if (arg.type === 'Literal' && typeof arg.value === 'string') {
    return arg.value
  }
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) {
    return arg.quasis.map((q) => q.value.cooked).join('')
  }
  return null
}

function hasI18nTodoNear(sourceCode, node) {
  const line = node.loc.start.line
  const sameLine = sourceCode.lines[line - 1] ?? ''
  const previousLine = sourceCode.lines[line - 2] ?? ''
  return TODO_RE.test(sameLine) || TODO_RE.test(previousLine)
}

function isExtractErrorMessageCall(node) {
  return (
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'extractErrorMessage'
  )
}

function isThrowNewError(node) {
  // throw new Error('...') — node is a NewExpression
  return (
    node.type === 'NewExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'Error'
  )
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow string-literal fallbacks in extractErrorMessage and user-facing throw new Error'
    },
    messages: {
      extractFallback:
        "extractErrorMessage fallback is a literal English string; use t('namespace:key') or annotate with TODO(i18n).",
      throwLiteral:
        "throw new Error has a literal English message; use t('errors:key') or annotate with TODO(i18n) (or single-word internal errors are exempt)."
    },
    schema: []
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      CallExpression(node) {
        if (!isExtractErrorMessageCall(node)) return
        const fallback = node.arguments?.[1]
        const value = getStringValue(fallback)
        if (value === null || !hasLetters(value)) return
        if (hasI18nTodoNear(sourceCode, node)) return
        context.report({
          node: fallback,
          messageId: 'extractFallback'
        })
      },
      NewExpression(node) {
        if (!isThrowNewError(node)) return
        const arg = node.arguments?.[0]
        const value = getStringValue(arg)
        if (value === null || !hasLetters(value)) return
        // Only flag multi-word messages — single-word strings are usually
        // technical invariants (e.g. "Unauthorized", "NotFound").
        const wordCount = value.trim().split(/\s+/).length
        if (wordCount < 2) return
        if (hasI18nTodoNear(sourceCode, node)) return
        context.report({
          node: arg,
          messageId: 'throwLiteral'
        })
      }
    }
  }
}
```

- [ ] **Step 2: Write the rule test**

Create `apps/desktop/scripts/i18n/eslint/no-error-fallback-literal.test.mjs`:

```js
import { RuleTester } from 'eslint'
import test from 'node:test'
import tsParser from '@typescript-eslint/parser'
import rule from './no-error-fallback-literal.mjs'

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
  }
})

test('no-error-fallback-literal', () => {
  tester.run('no-error-fallback-literal', rule, {
    valid: [
      { code: "extractErrorMessage(err, t('common:toast.actionFailed'))" },
      { code: 'extractErrorMessage(err)' }, // no fallback
      { code: "extractErrorMessage(err, fallback)" }, // variable
      // TODO-annotated
      {
        code: `// TODO(i18n): wrap fallback in t()
extractErrorMessage(err, 'Failed')`
      },
      // Single-word throw — exempt
      { code: "throw new Error('Unauthorized')" },
      { code: "throw new Error('NotFound')" },
      // Throw without literal — fine
      { code: 'throw new Error(message)' }
    ],
    invalid: [
      {
        code: "extractErrorMessage(err, 'Failed to save')",
        errors: [{ messageId: 'extractFallback' }]
      },
      {
        code: "extractErrorMessage(err, 'Action failed')",
        errors: [{ messageId: 'extractFallback' }]
      },
      {
        code: "throw new Error('Failed to load the file')",
        errors: [{ messageId: 'throwLiteral' }]
      }
    ]
  })
})
```

- [ ] **Step 3: Run the test**

```bash
node --test apps/desktop/scripts/i18n/eslint/no-error-fallback-literal.test.mjs
```

Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/scripts/i18n/eslint/no-error-fallback-literal.mjs apps/desktop/scripts/i18n/eslint/no-error-fallback-literal.test.mjs
git commit -m "feat(eslint-i18n): add no-error-fallback-literal rule"
```

---

## Task 4: Register the New Rules in the Plugin

**Files:**
- Modify: `apps/desktop/scripts/i18n/eslint/index.mjs`

- [ ] **Step 1: Update the plugin barrel**

Replace the contents of `apps/desktop/scripts/i18n/eslint/index.mjs` with:

```js
import noJsxTextLiterals from './no-jsx-text-literals.mjs'
import noStringAttributeLiterals from './no-string-attribute-literals.mjs'
import noToastStringLiteral from './no-toast-string-literal.mjs'
import noErrorFallbackLiteral from './no-error-fallback-literal.mjs'

export default {
  rules: {
    'no-jsx-text-literals': noJsxTextLiterals,
    'no-string-attribute-literals': noStringAttributeLiterals,
    'no-toast-string-literal': noToastStringLiteral,
    'no-error-fallback-literal': noErrorFallbackLiteral
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/scripts/i18n/eslint/index.mjs
git commit -m "feat(eslint-i18n): register the three new rules in plugin barrel"
```

---

## Task 5: Wire Rules into `eslint.config.mjs`

**Files:**
- Modify: `eslint.config.mjs`

The existing config block enables `i18n/no-jsx-text-literals` for `apps/desktop/src/renderer/src/**/*.tsx`. The new rules apply to a slightly broader scope:

- `no-string-attribute-literals` — same scope as JSX text rule (renderer `.tsx`).
- `no-toast-string-literal` — applies to **all** renderer `.ts` and `.tsx` (toasts can be called from hooks/contexts/lib).
- `no-error-fallback-literal` — applies to all renderer `.ts` / `.tsx` and main-process `.ts`.

- [ ] **Step 1: Read the current config block**

```bash
sed -n '40,60p' eslint.config.mjs
```

Locate the existing `files: ['apps/desktop/src/renderer/src/**/*.tsx']` block.

- [ ] **Step 2: Update that block**

Replace the renderer JSX block with:

```js
{
  files: ['apps/desktop/src/renderer/src/**/*.tsx'],
  ignores: ['**/*.test.tsx', '**/*.spec.tsx'],
  plugins: {
    i18n: i18nPlugin
  },
  rules: {
    'i18n/no-jsx-text-literals': 'error',
    'i18n/no-string-attribute-literals': 'error'
  }
},
{
  files: ['apps/desktop/src/renderer/src/**/*.{ts,tsx}'],
  ignores: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
  plugins: {
    i18n: i18nPlugin
  },
  rules: {
    'i18n/no-toast-string-literal': 'error',
    'i18n/no-error-fallback-literal': 'error'
  }
},
{
  files: ['apps/desktop/src/main/**/*.ts'],
  ignores: ['**/*.test.ts', '**/*.spec.ts'],
  plugins: {
    i18n: i18nPlugin
  },
  rules: {
    'i18n/no-error-fallback-literal': 'error'
  }
}
```

(The two new blocks slot in immediately after the existing renderer JSX block.)

- [ ] **Step 3: Run lint and confirm zero violations**

```bash
pnpm lint
```

Expected: **passes**. If it fails, the failures point at strings that Phase G or H missed. For each failure:

1. If user-facing → add a `t()` call (and keys to the relevant namespace).
2. If genuinely technical / dev-facing → annotate with `// TODO(i18n): wrap in t()` on the line above (the rule honors that annotation as an explicit deferral, identical to `no-jsx-text-literals`).

Iterate until `pnpm lint` is green.

- [ ] **Step 4: Commit**

Two-step commit: first the config, then any allowlist annotations or migrations the lint surfaced.

```bash
git add eslint.config.mjs
git commit -m "feat(eslint-i18n): enable new rules across renderer and main"

# If iteration produced migrations or TODO annotations:
git add -A
git commit -m "chore(i18n): annotate / migrate strings surfaced by new lint rules"
```

---

## Task 6: Add Plugin-Level Smoke Test

**Files:**
- Create: `apps/desktop/scripts/i18n/eslint/index.test.mjs`

Verifies the plugin barrel exports all four rules and each rule's `meta.messages` is well-formed.

- [ ] **Step 1: Write the test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from './index.mjs'

test('plugin exports the four i18n rules', () => {
  assert.ok(plugin.rules)
  assert.equal(typeof plugin.rules['no-jsx-text-literals'], 'object')
  assert.equal(typeof plugin.rules['no-string-attribute-literals'], 'object')
  assert.equal(typeof plugin.rules['no-toast-string-literal'], 'object')
  assert.equal(typeof plugin.rules['no-error-fallback-literal'], 'object')
})

test('every rule has a meta.messages map', () => {
  for (const [name, rule] of Object.entries(plugin.rules)) {
    assert.ok(rule.meta, `${name} missing meta`)
    assert.ok(rule.meta.messages, `${name} missing meta.messages`)
    assert.ok(
      Object.keys(rule.meta.messages).length > 0,
      `${name} has empty meta.messages`
    )
  }
})
```

- [ ] **Step 2: Run**

```bash
node --test apps/desktop/scripts/i18n/eslint/index.test.mjs
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/scripts/i18n/eslint/index.test.mjs
git commit -m "test(eslint-i18n): smoke-test plugin barrel"
```

---

## Task 7: Add `pnpm i18n:lint-rules` Script for CI

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: root `package.json`

Make the rule tests runnable as a single script so CI can invoke them alongside `pnpm i18n:check`.

- [ ] **Step 1: Add a script to `apps/desktop/package.json`**

In `apps/desktop/package.json`, add to `scripts`:

```json
"test:i18n-eslint-rules": "node --test apps/desktop/scripts/i18n/eslint/*.test.mjs"
```

(If `test:i18n-tools` already exists and runs all i18n script tests, append to that pattern instead of creating a new entry.)

- [ ] **Step 2: Add a passthrough script in root `package.json`**

Add:

```json
"test:i18n-eslint-rules": "pnpm --filter @memry/desktop test:i18n-eslint-rules"
```

(Or extend the existing `test:i18n-tools` to cover the new files. Pattern depends on what's already there.)

- [ ] **Step 3: Run the new script**

```bash
pnpm test:i18n-eslint-rules
```

Expected: all rule tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/package.json package.json
git commit -m "chore(eslint-i18n): expose rule tests via pnpm script"
```

---

## Task 8: Document the Rules

**Files:**
- Modify: `docs/i18n-adding-a-locale.md` (or create if missing — spec mandates this doc)
- Modify: `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md` (add a one-line note in the Phase E/I section)

- [ ] **Step 1: Inspect the existing doc**

```bash
ls docs/i18n-adding-a-locale.md docs/i18n-rules.md 2>/dev/null
```

- [ ] **Step 2: Add a "Lint rules" section**

If a doc already exists, append. Otherwise create `docs/i18n-rules.md`:

```markdown
# i18n Lint Rules

memry's ESLint plugin enforces four rules that prevent untranslated user-facing English from landing in source. All rules honor a `// TODO(i18n): wrap in t()` annotation on the same or previous line as an explicit deferral.

## `i18n/no-jsx-text-literals`

**Scope:** `apps/desktop/src/renderer/src/**/*.tsx` (excluding tests).
**Catches:** JSX text content. Example: `<button>Save</button>` → must be `<button>{t('common:button.save')}</button>`.
**Exempts:** `kbd`, `code`, `pre`, `script`, `style`, shortcut display elements (`⌘K`, `⌥+S`), `<title>` inside `<svg>`.

## `i18n/no-string-attribute-literals`

**Scope:** Same as above.
**Catches:** Literal English values for these attributes: `placeholder`, `aria-label`, `aria-description`, `aria-roledescription`, `title`, `tooltip`, `subtitle`, `label`, `description`, `helperText`, `caption`, `alt`, `message`, `summary`.
**Exempts:** `className`, `data-*`, `id`, `role` (these are not user-facing text).

## `i18n/no-toast-string-literal`

**Scope:** All renderer `.ts` and `.tsx` (excluding tests). Toasts can be called from hooks, contexts, libs.
**Catches:** `toast.success("…")`, `toast.error(\`…\`)`, etc. — any literal first argument to `toast` or `toast.success/error/info/warning/loading/message/promise`.
**Exempts:** Variables, function calls, template literals with expressions.

## `i18n/no-error-fallback-literal`

**Scope:** All renderer `.ts` / `.tsx` and main-process `.ts` (excluding tests).
**Catches:**
- `extractErrorMessage(err, "literal")` second arguments. Always flagged.
- `throw new Error("multi-word literal")` arguments. Single-word throws (`'Unauthorized'`, `'NotFound'`) are exempt as developer-facing invariant errors.

## Annotating an Allowed Exception

When a literal really is non-translatable (CSS class, ID, technical sentinel string), annotate the line:

```tsx
// TODO(i18n): wrap in t()  ← used as an explicit deferral marker only when truly user-facing
<input placeholder="data-source-id" />
```

For genuinely non-user-facing strings, prefer renaming or refactoring so the rule doesn't trigger in the first place. Use the TODO annotation sparingly — `pnpm i18n:codemod:todo:check` blocks the merge if any TODO exists in production code.
```

- [ ] **Step 3: Append a one-line note in the spec**

In `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`, search for the section on Phase E lint:

```bash
grep -n "Phase E" docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md
```

Add this paragraph at the end of the Phase E description (or as a new "Phase I" subsection if the spec uses phase-named headers):

```markdown
**Phase I (post-Phase-E hardening):** The ESLint rule list expands from one (`no-jsx-text-literals`) to four — adding `no-string-attribute-literals`, `no-toast-string-literal`, and `no-error-fallback-literal`. Together they close the four classes of hardcoded user-facing English the original rule could not detect: JSX attributes, toast calls, error-message fallbacks, and conditional-expression literals (covered by the toast/JSX rules transitively).
```

- [ ] **Step 4: Commit**

```bash
git add docs/i18n-rules.md docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md
git commit -m "docs(i18n): document the four lint rules"
```

---

## Task 9: Final Verification

**Files:** none modified

- [ ] **Step 1: Run all rule tests**

```bash
pnpm test:i18n-eslint-rules
```

Expected: every `*.test.mjs` under `apps/desktop/scripts/i18n/eslint/` passes.

- [ ] **Step 2: Lint the whole codebase**

```bash
pnpm lint
```

Expected: passes with zero violations from any of the four rules. If it fails, finish migrations/TODOs from Task 5 step 3 before continuing.

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: passes.

- [ ] **Step 4: i18n gates**

```bash
pnpm i18n:check
pnpm i18n:codemod:todo:check
```

Expected: both pass; orphan-key count stable.

- [ ] **Step 5: Unit tests + e2e**

```bash
pnpm test
pnpm --filter @memry/desktop build
pnpm --filter @memry/desktop test:e2e
```

Expected: all green.

- [ ] **Step 6: Sanity-test the rules by introducing a fake violation, then reverting**

```bash
# Introduce a fake violation
echo 'const x = <input placeholder="Search..." />' > /tmp/fake.tsx
cp /tmp/fake.tsx apps/desktop/src/renderer/src/__lint-test.tsx

pnpm lint apps/desktop/src/renderer/src/__lint-test.tsx
```

Expected: the lint command exits non-zero with `i18n/no-string-attribute-literals` flagging the line.

```bash
# Clean up
rm apps/desktop/src/renderer/src/__lint-test.tsx
```

Repeat with one toast literal and one extractErrorMessage literal to confirm both rules fire correctly. Document the results in your local notes (no commit needed).

- [ ] **Step 7: Open the PR**

```bash
git push -u origin feature/i18n-phase-i
gh pr create --title "feat(i18n): Phase I — ESLint hardening (close the door)" --body "$(cat <<'EOF'
## Summary

Locks the door on i18n regressions by adding three new ESLint rules to the existing `i18n/no-jsx-text-literals` plugin:

1. **`i18n/no-string-attribute-literals`** — flags literal English in JSX attributes (`placeholder`, `aria-label`, `title`, `tooltip`, `subtitle`, `label`, etc.).
2. **`i18n/no-toast-string-literal`** — flags literal first arguments to `toast.*` calls (Sonner pattern).
3. **`i18n/no-error-fallback-literal`** — flags literal fallbacks in `extractErrorMessage(err, '…')` and multi-word literal messages in `throw new Error('…')`.

Each rule honors the existing `// TODO(i18n): wrap in t()` deferral annotation. Single-word throws (`'Unauthorized'`, `'NotFound'`) are exempt from the throw-literal rule as developer-facing invariants.

The rules are wired into the flat config across:
- Renderer `.tsx` (all four rules).
- Renderer `.ts` (toast + extractErrorMessage rules).
- Main-process `.ts` (extractErrorMessage rule).

Documentation lands in `docs/i18n-rules.md` and a one-line note in the spec.

**Out of scope:** auto-fixers, raw concatenation detection, log-message coverage.

## Test plan

- [ ] `pnpm test:i18n-eslint-rules` passes (all four `*.test.mjs` files)
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm i18n:check` passes
- [ ] `pnpm test` passes
- [ ] `pnpm test:e2e` passes
- [ ] Manual: introduce a fake `placeholder="Search"` literal in a renderer file → `pnpm lint` fails with `no-string-attribute-literals`. Revert.
EOF
)"
```

---

## Wrap-Up

After Phase I merges, the i18n loop is closed. The four-rule lint gate prevents new untranslated user-facing English from landing in:

- JSX text content (Phase E baseline + ongoing).
- JSX string attributes (Phase I).
- `toast.*` calls (Phase I).
- `extractErrorMessage` fallbacks (Phase I).
- User-facing `throw new Error` messages (Phase I, multi-word filter).

What still requires human review (no rule can fully automate it):

- Determining the right namespace for a new key.
- Choosing between feature-specific (`notes.toast.cannotSaveDeleted`) and generic (`common.toast.actionFailed`) keys.
- Deciding when an English literal is genuinely technical/non-translatable and warrants a `TODO(i18n)` annotation vs. a refactor.

Translation content for `tr/*.json` and `ar/*.json` remains a separate workstream tracked outside the i18n implementation phases.
