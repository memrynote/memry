import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import reactYouMightNotNeedAnEffect from 'eslint-plugin-react-you-might-not-need-an-effect'

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
      'react-refresh/only-export-components': 'warn',
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
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
      'apps/desktop/src/main/ipc/settings-handlers.ts'
    ],
    rules: {
      // TODO(phase-2): drop these overrides once IPC handler files are split (Phase 2 registerCommand rollout)
      'max-lines': 'off'
    }
  },
  {
    files: [
      'apps/desktop/src/main/index.ts',
      'apps/desktop/src/main/database/seed.ts',
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
    files: [
      'apps/desktop/src/preload/index.ts',
      'apps/desktop/src/preload/index.d.ts'
    ],
    rules: {
      // TODO(phase-tbd): preload is generated from contracts; drop overrides once chunked output lands
      'max-lines': 'off'
    }
  },
  {
    files: [
      'packages/contracts/src/ipc-channels.ts',
      'packages/contracts/src/inbox-api.ts'
    ],
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
  },
  {
    files: [
      'apps/desktop-tauri/src/pages/tasks.tsx',
      'apps/desktop-tauri/src/pages/note.tsx',
      'apps/desktop-tauri/src/pages/journal.tsx',
      'apps/desktop-tauri/src/pages/folder-view.tsx',
      'apps/desktop-tauri/src/pages/inbox/inbox-list-view.tsx',
      'apps/desktop-tauri/src/components/folder-view/grouped-table.tsx',
      'apps/desktop-tauri/src/components/folder-view/folder-table-view.tsx',
      'apps/desktop-tauri/src/components/folder-view/property-cell.tsx',
      'apps/desktop-tauri/src/components/kibo-ui/tree/index.tsx',
      'apps/desktop-tauri/src/components/virtualized-notes-tree.tsx',
      'apps/desktop-tauri/src/components/note/content-area/ContentArea.tsx',
      'apps/desktop-tauri/src/contexts/tabs/context.tsx',
      'apps/desktop-tauri/src/hooks/use-drag-handlers.ts',
      'apps/desktop-tauri/src/hooks/use-folder-view.ts',
      'apps/desktop-tauri/src/hooks/use-note-tree-actions.ts',
      'apps/desktop-tauri/src/hooks/use-subtask-management.ts',
      'apps/desktop-tauri/src/lib/expression-evaluator.ts',
      // Tauri-specific consolidated preload types (no Electron equivalent)
      'apps/desktop-tauri/src/types/preload-types.ts'
    ],
    rules: {
      // Mirrors the Electron overrides above — same files, same reason
      // (port-audit confirms line-for-line copies). TODO(phase-5): drop
      // once renderer files are split during UI polish.
      'max-lines': 'off'
    }
  }
)
