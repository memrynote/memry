import { readFileSync } from 'node:fs'

import { defineConfig } from 'oxlint'

// Severity model. A rule with no violations is an error. A rule that still has a
// backlog is a warning, and scripts/lint-ratchet.mjs holds it at the counts in
// scripts/lint-baseline.json so it can only go down. When a rule's last violation
// is fixed, `pnpm lint:ratchet --update` drops it from the baseline and it turns
// into an error here with no config edit.
const baseline: { files: Record<string, Record<string, number>> } = JSON.parse(
  readFileSync(new URL('./scripts/lint-baseline.json', import.meta.url), 'utf8')
)
const backlog = new Set(Object.values(baseline.files).flatMap((rules) => Object.keys(rules)))
// `lint-ratchet.mjs --update --allow-increase` lints with every rule at warn, so each
// violation lands in the baseline instead of failing the run.
const everythingWarns = process.env.LINT_RATCHET_ALL_WARN === '1'
// oxlint also exposes a few type-aware rules under their core name (`no-implied-eval`), while
// reporting them as `typescript/…`, so a backlog entry under either spelling counts.
const severity = (rule: string) =>
  everythingWarns || backlog.has(rule) || backlog.has(`typescript/${rule}`) ? 'warn' : 'error'
const enable = (rule: string, options?: unknown): [string, unknown] => [
  rule,
  options === undefined ? severity(rule) : [severity(rule), options]
]
const enableAll = (...rules: Array<string | [string, unknown]>) =>
  Object.fromEntries(
    rules.map((rule) => (typeof rule === 'string' ? enable(rule) : enable(rule[0], rule[1])))
  )
const disable = (...rules: string[]) => Object.fromEntries(rules.map((rule) => [rule, 'off']))

const TEST_FILES = [
  '**/*.test.{ts,tsx,js,mjs,cjs}',
  '**/*.spec.{ts,tsx,js,mjs,cjs}',
  '**/__tests__/**',
  '**/tests/**',
  '**/test/**'
]

const RENDERER = 'apps/desktop/src/renderer/src'

