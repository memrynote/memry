import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import reactYouMightNotNeedAnEffect from 'eslint-plugin-react-you-might-not-need-an-effect'
import i18nPlugin from './apps/desktop/scripts/i18n/eslint/index.mjs'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/build',
      '**/coverage',
      '**/*.min.js',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      'tests/**',
      'apps/desktop/tests/**',
      // Static assets served verbatim (e.g. the Excalidraw asset-path shim)
      'apps/desktop/src/renderer/public/**',
      '*.config.ts',
      '*.config.mjs',
      '*.config.js',
      'config/**',
      'apps/desktop/config/**',
      'scripts/**',
      'apps/desktop/scripts/**',
      'specs/**',
      'docs/**',
      'apps/sync-server/**'
    ]
  },
  tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true
      }
    }
  },
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
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
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  reactYouMightNotNeedAnEffect.configs.recommended,
  {
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/prefer-as-const': 'warn',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      'react/display-name': 'off',
      '@typescript-eslint/unbound-method': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      // Existing renderer files intentionally co-export providers/hooks, UI primitives,
      // and editor block helpers. Enforcing this would require broad file-splitting
      // unrelated to normal lint correctness.
      'react-refresh/only-export-components': 'off',
      'react-hooks/rules-of-hooks': 'warn',
      // React Compiler advisory diagnostics: these four flag ~60 long-shipped
      // call sites (fetch-on-open effects, cached-selection refs, dynamic icon
      // components) that `eslint --cache` had been masking locally. Off until a
      // dedicated compliance pass; rules-of-hooks/purity/immutability stay on.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'off',
      'no-useless-escape': 'warn',
      'no-case-declarations': 'warn',
      'no-empty-pattern': 'warn',
      'no-control-regex': 'warn',
      'prefer-const': 'warn',
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }]
    }
  },
  {
    files: ['apps/desktop/src/main/ipc/sync-handlers.ts'],
    rules: {
      // TODO(phase-2): drop this override once sync-handlers.ts is split
      'max-lines': 'off'
    }
  },
  {
    files: ['apps/desktop/src/main/vault/notes.ts'],
    rules: {
      // TODO(phase-3): drop this override once vault/notes.ts is split
      'max-lines': 'off'
    }
  },
  {
    files: [
      'apps/desktop/src/main/ipc/notes-handlers.ts',
      'apps/desktop/src/main/ipc/settings-handlers.ts',
      'apps/desktop/src/main/ipc/calendar-handlers.ts'
    ],
    rules: {
      // TODO(phase-2): drop these overrides once IPC handler files are split (Phase 2 registerCommand rollout)
      'max-lines': 'off'
    }
  },
  {
    files: [
      'apps/desktop/src/main/index.ts',
      'apps/desktop/src/main/database/queries/tasks.ts',
      'apps/desktop/src/main/inbox/filing.ts',
      'apps/desktop/src/main/inbox/suggestions.ts',
      'apps/desktop/src/main/sync/attachments.ts',
      'apps/desktop/src/main/vault/watcher.ts'
    ],
    rules: {
      // TODO(phase-tbd): drop these overrides once large main-process modules are split
      'max-lines': 'off'
    }
  },
  {
    files: ['apps/desktop/src/preload/index.ts', 'apps/desktop/src/preload/index.d.ts'],
    rules: {
      // TODO(phase-tbd): preload is generated from contracts; drop overrides once chunked output lands
      'max-lines': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off'
    }
  },
  {
    files: [
      'apps/desktop/src/renderer/src/components/calendar/use-week-infinite-scroll.ts',
      'apps/desktop/src/renderer/src/components/note/note-title/HugeIconGrid.tsx',
      'apps/desktop/src/renderer/src/components/tasks/project/virtualized-project-task-list.tsx',
      'apps/desktop/src/renderer/src/components/tasks/virtualized-all-tasks-view.tsx',
      'apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx',
      'apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx',
      'apps/desktop/src/renderer/src/components/folder-view/grouped-table.tsx'
    ],
    rules: {
      // TanStack Virtual/Table are the app virtualization and table layers; React
      // Compiler cannot optimize these call sites, but the usage is intentional
      // and isolated.
      'react-hooks/incompatible-library': 'off'
    }
  },
  {
    files: [
      'apps/desktop/src/renderer/src/components/diagnostics/report-incident-dialog.tsx',
      'apps/desktop/src/renderer/src/components/tasks/projects/add-event-to-project-dialog.tsx',
      'apps/desktop/src/renderer/src/components/tasks/projects/add-file-to-project-dialog.tsx',
      'apps/desktop/src/renderer/src/components/tasks/projects/add-note-to-project-dialog.tsx',
      'apps/desktop/src/renderer/src/components/tasks/projects/project-overview-note.tsx',
      'apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.tsx',
      'apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.ts',
      'apps/desktop/src/renderer/src/pages/canvas/use-canvas-entities.ts',
      'apps/desktop/src/renderer/src/pages/project-home.tsx',
      'apps/desktop/src/renderer/src/sync/use-yjs-collaboration.ts'
    ],
    rules: {
      // Fetch-on-open dialogs and CRDT/IPC sync hooks set state inside effects to
      // synchronize with external systems (IPC fetches, the Y.Doc registry) and to
      // reset per open-cycle; each site documents its own race/ordering rationale.
      // The suggested refactors (key-remount, derive-in-render) don't apply there.
      'react-you-might-not-need-an-effect/no-adjust-state-on-prop-change': 'off',
      'react-you-might-not-need-an-effect/no-chain-state-updates': 'off',
      'react-you-might-not-need-an-effect/no-derived-state': 'off',
      'react-you-might-not-need-an-effect/no-event-handler': 'off',
      'react-you-might-not-need-an-effect/no-pass-ref-to-parent': 'off'
    }
  },
  {
    files: ['apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx'],
    rules: {
      // The mount-time load and the `onProjectUpdated` reload both call a
      // `load()` callback that toggles a `pendingRef` guard closing a
      // stale-state race on `project_links` writes (see the file's inline
      // comment). The plugin's ref-tracing through that callback misreads
      // the ref/prop combination as forwarding a ref to a parent; no ref is
      // exposed outside this component.
      'react-you-might-not-need-an-effect/no-pass-ref-to-parent': 'off'
    }
  },
  {
    files: ['packages/contracts/src/ipc-channels.ts', 'packages/contracts/src/inbox-api.ts'],
    rules: {
      // TODO(phase-4): drop these overrides once contract modules are split by domain
      'max-lines': 'off'
    }
  },
  {
    files: [
      'apps/desktop/src/renderer/src/pages/tasks.tsx',
      'apps/desktop/src/renderer/src/pages/note.tsx',
      'apps/desktop/src/renderer/src/pages/journal.tsx',
      'apps/desktop/src/renderer/src/pages/folder-view.tsx',
      'apps/desktop/src/renderer/src/pages/calendar.tsx',
      'apps/desktop/src/renderer/src/pages/inbox/inbox-list-view.tsx',
      'apps/desktop/src/renderer/src/components/folder-view/grouped-table.tsx',
      'apps/desktop/src/renderer/src/components/folder-view/folder-table-view.tsx',
      'apps/desktop/src/renderer/src/components/folder-view/property-cell.tsx',
      'apps/desktop/src/renderer/src/components/kibo-ui/tree/index.tsx',
      'apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx',
      'apps/desktop/src/renderer/src/components/note/content-area/ContentArea.tsx',
      'apps/desktop/src/renderer/src/contexts/tabs/context.tsx',
      'apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts',
      'apps/desktop/src/renderer/src/hooks/use-folder-view.ts',
      'apps/desktop/src/renderer/src/hooks/use-note-tree-actions.ts',
      'apps/desktop/src/renderer/src/hooks/use-subtask-management.ts',
      'apps/desktop/src/renderer/src/lib/expression-evaluator.ts'
    ],
    rules: {
      // TODO(phase-5): drop these overrides once renderer files are split during UI polish
      'max-lines': 'off'
    }
  }
)