export default defineConfig({
  plugins: [
    'eslint',
    'typescript',
    'unicorn',
    'react',
    'react-perf',
    'oxc',
    'import',
    'jsx-a11y',
    'promise',
    'node',
    'vitest'
  ],
  jsPlugins: [
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
    { name: 'i18n', specifier: './apps/desktop/scripts/i18n/oxlint/index.mjs' },
    { name: 'memry', specifier: './tools/oxlint/memry/index.mjs' },
    'eslint-plugin-react-you-might-not-need-an-effect'
  ],
  categories: {
    correctness: everythingWarns ? 'warn' : 'error',
    suspicious: everythingWarns ? 'warn' : 'error',
    perf: everythingWarns ? 'warn' : 'error'
  },
  // lint-staged sets OXLINT_TYPE_AWARE=0 for its fast, errors-only pass.
  options: { typeAware: process.env.OXLINT_TYPE_AWARE !== '0' },
  env: { builtin: true, es2024: true, node: true, browser: true },
  // Pinned because oxlint cannot detect the installed version (eslint-plugin-react's `detect`).
  settings: { react: { version: '19.3.0' } },
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/out/**',
    '**/build/**',
    '**/coverage/**',
    '**/*.min.js',
    // Extension build output (WXT).
    '**/.wxt/**',
    '**/.output/**',
    // Swift app: the JS under it is generated bundles (editor, article-extract).
    'apps/ios/**',
    // Static assets served verbatim (e.g. the Excalidraw asset-path shim)
    'apps/desktop/src/renderer/public/**',
    // The lint rules' own implementation is not product code.
    'tools/oxlint/**',
    // Agent tooling and per-user scratch directories, not product code.
    '.agent/**',
    '.agents/**',
    '.claude/**',
    '.codex/**',
    '.continue/**',
    '.cursor/**',
    '.gemini/**',
    '.gstack/**',
    '.impeccable/**',
    '.opencode/**',
    '.pi/**',
    '.roo/**',
    '.social/**',
    '.superpowers/**',
    '.turbo/**',
    '.windsurf/**',
    '.worktrees/**'
  ],
  rules: {
    ...Object.fromEntries([...backlog].map((rule) => [rule, 'warn'])),

    // --- ESLint parity: options and severities of the previous eslint.config.mjs ---
    ...enableAll(
      ['no-unused-vars', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      [
        'no-unused-expressions',
        { allowShortCircuit: true, allowTaggedTemplates: true, allowTernary: true }
      ],
      ['no-empty-function', { allow: ['arrowFunctions'] }],
      ['max-lines', { max: 800, skipBlankLines: true, skipComments: true }],
      // Vitest's `expect(value, message)` second argument is a failure message, not a bug.
      ['vitest/valid-expect', { maxArgs: 2 }],
      ['typescript/ban-ts-comment', { 'ts-ignore': 'allow-with-description' }],
      ['typescript/no-empty-object-type', { allowInterfaces: 'always' }],
      'no-array-constructor',
      'no-var',
      'prefer-const',
      'prefer-rest-params',
      'prefer-spread',
      'no-useless-escape',
      'no-case-declarations',
      'no-empty-pattern',
      'no-control-regex',
      'typescript/no-explicit-any',
      'typescript/no-require-imports',
      'typescript/prefer-as-const',
      'typescript/no-duplicate-enum-values',
      'typescript/no-extra-non-null-assertion',
      'typescript/no-misused-new',
      'typescript/no-namespace',
      'typescript/no-non-null-asserted-optional-chain',
      'typescript/no-this-alias',
      'typescript/no-unnecessary-type-constraint',
      'typescript/no-unsafe-declaration-merging',
      'typescript/no-unsafe-function-type',
      'typescript/no-wrapper-object-types',
      'typescript/prefer-namespace-keyword',
      'typescript/triple-slash-reference',
      'typescript/await-thenable',
      'typescript/no-array-delete',
      'typescript/no-base-to-string',
      'typescript/no-duplicate-type-constituents',
      'typescript/no-floating-promises',
      'typescript/no-for-in-array',
      'typescript/no-implied-eval',
      'no-implied-eval',
      'typescript/no-misused-promises',
      'typescript/no-redundant-type-constituents',
      'typescript/no-unnecessary-type-assertion',
      'typescript/no-unsafe-enum-comparison',
      'typescript/no-unsafe-unary-minus',
      'typescript/only-throw-error',
      'typescript/prefer-promise-reject-errors',
      'typescript/restrict-plus-operands',
      'typescript/unbound-method'
    ),

    // --- React and React Compiler (eslint-plugin-react-hooks v7 equivalents) ---
    ...enableAll(
      'react/rules-of-hooks',
      'react/exhaustive-deps',
      'react/use-memo',
      'react/incompatible-library',
      'react/globals',
      'react/error-boundaries',
      'react/set-state-in-render',
      'react/unsupported-syntax',
      'react/immutability',
      'react/purity',
      // Off in ESLint to hide ~60 long-shipped call sites (fetch-on-open effects,
      // cached-selection refs, dynamic icon components); the ratchet holds them now.
      'react/set-state-in-effect',
      'react/preserve-manual-memoization',
      'react/refs',
      'react/static-components'
    ),

    // --- eslint-plugin-react-you-might-not-need-an-effect recommended ---
    ...enableAll(
      ...[
        'no-empty-effect',
        'no-adjust-state-on-prop-change',
        'no-reset-all-state-on-prop-change',
        'no-event-handler',
        'no-pass-live-state-to-parent',
        'no-pass-data-to-parent',
        'no-pass-ref-to-parent',
        'no-initialize-state',
        'no-chain-state-updates',
        'no-derived-state'
      ].map((rule) => `react-you-might-not-need-an-effect/${rule}`)
    ),

    // --- Beyond parity: import hygiene and stricter type-aware rules ---
    ...enableAll(
      ['typescript/consistent-type-imports', { disallowTypeAnnotations: true }],
      'import/first',
      'import/no-duplicates',
      'import/no-cycle',
      ['typescript/switch-exhaustiveness-check', { considerDefaultExhaustiveForUnions: true }],
      ['typescript/return-await', 'error-handling-correctness-only'],
      'typescript/no-deprecated',
      'typescript/no-misused-spread',
      'typescript/no-meaningless-void-operator',
      'typescript/no-useless-default-assignment',
      'typescript/use-unknown-in-catch-callback-variable',
      'typescript/strict-boolean-expressions',
      'typescript/no-confusing-void-expression',
      'typescript/no-unsafe-type-assertion',
      'typescript/promise-function-async',
      'typescript/no-unnecessary-condition',
      'typescript/prefer-nullish-coalescing',
      'typescript/prefer-optional-chain',
      'typescript/consistent-return',
      'typescript/no-unnecessary-boolean-literal-compare',
      'typescript/no-unnecessary-template-expression',
      'typescript/no-unnecessary-type-arguments',
      'typescript/no-unnecessary-type-conversion'
    ),

    // --- Rules from the categories that contradict this setup ---
    ...disable(
      // JSX uses the automatic runtime; React is never imported for it.
      'react/react-in-jsx-scope',
      // A leading underscore is how this repo marks an intentionally unused name (see
      // no-unused-vars above), and the rule flags that same convention.
      'no-underscore-dangle',
      // Side-effect imports (CSS, polyfills, `vitest/globals`) are normal in an app.
      'import/no-unassigned-import',
      // The previous config turned these off: IPC payloads and `any` from untyped
      // libraries flow through on purpose, and numbers/booleans go into templates.
      'typescript/no-unsafe-member-access',
      'typescript/no-unsafe-call',
      'typescript/no-unsafe-assignment',
      'typescript/no-unsafe-return',
      'typescript/no-unsafe-argument',
      'typescript/require-await',
      'typescript/restrict-template-expressions',
      'typescript/explicit-function-return-type',
      // Existing renderer files co-export providers/hooks, UI primitives and editor block
      // helpers; enforcing this needs broad file-splitting unrelated to lint correctness.
      'react/only-export-components'
    ),

    // --- Repo guards ---
    ...enableAll(
      'anti-slop/no-chained-type-assertions',
      'anti-slop/no-conditional-empty-object-spread',
      'anti-slop/no-known-value-widening',
      'anti-slop/no-module-mocking',
      'anti-slop/no-object-parameters',
      'anti-slop/no-reflect-apply',
      'anti-slop/no-reflect-get',
      'anti-slop/no-runtime-typeof',
      'anti-slop/no-shape-in-symbol-names',
      'anti-slop/no-unknown-parameters',
      'anti-slop/no-unknown-returns',
      'anti-slop/no-unknown-type-aliases',
      'anti-slop/no-unsafe-dictionary-type',
      'anti-slop/no-widen-then-assert',
      'anti-slop/require-safety-comment-for-type-assertion'
    )
  },
  overrides: [
    {
      files: TEST_FILES,
      rules: {
        // The 800-line cap was never applied to tests.
        'max-lines': 'off'
      }
    },
    {
      files: [`${RENDERER}/**/*.tsx`],
      rules: enableAll('i18n/no-jsx-text-literals', 'i18n/no-string-attribute-literals')
    },
    {
      files: [`${RENDERER}/**/*.{ts,tsx}`],
      rules: enableAll('i18n/no-toast-string-literal', 'i18n/no-error-fallback-literal')
    },
    {
      // A command's chord is bound once, in `@memry/contracts/commands`, and run by
      // the dispatcher in `renderer/src/commands/`. Binding a key to behavior here
      // instead skips Settings → Shortcuts rebinds, the help dialog and the palette.
      // Page-local keys (a find bar, a list's arrows) listen on `keydown` themselves.
      files: [`${RENDERER}/**/*.{ts,tsx}`],
      rules: {
        ...enableAll([
          'no-restricted-imports',
          {
            patterns: [
              {
                group: ['**/use-keyboard-shortcuts-base', '@/hooks'],
                importNames: ['useKeyboardShortcuts', 'matchesShortcut', 'default'],
                message:
                  'Do not bind a key to behavior in a component. Add a command to packages/contracts/src/commands and register its behavior with an owner hook, or listen to keydown on the surface that owns the key.'
              }
            ]
          }
        ])
      }
    },
    {
      // Tests and the owners of the guarded imports are outside the keyboard-shortcut guard.
      files: [
        ...TEST_FILES,
        `${RENDERER}/commands/resolve-chord.ts`,
        `${RENDERER}/hooks/index.ts`,
        // Not commands: ⌘1-9 jumps to the Nth visible sidebar section, and Q focuses the capture bar.
        `${RENDERER}/components/app-sidebar.tsx`,
        `${RENDERER}/components/capture-bar/capture-bar.tsx`
      ],
      rules: { 'no-restricted-imports': 'off' }
    },
    {
      // The i18n rules never applied to tests.
      files: TEST_FILES,
      rules: disable(
        'i18n/no-jsx-text-literals',
        'i18n/no-string-attribute-literals',
        'i18n/no-toast-string-literal',
        'i18n/no-error-fallback-literal'
      )
    },
    {
      // Guard against a fourth regression of #935/#1000: hand-rolled window fan-out loops.
      // See tools/oxlint/memry/index.mjs for the rationale and its limits.
      files: ['apps/desktop/src/main/**/*.ts'],
      rules: enableAll('memry/no-window-fanout')
    },
    {
      files: ['apps/desktop/src/main/lib/window-broadcast.ts'],
      rules: disable('memry/no-window-fanout')
    },
    {
      files: ['apps/desktop/src/main/ipc/sync-handlers.ts'],
      // TODO(phase-2): drop this override once sync-handlers.ts is split
      rules: disable('max-lines')
    },
    {
      files: ['apps/desktop/src/main/vault/notes.ts'],
      // TODO(phase-3): drop this override once vault/notes.ts is split
      rules: disable('max-lines')
    },
    {
      files: [
        'apps/desktop/src/main/ipc/notes-handlers.ts',
        'apps/desktop/src/main/ipc/settings-handlers.ts',
        'apps/desktop/src/main/ipc/calendar-handlers.ts'
      ],
      // TODO(phase-2): drop these overrides once IPC handler files are split (Phase 2 registerCommand rollout)
      rules: disable('max-lines')
    },
    {
      files: [
        'apps/desktop/src/main/index.ts',
        'apps/desktop/src/main/database/queries/tasks.ts',
        'apps/desktop/src/main/inbox/filing.ts',
        'apps/desktop/src/main/inbox/suggestions.ts',
        'apps/desktop/src/main/sync/attachments.ts',
        // Sat at exactly 800 countable lines, so the local-only body guard (#1511)
        // could not land without either this or a speculative split of the CRDT
        // provider — the wrong refactor to attach to a privacy fix.
        'apps/desktop/src/main/sync/crdt-provider.ts',
        'apps/desktop/src/main/sync/engine/crdt-sync-coordinator.ts',
        // Crossed 800 with the math block (#1871), and epic #1869 adds three more
        // block types to the same per-type dispatch. The split this file wants is
        // parse and serialize into their own modules beside their renderer twins,
        // which is a refactor of its own and not one to attach to a block type.
        'apps/desktop/src/main/sync/blocknote-converter.ts',
        'apps/desktop/src/main/vault/watcher.ts',
        // Sat at 798, 800 and 800 countable lines on main, so the read-only lock
        // checks (#2606) could not land without this: one assert in each note and
        // folder writer (notes-crud, 814), the lock check at vault open (index,
        // 810) and the vault_lock record service (runtime, 805). The checks must
        // sit in the writers themselves; splitting these files is a refactor of
        // its own and not one to attach to a lock feature.
        'apps/desktop/src/main/sync/runtime.ts',
        'apps/desktop/src/main/vault/index.ts',
        'apps/desktop/src/main/vault/notes-crud.ts'
      ],
      // TODO(phase-tbd): drop these overrides once large main-process modules are split
      rules: disable('max-lines')
    },
    {
      files: ['apps/desktop/src/preload/index.ts', 'apps/desktop/src/preload/index.d.ts'],
      // TODO(phase-tbd): preload is generated from contracts; drop overrides once chunked output lands
      rules: disable('max-lines', 'typescript/no-redundant-type-constituents')
    },
    {
      files: [
        `${RENDERER}/components/calendar/use-week-infinite-scroll.ts`,
        `${RENDERER}/components/note/note-title/HugeIconGrid.tsx`,
        `${RENDERER}/components/tasks/project/virtualized-project-task-list.tsx`,
        `${RENDERER}/components/tasks/virtualized-all-tasks-view.tsx`,
        `${RENDERER}/components/virtualized-notes-tree.tsx`,
        `${RENDERER}/components/folder-view/folder-table-view.tsx`,
        `${RENDERER}/components/folder-view/grouped-table.tsx`
      ],
      // TanStack Virtual/Table are the app virtualization and table layers; React
      // Compiler cannot optimize these call sites, but the usage is intentional
      // and isolated.
      rules: disable('react/incompatible-library')
    },
    {
      files: [
        `${RENDERER}/components/diagnostics/report-incident-dialog.tsx`,
        `${RENDERER}/components/tasks/projects/add-event-to-project-dialog.tsx`,
        `${RENDERER}/components/tasks/projects/add-file-to-project-dialog.tsx`,
        `${RENDERER}/components/tasks/projects/add-note-to-project-dialog.tsx`,
        `${RENDERER}/components/tasks/projects/project-overview-note.tsx`,
        `${RENDERER}/components/note/info-section/editors/use-relation-search.ts`,
        `${RENDERER}/pages/canvas/canvas-add-card-dialog.tsx`,
        `${RENDERER}/pages/canvas/use-canvas-add-search.ts`,
        `${RENDERER}/pages/canvas/use-canvas-entities.ts`,
        `${RENDERER}/pages/project-home.tsx`,
        `${RENDERER}/sync/use-yjs-collaboration.ts`
      ],
      // Fetch-on-open dialogs and CRDT/IPC sync hooks set state inside effects to
      // synchronize with external systems (IPC fetches, the Y.Doc registry) and to
      // reset per open-cycle; each site documents its own race/ordering rationale.
      // The suggested refactors (key-remount, derive-in-render) don't apply there.
      rules: disable(
        'react-you-might-not-need-an-effect/no-adjust-state-on-prop-change',
        'react-you-might-not-need-an-effect/no-chain-state-updates',
        'react-you-might-not-need-an-effect/no-derived-state',
        'react-you-might-not-need-an-effect/no-event-handler',
        'react-you-might-not-need-an-effect/no-pass-ref-to-parent'
      )
    },
    {
      files: [`${RENDERER}/components/calendar/event-project-field.tsx`],
      // The mount-time load and the `onProjectUpdated` reload both call a
      // `load()` callback that moves the `pendingLoads` / `isWriting` guards
      // closing a stale-state race on `project_links` writes (see the file's
      // inline comment). The plugin's ref-tracing through that callback
      // misreads the ref/prop combination as forwarding a ref to a parent; no
      // ref is exposed outside this component.
      rules: disable('react-you-might-not-need-an-effect/no-pass-ref-to-parent')
    },
    {
      files: ['packages/contracts/src/ipc-channels.ts', 'packages/contracts/src/inbox-api.ts'],
      // TODO(phase-4): drop these overrides once contract modules are split by domain
      rules: disable('max-lines')
    },
    {
      files: [
        `${RENDERER}/pages/tasks.tsx`,
        `${RENDERER}/pages/note.tsx`,
        `${RENDERER}/pages/journal.tsx`,
        `${RENDERER}/pages/folder-view.tsx`,
        `${RENDERER}/pages/calendar.tsx`,
        `${RENDERER}/pages/inbox/inbox-list-view.tsx`,
        `${RENDERER}/components/folder-view/grouped-table.tsx`,
        `${RENDERER}/components/folder-view/folder-table-view.tsx`,
        `${RENDERER}/components/folder-view/property-cell.tsx`,
        `${RENDERER}/components/kibo-ui/tree/index.tsx`,
        `${RENDERER}/components/virtualized-notes-tree.tsx`,
        `${RENDERER}/components/note/content-area/ContentArea.tsx`,
        `${RENDERER}/contexts/tabs/context.tsx`,
        `${RENDERER}/hooks/use-drag-handlers.ts`,
        `${RENDERER}/hooks/use-folder-view.ts`,
        `${RENDERER}/hooks/use-note-tree-actions.ts`,
        `${RENDERER}/hooks/use-subtask-management.ts`,
        `${RENDERER}/lib/expression-evaluator.ts`
      ],
      // TODO(phase-5): drop these overrides once renderer files are split during UI polish
      rules: disable('max-lines')
    },
    {
      // apps/extension and apps/landing were linted by their own ESLint configs: Vite
      // apps where components may export constants next to them (landing's server
      // entry exports non-components by design).
      files: ['apps/extension/**/*.{ts,tsx}', 'apps/landing/**/*.{ts,tsx}'],
      rules: enableAll(['react/only-export-components', { allowConstantExport: true }])
    },
    {
      files: ['apps/landing/src/entry-server.tsx'],
      rules: disable('react/only-export-components')
    }
  ]
})
